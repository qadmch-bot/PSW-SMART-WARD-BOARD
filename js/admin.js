/*
 * PSW Smart Ward Board — Admin interface.
 * Live mode: Google Sign-In (ID token kept in memory only) → every request is verified by the server.
 * Demo mode: fictional data in this browser; no sign-in.
 */
(function () {
  "use strict";
  const CFG = window.PSW_CONFIG, P = window.PSW, API = window.PSWApi;
  const $ = id => document.getElementById(id);
  const TZ = CFG.TIMEZONE;
  const S = { data: null, user: null, lastSyncAt: 0, syncError: null, bed: null, doctorsDraft: [], logoDraft: null, tokenTimer: null, loading: false };

  // ================================================================ small UI helpers
  function toast(msg, isErr) {
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.innerHTML = P.icon(isErr ? "alert" : "check") + "<span>" + P.esc(msg) + "</span>";
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), isErr ? 7000 : 3500);
  }
  function busy(btn, on) { if (!btn) return; btn.classList.toggle("busy", on); btn.disabled = on; }
  function opt(v, label, sel) { return '<option value="' + P.esc(v) + '"' + (sel ? " selected" : "") + ">" + P.esc(label == null ? v : label) + "</option>"; }
  function isAdmin() { return S.user && S.user.role === "ADMIN"; }

  // ================================================================ top bar
  function renderTopbar() {
    const demo = API.mode() === "demo";
    $("tbMark").innerHTML = P.icon("bed");
    $("modePill").className = "mode-pill " + (demo ? "demo" : "live");
    $("modePill").textContent = demo ? "Demo — fictional data" : "Live";
    $("tvLink").innerHTML = P.icon("tv") + "Open TV board";
    if (S.user) {
      $("tbUser").hidden = false;
      $("tbUser").innerHTML = "<b>" + P.esc(S.user.name || S.user.email) + "</b>" + P.esc(S.user.role === "ADMIN" ? "Administrator" : "Editor") + (demo ? "" : " · " + P.esc(S.user.email));
    }
    $("signOut").hidden = demo || !S.user;
    $("signOut").innerHTML = P.icon("logout") + "Sign out";
    renderSync();
  }
  function renderSync() {
    const el = $("tbSync");
    if (!S.lastSyncAt && !S.syncError) { el.innerHTML = ""; return; }
    el.className = "tb-sync" + (S.syncError ? " err" : "");
    const t = S.lastSyncAt ? P.fmtTime(new Date(S.lastSyncAt), TZ, true) : "never";
    el.innerHTML = '<span class="d"></span>' + (S.syncError ? "Sync failed — last synced " + P.esc(t) : (API.mode() === "demo" ? "Demo data saved " : "Google Sheets synced ") + P.esc(t));
  }

  // ================================================================ tabs
  const TABS = [["beds", "Beds", "bed"], ["oncall", "On-call team", "users"], ["settings", "Settings", "settings"], ["audit", "Audit log", "list"]];
  let current = "beds";
  function renderTabs() {
    const visible = TABS.filter(t => t[0] !== "audit" || isAdmin());
    $("tabs").innerHTML = visible.map(t => '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === current) + '">' + P.icon(t[2]) + P.esc(t[1]) + "</button>").join("");
    TABS.forEach(t => { $("view-" + t[0]).hidden = t[0] !== current; });
  }
  $("tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    current = b.dataset.tab; renderTabs();
    if (current === "audit") loadAudit();
    if (current === "settings") renderSettings();
    if (current === "oncall") renderOnCall();
  });

  // ================================================================ data
  // Put the bed returned by the server straight into local state, so the next edit
  // carries the new version even before the background reload finishes.
  function applyBed(b) {
    if (!b || !S.data) return;
    const i = S.data.beds.findIndex(x => x.bed === b.bed);
    if (i < 0) return;
    const o = Object.assign({}, S.data.beds[i], b); delete o._row;
    S.data.beds[i] = o; renderBeds();
  }
  async function loadData(quiet) {
    if (S.loading) { S.reload = true; return; }   // run once more when the current load finishes
    S.loading = true; S.reload = false;
    try {
      const res = await API.call("adminData");
      if (res.ok) {
        S.data = res.data; S.user = res.data.user; S.lastSyncAt = Date.now(); S.syncError = null;
        showApp();
        renderAll();
        return true;
      }
      handleError(res, quiet);
      return false;
    } finally { S.loading = false; if (S.reload) setTimeout(() => loadData(true), 0); }
  }
  function handleError(res, quiet) {
    if (res.code === "UNAUTHENTICATED") { API.setIdToken(""); showGate(res.error); return; }
    if (res.code === "UNAUTHORIZED") { API.setIdToken(""); showGate(res.error + " Signed-in account is not allowed."); return; }
    S.syncError = res; renderSync();
    if (!quiet) toast(res.error || "Request failed.", true);
  }
  function renderAll() {
    renderTopbar(); renderTabs(); renderBeds();
    if (current === "oncall") renderOnCall();
    if (current === "settings") renderSettings();
  }

  // ================================================================ beds
  function renderBeds() {
    const beds = S.data.beds, k = P.computeKpis(beds);
    const ks = [["Total beds", k.operational + (k.outOfService ? " <small>+" + k.outOfService + " out</small>" : "")], ["Occupied", k.occupied], ["Available", k.available],
      ["Occupancy", k.rate + "<small>%</small>"], ["For discharge", k.discharge], ["Isolation", k.isolation], ["Transfer", k.transfer], ["New admission", k.newAdmission]];
    $("kstrip").innerHTML = ks.map(x => '<div class="ks"><div class="l">' + x[0] + '</div><div class="v">' + x[1] + "</div></div>").join("");
    const rows = P.packRows(P.groupRooms(beds), 10);
    $("map").innerHTML = rows.map(row => '<div class="ward-row">' + row.map(g => {
      const t = g.type === "Close Observation" ? "t-obs" : (g.type === "Isolation" || g.type === "Negative Pressure") ? "t-iso" : "t-reg";
      return '<section class="room ' + t + '" style="flex:' + g.beds.length + ' 1 0"><div class="room-h">' + P.esc(P.roomTitle(g)) + '</div><div class="room-beds" style="grid-template-columns:repeat(' +
        g.beds.length + ',1fr)">' + g.beds.map(b => P.bedCardHTML(b, { clickable: true, privacy: false })).join("") + "</div></section>";
    }).join("") + "</div>").join("");
    P.fitText($("map"));
  }
  $("map").addEventListener("click", e => { const c = e.target.closest(".bedcard"); if (c) openBed(c.dataset.bed); });

  // ================================================================ quick bed update
  const F = n => $("f-" + n);
  function findBed(id) { return S.data.beds.find(b => b.bed === id); }
  function doctorOptions(selected, filterLevel) {
    const docs = S.data.doctors.filter(d => d.active && (!filterLevel || d.level === filterLevel));
    let html = opt("", "Choose doctor", !selected);
    P.ENUMS.DOCTOR_LEVEL.forEach(level => {
      const ds = docs.filter(d => d.level === level);
      if (ds.length) html += '<optgroup label="' + level + 's">' + ds.map(d => opt(d.name, d.name, d.name === selected)).join("") + "</optgroup>";
    });
    if (selected && !docs.some(d => d.name === selected)) html += opt(selected, selected + " (not active)", true);
    return html;
  }
  function clearErrors(root) {
    root.querySelectorAll(".err").forEach(e => { e.textContent = ""; });
    root.querySelectorAll(".invalid").forEach(e => e.classList.remove("invalid"));
  }
  function showErrors(root, fields) {
    Object.keys(fields || {}).forEach(k => {
      const e = root.querySelector('.err[data-for="' + k + '"]');
      if (e) { e.textContent = fields[k]; const l = e.closest("label, fieldset"); if (l) l.classList.add("invalid"); }
    });
  }

  function openBed(id) {
    const b = findBed(id); if (!b) return;
    S.bed = b;
    const st = P.primaryState(b);
    const occupied = b.occupancyStatus === "Occupied";
    const oos = b.operationalStatus === "Out of Service";
    $("bedTitle").textContent = b.label || ("Bed " + b.bed);
    $("bedSub").textContent = b.room + " · " + b.bedType + (b.lastUpdated ? " · updated " + P.fmtDateTime(b.lastUpdated, TZ) + (b.updatedBy ? " by " + b.updatedBy : "") : "");
    $("bedState").className = "state-pill s-" + st;
    $("bedState").textContent = oos ? "Out of service" : occupied ? (b.patientStatus || "Occupied") + (P.hasIsolation(b) ? " + isolation" : "") : "Available";
    F("room").value = b.room; F("bed").value = b.bed;
    F("patientCode").value = b.patientCode || ""; F("age").value = b.age || "";
    document.querySelectorAll('input[name="gender"]').forEach(r => { r.checked = r.value === b.gender; });
    F("doctor").innerHTML = doctorOptions(b.doctor);
    F("patientStatus").innerHTML = P.ENUMS.PATIENT_STATUS.map(s => opt(s, s, s === (b.patientStatus || (occupied ? "Stable" : "New Admission")))).join("");
    F("isolationPrecaution").innerHTML = P.ENUMS.ISOLATION.map(s => opt(s, s, s === (b.isolationPrecaution || "None"))).join("");
    F("note").value = b.note || ""; F("expectedDischarge").value = b.expectedDischarge || "";
    noteCount();
    $("bedForm").querySelectorAll("input:not([readonly]), select").forEach(el => { el.disabled = oos; });
    $("bSave").textContent = occupied ? "Save" : "Save — admit patient";
    $("bSave").disabled = oos;
    $("bDischarge").disabled = !occupied; $("bTransfer").disabled = !occupied; $("bAvailable").disabled = !occupied;
    $("bService").hidden = occupied;
    $("bService").textContent = oos ? "Return bed to service" : "Take bed out of service";
    clearErrors($("bedForm")); $("bedMsg").textContent = ""; $("bedMsg").className = "form-msg";
    $("bedDialog").showModal();
    setTimeout(() => (oos ? $("bService") : occupied ? F("patientStatus") : F("patientCode")).focus(), 30);
  }
  function noteCount() { $("noteCount").textContent = F("note").value.length + " / 60"; }
  F("note").addEventListener("input", noteCount);
  F("patientCode").addEventListener("input", e => { const p = e.target.selectionStart; e.target.value = e.target.value.toUpperCase(); e.target.setSelectionRange(p, p); });
  F("age").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase(); });

  function collectBed() {
    const g = document.querySelector('input[name="gender"]:checked');
    return {
      bed: S.bed.bed, patientCode: F("patientCode").value.trim().toUpperCase(), age: F("age").value.trim().toUpperCase(),
      gender: g ? g.value : "", doctor: F("doctor").value, patientStatus: F("patientStatus").value,
      isolationPrecaution: F("isolationPrecaution").value, note: F("note").value.trim(),
      expectedDischarge: F("expectedDischarge").value, expectedLastUpdated: S.bed.lastUpdated || ""
    };
  }

  async function saveBed(btn, forceStatus) {
    const form = $("bedForm");
    clearErrors(form); $("bedMsg").textContent = "";
    const p = collectBed();
    if (forceStatus) { p.patientStatus = forceStatus; F("patientStatus").value = forceStatus; }
    const errs = P.validateBed(p, S.data.doctors, S.bed.occupancyStatus !== "Occupied");
    if (Object.keys(errs).length) { showErrors(form, errs); $("bedMsg").textContent = "Check the highlighted fields."; return; }
    busy(btn, true);
    const res = await API.call("updateBed", p);
    busy(btn, false);
    if (res.ok) {
      applyBed(res.data.bed);
      $("bedDialog").close();
      toast(res.data.unchanged ? "No changes to save." : (S.bed.label || S.bed.bed) + " saved.");
      await loadData(true);
      return;
    }
    if (res.fields) showErrors(form, res.fields);
    $("bedMsg").textContent = res.error || "Could not save.";
    if (res.code === "CONFLICT") { await loadData(true); }
    else handleError(res, true);
  }
  $("bSave").addEventListener("click", e => saveBed(e.currentTarget));
  $("bDischarge").addEventListener("click", e => saveBed(e.currentTarget, "For Discharge"));
  $("bTransfer").addEventListener("click", e => saveBed(e.currentTarget, "Transfer"));
  $("bCancel").addEventListener("click", () => $("bedDialog").close());

  $("bService").addEventListener("click", async e => {
    const oos = S.bed.operationalStatus === "Out of Service";
    const label = S.bed.label || S.bed.bed;
    if (!confirm(oos ? "Return " + label + " to service? It will count as an available bed." : "Take " + label + " out of service? It will not count towards occupancy.")) return;
    busy(e.currentTarget, true);
    const res = await API.call("setOperational", { bed: S.bed.bed, operationalStatus: oos ? "Operational" : "Out of Service" });
    busy(e.currentTarget, false);
    if (res.ok) { applyBed(res.data.bed); $("bedDialog").close(); toast(label + (oos ? " returned to service." : " taken out of service.")); loadData(true); }
    else { $("bedMsg").textContent = res.error; handleError(res, true); }
  });

  // ---- release (mark available) with explicit confirmation
  $("bAvailable").addEventListener("click", () => {
    const label = S.bed.label || S.bed.bed;
    $("relTitle").textContent = "Mark " + label + " available";
    $("relConfirm").checked = false;
    $("relClean").checked = S.bed.bedType === "Isolation" || S.bed.bedType === "Negative Pressure" || P.hasIsolation(S.bed);
    const reason = S.bed.patientStatus === "Transfer" ? "Transfer completed" : "Discharge completed";
    document.querySelectorAll('input[name="reason"]').forEach(r => { r.checked = r.value === reason; });
    $("relOk").disabled = true; $("relMsg").textContent = "";
    $("releaseDialog").showModal();
  });
  $("relConfirm").addEventListener("change", e => { $("relOk").disabled = !e.target.checked; });
  $("relCancel").addEventListener("click", () => $("releaseDialog").close());
  $("relOk").addEventListener("click", async e => {
    if (!$("relConfirm").checked) return;
    const r = document.querySelector('input[name="reason"]:checked');
    busy(e.currentTarget, true);
    const res = await API.call("markAvailable", {
      bed: S.bed.bed, confirmLeft: true, reason: r ? r.value : "Discharge completed",
      holdForCleaning: $("relClean").checked, expectedLastUpdated: S.bed.lastUpdated || ""
    });
    busy(e.currentTarget, false);
    $("relOk").disabled = !$("relConfirm").checked;
    if (res.ok) {
      applyBed(res.data.bed);
      $("releaseDialog").close(); $("bedDialog").close();
      toast((S.bed.label || S.bed.bed) + (res.data.bed.operationalStatus === "Out of Service" ? " released and held for cleaning." : " is now available."));
      loadData(true);
    } else { $("relMsg").textContent = res.error; if (res.code === "CONFLICT") loadData(true); else handleError(res, true); }
  });

  // ================================================================ on-call
  function renderOnCall() {
    if (!S.data) return;
    const by = {}; S.data.onCall.forEach(r => { by[r.role] = r; });
    $("oncallForm").innerHTML = P.ENUMS.ONCALL_ROLES.map((role, i) => {
      const r = by[role] || {};
      let who;
      if (role === "Consultant On Call") who = '<select data-k="staffName">' + doctorOptions(r.staffName, "Consultant").replace("Choose doctor", "Not assigned") + "</select>";
      else if (role === "Specialist On Call") who = '<select data-k="staffName">' + doctorOptions(r.staffName).replace("Choose doctor", "Not assigned") + "</select>";
      else who = '<input data-k="staffName" maxlength="40" autocomplete="off" placeholder="Name as shown on the board" value="' + P.esc(r.staffName) + '">';
      return '<div class="oc-line" data-role="' + P.esc(role) + '"><div class="role">' + P.icon(/Nurse/.test(role) ? "nurse" : "stethoscope") + P.esc(role) + "</div>" +
        "<label>Name" + who + '<em class="err" data-for="' + P.esc(role) + '"></em></label>' +
        '<label>Shift date<input type="date" data-k="shiftDate" value="' + P.esc(r.shiftDate) + '"><em class="err" data-for="' + P.esc(role) + '.date"></em></label>' +
        '<label>Start<input type="time" data-k="shiftStart" value="' + P.esc(r.shiftStart) + '"><em class="err" data-for="' + P.esc(role) + '.start"></em></label>' +
        '<label>End<input type="time" data-k="shiftEnd" value="' + P.esc(r.shiftEnd) + '"><em class="err" data-for="' + P.esc(role) + '.end"></em></label></div>';
    }).join("");
  }
  $("saveOnCall").addEventListener("click", async e => {
    const rows = Array.from(document.querySelectorAll(".oc-line")).map(line => {
      const o = { role: line.dataset.role };
      line.querySelectorAll("[data-k]").forEach(el => { o[el.dataset.k] = el.value.trim(); });
      return o;
    });
    clearErrors($("oncallForm"));
    busy(e.currentTarget, true);
    const res = await API.call("updateOnCall", { rows });
    busy(e.currentTarget, false);
    if (res.ok) { toast(res.data.unchanged ? "No changes to save." : "On-call team saved."); loadData(true); }
    else { showErrors($("oncallForm"), res.fields); toast(res.error, true); handleError(res, true); }
  });

  // ================================================================ settings
  const SETTING_FIELDS = [
    ["section", "Header"],
    ["hospitalName", "Hospital name", "text"], ["hospitalNameAr", "Hospital name (Arabic)", "text"],
    ["cluster", "Health cluster", "text"], ["departmentCode", "Department code", "text"],
    ["departmentName", "Department name", "text"], ["departmentNameAr", "Department name (Arabic)", "text"],
    ["tagline", "Tagline", "text"], ["logo", "Hospital logo", "logo"],
    ["section", "Emergency extensions"],
    ["rrtExtension", "RRT team extension", "ext"], ["codeBlueExtension", "Code Blue team extension", "ext"],
    ["section", "TV display"],
    ["refreshInterval", "Refresh every", "interval"], ["language", "Board language", "lang"],
    ["privacyMode", "Privacy mode — hide patient code, age, gender and notes on the TV", "toggle"],
    ["showNotes", "Show clinical notes on the TV (only when privacy mode is off)", "toggle"],
    ["timezone", "Time zone", "readonly"]
  ];
  function renderSettings() {
    if (!S.data) return;
    ["cardBoard", "cardDoctors", "cardTv"].forEach(id => { $(id).hidden = !isAdmin(); });
    renderConnPanel($("connPanel"));
    if (!isAdmin()) return;
    const s = S.data.settings;
    S.logoDraft = null;
    $("settingsForm").innerHTML = SETTING_FIELDS.map(f => {
      const [k, label, type] = f;
      if (k === "section") return '<div class="section">' + P.esc(label) + "</div>";
      const v = s[k] == null ? "" : s[k];
      const err = '<em class="err" data-for="' + k + '"></em>';
      switch (type) {
        case "logo":
          return '<div class="wide"><label>Hospital logo</label><div class="logo-edit"><img id="logoPreview" alt="" src="' + P.esc(v || "assets/logo-placeholder.png") + '">' +
            '<label class="btn">Upload image<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden></label><button type="button" class="btn link" id="logoRemove">Remove</button></div>' +
            "<small>Use the official hospital logo only. It is resized to fit.</small>" + err + "</div>";
        case "ext":
          return "<label>" + P.esc(label) + '<input data-s="' + k + '" inputmode="numeric" maxlength="8" value="' + P.esc(v) + '" placeholder="Not set">' + err + "</label>";
        case "interval":
          return "<label>" + P.esc(label) + '<select data-s="' + k + '">' + [15, 30, 60, 120, 300].map(n => opt(String(n), n < 60 ? n + " seconds" : (n / 60) + " minute" + (n > 60 ? "s" : ""), String(n) === String(v))).join("") + "</select>" + err + "</label>";
        case "lang":
          return "<label>" + P.esc(label) + '<select data-s="' + k + '">' + opt("en", "English", v === "en") + opt("ar", "العربية — Arabic", v === "ar") + "</select>" + err + "</label>";
        case "toggle":
          return '<label class="toggle wide">' + P.esc(label) + '<input type="checkbox" data-s="' + k + '"' + (v === "ON" ? " checked" : "") + ">" + err + "</label>";
        case "readonly":
          return "<label>" + P.esc(label) + '<input value="' + P.esc(v) + '" readonly></label>';
        default:
          return "<label>" + P.esc(label) + '<input data-s="' + k + '" maxlength="80" value="' + P.esc(v) + '">' + err + "</label>";
      }
    }).join("");
    $("logoFile").addEventListener("change", onLogo);
    $("logoRemove").addEventListener("click", () => { S.logoDraft = ""; $("logoPreview").src = "assets/logo-placeholder.png"; });
    S.doctorsDraft = S.data.doctors.map(d => Object.assign({}, d));
    renderDoctors();
    renderTvPanel();
  }
  function onLogo(e) {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast("Choose an image under 5 MB.", true); return; }
    const img = new Image();
    img.onload = () => {
      const max = 180, r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let url = c.toDataURL("image/png");
      if (url.length > 44000) url = c.toDataURL("image/webp", 0.85);
      if (url.length > 44000) url = c.toDataURL("image/jpeg", 0.8);
      if (url.length > 44000) { toast("This image is too detailed. Try a simpler PNG under 30 KB.", true); return; }
      S.logoDraft = url; $("logoPreview").src = url;
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => toast("That file is not an image this browser can read.", true);
    img.src = URL.createObjectURL(file);
  }
  $("saveSettings").addEventListener("click", async e => {
    const out = {};
    document.querySelectorAll("[data-s]").forEach(el => { out[el.dataset.s] = el.type === "checkbox" ? (el.checked ? "ON" : "OFF") : el.value.trim(); });
    if (S.logoDraft !== null) out.logo = S.logoDraft;
    clearErrors($("settingsForm"));
    busy(e.currentTarget, true);
    const res = await API.call("updateSettings", { settings: out });
    busy(e.currentTarget, false);
    if (res.ok) { toast(res.data.unchanged ? "No changes to save." : "Settings saved. The TV updates on its next refresh."); await loadData(true); renderSettings(); }
    else { showErrors($("settingsForm"), res.fields); toast(res.error, true); handleError(res, true); }
  });

  // ---- doctors
  function renderDoctors(errs) {
    $("doctorList").innerHTML = S.doctorsDraft.map((d, i) =>
      '<div class="doc-row" data-i="' + i + '"><input data-d="name" value="' + P.esc(d.name) + '" placeholder="Dr Name" maxlength="42" aria-label="Doctor name">' +
      '<select data-d="level" aria-label="Level">' + P.ENUMS.DOCTOR_LEVEL.map(l => opt(l, l, l === d.level)).join("") + "</select>" +
      '<label class="act"><input type="checkbox" data-d="active"' + (d.active ? " checked" : "") + "> Active</label>" +
      '<button type="button" class="icon-btn" data-del="' + i + '" aria-label="Remove ' + P.esc(d.name) + '">' + P.icon("x") + "</button></div>").join("") +
      '<div class="doc-errs">' + (errs ? Object.values(errs).map(P.esc).join("<br>") : "") + "</div>";
  }
  function syncDoctorsDraft() {
    document.querySelectorAll(".doc-row").forEach(row => {
      const d = S.doctorsDraft[+row.dataset.i];
      row.querySelectorAll("[data-d]").forEach(el => { d[el.dataset.d] = el.type === "checkbox" ? el.checked : el.value.trim(); });
    });
  }
  $("doctorList").addEventListener("click", e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    syncDoctorsDraft(); S.doctorsDraft.splice(+b.dataset.del, 1); renderDoctors();
  });
  $("addDoctor").addEventListener("click", () => {
    syncDoctorsDraft(); S.doctorsDraft.push({ name: "Dr ", level: "Specialist", active: true }); renderDoctors();
    const inputs = document.querySelectorAll('.doc-row [data-d="name"]'); inputs[inputs.length - 1].focus();
  });
  $("saveDoctors").addEventListener("click", async e => {
    syncDoctorsDraft();
    busy(e.currentTarget, true);
    const res = await API.call("updateDoctors", { doctors: S.doctorsDraft });
    busy(e.currentTarget, false);
    if (res.ok) { toast(res.data.unchanged ? "No changes to save." : "Doctor list saved."); await loadData(true); renderSettings(); }
    else { renderDoctors(res.fields); toast(res.error, true); handleError(res, true); }
  });

  // ---- TV link
  function tvBase() { return new URL("index.html", location.href).href.split("#")[0]; }
  function renderTvPanel() {
    const el = $("tvPanel");
    if (API.mode() === "demo") {
      el.innerHTML = '<p class="lead">In demo mode the TV page needs no link: open <a href="index.html" target="_blank" rel="noopener">the TV board</a> in another tab. Changes made here appear there within seconds.</p>' +
        '<div class="note">Demo data is fictional and stays in this browser only.</div>';
      return;
    }
    el.innerHTML = '<p class="lead">Open this link once on the TV. The screen remembers it and removes it from the address bar. The link shows the de-identified feed only.</p>' +
      '<div class="actions split" style="margin-top:0"><button class="btn" id="showKey">Show TV link</button><button class="btn danger" id="rotateKey">Issue new link</button></div><div id="keyOut"></div>';
    const show = async (rotate) => {
      if (rotate && !confirm("Issue a new TV link? Every TV using the old link will stop showing data until you open the new link on it.")) return;
      const res = await API.call(rotate ? "rotateDisplayKey" : "displayKey");
      if (!res.ok) { toast(res.error, true); handleError(res, true); return; }
      const link = tvBase() + "#key=" + res.data.key;
      $("keyOut").innerHTML = '<div class="tvlink" style="margin-top:12px"><input readonly value="' + P.esc(link) + '" aria-label="TV link"><button class="btn" id="copyKey">Copy</button></div>' +
        '<p class="note" style="margin-top:10px">Treat this link like a key. Anyone with it can see the TV view of the ward.</p>';
      $("copyKey").addEventListener("click", () => navigator.clipboard.writeText(link).then(() => toast("TV link copied.")));
      if (rotate) toast("New TV link issued.");
    };
    $("showKey").addEventListener("click", () => show(false));
    $("rotateKey").addEventListener("click", () => show(true));
  }

  // ---- connection (this device only)
  function renderConnPanel(el) {
    const c = API.readConn();
    const demo = API.mode() === "demo";
    el.innerHTML =
      '<dl class="kv"><dt>Mode</dt><dd>' + (demo ? "Demo — fictional data in this browser" : "Live — Google Sheets") + "</dd>" +
      "<dt>Last synchronised</dt><dd>" + (S.lastSyncAt ? P.esc(P.fmtDateTime(new Date(S.lastSyncAt).toISOString(), TZ)) : "—") + "</dd>" +
      (S.data && S.data.lastModified ? "<dt>Last change on board</dt><dd>" + P.esc(P.fmtDateTime(S.data.lastModified, TZ)) + "</dd>" : "") + "</dl>" +
      '<div class="form-grid"><label>Apps Script Web App URL<input id="cUrl" value="' + P.esc(c.apiUrl) + '" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false"><small>Leave empty for demo mode.</small></label>' +
      '<label>Google OAuth Client ID<input id="cClient" value="' + P.esc(c.clientId) + '" placeholder="…apps.googleusercontent.com" spellcheck="false"></label></div>' +
      '<p class="form-msg" id="cMsg"></p><div class="actions split"><button class="btn" id="cTest">Test connection</button><button class="btn primary" id="cSave">Save and reload</button></div>' +
      (demo ? '<div class="actions" style="justify-content:flex-start"><button class="btn danger" id="cReset">Reset demo data</button></div>' : "");
    el.querySelector("#cTest").addEventListener("click", async ev => {
      const url = el.querySelector("#cUrl").value.trim(), msg = el.querySelector("#cMsg");
      if (!url) { msg.className = "form-msg"; msg.textContent = "Enter the Web App URL first."; return; }
      busy(ev.currentTarget, true);
      const r = await API.ping(url);
      busy(ev.currentTarget, false);
      msg.className = "form-msg" + (r.ok ? " ok" : "");
      msg.textContent = r.ok ? "Connected to " + r.data.service + " " + r.data.version + "." : (r.error || "No answer.");
    });
    el.querySelector("#cSave").addEventListener("click", () => {
      const r = API.saveConn({ apiUrl: el.querySelector("#cUrl").value, clientId: el.querySelector("#cClient").value });
      const msg = el.querySelector("#cMsg");
      if (!r.ok) { msg.className = "form-msg"; msg.textContent = r.error; return; }
      location.reload();
    });
    const reset = el.querySelector("#cReset");
    if (reset) reset.addEventListener("click", () => { if (confirm("Restore the fictional demo ward?")) { API.resetDemo(); loadData(); toast("Demo data restored."); } });
  }

  // ================================================================ audit
  function describe(prev, next) {
    let p = {}, n = {};
    try { p = prev ? JSON.parse(prev) : {}; } catch (e) { /* ignore */ }
    try { n = next ? JSON.parse(next) : {}; } catch (e) { /* ignore */ }
    const keys = Array.from(new Set(Object.keys(p).concat(Object.keys(n))));
    return keys.map(k => "<b>" + P.esc(k) + "</b>: " + P.esc(p[k] === undefined || p[k] === "" ? "—" : p[k]) + " → " + P.esc(n[k] === undefined || n[k] === "" ? "—" : n[k])).join("<br>");
  }
  async function loadAudit() {
    $("auditBody").innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
    const res = await API.call("audit", { limit: 150 });
    if (!res.ok) { $("auditBody").innerHTML = '<tr><td colspan="5">' + P.esc(res.error) + "</td></tr>"; handleError(res, true); return; }
    const rows = res.data.entries;
    $("auditBody").innerHTML = rows.length ? rows.map(a =>
      '<tr><td class="t">' + P.esc(P.fmtDateTime(a.timestamp, TZ)) + "</td><td>" + P.esc(a.user) + '</td><td><span class="act">' + P.esc(a.action) + "</span></td><td>" +
      P.esc(a.bed) + '</td><td class="chg">' + describe(a.previous, a.next) + "</td></tr>").join("")
      : '<tr><td colspan="5">No changes recorded yet. Changes made on this page appear here.</td></tr>';
  }
  $("reloadAudit").addEventListener("click", loadAudit);

  // ================================================================ sign-in (live mode)
  function showGate(msg) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gateIcon").innerHTML = P.icon("lock");
    $("gateMsg").textContent = msg || "";
    S.user = null; renderTopbar();
    renderConnPanel($("gateConn"));
    if (!API.readConn().clientId) {
      $("gateMsg").textContent = "Sign-in is not set up on this device. Enter the Google OAuth Client ID below (see README step 3).";
      document.querySelector(".gate-conn").open = true;
    }
  }
  function showApp() { $("gate").hidden = true; $("app").hidden = false; }

  function decodeJwt(t) {
    try { return JSON.parse(decodeURIComponent(escape(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))); } catch (e) { return {}; }
  }
  async function onCredential(resp) {
    const token = resp && resp.credential;
    if (!token) return;
    API.setIdToken(token);
    const claims = decodeJwt(token);
    clearTimeout(S.tokenTimer);
    if (claims.exp) {
      // Google ID tokens last about an hour; ask for a fresh one shortly before expiry.
      const ms = claims.exp * 1000 - Date.now() - 5 * 60 * 1000;
      S.tokenTimer = setTimeout(() => { if (window.google) google.accounts.id.prompt(); }, Math.max(ms, 30000));
    }
    $("gateMsg").textContent = "Checking your access…";
    const ok = await loadData();
    if (ok) toast("Signed in as " + (S.user.name || S.user.email) + ".");
  }
  function initGoogle() {
    const clientId = API.readConn().clientId;
    showGate("");
    if (!clientId) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => {
      google.accounts.id.initialize({ client_id: clientId, callback: onCredential, auto_select: true, cancel_on_tap_outside: false, itp_support: true, use_fedcm_for_prompt: true });
      google.accounts.id.renderButton($("gisButton"), { theme: "filled_blue", size: "large", shape: "pill", text: "signin_with", width: 300 });
      google.accounts.id.prompt();
    };
    s.onerror = () => { $("gateMsg").textContent = "Could not load Google Sign-In. Check the internet connection."; };
    document.head.appendChild(s);
  }
  $("signOut").addEventListener("click", () => {
    API.setIdToken(""); clearTimeout(S.tokenTimer);
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    S.data = null; showGate("You are signed out.");
  });

  // ================================================================ background sync
  setInterval(() => {
    const dialogOpen = $("bedDialog").open || $("releaseDialog").open;
    const editing = current === "settings" || current === "oncall";
    if (!document.hidden && !dialogOpen && !editing && S.user) loadData(true);
    renderSync();
  }, Math.max(CFG.MIN_REFRESH_SECONDS, CFG.DEFAULT_REFRESH_SECONDS) * 1000);

  // ================================================================ start
  renderTopbar();
  if (API.mode() === "demo") { loadData(); }
  else { initGoogle(); }
  window.PSWAdmin = { state: S, loadData, openBed };
})();
