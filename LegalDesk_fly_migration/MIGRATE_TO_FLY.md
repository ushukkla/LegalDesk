# Migrate LegalDesk backend from Render to Fly.io

End-to-end runbook. Estimated time: **30-45 minutes**. Zero downtime if you follow the steps in order (keep Render running until Fly is verified).

## Why we're moving

| | Render free | Fly.io Mumbai |
|---|---|---|
| Cost | $0 | ~$3.88/mo (512MB shared CPU; $5 starter credit covers ~1 month) |
| Cold starts | Yes — 30-45s after 15 min idle | No — stays warm |
| Region | US/EU only | Mumbai (~30-50ms to Indian users vs Render's 200-300ms) |
| Tesseract.js memory | Tight on free tier | Comfortable with 512MB |

Render starter ($7/mo) also kills cold starts, but doesn't have an Indian region. Fly is cheaper AND faster for your user base.

---

## Step 1 — Install the Fly CLI

Mac:
```bash
brew install flyctl
```

Then sign up (one-time):
```bash
flyctl auth signup
```

Or if you already have an account:
```bash
flyctl auth login
```

Fly asks for a payment method (credit card or PayPal). They give a **$5 starter credit** — covers ~1 month of the 512MB Mumbai machine. No charge until that's used up.

---

## Step 2 — Drop the fly.toml into your repo

```bash
cd /path/to/your/local/LegalDesk
git pull origin main

cp "/Users/utkarsh/Desktop/Legal_AI/LegalDesk_fly_migration/fly.toml" ./fly.toml
```

Open `fly.toml` and check **line 7**: `app = "legaldesk-api"`. Fly app names are globally unique. If that name is already taken (it might be), change it to something else like `legaldesk-api-us` or `legaldesk-akshay`. Save.

(Optional, only if you don't already have one:) drop in the `.dockerignore` too. Skip if you already have one.

---

## Step 3 — Create and launch the app

```bash
cd /path/to/your/local/LegalDesk

# This reads fly.toml, builds your Dockerfile remotely, and deploys.
# First run will ask a couple of confirmation questions — accept defaults.
flyctl launch --copy-config --name <your-app-name> --region bom --no-deploy
```

The `--no-deploy` flag stops it before pushing — gives you a chance to verify the config. You'll see Fly resolve everything from the existing `Dockerfile` + `fly.toml`.

Then deploy:

```bash
flyctl deploy
```

First deploy takes 3-5 minutes (Docker build + push + boot). Subsequent deploys are 1-2 min.

Watch the deploy logs in real time:

```bash
flyctl logs
```

---

## Step 4 — Verify Fly backend is alive

Get the URL Fly assigned you (probably `https://<your-app-name>.fly.dev`):

```bash
flyctl info | grep Hostname
```

Run these against the new URL — they should mirror what Render was serving:

```bash
curl https://<your-app-name>.fly.dev/health
# {"status":"ok","server":"LegalDesk API","version":"1.0.0",...}

curl https://<your-app-name>.fly.dev/api/advmgmtsys-status
# {"status":"alpha","message":"Manual-captcha login flow active",...}

curl -X POST -H "Content-Type: application/json" -d '{}' \
  https://<your-app-name>.fly.dev/api/advmgmtsys-prepare
# {"status":"ready","sessionId":"...","captchaPng":"data:image/png;base64,...","cookieCount":1,...}
```

If all three return the right JSON, Fly is good. If not, run `flyctl logs --no-tail` to see what crashed.

---

## Step 5 — Point the frontend at Fly

In your local repo, open `index.html` and `LegalDesk.html`. Find the line (around line ~2103):

```js
baseUrl: 'https://legaldesk-api.onrender.com',
```

Replace with your new Fly URL:

```js
baseUrl: 'https://<your-app-name>.fly.dev',
```

Save both files. Commit:

```bash
git add fly.toml index.html LegalDesk.html
git commit -m "Migrate backend to Fly.io (Mumbai region) — point frontend at fly.dev"
git push origin main
```

GitHub Pages republishes in 3-5 min. After that, hard-refresh the dashboard (Cmd+Shift+R) and verify Sync Now works against the new backend.

---

## Step 6 — Verify end-to-end with Akshay's account

1. Hard-refresh `https://ushukkla.github.io/LegalDesk/`.
2. Open DevTools → Network tab — confirm requests now go to `<your-app-name>.fly.dev` not `legaldesk-api.onrender.com`.
3. Settings → Sync Now → enter captcha → confirm advmgmtsys matters load.
4. Wait 60+ seconds. Matters persist. (Confirms v4.2 fix is working on the new platform too.)
5. Check latency: in DevTools Network tab, API call should be ~50-100ms (vs Render's 300-500ms).

---

## Step 7 — Decommission Render (only after a few days of confidence)

Wait 2-3 days of using Fly without issues. Then:

1. Go to dashboard.render.com → `legaldesk-api` service.
2. Settings → Delete service.

Or **keep Render as a warm backup**: just leave it running. It's free, sleeps when idle. If Fly ever has issues you can swap the frontend baseUrl back in 5 minutes.

---

## Cost monitoring

Check anytime:

```bash
flyctl billing
flyctl status
```

Hard limits you should set so you never get a surprise bill (do this once after first deploy):

1. Fly dashboard → Billing → set a monthly cap of $10. That stops new deploys / scaling above that.
2. Fly dashboard → app → Metrics — watch RAM usage. If it consistently hits ~450MB+ during captcha solves, bump memory to 1GB (~$7.78/mo).

---

## Common things that go wrong (and the fix)

| Symptom | Cause | Fix |
|---|---|---|
| `flyctl launch` says "app name not available" | Someone took the global name | Change `app = "..."` in fly.toml to something else, retry |
| Deploy times out | Docker build is slow on Fly's remote builder | `flyctl deploy --local-only` (builds on your laptop, pushes the image) |
| Health checks fail after deploy | App didn't bind to `process.env.PORT` | Already correct in api-server/index.js — check `flyctl logs` for actual error |
| OOM (machine killed and restarted) | 512MB ran out during tesseract OCR | Bump memory in fly.toml to `"1024mb"`, `flyctl deploy` |
| First request takes 30s | Machine had auto-stopped | You set `auto_stop_machines = "off"` in fly.toml — shouldn't happen. If it does, check `min_machines_running = 1` is set |
| Login auto-stop credits running out | Free trial ended | Top up Fly with $5-10. Monthly cost is ~$4 |

---

## Bonus: secrets / env vars

If you ever add env vars (e.g., a Google Vision API key for auto-captcha), don't put them in fly.toml:

```bash
flyctl secrets set GOOGLE_VISION_KEY="..."
flyctl secrets set DATABASE_URL="..."
```

Secrets are injected as env vars at runtime, never logged, never in source.

---

## Reference

- Fly docs: https://fly.io/docs/
- This config uses Fly Machines v2 (current API as of 2026).
- Region codes: https://fly.io/docs/reference/regions/
- Pricing calculator: https://fly.io/calculator
