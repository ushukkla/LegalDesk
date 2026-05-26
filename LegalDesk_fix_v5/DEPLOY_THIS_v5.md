# LegalDesk v5 — per-matter detail from advmgmtsys

## What v5 fixes

Your report: matters synced from advmgmtsys appeared on the dashboard, but most were missing IA details, hearing dates, petitioner/respondent breakdown — basically the rich detail page that MyMunshi shows.

Reason: my v4 scraper only read the matter LIST table (which has limited columns). The rich detail lives on each matter's individual page, which I wasn't fetching.

v5 adds:

1. **Better LIST scrape**. Each row now also captures:
   - The detail-page URL (the anchor link on the row).
   - All cell values as a raw array (for fallback rendering).
   - Any date-shaped string in the row — so `nextHearing` gets populated from row text when the column header doesn't match my heuristic.

2. **New `/api/advmgmtsys-detail` endpoint** that uses the cached auth session (no captcha re-prompt) to fetch each matter's detail page and parse:
   - Standard fields: petitioner, respondent, stage, bench type, judicial branch, causelist type, coram, first/last/next hearing, state, district, filing date.
   - IA Details table (application number, classification, party, filing date, status).
   - Listing History table (date, bench, cause type, order text).
   - Order History / Judgments table.
   - Plus any extra label-value pairs the parser found (Bench ID, File No, etc.) → rendered in a new "Additional Court Details" card.

3. **Auto-fetch on matter detail page**. When you click into an advmgmtsys-sourced matter, the frontend automatically calls the detail endpoint in the background. You see a status banner: "Fetching full details…" → "✓ Loaded at HH:MM:SS" with a Refresh button.

4. **Stable matter IDs** keyed to caseRef — so re-syncing replaces existing matters instead of duplicating them.

5. **Detail cache** on the backend, 1-hour TTL per (user, caseRef), so re-opening a matter is instant.

6. **Session-expiry handling** — if the cached cookie expired (e.g. you waited > 1 hour), the auto-fetch detects it and clears the bad cookie, prompting a fresh Sync Now.

## Deploy

```bash
cd /Users/utkarsh/Desktop/Legal_AI
git checkout main
git pull origin main

cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5/api-server__index.js" api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5/index.html"            index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5/LegalDesk.html"        LegalDesk.html

# Sanity check — must all be > 0
grep -c "parseAdvmgmtDetail"          api-server/index.js   # should print 2
grep -c "advmgmtsys-detail"            api-server/index.js   # should print 2
grep -c "refreshAdvmgmtDetail"         index.html             # should print 5
grep -c "Additional Court Details"     index.html             # should print 1

git add api-server/ index.html LegalDesk.html
git commit -m "v5: per-matter detail fetch from advmgmtsys"
git push origin main
```

Fly auto-redeploys backend (~1 min). GitHub Pages republishes frontend (~3-5 min).

## How to test

1. Hard-refresh the dashboard (Cmd+Shift+R).
2. Settings → **Sync Now** (re-sync to capture the new detailUrl per row — old matters synced before v5 won't have it).
3. Solve the captcha.
4. Go to Matters → click any case.
5. You should see an orange banner at the top: **"Fetching full details from advmgmtsys…"** for 1-2 seconds.
6. Then it turns green: **"✓ Full detail loaded from advmgmtsys (HH:MM:SS)"**.
7. The matter's fields (last/next/first hearing, stage, bench type, judicial branch, coram, district, etc.) should now be populated.
8. Scroll down — Listing History and IA Details tables should be filled if upstream has them.
9. Below Listing History, there should be an **Additional Court Details** card with anything extra the parser caught (Bench ID, file numbers, classification codes).

## What to do if a matter is still sparse

The parser is best-effort against an unknown HTML layout. Some advmgmtsys detail pages may use a structure I didn't anticipate. If a matter still shows mostly empty fields after the green banner appears:

1. Open Chrome DevTools → Network tab.
2. Click **Refresh** on that matter's banner.
3. Find the request to `/api/advmgmtsys-detail` → click it → Response tab.
4. Copy the JSON response and paste it to me. I'll look at:
   - `fields` — every label/value the parser found loosely
   - `iaDetails`, `listingHistory`, `orderHistory` — whether those sections were detected
   - `sectionsDetected` — which headings my parser recognized
   That tells me which Yii pattern to add to the parser, and v5.1 ships in minutes.

## What v5 still doesn't do

- **Auto-sync on a schedule.** Detail re-fetching is on-demand or on-open. To get MyMunshi-style "Case has been updated 7 hours ago" notifications, we need a backend cron + diff job + activity log.
- **Order/judgment downloads.** If the detail page has PDF links to orders, the parser captures their text but doesn't download the PDFs. Easy to add when needed.
- **Pagination of the matter list.** If you have > 100 matters, advmgmtsys may paginate them. v5 only reads the first page. Tell me if you see fewer matters than expected and I'll add page traversal.

Each of those is a small follow-up — tell me when you want any of them and I'll bundle a v6.

## Costs to expect

This v5 doesn't change anything about hosting cost. Fly's free starter credit still covers your traffic.

The new detail endpoint does up to one HTTP fetch per matter open, but they're cached for 1 hour. Worst case for Akshay with 186 matters: 186 fetches × ~500ms each ≈ 90 seconds total, spread across whenever he clicks matters. That's fine for Fly's free tier.
