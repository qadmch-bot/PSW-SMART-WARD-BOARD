# PSW Smart Ward Board

Electronic ward board for the **Pediatric Surgical Ward (PSW)**: a full-screen TV dashboard for the nursing station, plus an Admin page where authorised staff update beds, the on-call team and settings.

| Part | Runs on | Cost |
|---|---|---|
| TV dashboard (`index.html`) and Admin (`admin.html`) | GitHub Pages (static HTML/CSS/JS) | free |
| Database | Google Sheets file in **your** Google Drive | free |
| API | Google Apps Script Web App | free |
| Staff sign-in | Google Sign-In (OAuth Client ID) | free |

> **Before any real patient data is entered, get approval from your hospital IT / information-security and privacy officer.** This board uses consumer Google services. Your organisation's policy decides whether that is acceptable, even for coded patient identifiers. Out of the box it runs on **fictional demo data** only.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Try it in demo mode (2 minutes)](#2-try-it-in-demo-mode)
3. [Security model and limitations](#3-security-model-and-limitations)
4. [Deploy with Google Drive, Apps Script and GitHub Pages](#4-deployment)
5. [Daily use](#5-daily-use)
6. [Google Sheets database](#6-google-sheets-database)
7. [Testing](#7-testing)
8. [Troubleshooting](#8-troubleshooting)
9. [Project structure](#9-project-structure)
10. [Assumptions to confirm](#10-assumptions-to-confirm)

---

## 1. What it does

**TV dashboard** (1920×1080, no scrolling, scales to any screen)
- Header: hospital logo and names, department title in English and Arabic, tagline, live Asia/Riyadh date and time (runs independently of the data).
- 8 KPIs calculated from the bed data: Total Beds, Occupied, Available, Occupancy Rate, For Discharge, Isolation, Transfer, New Admission.
  - Occupancy = occupied ÷ **operational** beds. Out-of-service beds are excluded and shown separately.
  - Isolation counts **occupied** beds with an isolation precaution. An empty isolation room is simply available.
- The actual PSW layout: 19 locations (Rooms 1, 2, 4, 6, 7, 8, Close Observation, Isolation incl. Negative Pressure). There is no Room 3 or Room 5.
- Colour-coded bed cards: green stable, blue post-op, yellow for discharge, red isolation, purple transfer, light-blue new admission, grey available, hatched out-of-service. Extra conditions appear as badges (e.g. post-op + contact isolation).
- Sidebar: Ward Summary, On Call Team, RRT and Code Blue extensions.
- Auto-refresh (default 30 s) without reloading the page. If the connection fails, a warning shows the real time of the last good data; after 3 missed refreshes the board is greyed out as **outdated** so old data is never shown as current.
- Keys: **F** or double-click = full screen, **R** = refresh now. The mouse cursor hides itself.

**Admin page**
- Google sign-in, restricted to e-mails listed in the `USERS` sheet (roles `ADMIN` / `EDITOR`).
- Click any bed for the Quick Bed Update form: patient code, age, gender, doctor, status, isolation, note, expected discharge. Buttons: **Save**, **For discharge**, **Transfer**, **Mark available**, **Cancel**.
- **Mark available** requires ticking “The patient has physically left this bed”, and can hold the bed out of service for cleaning.
- On-call team, settings (names, logo, extensions, refresh interval, privacy mode, language), approved doctor list, TV link, audit log (ADMIN only).
- Every change is validated on the server, locked against simultaneous saves, and written to `AUDIT LOG`.

## 2. Try it in demo mode

With `API_URL` empty in `js/config.js`, both pages run on **fictional** patients stored only in your browser.

```bash
cd PSW-SMART-WARD-BOARD
python3 -m http.server 8000
```

Open `http://localhost:8000/` (TV) and `http://localhost:8000/admin.html` (Admin) in two tabs of the same browser. Changes in Admin appear on the TV within a second. **Admin → Settings → Connection → Reset demo data** restores the starting state.

You can also publish the demo straight to GitHub Pages (step 4.6) before connecting Google.

## 3. Security model and limitations

**What protects the data**

| Control | How |
|---|---|
| Spreadsheet is private | It stays owned by you and is **never** shared or published. The Web App reads it as you, so staff and TVs never get spreadsheet access. |
| TV read access | `GET ?action=display&key=…`. The display key is a long random secret in the script's properties, compared in constant time. The TV receives it once through the link `…/index.html#key=…`; the part after `#` is not sent to GitHub, and the page removes it from the address bar and keeps it on that TV only. |
| De-identified TV feed | The feed never contains names, admission dates, user e-mails or the audit log. With **Privacy mode ON (the default)** the server also removes patient code, age, gender and notes before sending anything. Notes need Privacy OFF **and** “Show notes” ON. |
| Staff authentication | Admin sends a Google Sign-In ID token with every request. The server verifies it with Google (audience = your Client ID, verified e-mail, not expired), then checks the e-mail is **active** in `USERS`. |
| Authorisation | `EDITOR`: beds, on-call. `ADMIN`: also settings, doctors, TV link, audit log. |
| Integrity | Server-side validation of every field, a script lock for writes, version checks so two people cannot overwrite each other, and an audit row (user, time, before/after) for every change. |
| No patient data in the browser | In live mode nothing about patients is stored in `localStorage`; only the connection URL and the TV key are kept. |
| No secrets in GitHub | `js/config.js` holds only the Web App URL and OAuth Client ID, which are public identifiers. |

**Limitations you should accept knowingly**
- **The TV link is a bearer secret.** Anyone who has the full link can view the board (de-identified). Show it only on the ward TV. If it leaks, use **Admin → Settings → TV display → Rotate** and re-open the new link on the TV.
- **The Web App must be deployed as “Anyone”.** Browsers cannot send Google credentials across sites to Apps Script, so the endpoint is reachable anonymously. Every action still requires the display key or a verified Google sign-in. Without either, the only response is `ping`.
- **Direct sheet edits bypass validation and audit.** Data sheets carry a warning-only protection. Make changes through Admin.
- **Apps Script quotas.** Consumer accounts have daily limits on executions and external requests. One TV refreshing every 30 s uses about 2,900 requests per day, which is fine, but avoid many TVs at 15 s. Tokens are cached to reduce calls.
- **Google Sign-In needs internet.** No sign-in works without it, and the TV shows its last good data with a warning when offline.

## 4. Deployment

You need one Google account (the **owner**; ideally a dedicated ward account, not a personal one) and one GitHub account.

### 4.1 Create the Apps Script project

1. Signed in as the owner, open <https://script.google.com> → **New project**. Name it `PSW Smart Ward Board API`.
2. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.
3. In the editor create these files (**+ → Script**) and paste the contents from `google-apps-script/`:
   - `Engine` ← `Engine.gs`
   - `SeedData` ← `SeedData.gs`
   - `Code` ← `Code.gs` (replace the default `Code.gs` contents)
   - `Setup` ← `Setup.gs`
   - Replace `appsscript.json` with the provided `appsscript.json`.
4. Save.

### 4.2 Create the Google Sign-In Client ID

1. Open <https://console.cloud.google.com> → create a project, e.g. `psw-ward-board`.
2. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name: `PSW Ward Board`, plus your support e-mail.
   - Scopes: none extra.
   - While the app is in *Testing*, add every staff Google account under **Test users**, or publish the app. Sign-in only asks for the basic e-mail profile.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorised JavaScript origins**: `https://YOUR-GITHUB-USERNAME.github.io` (and `http://localhost:8000` if you test locally).
   - Create, then copy the **Client ID** (`…apps.googleusercontent.com`). No client secret is needed.

### 4.3 Create the database in Google Drive

1. In the Apps Script editor open `Setup.gs` and fill in `SETUP`:
   ```js
   OAUTH_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
   EXISTING_SPREADSHEET_ID: "",          // empty = create a new file in your Drive
   ADMINS: ["charge.nurse@example.com"],
   EDITORS: ["staff.nurse1@example.com"],
   LOAD_DEMO_DATA: true                  // fictional patients for testing
   ```
   To use a spreadsheet you already made, paste its ID (the part between `/d/` and `/edit` in its address).
2. Select `setupDatabase` in the function menu → **Run** → authorise.
   - Google will warn that the app is unverified. This is your own script: **Advanced → Go to … (unsafe)**.
3. Open **Execution log**. It prints the spreadsheet link (the file **PSW SMART WARD BOARD DATABASE** is now in your Drive) and the TV display key.
4. Optionally run `checkConfiguration` to confirm everything is set.

Running `setupDatabase` again is safe: it keeps existing data, re-applies validation and formatting, and adds any new users from `SETUP`.

### 4.4 Deploy the Web App

1. **Deploy → New deployment → type: Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**.
3. Deploy, then copy the **Web app URL** (ends in `/exec`).
4. Check it: open `…/exec?action=ping` in a browser. You should see `{"ok":true,…}`.

After editing the script later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

### 4.5 Connect the frontend

Edit `js/config.js`:

```js
API_URL: "https://script.google.com/macros/s/XXXXXXXX/exec",
GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
```

Alternatively, leave the file empty and enter both values on each device under **Admin → Settings → Connection**.

### 4.6 Publish on GitHub Pages

1. Create a repository (e.g. `psw-ward-board`) and upload the whole project folder, including `.nojekyll`.
2. **Settings → Pages → Source: Deploy from a branch → `main` / root** → Save.
3. After a minute the site is at `https://YOUR-GITHUB-USERNAME.github.io/psw-ward-board/`:
   - TV: `…/psw-ward-board/` (also `…/dashboard/`)
   - Admin: `…/psw-ward-board/admin.html` (also `…/admin/`)

All paths are relative, so the project also works from any sub-folder or other static host.

### 4.7 Connect the TV

1. On a computer, open Admin and sign in as an ADMIN.
2. Go to **Settings → TV display → Show TV link** and copy the link.
3. Open that link **once** in the TV's browser. The key is stored on the TV and removed from the address bar.
4. Press **F** for full screen, and set the TV/mini-PC browser to open the board URL on start-up.

### 4.8 Go live with real data

1. Test every workflow on demo data (see section 7).
2. In Apps Script run `clearAllPatients` (logged in the audit log). Set `LOAD_DEMO_DATA: false` for any future setup.
3. In Admin enter the real on-call team, RRT and Code Blue extensions, and upload the official logo.
4. Keep **Privacy mode ON** unless your policy explicitly allows patient codes on a screen visible to visitors.
5. Confirm the spreadsheet is shared with **nobody** (Drive → Share → only you).
6. Add or remove staff in the `USERS` sheet (untick **Active** when someone leaves).

## 5. Daily use

| Task | In Admin |
|---|---|
| Admit | Click an available bed → fill code, age, gender, doctor → **Save — admit patient**. Status defaults to *New Admission*. |
| Change status, doctor or isolation | Click the bed → change → **Save** |
| Ready to go home | **For discharge**. The bed stays occupied. |
| Patient has left | **Mark available** → choose reason → tick “has physically left” → confirm. |
| Transfer | **Transfer** (still occupied) → after the patient leaves, **Mark available** with “Transfer completed”. |
| Bed broken or cleaning | Empty bed → **Take bed out of service**. It is excluded from occupancy. |
| On-call | **On-call team** tab → **Save on-call team** |

Patient code means a code or masked MRN such as `P00123`. **Never enter a name.** Age uses `12D`, `3W`, `7M` or `5Y`.

## 6. Google Sheets database

The file **PSW SMART WARD BOARD DATABASE** contains these sheets:

| Sheet | Columns |
|---|---|
| `BEDS` | Room, Bed, Bed Type, Operational Status, Occupancy Status, Patient Code, Age, Gender, Responsible Doctor, Patient Status, Isolation Precaution, Clinical Note, Admission Date, Expected Discharge Date, Last Updated, Updated By |
| `DOCTORS` | Doctor Name, Doctor Level, Active (Dr Afif, Dr Jalal, Dr Akan, Dr Abdelhaq: Consultants; Dr Ahammed, Dr Patrick: Specialists) |
| `ON CALL TEAM` | Role, Staff Name, Shift Date, Shift Start, Shift End, Last Updated |
| `SETTINGS` | Setting Name, Setting Value |
| `AUDIT LOG` | Timestamp, User, Action, Bed, Previous Value, New Value, Record ID |
| `USERS` | Email, Role (`ADMIN`/`EDITOR`), Active, Name / Position |

- Drop-down validation is applied to every status column.
- Data sheets carry warning-only protection. `AUDIT LOG` and `USERS` can only be edited by the owner.
- Rows are colour-coded by bed state.

Script Properties (Project Settings → Script properties) hold `SPREADSHEET_ID`, `DISPLAY_KEY` and `OAUTH_CLIENT_ID`; see `.env.example`.

Maintenance functions (run from the editor):

| Function | Purpose |
|---|---|
| `setupDatabase` | Create or repair the database |
| `clearAllPatients` | Empty all beds |
| `showDisplayKey` | Print the current TV key |
| `rotateDisplayKey` | Issue a new TV key |
| `setOAuthClientId` | Save the Client ID from `SETUP` |
| `checkConfiguration` | Self-check |

## 7. Testing

```bash
node tests/run-tests.js          # 50 tests: rules, privacy, auth, Apps Script backend on a mock Google Sheets
pip install playwright && playwright install chromium
python3 tests/e2e_test.py        # 38 browser checks: Admin → TV sync, connection loss, screen sizes
```

The tests cover the full testing list:
- Admit, status change, for discharge, completed discharge, transfer.
- Isolation, doctor change, on-call, extensions, KPI recalculation.
- Sheets sync, automatic TV refresh, unauthorised access, connection failure, and 1920×1080 without scrolling.
- Also: 1366×768, 720p, 4K and portrait.

Before go-live, also run a manual check on the real deployment:
- Admit a fictional patient in Admin.
- See it on the TV within one refresh.
- Check the row in `BEDS` and in `AUDIT LOG`.
- Unplug the network and confirm the warning appears.
- Sign in with a Google account not in `USERS` and confirm it is refused.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| TV: “This screen is not connected” | Open the TV link from Admin once on that TV. After a key rotation, open the new link. |
| TV: “The server did not return board data” | Wrong URL, or the deployment is not *Anyone*. The URL must end in `/exec`, not `/dev`. |
| Admin sign-in button missing or “origin not allowed” | Add the exact `https://USERNAME.github.io` origin to the OAuth client, then wait ~5 minutes. |
| “Your account is not on the PSW authorised staff list” | Add the e-mail to `USERS` with Active ticked. For an app in Testing mode, also add it as a test user. |
| “NOT_CONFIGURED” | Run `setupDatabase`. Set `OAUTH_CLIENT_ID`. |
| Script changes not visible | Deploy a **new version** of the existing deployment. |
| “changed by someone else a moment ago” | Another user saved the same bed; it reloads, so check and save again. |

## 9. Project structure

```
index.html              TV dashboard           admin.html           Admin page
dashboard/index.html    /dashboard route       admin/index.html     /admin route
css/style.css           shared styles, status colours
css/dashboard.css       TV layout (1920×1080 stage)   css/admin.css   Admin layout
js/config.js            API URL + Client ID (public)
js/app.js               shared core: KPIs, card renderer, validation, i18n, icons
js/api.js               API client + demo backend
js/dashboard.js         TV refresh loop, connection handling
js/admin.js             Admin UI, Google sign-in
js/engine.js, js/seed.js   identical copies of Engine.gs / SeedData.gs for demo mode
google-apps-script/     Code.gs (HTTP + Sheets), Engine.gs (all business rules),
                        SeedData.gs (layout, doctors, demo data), Setup.gs, appsscript.json
assets/                 logo placeholder, icons
tests/                  run-tests.js (node), e2e_test.py (Playwright)
```

`Engine.gs` and `js/engine.js` must stay identical, and so must `SeedData.gs` and `js/seed.js`. The tests check this.

## 10. Assumptions to confirm

- **19 locations.** The Negative Pressure room is a separate location (`NP`, shown as “Neg. Pressure”) alongside ISO2 (single room), ISO1, ISO3 and ISO4. If NP is actually ISO2 itself, remove the `NP` row from `SeedData.gs`/`seed.js` (and from `BEDS`) and change ISO2's Bed Type to `Negative Pressure`.
- Close Observation locations are named `1 Y/O` and `> 1 Year`.
- A 6th sheet, `USERS`, controls who may sign in.
- Staff names on call and emergency extensions start **blank**. Enter the real ones in Admin; nothing is invented.
- The logo is a neutral placeholder. Upload the official logo in Admin → Settings.
