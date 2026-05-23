# LegalDesk API — Cloud Deployment Guide

Your API server can be deployed to any cloud platform. Below are step-by-step instructions for the two easiest options.

---

## Option A: Render (Recommended — Free Tier Available)

Render offers a generous free tier and auto-deploys from GitHub.

### Steps

1. **Push your repo to GitHub** (if not already done)

2. **Go to Render Dashboard**
   - Visit https://dashboard.render.com
   - Click **New → Blueprint**
   - Connect your GitHub repo

3. **Render auto-detects `render.yaml`** and sets everything up:
   - Builds from the Dockerfile
   - Sets up health checks on `/health`
   - Exposes port 3001

4. **Copy your deployment URL**
   - It'll look like: `https://legaldesk-api.onrender.com`

5. **Update LegalDesk frontend**
   - Open LegalDesk → Settings → Court Data Backend
   - Paste your Render URL (e.g., `https://legaldesk-api.onrender.com`)
   - Click "Test Connection"

### Notes
- **Free tier** spins down after 15 minutes of inactivity. First request after sleep takes ~30 seconds.
- **Starter tier** ($7/month) keeps it always-on with no cold starts.

---

## Option B: Railway

Railway is developer-friendly with generous free credits.

### Steps

1. **Go to** https://railway.com → New Project → Deploy from GitHub Repo

2. **Connect your repo** — Railway auto-detects `railway.json`

3. **Add environment variables** in the Railway dashboard:
   - `NODE_ENV` = `production`
   - `PORT` = `3001`

4. **Generate a domain** — Settings → Networking → Generate Domain

5. **Copy your URL** (e.g., `https://legaldesk-api.up.railway.app`)

6. **Update LegalDesk frontend** — Settings → paste URL → Test Connection

---

## Option C: Any Docker Host (VPS, DigitalOcean, AWS, etc.)

```bash
# From the repo root directory:
docker build -t legaldesk-api .
docker run -d -p 3001:3001 --name legaldesk-api legaldesk-api
```

Verify: `curl http://your-server-ip:3001/health`

---

## After Deployment

Once your API is live in the cloud:

1. **Open LegalDesk** in your browser
2. Go to **Settings** (gear icon)
3. Under **Court Data Backend**, replace `http://localhost:3001` with your cloud URL
4. Click **Test Connection** — you should see a green "Backend connected!" toast
5. The dashboard badge will switch from "DEMO DATA" to "LIVE DATA"

Your lawyers can now use real court data without needing to run anything locally.
