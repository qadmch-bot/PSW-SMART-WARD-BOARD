/*
 * PSW Smart Ward Board — Google Apps Script backend (Web App).
 *
 * Security model (see README "Security model"):
 *  - The spreadsheet stays PRIVATE to the owner. It is never published or link-shared.
 *  - The Web App runs as the owner, so staff do not need access to the spreadsheet.
 *  - READ for the TV:   GET  ?action=display&key=DISPLAY_KEY
 *        returns a de-identified feed. Privacy mode is applied here on the server.
 *  - ADMIN reads/writes: POST {action, idToken, payload}
 *        idToken is a Google Sign-In ID token. It is verified with Google on every
 *        request (audience = your OAuth Client ID, verified e-mail, not expired), then
 *        the e-mail must be ACTIVE in the USERS sheet with the right role.
 *  - Every write is validated, serialised with a lock, and written to AUDIT LOG.
 *
 * Script Properties (Project Settings → Script properties):
 *   SPREADSHEET_ID   set automatically by setupDatabase()
 *   DISPLAY_KEY      set automatically by setupDatabase(); rotate with rotateDisplayKey()
 *   OAUTH_CLIENT_ID  your Google OAuth 2.0 Web Client ID (same as js/config.js)
 */

var VERSION = "1.0.0";

var SHEETS = {
  BEDS: "BEDS", DOCTORS: "DOCTORS", ONCALL: "ON CALL TEAM", SETTINGS: "SETTINGS", AUDIT: "AUDIT LOG", USERS: "USERS"
};
var HEADERS = {
  BEDS: ["Room", "Bed", "Bed Type", "Operational Status", "Occupancy Status", "Patient Code", "Age", "Gender",
    "Responsible Doctor", "Patient Status", "Isolation Precaution", "Clinical Note", "Admission Date",
    "Expected Discharge Date", "Last Updated", "Updated By"],
  DOCTORS: ["Doctor Name", "Doctor Level", "Active"],
  ONCALL: ["Role", "Staff Name", "Shift Date", "Shift Start", "Shift End", "Last Updated"],
  SETTINGS: ["Setting Name", "Setting Value"],
  AUDIT: ["Timestamp", "User", "Action", "Bed", "Previous Value", "New Value", "Record ID"],
  USERS: ["Email", "Role", "Active", "Name / Position"]
};
var BED_KEYS = ["room", "bed", "bedType", "operationalStatus", "occupancyStatus", "patientCode", "age", "gender",
  "doctor", "patientStatus", "isolationPrecaution", "note", "admissionDate", "expectedDischarge", "lastUpdated", "updatedBy"];
var ONCALL_KEYS = ["role", "staffName", "shiftDate", "shiftStart", "shiftEnd", "lastUpdated"];
var WRITE_ACTIONS = ["updateBed", "markAvailable", "setOperational", "updateOnCall", "updateSettings", "updateDoctors"];
var MAX_BODY = 120000;

// ================================================================== HTTP entry points

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === "ping") return json_({ ok: true, data: { service: "PSW Smart Ward Board", version: VERSION } });
    if (p.action === "display") {
      if (!checkDisplayKey_(p.key)) return json_({ ok: false, code: "UNAUTHORIZED", error: "This screen is not authorised. Open the TV link from Admin → Settings → TV display." });
      return json_(engine_().displayPayload());
    }
    return json_({ ok: false, code: "UNKNOWN_ACTION", error: "Unknown request." });
  } catch (err) {
    return json_(safeError_(err));
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || "";
    if (raw.length > MAX_BODY) return json_({ ok: false, code: "TOO_LARGE", error: "The request is too large." });
    var req;
    try { req = JSON.parse(raw); } catch (x) { return json_({ ok: false, code: "BAD_REQUEST", error: "Malformed request." }); }
    var action = String(req.action || "");
    var email = verifyIdToken_(req.idToken);
    if (!email) return json_({ ok: false, code: "UNAUTHENTICATED", error: "Your sign-in has expired or is invalid. Sign in again with your Google account." });

    if (action === "displayKey" || action === "rotateDisplayKey") return json_(displayKeyAction_(action, email));

    if (WRITE_ACTIONS.indexOf(action) >= 0) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) return json_({ ok: false, code: "BUSY", error: "The board is saving another change. Try again in a few seconds." });
      try { return json_(engine_().handle(action, req.payload || {}, email)); }
      finally { SpreadsheetApp.flush(); lock.releaseLock(); }
    }
    return json_(engine_().handle(action, req.payload || {}, email));
  } catch (err) {
    return json_(safeError_(err));
  }
}

// ================================================================== auth

/** Verifies a Google Sign-In ID token with Google. Returns the verified e-mail or "". */
function verifyIdToken_(token) {
  token = String(token || "");
  if (token.length < 100 || token.length > 4096) return "";
  var clientId = prop_("OAUTH_CLIENT_ID");
  if (!clientId) throw new Error("OAUTH_CLIENT_ID script property is not set.");
  var cache = CacheService.getScriptCache();
  var ck = "tok_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  var hit = cache.get(ck);
  if (hit) return hit === "-" ? "" : hit;

  var res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { cache.put(ck, "-", 60); return ""; }
  var info = JSON.parse(res.getContentText());
  var now = Math.floor(Date.now() / 1000);
  var ok = info.aud === clientId &&
    (info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com") &&
    (info.email_verified === true || info.email_verified === "true") &&
    Number(info.exp) > now && info.email;
  if (!ok) { cache.put(ck, "-", 60); return ""; }
  var ttl = Math.max(1, Math.min(Number(info.exp) - now, 3000));
  cache.put(ck, String(info.email).toLowerCase(), ttl);
  return String(info.email).toLowerCase();
}

function checkDisplayKey_(key) {
  var expected = prop_("DISPLAY_KEY");
  key = String(key || "");
  if (!expected || key.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function displayKeyAction_(action, email) {
  var eng = engine_();
  var user = eng.authorize(email);
  if (!user) return { ok: false, code: "UNAUTHORIZED", error: "Your account is not on the PSW authorised staff list." };
  if (user.role !== "ADMIN") return { ok: false, code: "FORBIDDEN", error: "The TV link is available to administrators only." };
  if (action === "rotateDisplayKey") {
    PropertiesService.getScriptProperties().setProperty("DISPLAY_KEY", newKey_());
    store_().appendAudit([{ timestamp: new Date().toISOString(), user: email, action: "ROTATE_DISPLAY_KEY", bed: "", previous: "", next: "", recordId: Utilities.getUuid() }]);
  }
  return { ok: true, data: { key: prop_("DISPLAY_KEY") } };
}

function newKey_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""); }

// ================================================================== engine + store

function engine_() {
  return PSWEngine.create(store_(), {
    now: function () { return new Date(); },
    uuid: function () { return Utilities.getUuid(); },
    today: function () { return Utilities.formatDate(new Date(), "Asia/Riyadh", "yyyy-MM-dd"); }
  });
}

function ss_() {
  var id = prop_("SPREADSHEET_ID");
  if (!id) throw new Error("SPREADSHEET_ID is not set. Run setupDatabase() first.");
  return SpreadsheetApp.openById(id);
}

function store_() {
  var ss = ss_();
  var memo = {};
  function sheet(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) throw new Error("Missing sheet: " + name + ". Run setupDatabase().");
    return sh;
  }
  function rows(name) {
    if (memo[name]) return memo[name];
    var sh = sheet(name);
    var last = sh.getLastRow();
    var width = sh.getLastColumn();
    memo[name] = last < 2 ? [] : sh.getRange(2, 1, last - 1, width).getValues();
    return memo[name];
  }
  function cell(v) {
    if (v instanceof Date) return Utilities.formatDate(v, "Asia/Riyadh", "yyyy-MM-dd");
    return v == null ? "" : String(v).trim();
  }
  function bool(v) { return v === true || String(v).toUpperCase() === "TRUE"; }

  return {
    readBeds: function () {
      return rows(SHEETS.BEDS).map(function (r, i) {
        var o = { _row: i + 2 };
        BED_KEYS.forEach(function (k, c) { o[k] = cell(r[c]); });
        if (!o.isolationPrecaution) o.isolationPrecaution = "None";
        return o;
      }).filter(function (b) { return b.bed; });
    },
    writeBeds: function (beds) {
      var sh = sheet(SHEETS.BEDS);
      beds.forEach(function (b) {
        if (!b._row) throw new Error("Bed row unknown");
        sh.getRange(b._row, 1, 1, BED_KEYS.length).setValues([BED_KEYS.map(function (k) { return b[k] == null ? "" : String(b[k]); })]);
      });
      delete memo[SHEETS.BEDS];
    },
    readDoctors: function () {
      return rows(SHEETS.DOCTORS).filter(function (r) { return r[0]; })
        .map(function (r) { return { name: cell(r[0]), level: cell(r[1]), active: bool(r[2]) }; });
    },
    writeDoctors: function (list) {
      var sh = sheet(SHEETS.DOCTORS);
      var last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
      if (list.length) sh.getRange(2, 1, list.length, 3).setValues(list.map(function (d) { return [d.name, d.level, !!d.active]; }));
      delete memo[SHEETS.DOCTORS];
    },
    readOnCall: function () {
      return rows(SHEETS.ONCALL).filter(function (r) { return r[0]; }).map(function (r) {
        var o = {}; ONCALL_KEYS.forEach(function (k, c) { o[k] = cell(r[c]); });
        if (r[3] instanceof Date) o.shiftStart = Utilities.formatDate(r[3], "Asia/Riyadh", "HH:mm");
        if (r[4] instanceof Date) o.shiftEnd = Utilities.formatDate(r[4], "Asia/Riyadh", "HH:mm");
        return o;
      });
    },
    writeOnCall: function (list) {
      var sh = sheet(SHEETS.ONCALL);
      var last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, ONCALL_KEYS.length).clearContent();
      sh.getRange(2, 1, list.length, ONCALL_KEYS.length).setValues(list.map(function (r) { return ONCALL_KEYS.map(function (k) { return r[k] || ""; }); }));
      delete memo[SHEETS.ONCALL];
    },
    readSettings: function () {
      var byName = {};
      rows(SHEETS.SETTINGS).forEach(function (r) { byName[cell(r[0])] = cell(r[1]); });
      var o = {};
      PSWEngine.SETTINGS.forEach(function (s) { o[s[1]] = byName[s[0]] != null ? byName[s[0]] : (PSWSeed.SETTINGS[s[1]] || ""); });
      return o;
    },
    writeSettings: function (obj) {
      var sh = sheet(SHEETS.SETTINGS);
      var values = PSWEngine.SETTINGS.map(function (s) { return [s[0], obj[s[1]] == null ? "" : String(obj[s[1]])]; });
      var last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, 2).clearContent();
      sh.getRange(2, 1, values.length, 2).setValues(values);
      delete memo[SHEETS.SETTINGS];
    },
    appendAudit: function (entries) {
      var sh = sheet(SHEETS.AUDIT);
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, entries.length, 7).setValues(entries.map(function (a) {
        return [a.timestamp, a.user, a.action, a.bed, a.previous, a.next, a.recordId];
      }));
    },
    readAudit: function (limit) {
      var sh = sheet(SHEETS.AUDIT);
      var last = sh.getLastRow();
      if (last < 2) return [];
      var n = Math.min(limit, last - 1);
      return sh.getRange(last - n + 1, 1, n, 7).getValues().reverse().map(function (r) {
        return { timestamp: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), user: String(r[1]), action: String(r[2]),
          bed: String(r[3]), previous: String(r[4]), next: String(r[5]), recordId: String(r[6]) };
      });
    },
    readUsers: function () {
      return rows(SHEETS.USERS).filter(function (r) { return r[0]; })
        .map(function (r) { return { email: cell(r[0]).toLowerCase(), role: cell(r[1]).toUpperCase(), active: bool(r[2]), name: cell(r[3]) }; });
    },
    getMeta: function (k) { return prop_("META_" + k) || ""; },
    setMeta: function (k, v) { PropertiesService.getScriptProperties().setProperty("META_" + k, String(v)); }
  };
}

// ================================================================== utils

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ""; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeError_(err) {
  console.error(err && err.stack || err);
  var msg = String(err && err.message || err);
  if (/SPREADSHEET_ID|OAUTH_CLIENT_ID|Missing sheet/.test(msg)) return { ok: false, code: "NOT_CONFIGURED", error: "The backend is not fully configured: " + msg };
  return { ok: false, code: "SERVER_ERROR", error: "The board could not complete the request. Try again; if it repeats, tell the administrator." };
}
