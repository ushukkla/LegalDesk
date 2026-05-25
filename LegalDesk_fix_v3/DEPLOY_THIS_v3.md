# LegalDesk v3 — deploy this, please read first

## ⚠ Important: what went wrong last time

Your v2 push went through, but it only added a **folder** called
`LegalDesk_fix_v2/` to your repo. It did **not** modify the actual files at
`api-server/index.js`, `index.html`, etc. So Render and GitHub Pages built
the same v1 code as before. That's why nothing changed in production.

The four files in *this* folder are the SOURCE files that need to overwrite
the ones already in your repo. Do not commit this folder into your repo.

## The fastest, foolproof way to deploy v3

Open Terminal, then copy-paste this **whole block**:

```bash
cd /path/to/your/local/LegalDesk      # 👈 cd into your real repo first
git checkout main
git pull origin main

# Overwrite the four real source files (NOT into a subfolder)
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v3/api-server__index.js"               api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v3/allahabad-hc-mcp__captcha-solver.js" allahabad-hc-mcp/captcha-solver.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v3/index.html"                          index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v3/LegalDesk.html"                      LegalDesk.html

# (Optional) clean up the dead LegalDesk_fix_v2 folder from last attempt
git rm -rf LegalDesk_fix_v2 2>/dev/null

# Sanity check — should show 4 files changed
git status

# Sanity check — quick proof v3 is in there:
grep -c "get_ListedCaseRoll" api-server/index.js     # should print: 6
grep -c "LiveFetchBanner"    index.html              # should print: 2
grep -c "suggestCourtFromRoll" index.html            # should print: 4
grep -c "advmgmtsys_creds"   index.html              # should print: 6

git add -A
git commit -m "Apply v3: real matters fetch, bench auto-detect, advmgmtsys stub"
git push origin main
```

If any of the `grep -c` numbers above show `0`, the copy did NOT land in the
right place — re-check your `cd` step.

After push:
- **Render** redeploys the backend automatically (1-2 min on free tier).
- **GitHub Pages** rebuilds the frontend automatically (3-5 min).

## How to confirm v3 is actually live (do this after pushing)

```bash
# Backend should now have a /api/advocate-diag endpoint (v3 marker):
curl -s "https://legaldesk-api.onrender.com/api/advocate-diag/B%2FA2401%2F2019" | head -c 400

# Backend response should now include "benchStatus" field:
curl -s "https://legaldesk-api.onrender.com/api/advocate-cases-all/B%2FA2401%2F2019" | grep -c benchStatus    # should be > 0

# Frontend should now contain the LiveFetchBanner:
curl -s "https://ushukkla.github.io/LegalDesk/" | grep -c "LiveFetchBanner"   # should be > 0
```

If any of these still show 0 after 5 minutes:
- Check **Render dashboard** → `legaldesk-api` service → "Events" tab —
  there should be a recent deploy. If it failed, the logs will say why.
- Check **GitHub** → repo → "Actions" tab — Pages workflow should be green.

## What v3 changes (on top of v2)

### Bench auto-detect

Akshay's roll number `B/A2401/2019` starts with `B/` — by Allahabad HC
convention that's a Lucknow Bench advocate. v3 frontend now:

- On the login Verify step, auto-suggests "Allahabad High Court (Lucknow
  Bench)" when the typed roll number starts with `B/`. Shows a one-click
  "Use Lucknow Bench" chip if the current court selection contradicts.
- On the Settings page, the Court field is now editable (Change / Save /
  Cancel) with a warning + one-click fix when the saved court doesn't
  match the roll-number prefix.

For Akshay: when he opens Settings he'll see "Heads up: your roll number
B/A2401/2019 starts with B/ which usually means Allahabad High Court
(Lucknow Bench). [Switch to Lucknow Bench]". One click updates his
profile and from then on the live fetch prioritizes the Lucknow Bench.

### advmgmtsys credential stub (Alpha)

A new "Court Portal Connection (Alpha)" section in Settings lets the
advocate pre-fill their `advmgmtsys` username + password. **Stored only in
browser localStorage** — never transmitted to your backend in this
release. This is the UX scaffold for the next sprint, when the backend
will use those credentials once per scheduled fetch (and not persist
them) to pull the advocate's full case history the way MyMunshi does.

Why a separate session sprint for advmgmtsys?

1. The captcha there is a different style (alphanumeric on a blue
   gradient) — needs its own OCR profile, my color-extraction trick
   from the CCMS captcha won't work.
2. Login flow requires CSRF token + cookie session preserved across
   3 hops (login form → POST login → dashboard).
3. Dashboard scrape needs its own parser (different structure from
   CCMS results).
4. Most importantly: it requires per-user credential handling, which
   is a security decision worth making explicitly (e.g., do we store
   creds encrypted in Firestore, or only in browser?).

The new `GET /api/advmgmtsys-status` endpoint returns the planned
login/registration URLs and the current `not_implemented` state, so the
frontend can show appropriate UI.

### Plus everything from v2 (which wasn't actually deployed)

- Fixed `advocate-cases` URL (was hitting 404), field names (`adv_roll`
  not `roll_no`, etc.), year iteration, Lucknow host change, captcha
  OCR via color extraction, cookie parsing, demo-data clearance, new
  LiveFetchBanner with maintenance / no-cases / backend-down states.

### Plus everything from v1 (which WAS deployed)

- Cause list URLs (no more 404), live RSS news feed at `/api/news`,
  native court-view table replacing the blocked iframe.

## Once v3 is live, what Akshay will see

1. Logs in → Matters page loads.
2. Sees a banner saying either:
   - **"Allahabad HC CCMS (Lucknow Bench) is in maintenance"** — because LKO
     CCMS is currently down (I confirmed this morning). Demo data is cleared.
     Once LKO is back online (the court's banner said "back in a couple of
     hours"), real matters appear.
   - **OR "Loaded N live cases"** if LKO is back up by then. Public
     `advocate-cases-date-wise` only returns cases *listed in the next ~14
     days*. To pull his full 186-matter history we need advmgmtsys (Alpha
     section in Settings — next sprint).
3. Goes to Settings → sees a yellow warning if his court is set to
   "Allahabad High Court" but his roll number is `B/...`. One-click fix.
4. Sees the new "Court Portal Connection (Alpha)" section — can pre-fill
   his advmgmtsys credentials now, they'll be used automatically once the
   backend implementation ships.

## After deploy, please tell me

- Did the `grep -c` numbers all come back > 0? (Confirms files copied
  to the right place.)
- Did `curl` against `/api/advocate-diag` return JSON instead of HTML 404?
  (Confirms Render redeployed.)
- After ~5 min, did GitHub Pages show `LiveFetchBanner` in the source?
  (Confirms Pages rebuilt.)
- Is LKO out of maintenance yet?

Once LKO is back, the existing v3 code should pull Akshay's listed cases
for the upcoming ~14 days. If those cases match (subset of) what MyMunshi
shows him, the public-CCMS path is good. The remaining gap is full case
history → that's the next sprint with advmgmtsys.
