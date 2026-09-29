/*
 * PSW Smart Ward Board — business engine.
 *
 * This single file holds every rule of the ward board: validation, authorisation,
 * bed-state transitions, audit records and TV de-identification.
 * It runs unchanged in two places:
 *   - Google Apps Script (google-apps-script/Engine.gs)  — the real backend
 *   - the browser demo    (js/engine.js, an identical copy) — fictional data only
 * The storage layer is injected, so the same rules apply to Google Sheets and to the demo.
 *
 * Keep both copies identical: run `node tests/run-tests.js` (it checks this).
 */
var PSWEngine = (function () {
  "use strict";

  var ENUMS = {
    BED_TYPE: ["Regular", "Close Observation", "Isolation", "Negative Pressure"],
    OPERATIONAL: ["Operational", "Out of Service"],
    OCCUPANCY: ["Occupied", "Available"],
    GENDER: ["M", "F"],
    PATIENT_STATUS: ["Stable", "Post Operative", "For Discharge", "Transfer", "New Admission"],
    ISOLATION: ["None", "Contact", "Droplet", "Airborne", "Contact + Droplet", "Contact + Airborne", "Protective"],
    DOCTOR_LEVEL: ["Consultant", "Specialist"],
    ONCALL_ROLES: ["Consultant On Call", "Specialist On Call", "Charge Nurse", "Nurse Supervisor"],
    ROLES: ["ADMIN", "EDITOR"]
  };

  // Settings sheet names  <->  API keys
  var SETTINGS = [
    ["Hospital Name", "hospitalName", "text"],
    ["Hospital Name (Arabic)", "hospitalNameAr", "text"],
    ["Health Cluster", "cluster", "text"],
    ["Department Name", "departmentName", "text"],
    ["Department Name (Arabic)", "departmentNameAr", "text"],
    ["Department Code", "departmentCode", "code"],
    ["Tagline", "tagline", "text"],
    ["Hospital Logo", "logo", "logo"],
    ["RRT Extension", "rrtExtension", "ext"],
    ["Code Blue Extension", "codeBlueExtension", "ext"],
    ["Refresh Interval", "refreshInterval", "interval"],
    ["Privacy Mode", "privacyMode", "onoff"],
    ["Show Notes on TV", "showNotes", "onoff"],
    ["Dashboard Language", "language", "lang"],
    ["Timezone", "timezone", "tz"]
  ];

  var RE = {
    patientCode: /^[A-Z0-9][A-Z0-9-]{1,11}$/,
    age: /^([0-9]{1,2})\s?(D|W|M|Y)$/,
    date: /^\d{4}-\d{2}-\d{2}$/,
    time: /^([01]\d|2[0-3]):[0-5]\d$/,
    ext: /^[0-9]{2,8}$/,
    personName: /^[\p{L}][\p{L} .'\-]{1,39}$/u,
    doctorName: /^Dr [\p{L}][\p{L} .'\-]{1,38}$/u,
    code: /^[A-Z0-9-]{1,12}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  };
  var NOTE_MAX = 60;
  var TEXT_MAX = 80;
  var LOGO_MAX = 45000;   // a Google Sheets cell holds 50,000 characters

  var ACTION_ROLE = {
    whoami: "EDITOR", adminData: "EDITOR",
    updateBed: "EDITOR", markAvailable: "EDITOR", setOperational: "EDITOR", updateOnCall: "EDITOR",
    updateSettings: "ADMIN", updateDoctors: "ADMIN", audit: "ADMIN"
  };
  var ROLE_RANK = { EDITOR: 1, ADMIN: 2 };

  function PSWError(code, message, fields) { this.code = code; this.message = message; this.fields = fields || null; }

  function str(v) { return v == null ? "" : String(v).trim(); }
  function inList(v, list) { return list.indexOf(v) >= 0; }
  function isOccupied(b) { return b.operationalStatus !== "Out of Service" && b.occupancyStatus === "Occupied"; }
  function labelFor(b) {
    if (b.bedType === "Regular") return "Bed " + b.bed;
    if (b.bedType === "Negative Pressure") return "Neg. Pressure";
    return b.bed;
  }
  function pick(obj, keys) { var o = {}; keys.forEach(function (k) { o[k] = obj[k] == null ? "" : obj[k]; }); return o; }
  var PATIENT_KEYS = ["occupancyStatus", "patientCode", "age", "gender", "doctor", "patientStatus",
    "isolationPrecaution", "note", "admissionDate", "expectedDischarge"];

  function diff(before, after, keys) {
    var p = {}, n = {}, changed = false;
    keys.forEach(function (k) {
      if (str(before[k]) !== str(after[k])) { p[k] = before[k] == null ? "" : before[k]; n[k] = after[k] == null ? "" : after[k]; changed = true; }
    });
    return changed ? { previous: p, next: n } : null;
  }

  /**
   * @param store  { readBeds, writeBeds(beds[]), readDoctors, writeDoctors, readOnCall, writeOnCall,
   *                 readSettings, writeSettings, appendAudit(entries[]), readAudit(limit), readUsers,
   *                 getMeta(key), setMeta(key,val) }
   * @param env    { now(): Date, uuid(): string, today(): "yyyy-mm-dd" }
   */
  function create(store, env) {

    function audit(user, action, bed, change) {
      store.appendAudit([{
        timestamp: env.now().toISOString(),
        user: user.email,
        action: action,
        bed: bed || "",
        previous: change ? JSON.stringify(change.previous) : "",
        next: change ? JSON.stringify(change.next) : "",
        recordId: env.uuid()
      }]);
      store.setMeta("lastModified", env.now().toISOString());
    }

    function findBed(beds, id) {
      id = str(id);
      for (var i = 0; i < beds.length; i++) if (beds[i].bed === id) return beds[i];
      throw new PSWError("NOT_FOUND", "Bed " + id + " is not part of the PSW layout.");
    }

    // Optimistic concurrency: the Admin page sends the "Last Updated" value it was showing
    // (empty for a bed never edited). Any difference means someone else saved in between.
    function checkVersion(bed, expected) {
      if (expected !== undefined && expected !== null && str(bed.lastUpdated) !== str(expected)) {
        throw new PSWError("CONFLICT", labelFor(bed) + " was changed by someone else a moment ago. Reload the bed and try again.");
      }
    }

    function activeDoctors() { return store.readDoctors().filter(function (d) { return d.active; }); }

    // ------------------------------------------------------------ authorisation
    function authorize(email) {
      email = str(email).toLowerCase();
      if (!email) return null;
      var users = store.readUsers();
      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        if (str(u.email).toLowerCase() === email && u.active && inList(u.role, ENUMS.ROLES)) {
          return { email: email, role: u.role, name: u.name || "" };
        }
      }
      return null;
    }

    function requireRole(user, action) {
      var needed = ACTION_ROLE[action];
      if (!needed) throw new PSWError("UNKNOWN_ACTION", "Unknown action: " + action);
      if (!user) throw new PSWError("UNAUTHORIZED", "Your account is not on the PSW authorised staff list.");
      if ((ROLE_RANK[user.role] || 0) < ROLE_RANK[needed]) {
        throw new PSWError("FORBIDDEN", "This change needs the " + needed + " role. Ask the PSW board administrator.");
      }
    }

    // ------------------------------------------------------------ validation
    function validateBedPayload(p, current, isAdmit) {
      var e = {};
      var c = {
        patientCode: str(p.patientCode).toUpperCase(),
        age: str(p.age).toUpperCase().replace(/\s+/g, ""),
        gender: str(p.gender).toUpperCase(),
        doctor: str(p.doctor),
        patientStatus: str(p.patientStatus) || (isAdmit ? "New Admission" : current.patientStatus || "Stable"),
        isolationPrecaution: str(p.isolationPrecaution) || "None",
        note: str(p.note),
        expectedDischarge: str(p.expectedDischarge)
      };
      if (!RE.patientCode.test(c.patientCode)) e.patientCode = "Use a patient code or masked MRN: 2–12 letters/digits, e.g. P00123. Never a name.";
      if (!RE.age.test(c.age)) e.age = "Use a number and unit: 12D, 3W, 7M or 5Y.";
      else {
        var m = RE.age.exec(c.age), n = +m[1], u = m[2];
        var max = { D: 31, W: 8, M: 24, Y: 18 }[u];
        if (n < 0 || n > max) e.age = "Age " + c.age + " is outside the paediatric range.";
      }
      if (!inList(c.gender, ENUMS.GENDER)) e.gender = "Choose M or F.";
      var names = activeDoctors().map(function (d) { return d.name; });
      if (!inList(c.doctor, names)) e.doctor = "Choose an active doctor from the approved PSW list.";
      if (!inList(c.patientStatus, ENUMS.PATIENT_STATUS)) e.patientStatus = "Choose a listed patient status.";
      if (!inList(c.isolationPrecaution, ENUMS.ISOLATION)) e.isolationPrecaution = "Choose a listed isolation precaution.";
      if (c.note.length > NOTE_MAX) e.note = "Keep the note under " + NOTE_MAX + " characters.";
      if (/[<>]/.test(c.note)) e.note = "Remove < and > from the note.";
      if (c.expectedDischarge && !RE.date.test(c.expectedDischarge)) e.expectedDischarge = "Use a valid date.";
      if (Object.keys(e).length) throw new PSWError("VALIDATION", "Check the highlighted fields.", e);
      return c;
    }

    // ------------------------------------------------------------ actions
    var A = {};

    A.whoami = function (p, user) { return { user: user }; };

    A.adminData = function (p, user) {
      var beds = store.readBeds().map(function (b) { var o = pick(b, Object.keys(b)); o.label = labelFor(b); return o; });
      return {
        user: user,
        beds: beds,
        doctors: store.readDoctors(),
        onCall: store.readOnCall(),
        settings: store.readSettings(),
        enums: ENUMS,
        lastModified: store.getMeta("lastModified") || "",
        serverTime: env.now().toISOString()
      };
    };

    // Admit a patient to an available bed, or update the patient in an occupied bed.
    // Never makes a bed available — only markAvailable can do that.
    A.updateBed = function (p, user) {
      var beds = store.readBeds();
      var bed = findBed(beds, p.bed);
      if (bed.operationalStatus === "Out of Service") throw new PSWError("OUT_OF_SERVICE", labelFor(bed) + " is out of service. Return it to service first.");
      checkVersion(bed, p.expectedLastUpdated);
      var isAdmit = bed.occupancyStatus !== "Occupied";
      var c = validateBedPayload(p, bed, isAdmit);
      for (var i = 0; i < beds.length; i++) {
        var o = beds[i];
        if (o !== bed && isOccupied(o) && str(o.patientCode) === c.patientCode) {
          throw new PSWError("VALIDATION", "Patient code " + c.patientCode + " is already in " + labelFor(o) + ". Transfer or discharge it there first.", { patientCode: "Already assigned to " + labelFor(o) + "." });
        }
      }
      var before = pick(bed, PATIENT_KEYS);
      var after = {
        occupancyStatus: "Occupied",
        patientCode: c.patientCode, age: c.age, gender: c.gender, doctor: c.doctor,
        patientStatus: c.patientStatus, isolationPrecaution: c.isolationPrecaution, note: c.note,
        admissionDate: isAdmit ? env.today() : (bed.admissionDate || env.today()),
        expectedDischarge: c.expectedDischarge
      };
      var change = diff(before, after, PATIENT_KEYS);
      if (!change) return { bed: bed, unchanged: true };
      Object.keys(after).forEach(function (k) { bed[k] = after[k]; });
      bed.lastUpdated = env.now().toISOString();
      bed.updatedBy = user.email;
      store.writeBeds([bed]);
      var action = isAdmit ? "ADMIT" :
        (change.next.patientStatus === "For Discharge" ? "MARK_FOR_DISCHARGE" :
          change.next.patientStatus === "Transfer" ? "MARK_TRANSFER" :
            ("isolationPrecaution" in change.next) ? "UPDATE_ISOLATION" :
              ("doctor" in change.next) ? "CHANGE_DOCTOR" : "UPDATE_BED");
      audit(user, action, bed.bed, change);
      return { bed: bed, action: action };
    };

    // Patient has physically left the bed (discharge completed / transfer completed).
    A.markAvailable = function (p, user) {
      var beds = store.readBeds();
      var bed = findBed(beds, p.bed);
      if (bed.occupancyStatus !== "Occupied") throw new PSWError("NOT_OCCUPIED", labelFor(bed) + " is already available.");
      if (p.confirmLeft !== true) throw new PSWError("CONFIRMATION_REQUIRED", "Confirm that the patient has physically left " + labelFor(bed) + ".");
      checkVersion(bed, p.expectedLastUpdated);
      var reason = str(p.reason) || "Discharge completed";
      if (!inList(reason, ["Discharge completed", "Transfer completed", "Other"])) throw new PSWError("VALIDATION", "Choose why the bed is being released.");
      var before = pick(bed, PATIENT_KEYS.concat(["operationalStatus"]));
      bed.occupancyStatus = "Available";
      ["patientCode", "age", "gender", "doctor", "patientStatus", "note", "admissionDate", "expectedDischarge"].forEach(function (k) { bed[k] = ""; });
      bed.isolationPrecaution = "None";
      if (p.holdForCleaning === true) bed.operationalStatus = "Out of Service";
      bed.lastUpdated = env.now().toISOString();
      bed.updatedBy = user.email;
      store.writeBeds([bed]);
      var change = diff(before, pick(bed, PATIENT_KEYS.concat(["operationalStatus"])), PATIENT_KEYS.concat(["operationalStatus"]));
      change.next.reason = reason;
      audit(user, "MARK_AVAILABLE", bed.bed, change);
      return { bed: bed };
    };

    A.setOperational = function (p, user) {
      var beds = store.readBeds();
      var bed = findBed(beds, p.bed);
      var status = str(p.operationalStatus);
      if (!inList(status, ENUMS.OPERATIONAL)) throw new PSWError("VALIDATION", "Choose Operational or Out of Service.");
      if (status === "Out of Service" && bed.occupancyStatus === "Occupied") throw new PSWError("OCCUPIED", labelFor(bed) + " has a patient. Release the bed before taking it out of service.");
      if (bed.operationalStatus === status) return { bed: bed, unchanged: true };
      var change = { previous: { operationalStatus: bed.operationalStatus }, next: { operationalStatus: status } };
      bed.operationalStatus = status;
      bed.lastUpdated = env.now().toISOString();
      bed.updatedBy = user.email;
      store.writeBeds([bed]);
      audit(user, status === "Out of Service" ? "BED_OUT_OF_SERVICE" : "BED_RETURN_TO_SERVICE", bed.bed, change);
      return { bed: bed };
    };

    A.updateOnCall = function (p, user) {
      var rows = Array.isArray(p.rows) ? p.rows : [];
      var current = store.readOnCall();
      var doctors = activeDoctors();
      var e = {};
      var byRole = {};
      rows.forEach(function (r) { byRole[str(r.role)] = r; });
      var next = ENUMS.ONCALL_ROLES.map(function (role) {
        var r = byRole[role] || {};
        var name = str(r.staffName);
        var cur = current.filter(function (x) { return x.role === role; })[0] || {};
        if (role === "Consultant On Call" && name && !doctors.some(function (d) { return d.name === name && d.level === "Consultant"; })) e[role] = "Choose an active consultant from the approved list.";
        if (role === "Specialist On Call" && name && !doctors.some(function (d) { return d.name === name; })) e[role] = "Choose an active doctor from the approved list.";
        if ((role === "Charge Nurse" || role === "Nurse Supervisor") && name && !RE.personName.test(name)) e[role] = "Use letters, spaces, dots or hyphens (max 40).";
        var shiftDate = str(r.shiftDate), s1 = str(r.shiftStart), s2 = str(r.shiftEnd);
        if (shiftDate && !RE.date.test(shiftDate)) e[role + ".date"] = "Use a valid date.";
        if (s1 && !RE.time.test(s1)) e[role + ".start"] = "Use HH:MM.";
        if (s2 && !RE.time.test(s2)) e[role + ".end"] = "Use HH:MM.";
        var row = { role: role, staffName: name, shiftDate: shiftDate, shiftStart: s1, shiftEnd: s2 };
        row.lastUpdated = diff(cur, row, ["staffName", "shiftDate", "shiftStart", "shiftEnd"]) ? env.now().toISOString() : (cur.lastUpdated || "");
        return row;
      });
      if (Object.keys(e).length) throw new PSWError("VALIDATION", "Check the highlighted on-call fields.", e);
      var change = diff(flat(current), flat(next), Object.keys(flat(next)));
      if (!change) return { onCall: current, unchanged: true };
      store.writeOnCall(next);
      audit(user, "UPDATE_ON_CALL", "", change);
      return { onCall: next };
      function flat(list) { var o = {}; list.forEach(function (r) { o[r.role] = [r.staffName, r.shiftDate, r.shiftStart, r.shiftEnd].join(" | "); }); return o; }
    };

    A.updateSettings = function (p, user) {
      var incoming = p.settings || {};
      var current = store.readSettings();
      var next = {};
      var e = {};
      SETTINGS.forEach(function (s) {
        var key = s[1], kind = s[2];
        var v = (key in incoming) ? str(incoming[key]) : str(current[key]);
        switch (kind) {
          case "text": if (v.length > TEXT_MAX || /[<>]/.test(v)) e[key] = "Use plain text under " + TEXT_MAX + " characters."; break;
          case "code": v = v.toUpperCase(); if (v && !RE.code.test(v)) e[key] = "Use up to 12 letters or digits."; break;
          case "logo":
            if (v && !(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v) || /^https:\/\/[^\s<>"']+$/.test(v) || /^assets\/[\w\-./]+$/.test(v))) e[key] = "Upload a PNG/JPG/WebP image or use an https:// link.";
            if (v.length > LOGO_MAX) e[key] = "The logo image is too large. Use an image under about 30 KB.";
            break;
          case "ext": if (v && !RE.ext.test(v)) e[key] = "Use 2–8 digits."; break;
          case "interval": var n = parseInt(v, 10); if (!(n >= 15 && n <= 300)) e[key] = "Choose between 15 and 300 seconds."; else v = String(n); break;
          case "onoff": v = v.toUpperCase(); if (!inList(v, ["ON", "OFF"])) e[key] = "Choose ON or OFF."; break;
          case "lang": if (!inList(v, ["en", "ar"])) e[key] = "Choose English or Arabic."; break;
          case "tz": if (v !== "Asia/Riyadh") e[key] = "The PSW board runs on Asia/Riyadh time."; break;
        }
        next[key] = v;
      });
      if (Object.keys(e).length) throw new PSWError("VALIDATION", "Check the highlighted settings.", e);
      var change = diff(current, next, Object.keys(next));
      if (!change) return { settings: current, unchanged: true };
      if (change.previous.logo !== undefined) { change.previous.logo = "(image)"; change.next.logo = "(image)"; }
      store.writeSettings(next);
      audit(user, "UPDATE_SETTINGS", "", change);
      return { settings: next };
    };

    A.updateDoctors = function (p, user) {
      var list = Array.isArray(p.doctors) ? p.doctors : [];
      var e = {}, seen = {};
      var clean = list.map(function (d, i) {
        var o = { name: str(d.name).replace(/^dr\.?\s+/i, "Dr "), level: str(d.level), active: d.active === true || d.active === "TRUE" };
        if (!RE.doctorName.test(o.name)) e["doctor." + i] = "Write the name as 'Dr Name'.";
        if (!inList(o.level, ENUMS.DOCTOR_LEVEL)) e["level." + i] = "Choose Consultant or Specialist.";
        var k = o.name.toLowerCase();
        if (seen[k]) e["doctor." + i] = o.name + " is listed twice.";
        seen[k] = true;
        return o;
      });
      if (!clean.length) e.list = "Keep at least one doctor on the list.";
      // A doctor looking after a patient or on call cannot be removed or deactivated.
      var inUse = {};
      store.readBeds().forEach(function (b) { if (isOccupied(b) && b.doctor) (inUse[b.doctor] = inUse[b.doctor] || []).push(labelFor(b)); });
      store.readOnCall().forEach(function (r) { if (r.staffName && /Dr /.test(r.staffName)) (inUse[r.staffName] = inUse[r.staffName] || []).push(r.role); });
      Object.keys(inUse).forEach(function (name) {
        var still = clean.filter(function (d) { return d.name === name && d.active; })[0];
        if (!still) e["inuse." + name] = name + " is still assigned to " + inUse[name].join(", ") + ". Reassign first.";
      });
      if (Object.keys(e).length) throw new PSWError("VALIDATION", "Check the doctor list.", e);
      var current = store.readDoctors();
      var f = function (l) { var o = {}; l.forEach(function (d) { o[d.name] = d.level + (d.active ? "" : " (inactive)"); }); return o; };
      var a = f(current), b = f(clean);
      var keys = Object.keys(a).concat(Object.keys(b)).filter(function (k, i, arr) { return arr.indexOf(k) === i; });
      var change = diff(a, b, keys);
      if (!change) return { doctors: current, unchanged: true };
      store.writeDoctors(clean);
      audit(user, "UPDATE_DOCTORS", "", change);
      return { doctors: clean };
    };

    A.audit = function (p) {
      var limit = Math.min(Math.max(parseInt(p.limit, 10) || 100, 1), 500);
      return { entries: store.readAudit(limit) };
    };

    // ------------------------------------------------------------ dispatch
    function handle(action, payload, email) {
      try {
        var user = authorize(email);
        requireRole(user, action);
        return { ok: true, data: A[action](payload || {}, user) };
      } catch (err) {
        if (err instanceof PSWError) return { ok: false, code: err.code, error: err.message, fields: err.fields };
        if (typeof console !== "undefined") console.error(err && err.stack || err);   // details stay in the server log, not in the response
        return { ok: false, code: "SERVER_ERROR", error: "The board could not complete the request. Try again; if it repeats, tell the administrator." };
      }
    }

    // De-identified, read-only feed for the TV. Privacy is enforced HERE, on the server.
    function displayPayload() {
      var s = store.readSettings();
      var privacy = s.privacyMode !== "OFF";
      var notes = !privacy && s.showNotes === "ON";
      var beds = store.readBeds().map(function (b) {
        var o = { room: b.room, bed: b.bed, label: labelFor(b), bedType: b.bedType, operationalStatus: b.operationalStatus,
          occupancyStatus: b.occupancyStatus, doctor: b.occupancyStatus === "Occupied" ? b.doctor : "",
          patientStatus: b.occupancyStatus === "Occupied" ? b.patientStatus : "",
          isolationPrecaution: b.occupancyStatus === "Occupied" ? b.isolationPrecaution : "None" };
        if (!privacy && b.occupancyStatus === "Occupied") { o.patientCode = b.patientCode; o.age = b.age; o.gender = b.gender; }
        if (notes && b.occupancyStatus === "Occupied") o.note = b.note;
        return o;
      });
      var onCall = store.readOnCall().map(function (r) { return { role: r.role, staffName: r.staffName, shiftStart: r.shiftStart, shiftEnd: r.shiftEnd }; });
      var pub = {};
      SETTINGS.forEach(function (x) { pub[x[1]] = s[x[1]]; });
      return { ok: true, data: { beds: beds, onCall: onCall, settings: pub, privacy: privacy,
        lastModified: store.getMeta("lastModified") || "", serverTime: env.now().toISOString() } };
    }

    return { handle: handle, displayPayload: displayPayload, authorize: authorize, labelFor: labelFor };
  }

  return { create: create, ENUMS: ENUMS, SETTINGS: SETTINGS, ACTION_ROLE: ACTION_ROLE };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PSWEngine;
