# LegalDesk v4 — advmgmtsys authenticated sync

## What's new in v4

The Court Portal Connection section in Settings now has a working **Sync Now** button.

When an advocate clicks it:
1. Backend fetches the advmgmtsys login captcha (a 5-char alphanumeric one with strikethrough).
2. A modal pops up showing the captcha image — the user types what they see.
3. Backend logs in with the saved credentials + the captcha, scrapes the dashboard, returns matters.
4. Matters are merged into the dashboard (tagged `_source: advmgmtsys`, manual matters preserved).
5. The auth cookie is cached for 1 hour — subsequent **Sync Now** clicks skip the captcha entirely.

### Why manual captcha?

I tested 5 OCR preprocessing strategies against 4 real advmgmtsys captchas and only got 1/4 correct (~25%). The strikethrough line + gradient backgrounds break ordinary OCR. Auto-solving would mean most logins fail. Manual entry is faster, 100% reliable, and the user only has to do it once per hour.

We can revisit auto-OCR later by paying for Google Vision API (~$1.50/1000 calls), training a custom model, or using a captcha-solving service (~$1/1000 calls).

## How to deploy

```bash
cd /path/to/your/local/LegalDesk
git checkout main
git pull origin main

# Overwrite the three real source files
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4/api-server__index.js"  api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4/index.html"             index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4/LegalDesk.html"         LegalDesk.html

# Sanity check — must all be > 0
grep -c "advmgmtsys-prepare"   api-server/index.js   # should print 5
grep -c "scrapeAdvmgmtMatters" api-server/index.js   # should print 2
grep -c "Sync from Allahabad"  index.html             # should print 1
grep -c "advmgmtsysPrepare"    index.html             # should print 2

git add api-server/ index.html LegalDesk.html
git commit -m "v4: advmgmtsys authenticated sync (manual captcha + Sync Now UI)"
git push origin main
```

If any `grep -c` returns 0, your `cd` was wrong — don't push, fix the path and re-run `cp`.

## How to test after deploy

1. Wait 1-2 minutes for Render to redeploy. Confirm:
   ```bash
   curl -s "https://legaldesk-api.onrender.com/api/advmgmtsys-status" | head -c 300
   ```
   Expected: a JSON response that starts with `{"status":"alpha","message":"Manual-captcha login flow active"...`. If you still see `"status":"not_implemented"`, the backend hasn't redeployed yet.

2. Wait 3-5 min for GitHub Pages to rebuild. Open the dashboard, sign in as Akshay, go to Settings.

3. Under **Court Portal Connection (Alpha)**:
   - If you haven't saved creds yet, click **Connect CCMS account** and enter Akshay's advmgmtsys username (`B/A2401/2019`) + password. Click **Save in browser**.
   - Then click **Sync Now**.

4. A modal pops up with the captcha image. Type the characters you see. Click **Submit & Sync**.

5. One of three outcomes:

   **(a) Success** — modal shows "Synced N matters". Close it. Go to the Matters page — Akshay's real cases are now there, demo data gone.

   **(b) "Logged in but matters not found"** — login worked, but my 8 guesses at the dashboard URL didn't find a parseable matter table. Modal will list the URLs that were tried. Please share that list with me; I'll adjust the scraper based on what advmgmtsys actually returns for a logged-in advocate. (This is the most likely outcome on first attempt — we're navigating a portal we've never seen logged in.)

   **(c) Login failed** — wrong captcha, wrong password, or upstream maintenance. Modal shows the error. Click "Try again" → it refreshes the captcha and lets you re-enter.

## What to send me from the test

Especially if you hit outcome (b):
- The text inside the modal — particularly the "tried URLs" list and any error message.
- Or screenshot the modal.
- Even better: in Chrome DevTools (Network tab), copy the response body from `POST /api/advmgmtsys-sync` and paste it to me. That gives me the exact `triedUrls` array I need to widen the search.

Once I know the right dashboard URL, the v5 patch is just changing one constant in `scrapeAdvmgmtMatters` — should take 5 minutes.

## Privacy / security notes

- Akshay's advmgmtsys password is stored only in **his browser's localStorage**. Never on your Render backend disk. Never in Firestore.
- On each Sync, the password is sent over HTTPS to your backend, used once for the login POST, and discarded. Not logged. Not cached.
- The session cookie obtained after login IS cached (in process memory, 1-hour TTL, keyed by a hash of his username). That lets subsequent syncs skip both the password transmission AND the captcha. If you restart the Render container, all cached sessions are cleared and the next sync will prompt for the captcha again.
- He can wipe his saved creds anytime with the **Clear** button in Settings.

## What v4 does NOT do (yet)

- **Scheduled background sync.** Right now sync is on-demand. To get MyMunshi-style "case updated 7 hours ago" notifications, we'd need:
  - A cron job that runs every N hours per user.
  - Persistent storage of credentials (or a way to re-prompt for captcha automatically).
  - A diff job that compares fetched matters to the last snapshot and writes activity entries.
- **Matter-detail enrichment.** v4 pulls only the matter LIST. To pull the 15 fields MyMunshi shows on the detail page (Bench ID, judicial branch, listing history with outcomes, IA details with filing dates, etc.), we'd add a second scrape per matter detail page.
- **Auto-OCR captcha.** As above — 25% success rate isn't good enough. Could be added with paid service.

Each of these is a separate sprint. Tell me which you want next.

## What to do if the script timesout

- Render free tier sleeps after 15 min idle. First request to `/api/advmgmtsys-prepare` takes 30-45 sec on cold start. Subsequent requests within the next 15 min are fast.
- If `Sync Now` hangs > 60 sec, the modal will show an error — just click **Try again**.
