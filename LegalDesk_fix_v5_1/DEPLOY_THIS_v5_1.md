# v5.1 — Diagnose button to unblock per-matter detail for everyone

## What's actually going on

The matter page showed "No detail URL captured" because my v5 detail-URL regex was too narrow. It guessed at advmgmtsys's HTML without ever seeing it logged in.

**v5.1's job**: give you a one-click way to dump advmgmtsys's actual list HTML so I can see the real structure, fix the parser, and have it work permanently for every matter and every lawyer.

## Deploy

You already have GitHub Actions auto-deploy to Fly — pushing to main rebuilds both backend and frontend.

```bash
cd /Users/utkarsh/Desktop/Legal_AI
git checkout main && git pull origin main

cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_1/api-server__index.js" api-server/index.js
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_1/index.html"           index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v5_1/LegalDesk.html"       LegalDesk.html

# Sanity check — all must be > 0
grep -c "advmgmtsys-debug-list" api-server/index.js   # should print 1
grep -c "rawRowHtml"             api-server/index.js   # should print 1
grep -c "runDiagnose"            index.html             # should print 2
grep -c "advmgmtsysDebugList"    index.html             # should print 2

git add api-server/ index.html LegalDesk.html
git commit -m "v5.1: Diagnose button + broader detail-URL detection"
git push origin main
```

GitHub Actions deploys Fly backend (~2-3 min). GitHub Pages redeploys frontend (~3-5 min).

## Then do this once, paste me the result

Once both are live:

1. Open https://ushukkla.github.io/LegalDesk/, **Cmd+Shift+R** to hard-refresh.
2. Sign in as Akshay.
3. Settings → **Sync Now**, solve the captcha, wait for success toast. (This refreshes the auth session — required for the next step.)
4. Right under the Sync Now button there's now a new **🔍 Diagnose** button. Click it.
5. After 15-30 seconds a textarea appears below filled with JSON. Click **📋 Copy all**.
6. **Paste it here** in our chat.

That's all I need. The dump contains:
- Which dashboard URL had your matter list
- The first row's full HTML — so I can see exactly where the "view detail" link or click handler lives
- The truncated table HTML
- The list of URLs we tried and what they returned

With that one paste, I'll ship a v5.2 in minutes that:
- Correctly extracts the detail URL for every matter
- Parses the right fields when you click into a case
- Works for every advocate who signs up (same advmgmtsys flow, different creds)

## What v5.1 *also* improved (in case Sync Now alone gets you further)

The detail-URL detector now tries 5 different strategies — anchors with view/detail keywords, generic anchors, onclick URLs, JS-built URLs from `viewCase(123)` patterns, and `data-id` attributes. There's a decent chance Sync Now alone is enough to populate `_detailUrl` for most matters now.

So **after Sync Now, try clicking into a matter again**. If the orange "Fetching detail…" banner appears and turns green, we may already be done — no Diagnose needed. Only run Diagnose if the matter detail page still says "No detail URL captured".

## The bigger picture you asked about — "all matters and all lawyers"

Once the parser is fixed, the architecture is already generic:

- Every advocate signs up → enters their advmgmtsys credentials in Settings → clicks Sync Now → captcha → matters load.
- The matter list scrape works the same way for any advocate (just different cookies).
- The detail scrape will work the same way for any advocate.
- No per-user code branches.

The only thing that's currently per-user is the captcha (each login needs a fresh human-typed captcha). When the captcha is solved correctly, the auth session lasts 1 hour, so all syncs/clicks within that hour are seamless.
