/*
 * PSW Smart Ward Board — TV dashboard (read-only).
 * The clock runs independently of data refresh. Data refreshes in place (no page reload).
 * Last good data is kept IN MEMORY only, and is visibly marked when the connection fails.
 */
(function () {
  "use strict";
  const CFG = window.PSW_CONFIG, P = window.PSW, API = window.PSWApi;
  const $ = id => document.getElementById(id);
  const TZ = CFG.TIMEZONE;

  const state = { data: null, lastOkAt: 0, lastError: null, timer: null, prevSig: {}, busy: false };

  // ------------------------------------------------------------ stage scaling
  function scale() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    document.getElementById("stage").style.setProperty("--scale", s);
  }
  window.addEventListener("resize", scale);
  scale();

  // ------------------------------------------------------------ clock (independent)
  function tick() {
    const now = new Date();
    $("clockDate").textContent = P.fmtDate(now, TZ);
    const t = P.fmtTime(now, TZ, false).split(" ");
    $("clockTime").innerHTML = P.esc(t[0]) + "<small>" + P.esc(t[1] || "") + "</small>";
    renderSync();
  }
  setInterval(tick, 1000);
  tick();

  // ------------------------------------------------------------ header / static text
  function renderHeader(s) {
    P.setLang(s.language);
    $("hospitalName").textContent = s.hospitalName || "";
    $("hospitalNameAr").textContent = s.hospitalNameAr || "";
    $("cluster").textContent = s.cluster || "";
    $("deptName").textContent = s.departmentName || "";
    $("deptNameAr").textContent = s.departmentNameAr || "";
    const tg = (s.tagline || "").split(/,\s*/);
    $("tagline").innerHTML = tg.map(P.esc).join(",\n") + (s.tagline ? ' <span class="heart">♡</span>' : "");
    const logo = $("logo");
    const want = s.logo || "assets/logo-placeholder.png";
    if (logo.getAttribute("src") !== want) logo.setAttribute("src", want);
    document.title = (s.departmentCode || "PSW") + " Ward Board";
    $("h-summary").innerHTML = P.icon("bars", "", 2.6) + P.esc(P.t("wardSummary"));
    $("h-oncall").innerHTML = P.icon("users") + P.esc(P.t("onCallTeam"));
  }

  // ------------------------------------------------------------ KPIs
  function kpiCard(cls, label, iconName, value, sub) {
    return '<div class="kpi ' + cls + '"><div class="kpi-label">' + P.esc(label) + '</div><div class="kpi-main"><span class="kpi-icon">' +
      P.icon(iconName) + '</span><span class="kpi-value">' + value + '</span></div><div class="kpi-sub">' + P.esc(sub || "") + "</div></div>";
  }
  function renderKpis(k) {
    const C = 2 * Math.PI * 22;
    const off = C * (1 - Math.min(k.rate, 100) / 100);
    const ringCls = k.rate >= 100 ? "full" : k.rate >= 90 ? "high" : "";
    const ring = '<svg class="ring ' + ringCls + '" viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="22" fill="none" stroke-width="8"/>' +
      '<circle class="val" cx="27" cy="27" r="22" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + C.toFixed(2) +
      '" stroke-dashoffset="' + off.toFixed(2) + '" transform="rotate(-90 27 27)"/></svg>';
    $("kpis").innerHTML =
      kpiCard("k-total", P.t("totalBeds"), "bed", k.operational, k.outOfService ? k.outOfService + " " + P.t("outOfServiceShort") : "") +
      kpiCard("k-occ", P.t("occupied"), "person", k.occupied) +
      kpiCard("k-avail", P.t("available"), "bed", k.available) +
      '<div class="kpi k-rate"><div class="kpi-label">' + P.esc(P.t("occupancyRate")) + '</div><div class="kpi-main">' + ring +
      '<span class="kpi-value">' + k.rate + '<span class="pct">%</span></span></div><div class="kpi-sub">' + k.occupied + " / " + k.operational + "</div></div>" +
      kpiCard("k-disc", P.t("forDischarge"), "door", k.discharge) +
      kpiCard("k-iso", P.t("isolation"), "shieldPlus", k.isolation) +
      kpiCard("k-trans", P.t("transfer"), "swap", k.transfer) +
      kpiCard("k-new", P.t("newAdmission"), "userPlus", k.newAdmission);
  }

  // ------------------------------------------------------------ ward map
  function sig(b) {
    return [b.operationalStatus, b.occupancyStatus, b.patientCode, b.doctor, b.patientStatus, b.isolationPrecaution, b.note].join("|");
  }
  function renderWard(d) {
    const groups = P.groupRooms(d.beds);
    const rows = P.packRows(groups, 10);
    const opts = { privacy: d.privacy, showNotes: true };
    let html = "";
    rows.forEach(row => {
      html += '<div class="ward-row">';
      row.forEach(g => {
        const t = g.type === "Close Observation" ? "t-obs" : (g.type === "Isolation" || g.type === "Negative Pressure") ? "t-iso" : "t-reg";
        let hIcon = "";
        if (t === "t-obs") hIcon = P.icon("eye");
        if (t === "t-iso") hIcon = P.icon("shieldAlert");
        const hasNP = g.beds.some(b => b.bedType === "Negative Pressure");
        html += '<section class="room ' + t + '" style="flex:' + g.beds.length + ' 1 0">' +
          '<div class="room-h"><span class="name">' + hIcon + P.esc(P.roomTitle(g)) + "</span>" + (t === "t-obs" ? "" : '<span class="count">(' + g.beds.length + " " + P.esc(P.t("beds")) + ")</span>") +
          (hasNP ? '<span class="np-key"><span class="badge b-np">' + P.icon("negPressure") + "</span>" + P.esc(P.t("negPressure")) + "</span>" : "") +
          '</div><div class="room-beds" style="grid-template-columns:repeat(' + g.beds.length + ',1fr)">' +
          g.beds.map(b => P.bedCardHTML(b, opts)).join("") + "</div></section>";
      });
      html += "</div>";
    });
    $("ward").innerHTML = html;
    // Brief highlight on cards that changed since the previous refresh.
    const first = !Object.keys(state.prevSig).length;
    d.beds.forEach(b => {
      const s = sig(b);
      if (!first && state.prevSig[b.bed] !== s) {
        const el = $("ward").querySelector('[data-bed="' + CSS.escape(b.bed) + '"]');
        if (el) el.classList.add("changed");
      }
      state.prevSig[b.bed] = s;
    });
    P.fitText($("ward"));
  }

  // ------------------------------------------------------------ sidebar
  function renderSide(d, k) {
    const rows = [
      ["stable", "occupiedBeds", k.occupied], ["available", "availableBeds", k.available], ["discharge", "forDischarge", k.discharge],
      ["isolation", "isolation", k.isolation], ["transfer", "transfer", k.transfer], ["newadm", "newAdmission", k.newAdmission]
    ];
    $("summary").innerHTML = rows.map(r => '<div class="sum-row"><span class="dot ' + r[0] + '"></span>' + P.esc(P.t(r[1])) + '<span class="v">' + r[2] + "</span></div>").join("");

    const byRole = {};
    (d.onCall || []).forEach(r => { byRole[r.role] = r; });
    $("oncall").innerHTML = P.ENUMS.ONCALL_ROLES.map(role => {
      const r = byRole[role] || {};
      const nurse = /Nurse/.test(role);
      const shift = r.staffName && r.shiftStart && r.shiftEnd ? P.esc(r.shiftStart) + "–" + P.esc(r.shiftEnd) : "";
      return '<div class="oc-row' + (nurse ? " nurse" : "") + '">' + P.icon(nurse ? "nurse" : "stethoscope") +
        '<div class="oc-text"><div class="oc-role">' + P.esc(P.t(role)) + '</div><div class="oc-name' + (r.staffName ? "" : " empty") + '">' +
        P.esc(r.staffName || P.t("notAssigned")) + '</div></div><div class="oc-shift">' + shift + "</div></div>";
    }).join("");

    const s = d.settings || {};
    const ext = v => v ? '<span class="ext">' + P.esc(v) + "</span>" : '<span class="ext empty">' + P.esc(P.t("notSet")) + "</span>";
    $("emergency").innerHTML =
      '<div class="em rrt">' + P.icon("siren") + P.esc(P.t("rrt")) + ext(s.rrtExtension) + "</div>" +
      '<div class="em cb">' + P.icon("heartPulse") + P.esc(P.t("codeBlue")) + ext(s.codeBlueExtension) + "</div>";
  }

  function renderLegend() {
    const L = [["stable", P.t("legendStable")], ["postop", P.t("legendPostOp")], ["discharge", P.t("forDischarge")], ["isolation", P.t("isolation")],
      ["transfer", P.t("transfer")], ["newadm", P.t("newAdmission")], ["available", P.tStatus("Available")]];
    $("legend").innerHTML = L.map(x => '<span><i class="dot ' + x[0] + '"></i>' + P.esc(x[1]) + "</span>").join("") +
      '<span><i class="badge b-obs">' + P.icon("eye") + "</i>" + P.esc(P.t("closeObs")) + "</span>" +
      '<span><i class="badge b-np">' + P.icon("negPressure") + "</i>" + P.esc(P.t("negPressure")) + "</span>";
  }

  // ------------------------------------------------------------ sync status
  function intervalMs() {
    const s = state.data && state.data.settings;
    const v = parseInt(s && s.refreshInterval, 10) || CFG.DEFAULT_REFRESH_SECONDS;
    return Math.max(CFG.MIN_REFRESH_SECONDS, v) * 1000;
  }
  function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    return m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago";
  }
  function renderSync() {
    const el = $("sync"); if (!el) return;
    const demo = API.mode() === "demo";
    const stage = $("stage"), banner = $("connBanner");
    const now = Date.now();
    const stale = state.lastOkAt && (now - state.lastOkAt) > intervalMs() * CFG.STALE_AFTER_MISSED_CYCLES;
    let pill, when;
    if (state.lastError && state.lastOkAt) {
      pill = '<span class="pill err">' + P.esc(P.t("connectionLost")) + "</span>";
      when = P.esc(P.t("lastGood")) + " <b>" + P.esc(P.fmtTime(new Date(state.lastOkAt), TZ, true)) + "</b><br>" + ago(now - state.lastOkAt);
      banner.hidden = false;
      banner.innerHTML = P.icon("alert") + P.esc(stale ? P.t("outdated") : P.t("connectionLost")) + " — " +
        P.esc(P.t("lastGood")) + " " + P.esc(P.fmtTime(new Date(state.lastOkAt), TZ, false)) + " (" + ago(now - state.lastOkAt) + ")";
    } else if (state.lastError) {
      pill = '<span class="pill err">' + P.esc(P.t("connectionLost")) + "</span>";
      when = P.esc(state.lastError.error || "");
      banner.hidden = true;
    } else if (state.lastOkAt) {
      pill = demo ? '<span class="pill demo">Demo</span>' : '<span class="pill ok">' + P.esc(P.t("live")) + "</span>";
      when = P.esc(P.t("updated")) + " <b>" + P.esc(P.fmtTime(new Date(state.lastOkAt), TZ, true)) + "</b>" +
        (demo ? "<br>" + P.esc(P.t("demo")) : "");
      banner.hidden = true;
    } else {
      pill = '<span class="pill demo">…</span>'; when = P.esc(P.t("connecting"));
    }
    stage.classList.toggle("stale", !!(state.lastError && stale));
    const priv = state.data && state.data.privacy ? '<span class="priv">' + P.icon("lock") + P.esc(P.t("privacyOn")) + "</span>" : "";
    el.innerHTML = pill + '<span class="when">' + when + "</span>" + priv;
  }

  // ------------------------------------------------------------ refresh loop
  function render() {
    const d = state.data;
    renderHeader(d.settings || {});
    const k = P.computeKpis(d.beds);
    renderKpis(k);
    renderWard(d);
    renderSide(d, k);
    renderLegend();
    renderSync();
  }

  function showMessage(title, text) {
    $("ward").innerHTML = '<div class="ward-msg"><div><h2>' + P.esc(title) + "</h2><p>" + P.esc(text) + "</p></div></div>";
  }

  async function refresh() {
    if (state.busy) { state.again = true; return; }   // a change arrived mid-request: fetch again right after
    state.busy = true; state.again = false;
    clearTimeout(state.timer);
    try {
      const res = await API.getDisplay();
      if (res && res.ok && res.data && Array.isArray(res.data.beds)) {
        state.data = res.data; state.lastOkAt = Date.now(); state.lastError = null;
        render();
      } else {
        state.lastError = res || { error: "Unknown error" };
        if (res && (res.code === "UNAUTHORIZED" || res.code === "NO_DISPLAY_KEY")) {
          state.data = null; state.lastOkAt = 0;    // never keep showing data after the key is revoked
          $("kpis").innerHTML = ""; $("summary").innerHTML = ""; $("oncall").innerHTML = ""; $("emergency").innerHTML = "";
          showMessage("This screen is not connected", res.error);
        } else if (!state.data) {
          showMessage("Waiting for ward data", (res && res.error ? res.error + " " : "") + "The board retries automatically.");
        }
        renderSync();
      }
    } finally {
      state.busy = false;
      state.timer = setTimeout(refresh, state.again ? 50 : state.lastError ? Math.min(intervalMs(), 15000) : intervalMs());
    }
  }

  // Demo mode: the Admin page in another tab changes localStorage — show it immediately.
  window.addEventListener("storage", e => { if (e.key === API.DEMO_KEY && API.mode() === "demo") refresh(); });
  window.addEventListener("online", refresh);
  window.addEventListener("hashchange", () => { if (/key=/.test(location.hash)) { API.captureDisplayKey(); refresh(); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  // ------------------------------------------------------------ full screen + cursor
  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen && document.exitFullscreen();
  }
  document.addEventListener("keydown", e => { if (e.key === "f" || e.key === "F") toggleFs(); if (e.key === "r" || e.key === "R") refresh(); });
  document.addEventListener("dblclick", toggleFs);
  let cursorTimer;
  document.addEventListener("mousemove", () => {
    document.body.classList.remove("hide-cursor");
    const h = $("fsHint"); if (!document.fullscreenElement) h.classList.add("show");
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => { document.body.classList.add("hide-cursor"); h.classList.remove("show"); }, 3000);
  });
  // Prevent the TV from sleeping where supported.
  if (navigator.wakeLock) { const lock = () => navigator.wakeLock.request("screen").catch(() => {}); lock(); document.addEventListener("visibilitychange", () => { if (!document.hidden) lock(); }); }

  API.captureDisplayKey();
  renderLegend();
  refresh();
  window.PSWDashboard = { refresh, state };
})();
