/*
 * PSW Smart Ward Board — setup & maintenance functions.
 * Run these from the Apps Script editor (select function → Run). They are not web endpoints
 * (functions ending in "_" and these setup functions are never called by doGet/doPost).
 *
 * 1. Fill in SETUP below.
 * 2. Run setupDatabase().  Authorise when asked.
 * 3. Read the execution log: it prints the spreadsheet link and the TV display key.
 */
var SETUP = {
  // Your OAuth 2.0 Web Client ID from Google Cloud Console (README step 3).
  OAUTH_CLIENT_ID: "",

  // Leave empty to create a new spreadsheet "PSW SMART WARD BOARD DATABASE" in your Drive.
  // Or paste the ID of an empty spreadsheet you already created in your Drive
  // (the long code between /d/ and /edit in its address).
  EXISTING_SPREADSHEET_ID: "",

  // Staff allowed to sign in to /admin. The account running setup is added as ADMIN automatically.
  // ADMIN: everything, including settings, doctor list, TV link and audit log.
  // EDITOR: beds, patients, on-call team.
  ADMINS: [],        // e.g. ["charge.nurse.psw@gmail.com"]
  EDITORS: [],

  // true = load FICTIONAL demonstration patients. Run clearAllPatients() before real use.
  LOAD_DEMO_DATA: true
};

var DB_NAME = "PSW SMART WARD BOARD DATABASE";

function setupDatabase() {
  var props = PropertiesService.getScriptProperties();
  var owner = Session.getEffectiveUser().getEmail();
  var ss, created = false;

  var id = SETUP.EXISTING_SPREADSHEET_ID || props.getProperty("SPREADSHEET_ID");
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create(DB_NAME);
    created = true;
  }
  ss.rename(DB_NAME);
  ss.setSpreadsheetTimeZone("Asia/Riyadh");
  props.setProperty("SPREADSHEET_ID", ss.getId());
  if (SETUP.OAUTH_CLIENT_ID) props.setProperty("OAUTH_CLIENT_ID", SETUP.OAUTH_CLIENT_ID.trim());
  if (!props.getProperty("DISPLAY_KEY")) props.setProperty("DISPLAY_KEY", newKey_());

  var today = Utilities.formatDate(new Date(), "Asia/Riyadh", "yyyy-MM-dd");

  // ---- BEDS
  var beds = ensureSheet_(ss, SHEETS.BEDS, HEADERS.BEDS);
  if (beds.getLastRow() < 2) {
    var rows = PSWSeed.buildBeds(SETUP.LOAD_DEMO_DATA, today).map(function (b) { return BED_KEYS.map(function (k) { return b[k] || ""; }); });
    beds.getRange(2, 1, rows.length, BED_KEYS.length).setNumberFormat("@").setValues(rows);
  }
  beds.getRange(2, 1, 60, BED_KEYS.length).setNumberFormat("@");

  // ---- DOCTORS
  var docs = ensureSheet_(ss, SHEETS.DOCTORS, HEADERS.DOCTORS);
  if (docs.getLastRow() < 2) {
    docs.getRange(2, 1, PSWSeed.DOCTORS.length, 3).setValues(PSWSeed.DOCTORS.map(function (d) { return [d.name, d.level, d.active]; }));
  }
  docs.getRange(2, 1, 40, 2).setNumberFormat("@");
  docs.getRange(2, 3, 40, 1).insertCheckboxes();

  // ---- ON CALL TEAM (names left blank on purpose — enter the real team in Admin)
  var oc = ensureSheet_(ss, SHEETS.ONCALL, HEADERS.ONCALL);
  oc.getRange(2, 1, 10, 6).setNumberFormat("@");
  if (oc.getLastRow() < 2) {
    oc.getRange(2, 1, 4, 6).setValues(PSWEngine.ENUMS.ONCALL_ROLES.map(function (r) {
      var name = SETUP.LOAD_DEMO_DATA ? (PSWSeed.DEMO_ON_CALL[r] || "") : "";
      return [r, name, "", "", "", ""];
    }));
  }

  // ---- SETTINGS
  var st = ensureSheet_(ss, SHEETS.SETTINGS, HEADERS.SETTINGS);
  st.getRange(2, 1, 30, 2).setNumberFormat("@");
  if (st.getLastRow() < 2) {
    st.getRange(2, 1, PSWEngine.SETTINGS.length, 2).setValues(PSWEngine.SETTINGS.map(function (s) { return [s[0], PSWSeed.SETTINGS[s[1]] || ""]; }));
  }

  // ---- AUDIT LOG
  var au = ensureSheet_(ss, SHEETS.AUDIT, HEADERS.AUDIT);
  au.getRange(2, 1, 1000, 7).setNumberFormat("@");

  // ---- USERS
  var us = ensureSheet_(ss, SHEETS.USERS, HEADERS.USERS);
  var existing = us.getLastRow() > 1 ? us.getRange(2, 1, us.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); }) : [];
  var add = [];
  function addUser(email, role) {
    email = String(email || "").trim().toLowerCase();
    if (email && existing.indexOf(email) < 0) { add.push([email, role, true, role === "ADMIN" ? "Board administrator" : "Ward staff"]); existing.push(email); }
  }
  addUser(owner, "ADMIN");
  SETUP.ADMINS.forEach(function (e) { addUser(e, "ADMIN"); });
  SETUP.EDITORS.forEach(function (e) { addUser(e, "EDITOR"); });
  if (add.length) us.getRange(us.getLastRow() + 1, 1, add.length, 4).setValues(add);
  us.getRange(2, 3, 100, 1).insertCheckboxes();

  applyValidation_(ss);
  applyProtection_(ss);
  applyFormatting_(ss);

  var def = ss.getSheetByName("Sheet1");
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  props.setProperty("META_lastModified", new Date().toISOString());
  if (created) console.log("Created spreadsheet in your Drive: " + ss.getUrl());
  console.log("Spreadsheet: " + ss.getUrl());
  console.log("TV display key: " + props.getProperty("DISPLAY_KEY"));
  console.log(props.getProperty("OAUTH_CLIENT_ID") ? "OAuth Client ID is set." : "WARNING: OAUTH_CLIENT_ID is not set — /admin sign-in will fail until you set it.");
  console.log(SETUP.LOAD_DEMO_DATA ? "FICTIONAL demo patients loaded. Run clearAllPatients() before using real data." : "No patients loaded.");
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight("bold").setBackground("#16326b").setFontColor("#ffffff");
  sh.setFrozenRows(1);
  return sh;
}

function applyValidation_(ss) {
  var E = PSWEngine.ENUMS;
  function list(values, allowBlank) {
    return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  }
  var beds = ss.getSheetByName(SHEETS.BEDS);
  var n = 60;
  beds.getRange(2, 3, n).setDataValidation(list(E.BED_TYPE));
  beds.getRange(2, 4, n).setDataValidation(list(E.OPERATIONAL));
  beds.getRange(2, 5, n).setDataValidation(list(E.OCCUPANCY));
  beds.getRange(2, 8, n).setDataValidation(list(E.GENDER));
  beds.getRange(2, 9, n).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEETS.DOCTORS).getRange("A2:A41"), true).setAllowInvalid(false).build());
  beds.getRange(2, 10, n).setDataValidation(list(E.PATIENT_STATUS));
  beds.getRange(2, 11, n).setDataValidation(list(E.ISOLATION));
  ss.getSheetByName(SHEETS.DOCTORS).getRange(2, 2, 40).setDataValidation(list(E.DOCTOR_LEVEL));
  ss.getSheetByName(SHEETS.ONCALL).getRange(2, 1, 10).setDataValidation(list(E.ONCALL_ROLES));
  ss.getSheetByName(SHEETS.USERS).getRange(2, 2, 100).setDataValidation(list(E.ROLES));
}

function applyProtection_(ss) {
  var me = Session.getEffectiveUser();
  // Data sheets: warn anyone (including the owner) that manual edits bypass validation and the audit log.
  [SHEETS.BEDS, SHEETS.DOCTORS, SHEETS.ONCALL, SHEETS.SETTINGS].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
    var p = sh.protect().setDescription("Edit through the PSW Admin page — manual edits bypass validation and the audit log.");
    p.setWarningOnly(true);
  });
  // Audit log and users: owner only, no one else can edit even if the file is shared by mistake.
  [SHEETS.AUDIT, SHEETS.USERS].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
    var p = sh.protect().setDescription(name + " — owner only");
    p.addEditor(me);
    p.removeEditors(p.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
}

function applyFormatting_(ss) {
  var beds = ss.getSheetByName(SHEETS.BEDS);
  var range = beds.getRange("A2:P60");
  var colours = [
    ['=$D2="Out of Service"', "#e5e7eb"], ['=$E2="Available"', "#f1f4f8"],
    ['=$J2="Transfer"', "#ede3ff"], ['=$J2="For Discharge"', "#fff3c4"],
    ['=AND($E2="Occupied",$K2<>"None",$K2<>"")', "#ffe0e3"],
    ['=$J2="Post Operative"', "#dcebff"], ['=$J2="New Admission"', "#d9f5fb"], ['=$J2="Stable"', "#dff5e3"]
  ];
  beds.setConditionalFormatRules(colours.map(function (c) {
    return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(c[0]).setBackground(c[1]).setRanges([range]).build();
  }));
  [SHEETS.BEDS, SHEETS.DOCTORS, SHEETS.ONCALL, SHEETS.SETTINGS, SHEETS.AUDIT, SHEETS.USERS].forEach(function (n) {
    var sh = ss.getSheetByName(n); sh.autoResizeColumns(1, sh.getLastColumn());
  });
}

// ================================================================== maintenance

/** Empties every bed (use before switching from demo to real data). Logged in the audit log. */
function clearAllPatients() {
  var st = store_();
  var beds = st.readBeds();
  beds.forEach(function (b) {
    ["patientCode", "age", "gender", "doctor", "patientStatus", "note", "admissionDate", "expectedDischarge"].forEach(function (k) { b[k] = ""; });
    b.occupancyStatus = "Available"; b.isolationPrecaution = "None"; b.operationalStatus = "Operational";
    b.lastUpdated = new Date().toISOString(); b.updatedBy = Session.getEffectiveUser().getEmail();
  });
  st.writeBeds(beds);
  st.appendAudit([{ timestamp: new Date().toISOString(), user: Session.getEffectiveUser().getEmail(), action: "CLEAR_ALL_PATIENTS",
    bed: "ALL", previous: "", next: "", recordId: Utilities.getUuid() }]);
  st.setMeta("lastModified", new Date().toISOString());
  console.log("All " + beds.length + " locations are now Available and Operational.");
}

/** Prints the current TV display key. */
function showDisplayKey() { console.log("TV display key: " + prop_("DISPLAY_KEY")); }

/** Issues a new TV display key. Every TV must then be opened again with the new link. */
function rotateDisplayKey() {
  PropertiesService.getScriptProperties().setProperty("DISPLAY_KEY", newKey_());
  console.log("New TV display key: " + prop_("DISPLAY_KEY"));
}

/** Sets or changes the OAuth Client ID without re-running setup. */
function setOAuthClientId() {
  if (!SETUP.OAUTH_CLIENT_ID) throw new Error("Paste the Client ID into SETUP.OAUTH_CLIENT_ID first.");
  PropertiesService.getScriptProperties().setProperty("OAUTH_CLIENT_ID", SETUP.OAUTH_CLIENT_ID.trim());
  console.log("OAuth Client ID saved.");
}

/** Quick self-check of the configuration. */
function checkConfiguration() {
  var ok = true;
  ["SPREADSHEET_ID", "DISPLAY_KEY", "OAUTH_CLIENT_ID"].forEach(function (k) {
    var v = prop_(k); console.log(k + ": " + (v ? "set" : "MISSING")); if (!v) ok = false;
  });
  var ss = ss_();
  Object.keys(SHEETS).forEach(function (k) { console.log("Sheet " + SHEETS[k] + ": " + (ss.getSheetByName(SHEETS[k]) ? "ok" : "MISSING")); });
  var viewers = ss.getViewers().length + ss.getEditors().length;
  console.log("People with access to the spreadsheet (incl. you): " + viewers + (viewers > 1 ? "  ← review sharing: only the owner needs access." : ""));
  var d = engine_().displayPayload();
  console.log("Display feed: " + d.data.beds.length + " locations, privacy " + (d.data.privacy ? "ON" : "OFF"));
  console.log(ok ? "Configuration complete." : "Configuration incomplete.");
}
