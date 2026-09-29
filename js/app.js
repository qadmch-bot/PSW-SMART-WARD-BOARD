/*
 * PSW Smart Ward Board — shared core used by the TV dashboard and the Admin page.
 * Contains: vocabularies, icons, KPI engine, client-side validation (the server
 * repeats every check), bed-card renderer, i18n, time helpers.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- vocabularies
  // These MUST match google-apps-script/Code.gs (ENUMS).
  const ENUMS = {
    BED_TYPE: ["Regular", "Close Observation", "Isolation", "Negative Pressure"],
    OPERATIONAL: ["Operational", "Out of Service"],
    OCCUPANCY: ["Occupied", "Available"],
    GENDER: ["M", "F"],
    PATIENT_STATUS: ["Stable", "Post Operative", "For Discharge", "Transfer", "New Admission"],
    ISOLATION: ["None", "Contact", "Droplet", "Airborne", "Contact + Droplet", "Contact + Airborne", "Protective"],
    DOCTOR_LEVEL: ["Consultant", "Specialist"],
    ONCALL_ROLES: ["Consultant On Call", "Specialist On Call", "Charge Nurse", "Nurse Supervisor"]
  };

  const RULES = {
    patientCode: /^[A-Z0-9][A-Z0-9-]{1,11}$/,     // e.g. P00123 — fictional code or masked MRN, never a name
    age: /^([0-9]{1,2})\s?(D|W|M|Y)$/,              // 12D, 3W, 7M, 5Y
    date: /^\d{4}-\d{2}-\d{2}$/,
    extension: /^[0-9]{2,8}$/,
    noteMax: 60,
    staffNameMax: 40
  };

  // ------------------------------------------------------------------- i18n
  const I18N = {
    en: {
      totalBeds: "Total Beds", occupied: "Occupied", available: "Available", occupancyRate: "Occupancy Rate",
      forDischarge: "For Discharge", isolation: "Isolation", transfer: "Transfer", newAdmission: "New Admission",
      wardSummary: "Ward Summary", occupiedBeds: "Occupied Beds", availableBeds: "Available Beds",
      onCallTeam: "On Call Team", emergencyTeam: "Emergency Team", rrt: "RRT Team", codeBlue: "Code Blue Team",
      notAssigned: "Not assigned", notSet: "Not set", beds: "beds", bed: "Bed",
      closeObs: "Close Observation", isoRooms: "Isolation Rooms", negPressure: "Negative Pressure",
      outOfService: "Out of Service", outOfServiceShort: "out of service", privacyOn: "Privacy mode",
      live: "Live", updated: "Updated", connectionLost: "Connection lost", lastGood: "Showing data from",
      outdated: "Data may be outdated — check the ward records", connecting: "Connecting…",
      demo: "Demo data — fictional patients", stable: "Stable", postOp: "Post Operative",
      legendStable: "Occupied / Stable", legendPostOp: "Post Operative",
      "Consultant On Call": "Consultant On Call", "Specialist On Call": "Specialist On Call",
      "Charge Nurse": "Charge Nurse", "Nurse Supervisor": "Nurse Supervisor",
      patientSafety: "Patient safety", ourPriority: "our priority",
      teamwork: "Teamwork", makesDifference: "makes the difference",
      betterCare: "Better care", brighterFutures: "brighter futures"
    },
    ar: {
      totalBeds: "إجمالي الأسرة", occupied: "مشغول", available: "متاح", occupancyRate: "نسبة الإشغال",
      forDischarge: "للخروج", isolation: "عزل", transfer: "تحويل", newAdmission: "تنويم جديد",
      wardSummary: "ملخص القسم", occupiedBeds: "الأسرة المشغولة", availableBeds: "الأسرة المتاحة",
      onCallTeam: "فريق المناوبة", emergencyTeam: "فريق الطوارئ", rrt: "فريق الاستجابة السريعة", codeBlue: "فريق الكود الأزرق",
      notAssigned: "غير محدد", notSet: "غير محدد", beds: "أسرة", bed: "سرير",
      closeObs: "الملاحظة الدقيقة", isoRooms: "غرف العزل", negPressure: "ضغط سلبي",
      outOfService: "خارج الخدمة", outOfServiceShort: "خارج الخدمة", privacyOn: "وضع الخصوصية",
      live: "مباشر", updated: "آخر تحديث", connectionLost: "انقطع الاتصال", lastGood: "بيانات من",
      outdated: "قد تكون البيانات قديمة — راجع سجلات القسم", connecting: "جارٍ الاتصال…",
      demo: "بيانات تجريبية — مرضى وهميون", stable: "مستقر", postOp: "بعد العملية",
      legendStable: "مشغول / مستقر", legendPostOp: "بعد العملية",
      "Consultant On Call": "الاستشاري المناوب", "Specialist On Call": "الأخصائي المناوب",
      "Charge Nurse": "رئيسة التمريض المناوبة", "Nurse Supervisor": "مشرفة التمريض",
      patientSafety: "سلامة المريض", ourPriority: "أولويتنا",
      teamwork: "العمل الجماعي", makesDifference: "يصنع الفرق",
      betterCare: "رعاية أفضل", brighterFutures: "مستقبل أجمل"
    }
  };
  const STATUS_AR = {
    "Stable": "مستقر", "Post Operative": "بعد العملية", "For Discharge": "للخروج",
    "Transfer": "تحويل", "New Admission": "تنويم جديد", "Available": "متاح", "Out of Service": "خارج الخدمة"
  };
  let lang = "en";
  function setLang(l) { lang = (l === "ar") ? "ar" : "en"; document.documentElement.lang = lang; }
  function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key; }
  function tStatus(s) { return lang === "ar" ? (STATUS_AR[s] || s) : s; }
  const CARD_SHORT = { "Post Operative": "Post Op" };
  function tCard(s) { return lang === "ar" ? (STATUS_AR[s] || s) : (CARD_SHORT[s] || s); }

  // ------------------------------------------------------------------- icons
  // Hand-drawn 24px line icons; colour via currentColor.
  const P = {
    bed: '<path d="M3 6v13M3 15h18v4M21 15v-2.5A3.5 3.5 0 0 0 17.5 9H11v6"/><circle cx="7" cy="11.5" r="2.2"/>',
    person: '<circle cx="12" cy="7.5" r="4.2" fill="currentColor" stroke="none"/><path d="M3.5 21.5c.6-4.6 4-7.6 8.5-7.6s7.9 3 8.5 7.6z" fill="currentColor" stroke="none"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.8 3.1-6 6.5-6s6 2.2 6.5 6"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.2c2.8.2 4.6 2.2 5 5.3"/>',
    bars: '<path d="M5 20v-7M10 20V9M15 20V5M20 20v-9"/>',
    door: '<path d="M13 3H5v18h8"/><path d="M9 12h12M17.5 8.5 21 12l-3.5 3.5"/>',
    shieldPlus: '<path d="M12 2.8 20 6v6c0 5-3.5 8.3-8 9.4-4.5-1.1-8-4.4-8-9.4V6z"/><path d="M12 8.5v7M8.5 12h7"/>',
    shieldAlert: '<path d="M12 2.8 20 6v6c0 5-3.5 8.3-8 9.4-4.5-1.1-8-4.4-8-9.4V6z"/><path d="M12 7.8v5.4M12 16.3v.4"/>',
    swap: '<path d="M4 8h15M15.5 4.5 19 8l-3.5 3.5M20 16H5M8.5 12.5 5 16l3.5 3.5"/>',
    userPlus: '<circle cx="10" cy="7.5" r="4"/><path d="M2.5 21c.5-4.1 3.5-7 7.5-7 1.6 0 3 .4 4.2 1.2"/><path d="M18.5 13.5v7M15 17h7"/>',
    postOp: '<rect x="1.5" y="8" width="21" height="8" rx="4" transform="rotate(-45 12 12)"/><path d="M9 9l6 6" stroke-dasharray="0.1 2.7"/><path d="M10.6 12h.01M12 10.6h.01M13.4 12h.01M12 13.4h.01"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3.2"/>',
    negPressure: '<rect x="2.5" y="2.5" width="19" height="19" rx="4"/><path d="M6.5 6.5l3.2 3.2M9.7 6.9v2.8H6.9M17.5 6.5l-3.2 3.2M14.3 6.9v2.8h2.8M6.5 17.5l3.2-3.2M9.7 17.1v-2.8H6.9M17.5 17.5l-3.2-3.2M14.3 17.1v-2.8h2.8"/>',
    phone: '<path d="M5 3.5h3.6l1.9 4.8-2.4 1.5a11 11 0 0 0 6.1 6.1l1.5-2.4 4.8 1.9V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5.5a2 2 0 0 1 2-2z"/>',
    heartPulse: '<path d="M20.6 5.4a5.2 5.2 0 0 0-7.4 0L12 6.6l-1.2-1.2a5.2 5.2 0 1 0-7.4 7.4l8.6 8.6 8.6-8.6a5.2 5.2 0 0 0 0-7.4z"/><path d="M3 12h4.5l2-3 3 6 2-3H21"/>',
    siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M4.5 21h15v-3h-15zM12 2.5v2M4 5.5l1.5 1.5M20 5.5 18.5 7"/>',
    stethoscope: '<path d="M5 3v6a5 5 0 0 0 10 0V3"/><path d="M10 14v1.5a5 5 0 0 0 10 0V13"/><circle cx="20" cy="11" r="2"/>',
    nurse: '<circle cx="12" cy="9" r="3.6"/><path d="M4.5 21c.6-4 3.6-6.6 7.5-6.6s6.9 2.6 7.5 6.6"/><path d="M7.5 5.2 12 2.5l4.5 2.7"/><path d="M12 3.2v1.6M11.2 4h1.6"/>',
    wrench: '<path d="M14.7 6.3a4.2 4.2 0 0 0-5.5 5.5L3 18l3 3 6.2-6.2a4.2 4.2 0 0 0 5.5-5.5l-2.7 2.7-2.4-.6-.6-2.4z"/>',
    alert: '<path d="M12 3 22 20.5H2z"/><path d="M12 9.5v5M12 17.5v.3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    heart: '<path d="M20.6 5.4a5.2 5.2 0 0 0-7.4 0L12 6.6l-1.2-1.2a5.2 5.2 0 1 0-7.4 7.4l8.6 8.6 8.6-8.6a5.2 5.2 0 0 0 0-7.4z"/>',
    star: '<path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 3.5V8h4.5M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20.5V16h-4.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.5M4.5 12h.5M4.5 18h.5"/>',
    tv: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    logout: '<path d="M10 3H4v18h6"/><path d="M9 12h12M17.5 8.5 21 12l-3.5 3.5"/>'
  };
  function icon(name, cls, sw) {
    const body = P[name] || "";
    return '<svg class="ic ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }

  // ------------------------------------------------------------------ helpers
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function isOperational(b) { return b.operationalStatus !== "Out of Service"; }
  function isOccupied(b) { return isOperational(b) && b.occupancyStatus === "Occupied"; }
  function hasIsolation(b) { return !!b.isolationPrecaution && b.isolationPrecaution !== "None"; }

  // The card's primary colour. Priority (highest first):
  // Out of service > Available > Transfer > For Discharge > Isolation > Post Operative > New Admission > Stable.
  // Every other active condition is shown as a small badge on the card.
  function primaryState(b) {
    if (!isOperational(b)) return "oos";
    if (b.occupancyStatus !== "Occupied") return "available";
    if (b.patientStatus === "Transfer") return "transfer";
    if (b.patientStatus === "For Discharge") return "discharge";
    if (hasIsolation(b)) return "isolation";
    if (b.patientStatus === "Post Operative") return "postop";
    if (b.patientStatus === "New Admission") return "newadm";
    return "stable";
  }

  // ------------------------------------------------------------------ KPI engine
  function computeKpis(beds) {
    const k = { locations: beds.length, operational: 0, outOfService: 0, occupied: 0, available: 0,
      discharge: 0, isolation: 0, transfer: 0, newAdmission: 0, postOp: 0, rate: 0 };
    beds.forEach(b => {
      if (!isOperational(b)) { k.outOfService++; return; }
      k.operational++;
      if (b.occupancyStatus !== "Occupied") { k.available++; return; }
      k.occupied++;                                   // discharge/transfer/post-op/new admission stay occupied
      if (b.patientStatus === "For Discharge") k.discharge++;
      if (b.patientStatus === "Transfer") k.transfer++;
      if (b.patientStatus === "New Admission") k.newAdmission++;
      if (b.patientStatus === "Post Operative") k.postOp++;
      if (hasIsolation(b)) k.isolation++;            // precaution on an occupied bed; an empty isolation room is NOT counted
    });
    k.rate = k.operational ? Math.round((k.occupied / k.operational) * 100) : 0;
    return k;
  }

  // Group beds by room keeping sheet order.
  function groupRooms(beds) {
    const map = new Map();
    beds.forEach(b => {
      if (!map.has(b.room)) map.set(b.room, { room: b.room, type: b.bedType, beds: [] });
      map.get(b.room).beds.push(b);
    });
    return Array.from(map.values());
  }

  // Pack room groups into rows of ≈capacity bed columns.
  function packRows(groups, capacity) {
    const rows = []; let cur = [], n = 0;
    groups.forEach(g => {
      const w = g.beds.length;
      if (n + w > capacity && cur.length) { rows.push(cur); cur = []; n = 0; }
      cur.push(g); n += w;
    });
    if (cur.length) rows.push(cur);
    return rows;
  }

  function roomTitle(g) {
    if (g.type === "Close Observation") return t("closeObs");
    if (g.type === "Isolation" || g.type === "Negative Pressure") return t("isoRooms");
    return g.room;
  }

  // ------------------------------------------------------------------ bed card
  const STATE_ICON = { stable: "person", postop: "person", discharge: "person", newadm: "person",
    isolation: "shieldAlert", transfer: "swap", available: "bed", oos: "wrench" };

  function bedCardHTML(b, opts) {
    opts = opts || {};
    const st = primaryState(b);
    const privacy = !!opts.privacy;
    const badges = [];
    if (b.bedType === "Close Observation") badges.push('<span class="badge b-obs" title="Close observation">' + icon("eye") + "</span>");
    if (b.bedType === "Negative Pressure") badges.push('<span class="badge b-np" title="Negative pressure room">' + icon("negPressure") + "</span>");
    if (st !== "oos" && st !== "available") {
      if (hasIsolation(b) && st !== "isolation") badges.push('<span class="badge b-iso" title="Isolation: ' + esc(b.isolationPrecaution) + '">' + icon("shieldAlert") + "</span>");
      if (b.patientStatus === "Post Operative" && st !== "postop") badges.push('<span class="badge b-postop" title="Post operative">' + icon("postOp") + "</span>");
      if (b.patientStatus === "New Admission" && st !== "newadm") badges.push('<span class="badge b-newadm" title="New admission">' + icon("userPlus") + "</span>");
    }
    const label = b.label || ("Bed " + b.bed);
    let body;
    if (st === "oos") {
      body = '<div class="bc-icon">' + icon(STATE_ICON.oos) + '</div><div class="bc-empty">' + esc(t("outOfService")) + "</div>";
    } else if (st === "available") {
      body = '<div class="bc-icon">' + icon(STATE_ICON.available, "", 1.8) + '</div><div class="bc-empty">' + esc(tStatus("Available")) + "</div>";
    } else {
      const statusText = b.patientStatus || "Stable";
      const lines = [];
      if (!privacy) {
        lines.push('<div class="bc-code fit">' + esc(b.patientCode || "—") + "</div>");
        const ag = [b.age, b.gender].filter(Boolean).join(" / ");
        if (ag) lines.push('<div class="bc-meta fit">' + esc(ag) + "</div>");
      } else {
        lines.push('<div class="bc-code bc-hidden" title="Hidden by privacy mode">' + icon("lock") + "</div>");
      }
      lines.push('<div class="bc-doc fit">' + esc(b.doctor || "—") + "</div>");
      body = '<div class="bc-icon">' + icon(STATE_ICON[st]) + "</div>" + lines.join("") +
        '<div class="bc-status fit">' + esc(tCard(statusText)) + "</div>";
      if (hasIsolation(b)) body += '<div class="bc-iso fit">' + esc(b.isolationPrecaution) + "</div>";
      if (!privacy && b.note && opts.showNotes !== false) body += '<div class="bc-note fit" title="' + esc(b.note) + '">' + esc(b.note) + "</div>";
    }
    const tag = opts.clickable ? "button" : "div";
    return "<" + tag + ' class="bedcard s-' + st + '" data-bed="' + esc(b.bed) + '"' +
      (opts.clickable ? ' type="button" aria-label="' + esc(label) + ", " + esc(st) + '"' : "") + ">" +
      '<div class="bc-head"><span class="bc-label fit">' + esc(label) + '</span><span class="bc-badges">' + badges.join("") + "</span></div>" +
      '<div class="bc-body">' + body + "</div></" + tag + ">";
  }

  // Shrink text inside .fit elements until it fits on one line (never below 60%).
  function fitText(root) {
    (root || document).querySelectorAll(".fit").forEach(el => {
      el.style.fontSize = "";
      const base = parseFloat(getComputedStyle(el).fontSize);
      let size = base, guard = 0;
      while (el.scrollWidth > el.clientWidth + 1 && size > base * 0.6 && guard++ < 30) {
        size -= 0.5; el.style.fontSize = size + "px";
      }
    });
  }

  // ------------------------------------------------------------------ time
  function fmtDate(d, tz) {
    const p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" })
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return p.weekday + ", " + p.day + " " + p.month + " " + p.year;       // Wed, 23 Sep 2026
  }
  function fmtTime(d, tz, seconds) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hour12: true }).format(d);
  }
  function fmtDateTime(iso, tz) {
    if (!iso) return "—";
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
  }
  function todayISO(tz) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  // ---------------------------------------------------------- client validation
  // Mirrors Code.gs validateBedPayload_(). The server is the authority.
  function validateBed(p, doctors, isAdmit) {
    const errs = {};
    const code = String(p.patientCode || "").trim().toUpperCase();
    if (isAdmit || code) {
      if (!RULES.patientCode.test(code)) errs.patientCode = "Use a patient code or masked MRN: 2–12 letters/digits, e.g. P00123. Never a name.";
    }
    if (p.age && !RULES.age.test(String(p.age).trim().toUpperCase())) errs.age = "Use a number and unit: 12D, 3W, 7M or 5Y.";
    if (isAdmit && !p.age) errs.age = "Age is required on admission.";
    if (p.gender && ENUMS.GENDER.indexOf(p.gender) < 0) errs.gender = "Choose M or F.";
    if (isAdmit && !p.gender) errs.gender = "Gender is required on admission.";
    const active = (doctors || []).filter(d => d.active).map(d => d.name);
    if (isAdmit && !p.doctor) errs.doctor = "Choose the responsible doctor.";
    if (p.doctor && active.indexOf(p.doctor) < 0) errs.doctor = "Choose a doctor from the approved PSW list.";
    if (p.patientStatus && ENUMS.PATIENT_STATUS.indexOf(p.patientStatus) < 0) errs.patientStatus = "Choose a listed status.";
    if (p.isolationPrecaution && ENUMS.ISOLATION.indexOf(p.isolationPrecaution) < 0) errs.isolationPrecaution = "Choose a listed precaution.";
    if (p.note && String(p.note).length > RULES.noteMax) errs.note = "Keep the note under " + RULES.noteMax + " characters.";
    if (p.expectedDischarge && !RULES.date.test(p.expectedDischarge)) errs.expectedDischarge = "Use a valid date.";
    return errs;
  }

  window.PSW = {
    ENUMS, RULES, icon, esc, t, tStatus, setLang, get lang() { return lang; },
    isOperational, isOccupied, hasIsolation, primaryState, computeKpis, groupRooms, packRows, roomTitle,
    bedCardHTML, fitText, fmtDate, fmtTime, fmtDateTime, todayISO, validateBed
  };
})();
