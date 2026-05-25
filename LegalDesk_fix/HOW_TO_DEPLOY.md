# LegalDesk fix — how to deploy

These files are a drop-in replacement for three files in your `LegalDesk` repo:

| File in this folder | Replaces in your repo |
|---|---|
| `api-server_index.js` | `api-server/index.js` |
| `index.html` | `index.html` (GitHub Pages entry) |
| `LegalDesk.html` | `LegalDesk.html` (mirror of index.html) |
| `legaldesk-fix.patch` | The full diff if you'd rather review than overwrite |

---

## Option A — apply the patch (recommended, cleanest history)

```bash
cd /path/to/your/LegalDesk
git checkout -b fix/live-data-sources
git apply /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix/legaldesk-fix.patch
git status                      # review what changed
git diff                        # review line-by-line
git add -A
git commit -m "Fix live data sources: cause list URL, RSS news, native court-view render"
git push -u origin fix/live-data-sources
```

Then open a PR on GitHub, merge to `main`. Render auto-deploys the backend on push to main.

## Option B — overwrite the three files

```bash
cd /path/to/your/LegalDesk
git checkout -b fix/live-data-sources

cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix/api-server_index.js  api-server/index.js
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix/index.html           index.html
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix/LegalDesk.html       LegalDesk.html

git diff                        # review
git add -A
git commit -m "Fix live data sources: cause list URL, RSS news, native court-view render"
git push -u origin fix/live-data-sources
```

## Option C — push straight to main (faster, no PR)

Same as B but replace `git checkout -b fix/live-data-sources` with `git checkout main`,
and the final push with `git push origin main`. Render and GitHub Pages will
redeploy automatically.

---

## What changed and why

### Backend (`api-server/index.js`)

1. **Fixed the broken cause-list URL.**
   `fetchCauselistToday` was hitting `/causelist/causelist_ald.htm` and
   `/causelist/causelist_lko.htm` — both return HTTP 404. The court moved
   this content to the CCMS app. New URLs:
   - Allahabad: `https://www.allahabadhighcourt.in/apps/status_ccms/index.php/causelist`
   - Lucknow: `https://hclko.allahabadhighcourt.in/status/index.php/cause-list`
   - Plus a fallback parse of the legacy PDF index (`indexA.html` / `indexL.html`)
     to pick up consolidated/supplementary PDFs.

2. **Added `/api/news` — live legal updates.**
   Fetches and parses two RSS feeds:
   - `https://www.allahabadhighcourt.in/calendar/rssHeadlines.jsp` — court
     notifications / circulars / judicial-officer transfers.
   - `https://elegalix.allahabadhighcourt.in/elegalix/rssfeed.do` — AFR /
     Landmark judgments.

   Returns merged-and-sorted items with `{title, link, description, source,
   pubDate}`. Cached 60 min. Supports `?limit=N`.

### Frontend (`index.html` / `LegalDesk.html`)

3. **Replaced hardcoded `LEGAL_NEWS` with a live hook.**
   The old constant was 5 fake headlines dated "2 hours ago" that never
   changed. Now there's a `useLegalNews()` hook + `LegalUpdatesCard`
   component that calls `/api/news` and renders real items. The full
   "Legal Updates" page got a filter (All / Headlines / Judgments) and
   source badges.

4. **Replaced the unworkable iframe with a native court-view table.**
   `courtview2.allahabadhighcourt.in` sends `X-Frame-Options: SAMEORIGIN`,
   which blocks iframe embedding in every browser. The old CTA box
   ("Court websites restrict embedding…") was the symptom. The new
   `LiveCourtViewPanel` calls `/api/court-view` and renders a real table
   of in-session courts (Court · Item · Case · Title · Petitioner Counsel
   · Respondent Counsel · Progress), auto-refreshing every 30 seconds.

5. **Fixed the two other dead causelist URLs in the frontend** (the Live
   Panels config and the "Today's Cause List" button on the Causelist
   page).

---

## Verified locally

Run these against your Render deployment after pushing to confirm:

```bash
curl https://legaldesk-api.onrender.com/health
curl https://legaldesk-api.onrender.com/api/news?limit=5
curl https://legaldesk-api.onrender.com/api/causelist-today?bench=allahabad
curl https://legaldesk-api.onrender.com/api/court-view?bench=allahabad
```

When I ran these locally against the patched code (port 3099) I got:

- `/health` → ok
- `/api/news` → status: success, **13 items** (3 headlines, 10 judgments),
  real titles like "Deposits under S 30(1) without compliance of Rule 21
  are invalid…" with proper pubDates.
- `/api/causelist-today` → status: success, source: ccms+pdf-index,
  picks up the CCMS link. The CCMS page is mostly a UI shell that loads
  its table via AJAX from form submissions — so right now you get the
  link to it rather than parsed rows. That's still a real improvement
  over the previous 404. (Parsing the AJAX response is Sprint 1.5
  work: a follow-up endpoint that POSTs a date + court to the CCMS form.)
- `/api/court-view` → status: success, **94 courts**, 50 in_session.

---

## What's still on the roadmap (not in this patch)

These are the bigger items from the audit doc, deliberately deferred:

- **Persistence layer (Sprint 2).** Adding Postgres/Firestore for matters
  and an activity_log table. Required to match MyMunshi's instant matter
  loads and the "Case has been updated 7 hours ago" notification panel.
- **Richer matter-detail parser (Sprint 3).** The 15 fields MyMunshi shows
  that LegalDesk currently doesn't extract (bench_type, judicial_branch,
  causelist_type, IA details, listing history with bench composition, etc.).
- **Activity feed (Sprint 4).** Needs the persistence layer first.
- **Trackers + multi-court (Sprints 5-6).** FIR, Appeal, Caveat, DRT,
  NCLT — all separate adapters.

When you're ready, just ask for the next sprint.

---

## Render notes

Your backend at `legaldesk-api.onrender.com` is on the free tier (you
confirmed auto-deploy on push to main). First request after a 15-min
idle period takes ~30s while the container wakes up — this affects all
endpoints, not anything I changed. When you start persistence/scrapers
in Sprint 2, plan for either a paid Render tier or a cron-pinger to keep
the service warm.
