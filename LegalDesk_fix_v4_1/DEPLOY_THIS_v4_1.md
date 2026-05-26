# LegalDesk v4.1 — fix the "API error 401" surfacing

The 401 you saw was actually a **captcha typo** response, not a real backend error. Three bugs combined to hide the real reason:

1. **Frontend `_fetch` swallowed the response body on non-2xx** — so the detailed JSON message from the backend never reached the modal. You only saw "API error 401".
2. **Backend error detector was reading the wrong text** — Yii renders field-placeholder validation messages on every page load (even when the page just loaded fresh). I was treating those as the real error. The actual signal is the `?captchaerror` query param Yii appends to the URL.
3. **Backend `fetch` was auto-following redirects** — which silently drops cookies set on 302 hops. Even a successful login would end up unauthenticated for the dashboard scrape.

## What's fixed in v4.1

- `_fetch` now parses the body even on non-2xx and surfaces `error`, `errorCode`, `debugTrace`.
- New `fetchWithCookieJar()` — manual redirect following with per-call cookie jar (cookies preserved across hops).
- Login-failure detection now uses URL query params:
  - `?captchaerror` → `errorCode: "captcha_wrong"`
  - `?invalidlogin`/`?autherror` → `errorCode: "bad_credentials"`
  - `?invaliduser` → `errorCode: "unknown_user"`
- Frontend auto-refreshes the captcha modal on `captcha_wrong` (no Try Again click needed — you just see a new captcha and a toast saying "Captcha was wrong, fetching a fresh one").
- Error modal now has a **Show technical details** dropdown with the full debug trace (URL, hops, status codes) — paste me that if you hit a real error.

## Deploy

```bash
cd /path/to/your/local/LegalDesk
git checkout main
git pull origin main

cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4_1/api-server__index.js" api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4_1/index.html"            index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4_1/LegalDesk.html"        LegalDesk.html

# Sanity check — all must be > 0
grep -c "fetchWithCookieJar"        api-server/index.js   # should print 5
grep -c "captcha_wrong"             api-server/index.js   # should print 2
grep -c "Show technical details"    index.html             # should print 1

git add api-server/ index.html LegalDesk.html
git commit -m "v4.1: real error surface + redirect-cookie capture for advmgmtsys"
git push origin main
```

## How to test after deploy

1. Wait 1-2 min for Render redeploy. Confirm:
   ```bash
   curl -s "https://legaldesk-api.onrender.com/api/advocate-diag/X" | head -c 80
   ```
   (Should return JSON — proves backend is alive.)

2. On the dashboard: Settings → Court Portal Connection → **Sync Now**.

3. **Outcome A — captcha typo**: captcha modal auto-refreshes with a new image and shows toast *"Captcha was wrong — fetching a fresh one"*. Try again with the new one.

4. **Outcome B — wrong password**: red error box says *"Wrong password — please double-check the password saved in Settings"*. Click Settings → Edit credentials → Save → Sync Now.

5. **Outcome C — login succeeds, dashboard URL guess is wrong**: blue message *"Login succeeded but the dashboard URLs we tried didn't return a parseable matter list"*. Open the **Show technical details** dropdown — paste me what it says, and I'll patch the dashboard URL in v4.2.

6. **Outcome D — success**: matters appear on the dashboard. Demo data gone.

## What to send me if something still goes wrong

After clicking Sync Now and reading the captcha correctly, if you hit *any* error:
- Click **Show technical details** in the error modal.
- Copy the contents.
- Paste them to me.

That gives me the URL hops, status codes, and final URL — enough to diagnose any login or scrape issue in one shot.
