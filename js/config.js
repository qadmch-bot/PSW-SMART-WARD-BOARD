/*
 * PSW Smart Ward Board — public frontend configuration.
 *
 * NOTHING in this file is secret. It is published on GitHub Pages.
 *  - API_URL          : the Google Apps Script Web App URL (ends in /exec).
 *                       Leave empty to run in DEMO mode (fictional data only).
 *  - GOOGLE_CLIENT_ID : OAuth 2.0 Web Client ID used for staff sign-in on /admin.
 *                       Client IDs are public identifiers, not secrets.
 *
 * Never put spreadsheet IDs with sharing links, API keys, service-account keys,
 * display keys or patient information in this file.
 *
 * Both values can also be set from Admin → Settings → Connection on each device;
 * a value saved there overrides this file on that device only.
 */
window.PSW_CONFIG = {
  API_URL: "",
  GOOGLE_CLIENT_ID: "",

  TIMEZONE: "Asia/Riyadh",
  DEFAULT_REFRESH_SECONDS: 30,
  MIN_REFRESH_SECONDS: 15,
  // After this many missed refresh cycles the TV marks all data as outdated.
  STALE_AFTER_MISSED_CYCLES: 3,
  REQUEST_TIMEOUT_MS: 20000
};
