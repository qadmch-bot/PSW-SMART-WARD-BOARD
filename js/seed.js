/*
 * PSW Smart Ward Board — seed data.
 * Identical copy in js/seed.js (browser demo). Keep both the same.
 *
 * LAYOUT is the actual Pediatric Surgical Ward layout (19 listed locations).
 * There is no Room 3 and no Room 5. Mark any location that is not an operational
 * inpatient bed as "Out of Service" in the BEDS sheet instead of deleting it.
 *
 * DEMO_PATIENTS are FICTIONAL. Patient codes are invented and do not refer to anyone.
 */
var PSWSeed = {
  LAYOUT: [
    { room: "Room 1", bedType: "Regular", beds: ["1A", "1B"] },
    { room: "Room 2", bedType: "Regular", beds: ["2A", "2B"] },
    { room: "Room 4", bedType: "Regular", beds: ["4A", "4B"] },
    { room: "Room 6", bedType: "Regular", beds: ["6A", "6B"] },
    { room: "Room 7", bedType: "Regular", beds: ["7A", "7B"] },
    { room: "Room 8", bedType: "Regular", beds: ["8A", "8B"] },
    { room: "Close Observation", bedType: "Close Observation", beds: ["1 Y/O", "> 1 Year"] },
    { room: "Isolation", bedType: "Isolation", beds: ["ISO2"] },          // ISO2 – single room
    { room: "Isolation", bedType: "Negative Pressure", beds: ["NP"] },     // Negative pressure room
    { room: "Isolation", bedType: "Isolation", beds: ["ISO1", "ISO3", "ISO4"] }
  ],

  DOCTORS: [
    { name: "Dr Afif", level: "Consultant", active: true },
    { name: "Dr Jalal", level: "Consultant", active: true },
    { name: "Dr Akan", level: "Consultant", active: true },
    { name: "Dr Abdelhaq", level: "Consultant", active: true },
    { name: "Dr Ahammed", level: "Specialist", active: true },
    { name: "Dr Patrick", level: "Specialist", active: true }
  ],

  // Blank staff names and extensions on purpose: enter the real values in Admin.
  SETTINGS: {
    hospitalName: "Maternity & Children's Hospital",
    hospitalNameAr: "مستشفى الولادة والأطفال",
    cluster: "Hafar Al Batin Health Cluster",
    departmentName: "PEDIATRIC SURGICAL WARD (PSW)",
    departmentNameAr: "قسم جراحة الأطفال",
    departmentCode: "PSW",
    tagline: "Small Patients, Big Courage",
    logo: "",
    rrtExtension: "",
    codeBlueExtension: "",
    refreshInterval: "30",
    privacyMode: "ON",
    showNotes: "OFF",
    language: "en",
    timezone: "Asia/Riyadh"
  },

  // bed: [patientCode, age, gender, doctor, patientStatus, isolation, note]   — FICTIONAL
  DEMO_PATIENTS: {
    "1A": ["P00123", "5Y", "M", "Dr Afif", "Post Operative", "None", "POD 1"],
    "1B": ["P00456", "3Y", "F", "Dr Jalal", "For Discharge", "None", ""],
    "2A": ["P00789", "8Y", "M", "Dr Akan", "Post Operative", "None", "POD 2"],
    "2B": ["P00654", "11Y", "F", "Dr Abdelhaq", "Stable", "None", ""],
    "1 Y/O": ["P00811", "7M", "M", "Dr Ahammed", "New Admission", "None", ""],
    "4A": ["P00876", "6Y", "M", "Dr Patrick", "Post Operative", "None", "POD 1"],
    "6A": ["P00333", "2Y", "F", "Dr Afif", "Stable", "None", ""],
    "6B": ["P00444", "9Y", "M", "Dr Jalal", "Stable", "Contact", ""],
    "7A": ["P00555", "4Y", "F", "Dr Akan", "For Discharge", "None", ""],
    "8A": ["P00666", "10Y", "M", "Dr Abdelhaq", "Stable", "None", ""],
    "8B": ["P00777", "1Y", "F", "Dr Ahammed", "Transfer", "None", ""],
    "ISO2": ["P00987", "6Y", "M", "Dr Afif", "Post Operative", "Contact", "POD 3"],
    "NP": ["P00321", "13Y", "F", "Dr Patrick", "New Admission", "Airborne", ""],
    "ISO3": ["P00222", "3Y", "M", "Dr Jalal", "Stable", "Droplet", ""]
  },
  DEMO_OUT_OF_SERVICE: ["7B"],
  DEMO_ON_CALL: { "Consultant On Call": "Dr Afif", "Specialist On Call": "Dr Patrick" },

  /** Build the bed rows. withDemo=true adds the fictional patients. */
  buildBeds: function (withDemo, todayISO) {
    var rows = [];
    PSWSeed.LAYOUT.forEach(function (g) {
      g.beds.forEach(function (id) {
        var d = withDemo ? PSWSeed.DEMO_PATIENTS[id] : null;
        rows.push({
          room: g.room, bed: id, bedType: g.bedType,
          operationalStatus: withDemo && PSWSeed.DEMO_OUT_OF_SERVICE.indexOf(id) >= 0 ? "Out of Service" : "Operational",
          occupancyStatus: d ? "Occupied" : "Available",
          patientCode: d ? d[0] : "", age: d ? d[1] : "", gender: d ? d[2] : "", doctor: d ? d[3] : "",
          patientStatus: d ? d[4] : "", isolationPrecaution: d ? d[5] : "None", note: d ? d[6] : "",
          admissionDate: d ? todayISO : "", expectedDischarge: "", lastUpdated: "", updatedBy: ""
        });
      });
    });
    return rows;
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = PSWSeed;
