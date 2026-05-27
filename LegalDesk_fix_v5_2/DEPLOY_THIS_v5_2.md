# v5.2 — fix LIST parser + auto-fallback to public CCMS for detail

## What the Diagnose dump revealed

Three concrete facts about advmgmtsys's dashboard:

1. **Working URL is `/advmgmtsys/dashboard`** (we probed all 8 candidates; only this one returned a table).
2. **302 rows for Akshay** with **7 columns**: `# | Case Status | Case Number | Petitioner | Respondent | Registration Date | Advocate Side`.
3. **ZERO per-row links** — no `<a>`, no `onclick`, no `data-id`. It's a flat jQuery DataTables widget. There IS no detail URL to extract.

## What v5.2 fixes

**Bug A — wrong column going to nextHearing**. My v5 regex `/next|listing|hearing|date/` matched "Registration **Date**" — so each matter's filing date was being stuffed into `nextHearing`. That's why matters showed wrong dates.

Tightened to: `nextHearing` requires literal "next"; new `registrationDate` / `lastHearing` / `listingDate` / `advocateSide` column types; `caseStatus` normalized to PENDING/DISPOSED.

**Bug B — "No detail URL captured" treated as a hard error**. Now removed. Every advmgmtsys matter auto-triggers detail fetch which the backend handles via **public CCMS fallback** — using the caseRef to call our existing `fetchCaseStatus` + `fetchCaseHistory`. That gives real IA Details and Listing History via the public CCMS portal.

## What you'll see after deploy

For every matter in the list:
- **Status**: PENDING or DISPOSED (was wrongly always PENDING before).
- **Petitioner** and **Respondent** populated.
- **First Hearing** populated with the Registration Date (no longer wrongly the same as Next Hearing).
- **Advocate Side**: PETITIONER or RESPONDENT — under Additional Court Details card.

When you click into a matter:
- Orange "Fetching full details" → it now tries CCMS automatically.
- If CCMS finds the case (most should): IA details, listing history, judges, stage, next hearing — all populate.
- If CCMS doesn't (the case might be too old or the Lucknow CCMS still has flaky uptime): you still see the LIST data nicely rendered, with no error banner.

## Deploy

```bash
cd /Users/utkarsh/Desktop/Legal_AI
git checkout main && git pull origin main

cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_2/api-server__index.js" api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_2/index.html"           index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_2/LegalDesk.html"       LegalDesk.html

grep -c "registrationDate"   api-server/index.js   # must be 5
grep -c "public_ccms_fallback" api-server/index.js # must be 1
grep -c "_extraColumns"       index.html           # must be 1

git add -A && git commit -m "v5.2: fix LIST parser + CCMS detail fallback"
git push origin main
```

GitHub Actions auto-deploys Fly (~2-3 min). GitHub Pages auto-deploys frontend (~3-5 min).

## How to test

1. Hard-refresh dashboard.
2. **Settings → Sync Now** (re-sync to get the new field mapping).
3. Open the Matters list — every matter should now show status (PENDING/DISPOSED), petitioner, respondent, and registration date.
4. Click any matter — the auto-fetch banner should show progress, then turn green when CCMS responds.

## What v5.2 still doesn't do

- **Hearing dates from advmgmtsys.** The dashboard list literally doesn't have a "next hearing" column — that's an upstream limitation, not a parser bug. We fill this from public CCMS detail fetch.
- **Real-time refresh.** Sync is on-demand. To get scheduled background syncs (every 6-12 hours per user), we'd add a cron job + diff job. Separate sprint.
- **DataTables AJAX endpoint discovery.** The advmgmtsys dashboard uses DataTables, which might have a hidden AJAX endpoint for "click row for detail" — but we'd need to inspect the page's JS code to find it. Currently the CCMS fallback gets us the same data via a different route, so this is just an optimization for later.
