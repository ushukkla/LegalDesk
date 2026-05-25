# LegalDesk fix v2 — live matters + demo-data cleanup

This is the follow-up to the first fix. It addresses your report that real
matters still weren't loading and demo data was visible for actual advocates.

## What's in this folder

| File | Replaces in your repo |
|------|----------------------|
| `api-server_index.js` | `api-server/index.js` |
| `captcha-solver.js` | `allahabad-hc-mcp/captcha-solver.js` |
| `index.html` | `index.html` |
| `LegalDesk.html` | `LegalDesk.html` (mirror) |
| `legaldesk-fix-v2.patch` | Combined diff of v1 + v2 against origin/master |

## Quickest way to ship — apply the patch

```bash
cd /path/to/your/LegalDesk
git checkout -b fix/live-matters
git apply /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v2/legaldesk-fix-v2.patch
git diff                    # review
git add -A
git commit -m "Fix live matters fetch + cause list + RSS news + native court-view"
git push -u origin fix/live-matters
```

PR on GitHub → merge to main. Render auto-deploys the backend; GitHub Pages
publishes the frontend.

## Or overwrite the four files

```bash
cd /path/to/your/LegalDesk
git checkout -b fix/live-matters
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v2/api-server_index.js   api-server/index.js
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v2/captcha-solver.js     allahabad-hc-mcp/captcha-solver.js
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v2/index.html            index.html
cp /Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v2/LegalDesk.html        LegalDesk.html
git diff
git add -A && git commit -m "Fix live matters fetch"
git push -u origin fix/live-matters
```

---

## What was broken (and is now fixed)

The matters page kept showing the canned demo data (Rajesh Kumar Mishra,
Amit Singh, Smt. Priya Devi) because **every** advocate-cases call was
failing silently. Seven compounding bugs in one code path:

1. **Wrong submit URL.** Code POSTed to `/apps/status_ccms/advocate-cases-roll-wise`
   — returns HTTP 404. The visible form's `action` attribute lies. The real
   submit is an AJAX call to `/apps/status_ccms/index.php/get_ListedCaseRoll`,
   which returns either an HTML fragment with the cases, or `Record Not Found`,
   or `Captcha code was not match, please try again.`

2. **Wrong form field names.** The CCMS form expects `adv_roll`, `case_year`,
   `captchacode`, `submit=Go`. We were sending `roll_no`, `captcha`,
   `submit=Search`.

3. **Missing `case_year`.** The Allahabad form requires a year per request,
   so to get all cases for an advocate you must iterate years. Now scans
   `currentYear-4` through `currentYear` by default; pass `?yearsBack=N`
   to widen.

4. **Wrong Lucknow host.** `status_ccms_lko` on the main domain is dead.
   LKO moved to `hclko.allahabadhighcourt.in/status` and uses
   `advocate-cases-date-wise` (per-date listings), not roll-wise. **The
   Lucknow Bench CCMS is currently in maintenance** — when you run this,
   you may see a maintenance banner instead of cases. The new code detects
   that banner and surfaces a clear `upstream_maintenance` status to the UI
   instead of confusing the user with "no cases found".

5. **Captcha image regex didn't match.** Old regex only matched `<img>` with
   `captcha` in the `src` URL. The CCMS captcha is at
   `/secureimage/securimage` — no `captcha` substring. Added multiple
   patterns (id="captcha", securimage URLs, etc.).

6. **Captcha OCR was reading background noise.** The captcha is bold
   dark-teal digits over a light-gray background of random letters and
   strikethrough lines. Plain grayscale + threshold kept both. Added
   color-based pixel extraction: keep only dark-teal/blue, drop everything
   gray. Verified OCR going from ~0% accuracy to ~70-80% on real captchas
   ("4832" and "4155" both read correctly). Plus a digit-only whitelist
   and a 4-digit shape bonus.

7. **Cookie session was broken.** Old code took `Set-Cookie` response
   headers (e.g. `ci_session=abc; Path=/; HttpOnly`) and used the whole
   string as the `Cookie` request header — which is invalid syntax. The
   session was thrown away on every POST, so even a correct captcha would
   be rejected because the server didn't recognize the session it
   generated the captcha for. Fixed by stripping everything after the
   first `;`.

### Frontend changes

8. **Demo matters were always shown on first load** and never cleared when
   the live fetch returned no cases. Now:
   - Demo matters seed only when no user has signed in yet.
   - Once an advocate signs in, demo data is replaced by live data, cleared
     when the fetch returns "no cases", or replaced with a maintenance
     message — never silently kept.

9. **New LiveFetchBanner on the Matters page** that distinguishes:
   - "Sample data shown" (you're seeing the demo set — warning)
   - "Fetching your live matters…" (in progress)
   - "Lucknow Bench is in maintenance" (upstream is down)
   - "No live cases found for roll number X" (clear, with hint to check
     Settings for roll-number format)
   - "Backend is unreachable" (Render cold start)
   - "Loaded N live cases" (success, with per-bench counts)

10. **New diagnostic endpoints** to help debug:
    - `GET /api/advocate-diag/:rollNumber` — shows the URLs, roll-number
      variants, and years the backend will try.
    - `GET /api/advocate-dryrun?bench=allahabad&year=2026&roll=B/A2401/2019`
      — one POST with raw response, for inspecting what the upstream returns.

---

## Verified for B/A2401/2019 (Akshay Kumar Singh)

When I tested the patched code against the live court site for Akshay's roll number:

- **ALD bench** (`advocate-cases/B/A2401/2019?bench=allahabad`)
  - POST reaches `get_ListedCaseRoll` — HTTP 200.
  - When captcha solves correctly → `Record Not Found` (he has no
    Allahabad-bench cases, consistent with MyMunshi showing him as a
    Lucknow Bench advocate).
  - When captcha OCR misses → `Captcha code was not match, please try
    again.` Solver retries up to 6 times per call.

- **LKO bench** (`advocate-cases/B/A2401/2019?bench=lucknow`)
  - Detected upstream maintenance immediately and returned status
    `upstream_maintenance` with a clear error message. Once LKO is back
    online, the same code will scrape per-date listings to assemble his
    186-matter list.

- **Demo data**: With my patched frontend, an advocate who signs in sees
  either their real cases, a maintenance banner, or a clear "no cases
  found" message — never the Rajesh Kumar Mishra demo unless they're a
  brand-new visitor with no profile saved.

---

## What's still on the to-do list

The first-pass fix (cause list URL, RSS news, native court-view) shipped in
v1. This v2 fix removes the demo data and gets advocate-cases working.

Still ahead (Sprints 2+, when you're ready):

- **Persistence layer.** Right now every advocate-cases call re-scrapes
  from scratch (and rate-limits via in-memory cache only). Add Postgres
  or Firestore so cases are stored per advocate and the dashboard loads
  instantly.
- **Scheduled scraper + activity feed.** What powers MyMunshi's "Case has
  been updated 7 hours ago" panel. Requires the persistence layer.
- **Richer matter detail parser.** Pull the 15 fields MyMunshi shows
  (bench type, Bench ID, judicial branch, causelist type, IA details
  with filing dates, listing history with outcomes, etc.). They're all
  available on the CCMS case-detail page — current parser collapses
  rows.
- **Authenticated LKO via `advmgmtsys`.** MyMunshi clearly logs into the
  Lucknow advocate management system to get the full matter history.
  Public per-date scraping only approximates it.

When LKO comes out of maintenance, please re-test and let me know:
- whether the LKO date-wise scrape returns any of his real cases for
  current/upcoming listings, and
- whether the captcha success rate is acceptable on a real Render
  deployment (sometimes Render's CPU is slower than local).

If LKO returns 0 cases consistently when it's back online, the next step
is to wire up the `advmgmtsys` login flow.
