# LegalDesk v4.2 — fix advmgmtsys matters disappearing

## What happened in your test

You clicked **Sync Now**, advmgmtsys matters appeared on the dashboard — then 30 seconds later they disappeared and the demo cases came back with a "No cases found for your roll number" toast.

That wasn't a sync failure. The sync worked. What killed it was the **public-CCMS auto-fetch effect** that runs every 10 minutes (and once on mount). It queries `/api/advocate-cases-all` for Akshay's roll, gets back `no_cases_found` (correct — Akshay is a Lucknow Bench advocate, public ALD endpoint genuinely has nothing for him), and then my merge logic wiped *all* matters tagged `_liveData=true`. That tag was set on both public-CCMS results AND advmgmtsys-synced results, so both got dropped.

## What v4.2 fixes

The merge now treats three sources independently:

| Source | Tag |
|---|---|
| advmgmtsys sync | `_source='advmgmtsys'`, id `advm_*` |
| Public CCMS auto-fetch | `_liveData=true`, id `live_*` |
| Manual matter | no tags, id `m*` |

Each source only replaces its own matters. The others survive every fetch outcome:
- ✅ Public CCMS success → only updates `live_*` matters; advmgmtsys + manual preserved
- ✅ Public CCMS "no cases" → advmgmtsys + manual preserved (no more wipe!)
- ✅ Public CCMS maintenance → advmgmtsys + manual preserved
- ✅ advmgmtsys Sync Now → updates `advm_*` matters; public + manual preserved, with caseRef de-dupe so a case in both sources doesn't appear twice

Also:
- The "No cases found" toast is suppressed when advmgmtsys matters are present (they're not "no cases", they're cases from a different source).
- LiveFetchBanner stops shouting about demo data whenever *any* live matter is visible.
- The `no_cases` toast now hints "B/* roll numbers are Lucknow Bench — use Settings → Sync Now to load matters" so future users learn the right path.

## Deploy

```bash
cd /path/to/your/local/LegalDesk
git checkout main
git pull origin main

# Only frontend changed in v4.2 (no backend changes needed)
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4_2/index.html"      index.html
cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fix_v4_2/LegalDesk.html"  LegalDesk.html

# Sanity check — should all be > 0
grep -c "fromAdvmgmtsys" index.html   # should print 10
grep -c "hasAnyLive"     index.html   # should print 2

git add index.html LegalDesk.html
git commit -m "v4.2: preserve advmgmtsys matters across public-CCMS auto-fetch"
git push origin main
```

Only `index.html` and `LegalDesk.html` change. `api-server/index.js` is unchanged (the file in this folder is identical to v4.1 — included for completeness in case you want to verify).

Render auto-deploy doesn't even need to happen (no backend change). GitHub Pages will republish in 3-5 min.

## How to test

1. Hard-refresh the dashboard (Cmd+Shift+R on Mac) to bust the GitHub Pages cache.
2. Sign in as Akshay, go to Settings → **Sync Now**, solve the captcha.
3. Synced matters appear on the dashboard AND on the Matters page.
4. Wait 60+ seconds (longer than the public-CCMS fetch which runs once on mount + every 10 min).
5. Matters should **still be there**, no "No cases found" toast.
6. Navigate around — dashboard, matters, back — matters persist.

If they still disappear, hard-refresh again and check Chrome DevTools → Application → Local Storage → `matters` key. Each matter object should have `_source: "advmgmtsys"` for the synced ones. If they're missing that field, the v4.2 frontend isn't deployed yet (give GitHub Pages another minute).
