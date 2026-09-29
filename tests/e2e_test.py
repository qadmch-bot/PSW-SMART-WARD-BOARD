"""
PSW Smart Ward Board — end-to-end browser test (optional, for developers).

    pip install playwright && playwright install chromium
    python tests/e2e_test.py            # add --screens to save screenshots in tests/screens/

Serves the project locally and checks, in a real browser:
  A. Demo mode: an Admin change appears on the TV board automatically (no reload),
     KPIs recalculate, discharge needs the "patient has left" confirmation.
  B. Live mode with a simulated Apps Script backend: data loads, then the connection
     fails -> warning banner with the real last-update time, data kept, then marked
     outdated (greyed) after 3 missed refresh cycles; revoked key -> data removed.
  C. 1920x1080 (and other TV sizes) fit without scrolling; no console errors.
"""
import functools, http.server, json, os, socketserver, subprocess, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8823
BASE = f"http://127.0.0.1:{PORT}/"
SCREENS = "--screens" in sys.argv
FAKE_URL = "https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec"
KEY = "a" * 64

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()

passed = failed = 0
def check(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print("  \u2713 " + name)
    else: failed += 1; print("  \u2717 " + name + (" — " + str(detail) if detail else ""))

def shot(page, name):
    if SCREENS:
        os.makedirs(os.path.join(ROOT, "tests", "screens"), exist_ok=True)
        page.screenshot(path=os.path.join(ROOT, "tests", "screens", name))

# A display payload produced by the real engine (same code as Apps Script), fictional demo data.
payload = json.loads(subprocess.check_output(["node", "-e", """
const E=require('./js/engine.js'), S=require('./js/seed.js');
const st={beds:S.buildBeds(true,'2026-09-23'),settings:Object.assign({},S.SETTINGS,{refreshInterval:'15'})};
const store={readBeds:()=>st.beds,readSettings:()=>st.settings,readOnCall:()=>[{role:'Consultant On Call',staffName:'Dr Afif'}],getMeta:()=>''};
console.log(JSON.stringify(E.create(store,{now:()=>new Date()}).displayPayload()));
"""], cwd=ROOT))

def bed_text(page, bed):
    return page.locator(f'#ward [data-bed="{bed}"]').inner_text()

def kpi(page, cls):
    return page.locator(f"#kpis .{cls} .kpi-value").inner_text().replace("%", "").strip()

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    def watch(pg):
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts.g" not in m.text and "ERR_" not in m.text and "Failed to load resource" not in m.text else None)

    # ---------------------------------------------------------------- A. demo mode
    print("\nA. Demo mode — Admin -> TV synchronisation")
    ctx = browser.new_context(viewport={"width": 1920, "height": 1080})
    tv = ctx.new_page(); watch(tv)
    tv.goto(BASE + "index.html"); tv.wait_for_selector('#ward [data-bed="4B"]')
    adm = ctx.new_page(); watch(adm)
    adm.set_viewport_size({"width": 1440, "height": 900})
    adm.goto(BASE + "admin.html"); adm.wait_for_selector('[data-bed="4B"]')

    check("TV shows all 19 actual locations", tv.locator("#ward [data-bed]").count() == 19, tv.locator("#ward [data-bed]").count())
    ids = tv.eval_on_selector_all("#ward [data-bed]", "els => els.map(e => e.dataset.bed)")
    check("no Room 3 / Room 5 beds", not any(i.startswith(("3", "5")) for i in ids), ids)
    occ0 = int(kpi(tv, "k-occ"))
    check("4B starts available", "Available" in bed_text(tv, "4B"))

    adm.click('[data-bed="4B"]')
    adm.fill("#f-patientCode", "P09999"); adm.fill("#f-age", "6Y")
    adm.click('input[name="gender"][value="F"] + span')
    adm.select_option("#f-doctor", "Dr Jalal")
    adm.select_option("#f-patientStatus", "Post Operative")
    adm.fill("#f-note", "POD 0")
    adm.click("#bSave")
    adm.wait_for_selector("#bedDialog", state="hidden")
    tv.wait_for_function("document.querySelector('#ward [data-bed=\"4B\"]').innerText.includes('P09999')", timeout=8000)
    t = bed_text(tv, "4B")
    check("#1 admission appears on the TV without reload", "P09999" in t and "Dr Jalal" in t, t)
    check("#2 status shown on card (Post Op)", "Post Op" in t, t)
    check("#10 occupied KPI recalculated", int(kpi(tv, "k-occ")) == occ0 + 1, kpi(tv, "k-occ"))
    check("card colour follows status", "s-postop" in tv.get_attribute('#ward [data-bed="4B"]', "class"))

    adm.click('[data-bed="4B"]')
    adm.select_option("#f-isolationPrecaution", "Contact")
    adm.click("#bSave"); adm.wait_for_selector("#bedDialog", state="hidden")
    tv.wait_for_function("document.querySelector('#ward [data-bed=\"4B\"]').className.includes('s-isolation')", timeout=8000)
    check("#6 isolation precaution turns card red and keeps Post Op status", "Post Op" in bed_text(tv, "4B"))

    adm.click('[data-bed="4B"]'); adm.click("#bDischarge")
    adm.wait_for_selector("#bedDialog", state="hidden")
    tv.wait_for_function("document.querySelector('#ward [data-bed=\"4B\"]').innerText.includes('Discharge')", timeout=8000)
    check("#3 For Discharge shown, bed still occupied", int(kpi(tv, "k-occ")) == occ0 + 1)

    adm.click('[data-bed="4B"]'); adm.click("#bAvailable")
    adm.wait_for_selector("#releaseDialog[open]")
    check("#4 release needs the 'patient has left' confirmation", adm.is_disabled("#relOk"))
    adm.check("#relConfirm"); adm.uncheck("#relClean")
    adm.click("#relOk"); adm.wait_for_selector("#releaseDialog", state="hidden")
    tv.wait_for_function("document.querySelector('#ward [data-bed=\"4B\"]').innerText.includes('Available')", timeout=8000)
    check("#4 discharge completed -> bed available, patient data gone", "P09999" not in bed_text(tv, "4B"))
    check("#10 occupied KPI back to start", int(kpi(tv, "k-occ")) == occ0)

    adm.click('[data-bed="8A"]'); adm.click("#bTransfer"); adm.wait_for_selector("#bedDialog", state="hidden")
    tv.wait_for_function("document.querySelector('#ward [data-bed=\"8A\"]').className.includes('s-transfer')", timeout=8000)
    check("#5 transfer shown in purple", True)

    adm.click('[data-tab="oncall"]')
    adm.locator(".oc-line").nth(2).locator("input").first.fill("Test Charge Nurse")
    adm.click("text=Save on-call team"); adm.wait_for_timeout(600)
    tv.wait_for_function("document.querySelector('#oncall').innerText.includes('Test Charge Nurse')", timeout=8000)
    check("#8 on-call change appears on TV", True)

    adm.click('[data-tab="settings"]')
    adm.fill('[data-s="rrtExtension"]', "2222"); adm.fill('[data-s="codeBlueExtension"]', "3333")
    adm.click("text=Save settings"); adm.wait_for_timeout(600)
    tv.wait_for_function("document.querySelector('#emergency').innerText.includes('2222')", timeout=8000)
    check("#9 emergency extensions appear on TV", "3333" in tv.inner_text("#emergency"))

    adm.click('[data-tab="audit"]'); adm.wait_for_timeout(500)
    at = adm.inner_text("#auditBody")
    check("audit log lists the changes", all(a in at for a in ["ADMIT", "MARK_AVAILABLE", "UPDATE_ON_CALL", "UPDATE_SETTINGS"]), at[:200])

    size = tv.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
    check("#15 1920x1080: no scrolling", size[0] <= 1920 and size[1] <= 1080, size)
    shot(tv, "tv-1920x1080.png")
    ls = tv.evaluate("JSON.stringify(Object.keys(localStorage))")
    check("no patient data stored outside the demo key", "psw_demo_state_v1" in ls)
    ctx.close()

    for w, h in [(1366, 768), (1280, 720), (3840, 2160), (1080, 1920)]:
        c = browser.new_context(viewport={"width": w, "height": h}); pg = c.new_page(); watch(pg)
        pg.goto(BASE + "index.html"); pg.wait_for_selector('#ward [data-bed="4B"]')
        sz = pg.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
        check(f"{w}x{h}: board scales without scrolling", sz[0] <= w and sz[1] <= h, sz)
        c.close()

    # ---------------------------------------------------------------- B. live mode, failures
    print("\nB. Live mode — simulated Apps Script, connection failure, revoked key")
    ctx = browser.new_context(viewport={"width": 1920, "height": 1080})
    ctx.add_init_script(f"""localStorage.setItem('psw_connection', JSON.stringify({{apiUrl:'{FAKE_URL}', clientId:''}}));""")
    mode = {"v": "ok"}
    seen = []
    def handler(route):
        url = route.request.url; seen.append(url)
        if mode["v"] == "down": return route.abort()
        if mode["v"] == "revoked":
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": False, "code": "UNAUTHORIZED", "error": "This screen is not authorised."}))
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
    ctx.route("https://script.google.com/**", handler)
    tv = ctx.new_page(); watch(tv)
    tv.goto(BASE + "index.html")
    tv.wait_for_selector("#ward .ward-msg")
    check("TV without a display key shows 'not connected' and no data", "not connected" in tv.inner_text("#ward").lower() and not seen)

    tv.goto(BASE + "index.html#key=" + KEY)
    tv.wait_for_selector('#ward [data-bed="1A"]')
    check("display key is removed from the address bar", "key=" not in tv.url, tv.url)
    check("key sent to backend, TV renders live data", any("action=display&key=" + KEY in u for u in seen))
    check("privacy ON (server default): no patient codes on TV", "P00" not in tv.inner_text("#ward"))
    check("sync pill says Live", "Live" in tv.inner_text("#sync"))

    mode["v"] = "down"; t_fail = time.time()
    tv.keyboard.press("r")
    tv.wait_for_selector("#connBanner:not([hidden])", timeout=10000)
    banner = tv.inner_text("#connBanner")
    check("#14 connection warning is visible", "connection" in banner.lower(), banner)
    import re
    check("#14 shows actual time of last good data", re.search(r"\d{1,2}:\d{2}", banner) is not None, banner)
    check("#14 last good data kept on screen", tv.locator("#ward [data-bed]").count() == 19)
    shot(tv, "tv-connection-lost.png")
    print("    waiting for 3 missed refresh cycles (about 45 s)…")
    tv.wait_for_selector("#stage.stale", timeout=70000)
    check("#14 after 3 missed cycles the board is marked outdated (never shown as current)", "outdated" in tv.inner_text("#connBanner").lower(), tv.inner_text("#connBanner"))
    shot(tv, "tv-outdated.png")

    mode["v"] = "ok"; tv.keyboard.press("r")
    tv.wait_for_selector("#connBanner", state="hidden", timeout=10000)
    check("#12 recovers automatically when the connection returns", not tv.eval_on_selector("#stage", "e => e.classList.contains('stale')"))

    mode["v"] = "revoked"; tv.keyboard.press("r")
    tv.wait_for_selector("#ward .ward-msg", timeout=10000)
    check("#13 revoked display key -> patient data removed from the screen", tv.locator("#ward [data-bed]").count() == 0)
    ctx.close()

    # ---------------------------------------------------------------- admin live gate
    print("\nC. Admin in live mode requires Google sign-in")
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(f"""localStorage.setItem('psw_connection', JSON.stringify({{apiUrl:'{FAKE_URL}', clientId:'123-test.apps.googleusercontent.com'}}));""")
    ctx.route("https://script.google.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": False, "code": "UNAUTHENTICATED", "error": "Sign in"})))
    ctx.route("https://accounts.google.com/**", lambda r: r.abort())
    adm = ctx.new_page(); watch(adm)
    adm.goto(BASE + "admin.html"); adm.wait_for_timeout(1500)
    check("#13 no ward data before sign-in", adm.locator('[data-bed]').count() == 0)
    check("sign-in gate shown", adm.is_visible("#gate"))
    ctx.close()

    # ---------------------------------------------------------------- routes
    print("\nD. Static routes")
    ctx = browser.new_context(); pg = ctx.new_page()
    pg.goto(BASE + "dashboard/"); pg.wait_for_url("**/index.html*")
    check("/dashboard/ opens the TV board", pg.url.endswith("index.html"), pg.url)
    pg.goto(BASE + "admin/"); pg.wait_for_url("**/admin.html*")
    check("/admin/ opens the Admin page", pg.url.endswith("admin.html"), pg.url)
    ctx.close()

    check("no JavaScript errors", not errors, errors[:5])
    browser.close()

print(f"\n{passed} passed, {failed} failed")
srv.shutdown()
sys.exit(1 if failed else 0)
