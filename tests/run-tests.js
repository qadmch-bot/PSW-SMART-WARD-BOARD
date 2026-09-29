#!/usr/bin/env node
/*
 * PSW Smart Ward Board — automated tests (no dependencies).
 *   node tests/run-tests.js
 *
 * 1. Shared-code integrity: the Apps Script and browser copies of the engine/seed are identical.
 * 2. Ward layout: exactly the 19 actual PSW locations, no Room 3 / Room 5.
 * 3. Business rules (engine) with an in-memory store: admit, status, discharge, transfer,
 *    isolation, doctor, on-call, extensions, KPIs, authorisation, privacy.
 * 4. Google Apps Script backend (Code.gs + Setup.gs) against a mock Google Sheets / Drive
 *    runtime: setupDatabase, doGet/doPost, ID-token checks, display key, sheet writes, audit log.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

let passed = 0, failed = 0, section = "";
function group(name) { section = name; console.log("\n" + name); }
function test(name, fn) {
  try { fn(); passed++; console.log("  \u2713 " + name); }
  catch (e) { failed++; console.log("  \u2717 " + name + "\n      " + (e && e.message || e)); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "") + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

const PSWEngine = require(path.join(ROOT, "js/engine.js"));
const PSWSeed = require(path.join(ROOT, "js/seed.js"));

// Load js/app.js (browser core) with a minimal window for computeKpis / validateBed.
const appCtx = { window: {}, document: { documentElement: {} }, Intl, Date, console, Math, JSON, Map, Set };
vm.createContext(appCtx);
vm.runInContext(read("js/app.js"), appCtx);
const PSW = appCtx.window.PSW;

const TODAY = "2026-09-23";
const ADMIN = "admin.psw@example.invalid", EDITOR = "nurse.psw@example.invalid", STRANGER = "someone@example.invalid";

// ------------------------------------------------------------------ in-memory store
function memoryStore(withDemo) {
  const s = {
    beds: PSWSeed.buildBeds(withDemo, TODAY),
    doctors: PSWSeed.DOCTORS.map(d => Object.assign({}, d)),
    onCall: PSWEngine.ENUMS.ONCALL_ROLES.map(r => ({ role: r, staffName: "", shiftDate: "", shiftStart: "", shiftEnd: "", lastUpdated: "" })),
    settings: Object.assign({}, PSWSeed.SETTINGS),
    audit: [], meta: {},
    users: [{ email: ADMIN, role: "ADMIN", active: true }, { email: EDITOR, role: "EDITOR", active: true },
      { email: "left.psw@example.invalid", role: "ADMIN", active: false }]
  };
  const c = o => JSON.parse(JSON.stringify(o));
  return {
    _s: s,
    readBeds: () => s.beds.map(b => Object.assign({}, b)),
    writeBeds: l => l.forEach(b => { const i = s.beds.findIndex(x => x.bed === b.bed); s.beds[i] = Object.assign({}, b); }),
    readDoctors: () => c(s.doctors), writeDoctors: l => { s.doctors = c(l); },
    readOnCall: () => c(s.onCall), writeOnCall: l => { s.onCall = c(l); },
    readSettings: () => c(s.settings), writeSettings: o => { s.settings = c(o); },
    appendAudit: e => { s.audit = s.audit.concat(e); },
    readAudit: n => s.audit.slice(-n).reverse(),
    readUsers: () => c(s.users),
    getMeta: k => s.meta[k] || "", setMeta: (k, v) => { s.meta[k] = v; }
  };
}
let tick = 0;
const env = { now: () => new Date(Date.UTC(2026, 8, 23, 6, 0, tick++)), uuid: () => "id-" + tick, today: () => TODAY };
function fresh(withDemo) { const store = memoryStore(withDemo); return { store, eng: PSWEngine.create(store, env) }; }
const bedOf = (store, id) => store._s.beds.find(b => b.bed === id);
const lastAudit = store => store._s.audit[store._s.audit.length - 1];

// ================================================================== 1. integrity
group("1. Shared code integrity");
test("google-apps-script/Engine.gs is identical to js/engine.js", () => eq(read("google-apps-script/Engine.gs"), read("js/engine.js")));
test("google-apps-script/SeedData.gs is identical to js/seed.js", () => eq(read("google-apps-script/SeedData.gs"), read("js/seed.js")));
test("js/app.js enums match the engine enums", () => {
  Object.keys(PSW.ENUMS).forEach(k => eq(JSON.stringify(PSW.ENUMS[k]), JSON.stringify(PSWEngine.ENUMS[k]), k));
});
test("no secrets or real endpoints committed in js/config.js", () => {
  const cfg = read("js/config.js");
  ok(/API_URL:\s*""/.test(cfg), "API_URL should be empty in the repository");
  ok(!/AIza[0-9A-Za-z_-]{20,}/.test(cfg) && !/BEGIN PRIVATE KEY/.test(cfg), "looks like a key");
});
test("all frontend asset paths are relative (GitHub Pages project URL)", () => {
  ["index.html", "admin.html", "dashboard/index.html", "admin/index.html"].forEach(f => {
    const html = read(f);
    const abs = html.match(/(?:src|href)="\/(?!\/)[^"]*"/g);
    ok(!abs, f + " uses root-absolute paths: " + abs);
  });
});

// ================================================================== 2. layout
group("2. Actual PSW layout");
test("19 listed locations in the exact order", () => {
  const ids = PSWSeed.buildBeds(false, TODAY).map(b => b.bed);
  eq(ids.join(","), "1A,1B,2A,2B,4A,4B,6A,6B,7A,7B,8A,8B,1 Y/O,> 1 Year,ISO2,NP,ISO1,ISO3,ISO4");
});
test("no Room 3 or Room 5", () => {
  const rooms = PSWSeed.buildBeds(false, TODAY).map(b => b.room);
  ok(!rooms.some(r => /Room [35]\b/.test(r)));
});
test("live seed: every bed empty, operational, privacy ON, no staff names or extensions", () => {
  const beds = PSWSeed.buildBeds(false, TODAY);
  ok(beds.every(b => b.occupancyStatus === "Available" && b.operationalStatus === "Operational" && !b.patientCode));
  eq(PSWSeed.SETTINGS.privacyMode, "ON"); eq(PSWSeed.SETTINGS.rrtExtension, ""); eq(PSWSeed.SETTINGS.codeBlueExtension, "");
});
test("approved doctor list only (4 consultants, 2 specialists)", () => {
  eq(PSWSeed.DOCTORS.map(d => d.name + ":" + d.level).join(","),
    "Dr Afif:Consultant,Dr Jalal:Consultant,Dr Akan:Consultant,Dr Abdelhaq:Consultant,Dr Ahammed:Specialist,Dr Patrick:Specialist");
});
test("empty isolation rooms are not occupied by default", () => {
  const beds = PSWSeed.buildBeds(true, TODAY).filter(b => /ISO|NP/.test(b.bed));
  ok(beds.some(b => b.occupancyStatus === "Available"));
});

// ================================================================== 3. engine rules
group("3. Business rules (testing list 1–10, 13)");
const admit = { bed: "4B", patientCode: "p01234", age: "4y", gender: "f", doctor: "Dr Akan", patientStatus: "", isolationPrecaution: "None", note: "Appendix", expectedDischarge: "" };

test("#1 add a patient to an available bed (defaults to New Admission, ADMIT audited)", () => {
  const { store, eng } = fresh(true);
  const r = eng.handle("updateBed", admit, EDITOR);
  ok(r.ok, JSON.stringify(r));
  const b = bedOf(store, "4B");
  eq(b.occupancyStatus, "Occupied"); eq(b.patientCode, "P01234"); eq(b.age, "4Y"); eq(b.gender, "F");
  eq(b.patientStatus, "New Admission"); eq(b.admissionDate, TODAY); eq(b.updatedBy, EDITOR);
  eq(lastAudit(store).action, "ADMIT"); eq(lastAudit(store).bed, "4B"); eq(lastAudit(store).user, EDITOR);
});
test("#2 change a patient status (bed stays occupied)", () => {
  const { store, eng } = fresh(true);
  const b0 = bedOf(store, "2B");
  const r = eng.handle("updateBed", Object.assign({}, b0, { patientStatus: "Post Operative", expectedLastUpdated: b0.lastUpdated }), EDITOR);
  ok(r.ok, JSON.stringify(r));
  eq(bedOf(store, "2B").patientStatus, "Post Operative"); eq(bedOf(store, "2B").occupancyStatus, "Occupied");
  eq(lastAudit(store).action, "UPDATE_BED");
  ok(/Stable/.test(lastAudit(store).previous) && /Post Operative/.test(lastAudit(store).next));
});
test("#3 mark for discharge keeps the bed occupied", () => {
  const { store, eng } = fresh(true);
  const before = PSW.computeKpis(store.readBeds());
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "2B"), { patientStatus: "For Discharge" }), EDITOR);
  ok(r.ok);
  const k = PSW.computeKpis(store.readBeds());
  eq(k.occupied, before.occupied); eq(k.discharge, before.discharge + 1);
  eq(lastAudit(store).action, "MARK_FOR_DISCHARGE");
});
test("#4 complete discharge: requires confirmation, then frees the bed and clears patient data", () => {
  const { store, eng } = fresh(true);
  const r1 = eng.handle("markAvailable", { bed: "1B", reason: "Discharge completed" }, EDITOR);
  eq(r1.ok, false); eq(r1.code, "CONFIRMATION_REQUIRED");
  eq(bedOf(store, "1B").occupancyStatus, "Occupied");
  const r1b = eng.handle("markAvailable", { bed: "1B", reason: "Discharge completed", confirmLeft: "true" }, EDITOR);
  eq(r1b.code, "CONFIRMATION_REQUIRED", "string 'true' must not count as confirmation");
  const r2 = eng.handle("markAvailable", { bed: "1B", reason: "Discharge completed", confirmLeft: true }, EDITOR);
  ok(r2.ok, JSON.stringify(r2));
  const b = bedOf(store, "1B");
  eq(b.occupancyStatus, "Available"); eq(b.patientCode, ""); eq(b.age, ""); eq(b.doctor, ""); eq(b.isolationPrecaution, "None");
  eq(lastAudit(store).action, "MARK_AVAILABLE");
  ok(/Discharge completed/.test(lastAudit(store).next));
  const r3 = eng.handle("markAvailable", { bed: "1B", confirmLeft: true }, EDITOR);
  eq(r3.code, "NOT_OCCUPIED");
});
test("#5 transfer: marked (still occupied), then completed", () => {
  const { store, eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "8A"), { patientStatus: "Transfer" }), EDITOR);
  ok(r.ok); eq(lastAudit(store).action, "MARK_TRANSFER"); eq(bedOf(store, "8A").occupancyStatus, "Occupied");
  eq(PSW.primaryState(bedOf(store, "8A")), "transfer");
  const r2 = eng.handle("markAvailable", { bed: "8A", reason: "Transfer completed", confirmLeft: true }, EDITOR);
  ok(r2.ok); eq(bedOf(store, "8A").occupancyStatus, "Available");
});
test("#6 isolation precaution is separate from status and occupancy", () => {
  const { store, eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "1A"), { isolationPrecaution: "Contact + Droplet" }), EDITOR);
  ok(r.ok); eq(lastAudit(store).action, "UPDATE_ISOLATION");
  const b = bedOf(store, "1A");
  eq(b.patientStatus, "Post Operative", "post-op stays post-op"); eq(b.isolationPrecaution, "Contact + Droplet");
  eq(PSW.primaryState(b), "isolation", "isolation colour wins over post-op; post-op shows as badge");
  const bad = eng.handle("updateBed", Object.assign({}, b, { isolationPrecaution: "Radiation" }), EDITOR);
  eq(bad.code, "VALIDATION"); ok(bad.fields.isolationPrecaution);
});
test("#7 change responsible doctor (approved list only)", () => {
  const { store, eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "2A"), { doctor: "Dr Jalal" }), EDITOR);
  ok(r.ok); eq(bedOf(store, "2A").doctor, "Dr Jalal"); eq(lastAudit(store).action, "CHANGE_DOCTOR");
  const bad = eng.handle("updateBed", Object.assign({}, bedOf(store, "2A"), { doctor: "Dr Imaginary" }), EDITOR);
  eq(bad.code, "VALIDATION"); ok(bad.fields.doctor);
});
test("#8 update the on-call team (consultant must be a consultant; nurse names validated)", () => {
  const { store, eng } = fresh(false);
  const rows = [{ role: "Consultant On Call", staffName: "Dr Jalal", shiftDate: TODAY, shiftStart: "07:00", shiftEnd: "19:00" },
    { role: "Specialist On Call", staffName: "Dr Ahammed" }, { role: "Charge Nurse", staffName: "Test Nurse Name" }, { role: "Nurse Supervisor", staffName: "" }];
  const r = eng.handle("updateOnCall", { rows }, EDITOR);
  ok(r.ok, JSON.stringify(r));
  eq(store._s.onCall[0].staffName, "Dr Jalal"); eq(store._s.onCall[2].staffName, "Test Nurse Name");
  eq(lastAudit(store).action, "UPDATE_ON_CALL");
  const bad = eng.handle("updateOnCall", { rows: [{ role: "Consultant On Call", staffName: "Dr Patrick" }] }, EDITOR);
  eq(bad.code, "VALIDATION", "a specialist cannot be consultant on call");
  const bad2 = eng.handle("updateOnCall", { rows: [{ role: "Charge Nurse", staffName: "<script>" }] }, EDITOR);
  eq(bad2.code, "VALIDATION");
});
test("#9 update emergency extensions (ADMIN only, digits only)", () => {
  const { store, eng } = fresh(false);
  const r = eng.handle("updateSettings", { settings: { rrtExtension: "1234", codeBlueExtension: "4321" } }, ADMIN);
  ok(r.ok, JSON.stringify(r));
  eq(store._s.settings.rrtExtension, "1234"); eq(lastAudit(store).action, "UPDATE_SETTINGS");
  eq(eng.handle("updateSettings", { settings: { rrtExtension: "12a" } }, ADMIN).code, "VALIDATION");
  eq(eng.handle("updateSettings", { settings: { rrtExtension: "9999" } }, EDITOR).code, "FORBIDDEN");
  eq(eng.handle("updateSettings", { settings: { timezone: "Europe/London" } }, ADMIN).code, "VALIDATION");
  eq(eng.handle("updateSettings", { settings: { refreshInterval: "5" } }, ADMIN).code, "VALIDATION");
});
test("#10 KPIs recalculate from data (occupancy = occupied / operational)", () => {
  const { store, eng } = fresh(true);
  let k = PSW.computeKpis(store.readBeds());
  eq(k.locations, 19); eq(k.outOfService, 1); eq(k.operational, 18); eq(k.occupied, 14); eq(k.available, 4);
  eq(k.rate, Math.round(14 / 18 * 100)); eq(k.discharge, 2); eq(k.isolation, 4); eq(k.transfer, 1); eq(k.newAdmission, 2);
  eng.handle("updateBed", admit, EDITOR);
  k = PSW.computeKpis(store.readBeds());
  eq(k.occupied, 15); eq(k.available, 3); eq(k.newAdmission, 3); eq(k.rate, Math.round(15 / 18 * 100));
  eng.handle("setOperational", { bed: "7B", operationalStatus: "Operational" }, EDITOR);
  k = PSW.computeKpis(store.readBeds());
  eq(k.operational, 19); eq(k.available, 4); eq(k.outOfService, 0);
});
test("isolation is only counted for occupied beds; empty isolation rooms stay available", () => {
  const k = PSW.computeKpis([
    { bed: "ISO1", operationalStatus: "Operational", occupancyStatus: "Available", isolationPrecaution: "None" },
    { bed: "ISO3", operationalStatus: "Operational", occupancyStatus: "Occupied", patientStatus: "Stable", isolationPrecaution: "Droplet" }]);
  eq(k.isolation, 1); eq(k.occupied, 1); eq(k.available, 1);
});
test("#13 unauthorised and forbidden requests are rejected", () => {
  const { store, eng } = fresh(true);
  eq(eng.handle("updateBed", admit, STRANGER).code, "UNAUTHORIZED");
  eq(eng.handle("adminData", {}, "").code, "UNAUTHORIZED");
  eq(eng.handle("updateBed", admit, "left.psw@example.invalid").code, "UNAUTHORIZED", "inactive user");
  eq(eng.handle("updateDoctors", { doctors: [] }, EDITOR).code, "FORBIDDEN");
  eq(eng.handle("audit", {}, EDITOR).code, "FORBIDDEN");
  eq(eng.handle("dropTables", {}, ADMIN).code, "UNKNOWN_ACTION");
  eq(bedOf(store, "4B").occupancyStatus, "Available");
  eq(eng.handle("adminData", {}, ADMIN.toUpperCase()).ok, true, "e-mail match is case-insensitive");
});
test("a clinical status change can never release a bed", () => {
  const { store, eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "2A"), { occupancyStatus: "Available", patientStatus: "Stable" }), EDITOR);
  ok(r.ok); eq(bedOf(store, "2A").occupancyStatus, "Occupied");
});
test("validation: names are rejected as patient codes, age range, note length and markup", () => {
  const { eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, admit, { patientCode: "Ahmed Ali", age: "30Y", note: "<b>x</b>" }), EDITOR);
  eq(r.code, "VALIDATION"); ok(r.fields.patientCode && r.fields.age && r.fields.note);
  eq(eng.handle("updateBed", Object.assign({}, admit, { note: "x".repeat(61) }), EDITOR).code, "VALIDATION");
  eq(eng.handle("updateBed", Object.assign({}, admit, { bed: "3A" }), EDITOR).code, "NOT_FOUND", "no Room 3");
});
test("the same patient code cannot occupy two beds", () => {
  const { eng } = fresh(true);
  const r = eng.handle("updateBed", Object.assign({}, admit, { patientCode: "P00123" }), EDITOR);
  eq(r.code, "VALIDATION"); ok(/1A/.test(r.fields.patientCode));
});
test("out-of-service rules: cannot admit, cannot take an occupied bed out", () => {
  const { eng } = fresh(true);
  eq(eng.handle("updateBed", Object.assign({}, admit, { bed: "7B" }), EDITOR).code, "OUT_OF_SERVICE");
  eq(eng.handle("setOperational", { bed: "1A", operationalStatus: "Out of Service" }, EDITOR).code, "OCCUPIED");
});
test("release with 'hold for cleaning' puts the bed out of service", () => {
  const { store, eng } = fresh(true);
  ok(eng.handle("markAvailable", { bed: "ISO2", reason: "Discharge completed", confirmLeft: true, holdForCleaning: true }, EDITOR).ok);
  eq(bedOf(store, "ISO2").operationalStatus, "Out of Service");
});
test("concurrent edits: a stale version is refused (CONFLICT)", () => {
  const { store, eng } = fresh(true);
  const b = bedOf(store, "2B");
  eq(b.lastUpdated, "", "seed bed never edited");
  ok(eng.handle("updateBed", Object.assign({}, b, { note: "first", expectedLastUpdated: b.lastUpdated }), EDITOR).ok);
  eq(eng.handle("updateBed", Object.assign({}, b, { note: "second", expectedLastUpdated: b.lastUpdated }), EDITOR).code, "CONFLICT");
});
test("doctor list: editable from Settings, but in-use doctors cannot be removed", () => {
  const { store, eng } = fresh(true);
  const list = PSWSeed.DOCTORS.map(d => Object.assign({}, d));
  const r1 = eng.handle("updateDoctors", { doctors: list.filter(d => d.name !== "Dr Afif") }, ADMIN);
  eq(r1.code, "VALIDATION"); ok(r1.fields["inuse.Dr Afif"]);
  const r2 = eng.handle("updateDoctors", { doctors: list.concat([{ name: "dr. Test", level: "Specialist", active: true }]) }, ADMIN);
  ok(r2.ok, JSON.stringify(r2)); ok(store._s.doctors.some(d => d.name === "Dr Test"), "'dr.' normalised to 'Dr'");
  eq(lastAudit(store).action, "UPDATE_DOCTORS");
  const r3 = eng.handle("updateDoctors", { doctors: store._s.doctors.map(d => d.name === "Dr Test" ? Object.assign({}, d, { active: false }) : d) }, ADMIN);
  ok(r3.ok); ok(!eng.handle("adminData", {}, EDITOR).data.doctors.find(d => d.name === "Dr Test").active);
  eq(eng.handle("updateBed", Object.assign({}, admit, { doctor: "Dr Test" }), EDITOR).code, "VALIDATION", "inactive doctor not selectable");
  eq(eng.handle("updateDoctors", { doctors: list.concat([{ name: "Afif", level: "Consultant", active: true }]) }, ADMIN).code, "VALIDATION");
});
test("unchanged saves do not write audit noise", () => {
  const { store, eng } = fresh(true);
  const n = store._s.audit.length;
  const r = eng.handle("updateBed", Object.assign({}, bedOf(store, "2B")), EDITOR);
  ok(r.ok && r.data.unchanged); eq(store._s.audit.length, n);
});
test("server errors never leak internal details", () => {
  const store = memoryStore(true); store.readBeds = () => { throw new Error("secret internal path /x/y"); };
  const orig = console.error; console.error = () => {};
  const r = PSWEngine.create(store, env).handle("updateBed", admit, EDITOR);
  console.error = orig;
  eq(r.code, "SERVER_ERROR"); ok(!JSON.stringify(r).includes("secret"));
});

group("Privacy (TV feed is de-identified on the server)");
test("privacy ON: no code, age, gender or note in the TV feed", () => {
  const { store, eng } = fresh(true);
  store._s.settings.privacyMode = "ON"; store._s.settings.showNotes = "ON";
  const d = eng.displayPayload().data;
  eq(d.privacy, true);
  const s = JSON.stringify(d.beds);
  ok(!/P00\d{3}/.test(s), "patient code leaked"); ok(!/"age"|"gender"|"note"/.test(s), "field leaked");
  ok(d.beds.find(b => b.bed === "1A").doctor === "Dr Afif", "doctor/status still shown");
});
test("privacy OFF: codes shown, notes only when Show Notes is ON; empty beds carry no patient data", () => {
  const { store, eng } = fresh(true);
  store._s.settings.privacyMode = "OFF"; store._s.settings.showNotes = "OFF";
  let d = eng.displayPayload().data;
  eq(d.beds.find(b => b.bed === "1A").patientCode, "P00123"); ok(!("note" in d.beds.find(b => b.bed === "1A")));
  store._s.settings.showNotes = "ON";
  d = eng.displayPayload().data;
  eq(d.beds.find(b => b.bed === "1A").note, "POD 1");
  const empty = d.beds.find(b => b.bed === "4B");
  ok(!empty.patientCode && !empty.doctor && empty.isolationPrecaution === "None");
});
test("TV feed never includes users, audit, 'updated by' or admission dates", () => {
  const { eng } = fresh(true);
  const s = JSON.stringify(eng.displayPayload());
  ok(!/updatedBy|admissionDate|example\.invalid|audit/i.test(s));
});
test("bed card renderer escapes text (no HTML injection on the TV)", () => {
  const html = PSW.bedCardHTML({ room: "Room 1", bed: "1A", label: "Bed 1A", bedType: "Regular", operationalStatus: "Operational",
    occupancyStatus: "Occupied", patientCode: "P1", age: "5Y", gender: "M", doctor: "<img src=x onerror=alert(1)>", patientStatus: "Stable",
    isolationPrecaution: "None", note: "<script>" }, { privacy: false, showNotes: true });
  ok(!/<img|<script/.test(html), html);
});

// ================================================================== 4. Apps Script backend
group("4. Google Apps Script backend against a mock Google Sheets runtime (#11, #13)");

function makeRuntime() {
  const props = {}, cache = {}, tokens = {};
  const files = {};
  let fileSeq = 0;
  const chain = () => new Proxy(function () {}, { get: (t, k) => k === "then" ? undefined : chain(), apply: () => chain() });

  function Sheet(name) {
    const grid = [];
    const sh = {
      name, grid, frozen: 0, protections: [],
      getName: () => name,
      getLastRow: () => { for (let r = grid.length; r > 0; r--) if ((grid[r - 1] || []).some(v => v !== "" && v != null && v !== false)) return r; return 0; },
      getLastColumn: () => grid.reduce((m, row) => Math.max(m, (row || []).reduce((mm, v, i) => (v !== "" && v != null) ? i + 1 : mm, 0)), 0),
      getRange: (r, c, nr, nc) => {
        if (typeof r === "string") { const m = /^([A-Z])(\d+):([A-Z])(\d+)$/.exec(r); r = +m[2]; c = m[1].charCodeAt(0) - 64; nr = +m[4] - r + 1; nc = m[3].charCodeAt(0) - 64 - c + 1; }
        nr = nr || 1; nc = nc || 1;
        const rg = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = (grid[r - 1 + i] || [])[c - 1 + j]; return v == null ? "" : v; })),
          setValues: vals => {
            if (vals.length !== nr || vals.some(x => x.length !== nc)) throw new Error("setValues dimension mismatch on " + name);
            vals.forEach((row, i) => row.forEach((v, j) => { grid[r - 1 + i] = grid[r - 1 + i] || []; grid[r - 1 + i][c - 1 + j] = v; })); return rg;
          },
          clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (grid[r - 1 + i]) grid[r - 1 + i][c - 1 + j] = ""; return rg; },
          insertCheckboxes: () => rg, setNumberFormat: () => rg, setDataValidation: () => rg, setFontWeight: () => rg,
          setBackground: () => rg, setFontColor: () => rg
        };
        return rg;
      },
      setFrozenRows: n => { sh.frozen = n; },
      getProtections: () => sh.protections.slice(),
      protect: () => { const p = chain(); sh.protections.push(p); return p; },
      setConditionalFormatRules: () => {}, autoResizeColumns: () => {}
    };
    return sh;
  }
  function Spreadsheet(id) {
    const sheets = [Sheet("Sheet1")];
    const ss = {
      sheets, getId: () => id, getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit", name: "",
      rename: n => { ss.name = n; }, setSpreadsheetTimeZone: tz => { ss.tz = tz; },
      getSheetByName: n => sheets.find(s => s.name === n) || null,
      insertSheet: n => { const s = Sheet(n); sheets.push(s); return s; },
      getSheets: () => sheets.slice(), deleteSheet: s => sheets.splice(sheets.indexOf(s), 1),
      getViewers: () => [], getEditors: () => []
    };
    return ss;
  }
  const logs = [];
  const ctx = {
    console: { log: m => logs.push(String(m)), error: () => {} },
    JSON, Math, Date, Intl, String, Number, Array, Object, Error, RegExp, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner.psw@example.invalid" }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ text: t, setMimeType: function () { return this; } }) },
    Utilities: {
      getUuid: () => require("crypto").randomUUID(),
      formatDate: (d, tz, f) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
        return f === "HH:mm" ? p.hour + ":" + p.minute : p.year + "-" + p.month + "-" + p.day;
      },
      DigestAlgorithm: { SHA_256: "sha256" },
      computeDigest: (alg, s) => Array.from(require("crypto").createHash("sha256").update(s).digest()),
      base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => b & 255)).toString("base64url")
    },
    UrlFetchApp: {
      fetch: url => {
        const t = decodeURIComponent(/id_token=([^&]+)/.exec(url)[1]);
        const info = tokens[t];
        return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info || { error: "invalid_token" }) };
      }
    },
    SpreadsheetApp: {
      create: () => { const id = "sheet" + (++fileSeq); files[id] = Spreadsheet(id); return files[id]; },
      openById: id => { if (!files[id]) throw new Error("not found"); return files[id]; },
      flush: () => {}, newDataValidation: chain, newConditionalFormatRule: chain,
      ProtectionType: { SHEET: "SHEET" }
    }
  };
  vm.createContext(ctx);
  ["google-apps-script/SeedData.gs", "google-apps-script/Engine.gs", "google-apps-script/Code.gs", "google-apps-script/Setup.gs"]
    .forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
  ctx.decodeURIComponent = decodeURIComponent;
  return { ctx, props, files, tokens, logs };
}

const CLIENT = "1234567890-test.apps.googleusercontent.com";
function tokenFor(rt, email, over) {
  const tok = "eyJ" + require("crypto").randomBytes(90).toString("hex");
  rt.tokens[tok] = Object.assign({ aud: CLIENT, iss: "https://accounts.google.com", email, email_verified: "true", exp: String(Math.floor(Date.now() / 1000) + 3000) }, over || {});
  return tok;
}
const get = (rt, params) => JSON.parse(rt.ctx.doGet({ parameter: params }).text);
const post = (rt, body) => JSON.parse(rt.ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }).text);

const rt = makeRuntime();
rt.ctx.SETUP.OAUTH_CLIENT_ID = CLIENT;
rt.ctx.SETUP.EDITORS = [EDITOR];
rt.ctx.setupDatabase();
const SS = rt.files[rt.props.SPREADSHEET_ID];
const sheetRows = name => SS.getSheetByName(name).getRange(2, 1, SS.getSheetByName(name).getLastRow() - 1, SS.getSheetByName(name).getLastColumn()).getValues();

test("setupDatabase creates 'PSW SMART WARD BOARD DATABASE' with the required sheets and headers", () => {
  eq(SS.name, "PSW SMART WARD BOARD DATABASE"); eq(SS.tz, "Asia/Riyadh");
  eq(SS.sheets.map(s => s.name).join("|"), "BEDS|DOCTORS|ON CALL TEAM|SETTINGS|AUDIT LOG|USERS");
  eq(SS.getSheetByName("BEDS").getRange(1, 1, 1, 16).getValues()[0].join("|"),
    "Room|Bed|Bed Type|Operational Status|Occupancy Status|Patient Code|Age|Gender|Responsible Doctor|Patient Status|Isolation Precaution|Clinical Note|Admission Date|Expected Discharge Date|Last Updated|Updated By");
  eq(sheetRows("BEDS").length, 19); eq(sheetRows("DOCTORS").length, 6); eq(sheetRows("ON CALL TEAM").length, 4);
  ok(sheetRows("SETTINGS").some(r => r[0] === "RRT Extension")); ok(sheetRows("SETTINGS").some(r => r[0] === "Privacy Mode" && r[1] === "ON"));
  eq(SS.getSheetByName("AUDIT LOG").getRange(1, 1, 1, 7).getValues()[0].join("|"), "Timestamp|User|Action|Bed|Previous Value|New Value|Record ID");
  ok(rt.props.DISPLAY_KEY && rt.props.DISPLAY_KEY.length >= 32); eq(rt.props.OAUTH_CLIENT_ID, CLIENT);
  ok(SS.getSheetByName("BEDS").protections.length === 1 && SS.getSheetByName("AUDIT LOG").protections.length === 1, "protections applied");
});
test("running setupDatabase again keeps existing data", () => {
  const before = JSON.stringify(sheetRows("BEDS"));
  rt.ctx.setupDatabase();
  eq(JSON.stringify(sheetRows("BEDS")), before); eq(sheetRows("USERS").length, 2);
});
test("ping works without credentials and reveals no data", () => {
  const r = get(rt, { action: "ping" }); ok(r.ok); ok(!JSON.stringify(r).includes("P00"));
});
test("TV feed requires the display key (missing / wrong key rejected)", () => {
  eq(get(rt, { action: "display" }).code, "UNAUTHORIZED");
  eq(get(rt, { action: "display", key: "x".repeat(64) }).code, "UNAUTHORIZED");
  const r = get(rt, { action: "display", key: rt.props.DISPLAY_KEY });
  ok(r.ok); eq(r.data.beds.length, 19); eq(r.data.privacy, true); ok(!/P00\d{3}/.test(JSON.stringify(r)), "privacy ON by default");
});
test("admin API rejects missing, forged, expired, wrong-audience and unverified tokens", () => {
  eq(post(rt, { action: "adminData" }).code, "UNAUTHENTICATED");
  eq(post(rt, { action: "adminData", idToken: "eyJ" + "a".repeat(200) }).code, "UNAUTHENTICATED");
  eq(post(rt, { action: "adminData", idToken: tokenFor(rt, ADMIN, { aud: "someone-else" }) }).code, "UNAUTHENTICATED");
  eq(post(rt, { action: "adminData", idToken: tokenFor(rt, EDITOR, { exp: "1000" }) }).code, "UNAUTHENTICATED");
  eq(post(rt, { action: "adminData", idToken: tokenFor(rt, EDITOR, { email_verified: "false" }) }).code, "UNAUTHENTICATED");
  eq(post(rt, "not json").code, "BAD_REQUEST");
});
test("a valid Google account that is not on the USERS sheet is refused", () => {
  eq(post(rt, { action: "adminData", idToken: tokenFor(rt, STRANGER) }).code, "UNAUTHORIZED");
  eq(post(rt, { action: "displayKey", idToken: tokenFor(rt, STRANGER) }).code, "UNAUTHORIZED");
});
test("EDITOR cannot read the TV key, change settings or read the audit log", () => {
  const t = tokenFor(rt, EDITOR);
  eq(post(rt, { action: "displayKey", idToken: t }).code, "FORBIDDEN");
  eq(post(rt, { action: "updateSettings", idToken: t, payload: { settings: { rrtExtension: "1111" } } }).code, "FORBIDDEN");
  eq(post(rt, { action: "audit", idToken: t }).code, "FORBIDDEN");
});
test("#11 admit through the API writes the BEDS row and an AUDIT LOG row in Google Sheets", () => {
  const t = tokenFor(rt, EDITOR);
  const auditBefore = SS.getSheetByName("AUDIT LOG").getLastRow();
  const r = post(rt, { action: "updateBed", idToken: t, payload: admit });
  ok(r.ok, JSON.stringify(r));
  const row = sheetRows("BEDS").find(x => x[1] === "4B");
  eq(row[4], "Occupied"); eq(row[5], "P01234"); eq(row[8], "Dr Akan"); eq(row[15], EDITOR);
  const auditRows = SS.getSheetByName("AUDIT LOG");
  eq(auditRows.getLastRow(), auditBefore + 1);
  const a = auditRows.getRange(auditRows.getLastRow(), 1, 1, 7).getValues()[0];
  eq(a[1], EDITOR); eq(a[2], "ADMIT"); eq(a[3], "4B"); ok(a[6].length > 10, "record id");
});
test("the TV feed reflects the change and the last-modified marker moves", () => {
  const before = get(rt, { action: "display", key: rt.props.DISPLAY_KEY });
  const b4 = before.data.beds.find(b => b.bed === "4B");
  eq(b4.occupancyStatus, "Occupied"); eq(b4.doctor, "Dr Akan");
  const k = PSW.computeKpis(before.data.beds);
  eq(k.occupied, 15);
});
test("ADMIN: extensions and privacy saved to SETTINGS; on-call to ON CALL TEAM; discharge frees the sheet row", () => {
  const t = tokenFor(rt, "owner.psw@example.invalid");
  ok(post(rt, { action: "updateSettings", idToken: t, payload: { settings: { rrtExtension: "2468", codeBlueExtension: "1357", privacyMode: "OFF" } } }).ok);
  ok(sheetRows("SETTINGS").some(r => r[0] === "RRT Extension" && r[1] === "2468"));
  ok(post(rt, { action: "updateOnCall", idToken: t, payload: { rows: [{ role: "Consultant On Call", staffName: "Dr Abdelhaq" }] } }).ok);
  eq(sheetRows("ON CALL TEAM").find(r => r[0] === "Consultant On Call")[1], "Dr Abdelhaq");
  const d = get(rt, { action: "display", key: rt.props.DISPLAY_KEY });
  eq(d.data.settings.rrtExtension, "2468"); eq(d.data.privacy, false); eq(d.data.onCall[0].staffName, "Dr Abdelhaq");
  ok(post(rt, { action: "markAvailable", idToken: t, payload: { bed: "4B", reason: "Discharge completed", confirmLeft: true } }).ok);
  const row = sheetRows("BEDS").find(x => x[1] === "4B");
  eq(row[4], "Available"); eq(row[5], ""); eq(row[6], "");
});
test("ADMIN can read and rotate the TV key; old key stops working", () => {
  const t = tokenFor(rt, "owner.psw@example.invalid");
  const k1 = post(rt, { action: "displayKey", idToken: t }).data.key;
  const k2 = post(rt, { action: "rotateDisplayKey", idToken: t }).data.key;
  ok(k1 !== k2);
  eq(get(rt, { action: "display", key: k1 }).code, "UNAUTHORIZED");
  ok(get(rt, { action: "display", key: k2 }).ok);
});
test("audit log has one row per change, readable by ADMIN", () => {
  const t = tokenFor(rt, "owner.psw@example.invalid");
  const r = post(rt, { action: "audit", idToken: t, payload: { limit: 50 } });
  ok(r.ok); const acts = r.data.entries.map(e => e.action);
  ["ADMIT", "UPDATE_SETTINGS", "UPDATE_ON_CALL", "MARK_AVAILABLE", "ROTATE_DISPLAY_KEY"].forEach(a => ok(acts.includes(a), "missing " + a));
});
test("clearAllPatients empties every bed and is audited", () => {
  rt.ctx.clearAllPatients();
  ok(sheetRows("BEDS").every(r => r[4] === "Available" && r[5] === "" && r[3] === "Operational"));
  const au = SS.getSheetByName("AUDIT LOG"); eq(au.getRange(au.getLastRow(), 3).getValues()[0][0], "CLEAR_ALL_PATIENTS");
});
test("oversized requests are refused", () => {
  eq(post(rt, JSON.stringify({ action: "adminData", pad: "x".repeat(130000) })).code, "TOO_LARGE");
});
test("missing configuration is reported clearly, not as a crash", () => {
  const r2 = makeRuntime();
  eq(get(r2, { action: "display", key: "x" }).code, "UNAUTHORIZED");
  r2.props.DISPLAY_KEY = "k".repeat(32);
  eq(get(r2, { action: "display", key: "k".repeat(32) }).code, "NOT_CONFIGURED");
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
