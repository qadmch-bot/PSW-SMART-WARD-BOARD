/*
 * PSW Smart Ward Board — API layer.
 *
 * LIVE mode  (API_URL set): talks to the Google Apps Script Web App.
 *   TV:    GET  <API_URL>?action=display&key=<display key>     (de-identified feed)
 *   Admin: POST <API_URL>  {action, idToken, payload}          (Google Sign-In ID token)
 *   POST uses Content-Type text/plain so the browser sends a "simple" cross-origin request
 *   that Apps Script accepts without a CORS pre-flight.
 *
 * DEMO mode (no API_URL): runs the SAME engine (js/engine.js) in the browser against
 *   FICTIONAL data kept in this browser's localStorage. Demo mode is disabled as soon as
 *   an API URL is configured, and no real patient data is ever stored in the browser.
 */
(function () {
  "use strict";
  const CFG = window.PSW_CONFIG;
  const CONN_KEY = "psw_connection";        // API URL + OAuth client id (public, not patient data)
  const DKEY_KEY = "psw_display_key";       // TV credential for the de-identified feed
  const DEMO_KEY = "psw_demo_state_v1";     // fictional demo data only
  let idToken = "";

  // ------------------------------------------------------------ connection config
  function readConn() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CONN_KEY) || "{}"); } catch (e) { saved = {}; }
    return {
      apiUrl: (saved.apiUrl != null ? saved.apiUrl : CFG.API_URL || "").trim(),
      clientId: (saved.clientId != null ? saved.clientId : CFG.GOOGLE_CLIENT_ID || "").trim()
    };
  }
  function saveConn(c) {
    const url = String(c.apiUrl || "").trim();
    if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      return { ok: false, error: "Paste the Web App URL that ends in /exec (from Deploy → Manage deployments)." };
    }
    try { localStorage.setItem(CONN_KEY, JSON.stringify({ apiUrl: url, clientId: String(c.clientId || "").trim() })); }
    catch (e) { return { ok: false, error: "This browser blocked saving the connection." }; }
    return { ok: true };
  }
  function mode() { return readConn().apiUrl ? "live" : "demo"; }

  // TV display key: open the TV once with  index.html#key=XXXX  — it is stored and removed from the address bar.
  function captureDisplayKey() {
    const m = /[#&]key=([A-Za-z0-9]{16,128})/.exec(location.hash || "");
    if (m) {
      try { localStorage.setItem(DKEY_KEY, m[1]); } catch (e) { /* ignore */ }
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
  function displayKey() { try { return localStorage.getItem(DKEY_KEY) || ""; } catch (e) { return ""; } }
  function forgetDisplayKey() { try { localStorage.removeItem(DKEY_KEY); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ HTTP
  async function fetchJSON(url, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ cache: "no-store", redirect: "follow", signal: ctl.signal }, opts || {}));
      if (!res.ok) return { ok: false, code: "HTTP_" + res.status, error: "The server answered " + res.status + "." };
      const text = await res.text();
      try { return JSON.parse(text); }
      catch (e) { return { ok: false, code: "BAD_RESPONSE", error: "The server did not return board data. Check the Web App URL and that it is deployed for 'Anyone'." }; }
    } catch (e) {
      return { ok: false, code: "NETWORK", error: e.name === "AbortError" ? "The server took too long to answer." : "No connection to the server." };
    } finally { clearTimeout(timer); }
  }

  // ------------------------------------------------------------ demo backend
  function demoEnv() {
    return {
      now: () => new Date(),
      uuid: () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      today: () => window.PSW.todayISO(CFG.TIMEZONE)
    };
  }
  function freshDemo() {
    const settings = Object.assign({}, window.PSWSeed.SETTINGS, { privacyMode: "OFF", showNotes: "ON" });
    return {
      beds: window.PSWSeed.buildBeds(true, window.PSW.todayISO(CFG.TIMEZONE)),
      doctors: window.PSWSeed.DOCTORS.map(d => Object.assign({}, d)),
      onCall: window.PSWEngine.ENUMS.ONCALL_ROLES.map(r => ({ role: r, staffName: window.PSWSeed.DEMO_ON_CALL[r] || "", shiftDate: "", shiftStart: "", shiftEnd: "", lastUpdated: "" })),
      settings: settings,
      audit: [],
      meta: { lastModified: new Date().toISOString() },
      users: [{ email: "demo.admin@example.invalid", role: "ADMIN", active: true, name: "Demo administrator" }]
    };
  }
  function loadDemo() {
    try { const s = JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); if (s && s.beds) return s; } catch (e) { /* ignore */ }
    const s = freshDemo(); saveDemo(s); return s;
  }
  function saveDemo(s) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function demoStore() {
    const s = loadDemo();
    const clone = o => JSON.parse(JSON.stringify(o));
    return {
      readBeds: () => s.beds.map(b => Object.assign({}, b)),
      writeBeds: list => { list.forEach(b => { const i = s.beds.findIndex(x => x.bed === b.bed); if (i >= 0) s.beds[i] = Object.assign({}, b); }); saveDemo(s); },
      readDoctors: () => clone(s.doctors), writeDoctors: l => { s.doctors = clone(l); saveDemo(s); },
      readOnCall: () => clone(s.onCall), writeOnCall: l => { s.onCall = clone(l); saveDemo(s); },
      readSettings: () => clone(s.settings), writeSettings: o => { s.settings = clone(o); saveDemo(s); },
      appendAudit: e => { s.audit = s.audit.concat(e).slice(-300); saveDemo(s); },
      readAudit: n => s.audit.slice(-n).reverse(),
      readUsers: () => clone(s.users),
      getMeta: k => s.meta[k] || "", setMeta: (k, v) => { s.meta[k] = v; saveDemo(s); }
    };
  }
  const delay = ms => new Promise(r => setTimeout(r, ms));
  function demoEngine() { return window.PSWEngine.create(demoStore(), demoEnv()); }

  // ------------------------------------------------------------ public API
  async function getDisplay() {
    if (mode() === "demo") { await delay(120); return demoEngine().displayPayload(); }
    const key = displayKey();
    if (!key) return { ok: false, code: "NO_DISPLAY_KEY", error: "This screen has no TV link yet. Open the TV link from Admin → Settings → TV display." };
    return fetchJSON(readConn().apiUrl + "?action=display&key=" + encodeURIComponent(key));
  }

  async function call(action, payload) {
    if (mode() === "demo") {
      await delay(180);
      if (action === "displayKey" || action === "rotateDisplayKey") return { ok: true, data: { key: "" } };
      return demoEngine().handle(action, payload || {}, "demo.admin@example.invalid");
    }
    if (!idToken) return { ok: false, code: "UNAUTHENTICATED", error: "Sign in with your Google account first." };
    return fetchJSON(readConn().apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: action, idToken: idToken, payload: payload || {} })
    });
  }

  async function ping(url) {
    return fetchJSON((url || readConn().apiUrl) + "?action=ping");
  }

  window.PSWApi = {
    mode, readConn, saveConn, captureDisplayKey, displayKey, forgetDisplayKey, getDisplay, call, ping,
    setIdToken: t => { idToken = t || ""; },
    hasToken: () => !!idToken,
    resetDemo: () => { saveDemo(freshDemo()); },
    DEMO_KEY
  };
})();
