# EvalNexa Production Deployment Runbook
**Target:** Render Backend + Cloudflare Pages Frontends (Custom Subdomains)

---

## 1. Architecture Overview

| Component | Host | URL / Custom Subdomain | Build Command | Output Directory | Root Directory |
|---|---|---|---|---|---|
| **Backend API & Sockets** | Render | `https://evalnexa.onrender.com` | `pnpm --filter backend build` | N/A (Server) | `/` (or `/backend`) |
| **Examiner Workspace** | Cloudflare Pages | `https://examiner.shivasoni.me` | `pnpm --filter examiner build` | `apps/examiner/dist` | `/` |
| **Control Center** | Cloudflare Pages | `https://control.shivasoni.me` | `pnpm --filter control-center build` | `apps/control-center/dist` | `/` |
| **Moderation Centre** | Cloudflare Pages | `https://moderation.shivasoni.me` | `pnpm --filter moderation build` | `apps/moderation/dist` | `/` |

---

## 2. Render Backend Configuration

### Service Type: Web Service
- **Runtime:** Node.js (Node >= 20.x, pnpm >= 9.x)
- **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter backend build`
- **Start Command:** `pnpm --filter backend start` (or `node backend/dist/server.js`)
- **Health Check Path:** `/health`

### Environment Variables on Render:

| Variable Name | Required | Description / Example Value |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `PORT` | Auto (Render) | `5000` (Render assigns dynamically) |
| `MONGODB_URI` | Yes | MongoDB Atlas production connection URI |
| `JWT_SECRET` | Yes | Secure, random 64-character secret key |
| `JWT_EXPIRES_IN` | Optional | `7d` (defaults to 7d) |
| `CLIENT_CONTROL_CENTER_URL` | Yes | `https://control.shivasoni.me` |
| `CLIENT_EXAMINER_URL` | Yes | `https://examiner.shivasoni.me` |
| `CLIENT_MODERATION_URL` | Yes | `https://moderation.shivasoni.me` |
| `CLOUDINARY_CLOUD_NAME` | Yes | Production Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Production Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Production Cloudinary API secret |
| `INGESTION_API_KEY` | Yes | Pre-shared key for hardware scanner/batch upload ingestion |
| `GEMINI_API_KEY` | Yes | Google AI Gemini Studio API key |
| `GEMINI_MODEL` | Optional | `gemini-3.1-flash-lite` |

---

## 3. Cloudflare Pages Projects Configuration

### A. Examiner Workspace Project
- **Project Name:** `evalnexa-examiner`
- **Framework Preset:** None (or Vite)
- **Root Directory:** `/`
- **Build Command:** `pnpm --filter examiner build`
- **Build Output Directory:** `apps/examiner/dist`
- **Node.js Version:** `20.x` (or via `packageManager` / `engines`)
- **Custom Domain:** `examiner.shivasoni.me`
- **Environment Variables (Optional overrides):**
  - `VITE_BACKEND_URL`: `https://evalnexa.onrender.com` (already default fallback)

### B. Control Center Project
- **Project Name:** `evalnexa-control`
- **Framework Preset:** None (or Vite)
- **Root Directory:** `/`
- **Build Command:** `pnpm --filter control-center build`
- **Build Output Directory:** `apps/control-center/dist`
- **Node.js Version:** `20.x`
- **Custom Domain:** `control.shivasoni.me`
- **Environment Variables (Optional overrides):**
  - `VITE_BACKEND_URL`: `https://evalnexa.onrender.com`
  - `VITE_MODERATION_URL`: `https://moderation.shivasoni.me`

### C. Moderation Centre Project
- **Project Name:** `evalnexa-moderation`
- **Framework Preset:** None (or Vite)
- **Root Directory:** `/`
- **Build Command:** `pnpm --filter moderation build`
- **Build Output Directory:** `apps/moderation/dist`
- **Node.js Version:** `20.x`
- **Custom Domain:** `moderation.shivasoni.me`
- **Environment Variables (Optional overrides):**
  - `VITE_BACKEND_URL`: `https://evalnexa.onrender.com`

---

## 4. Single-Page Application (SPA) Routing on Cloudflare Pages

For client-side React Router navigation (e.g. `/review/:id`, `/exams`, etc.), ensure Cloudflare Pages routes not-found URLs to `/index.html`. Cloudflare Pages does this natively for single-page applications. If needed, a `_routes.json` or fallback rule redirects `/*` to `/index.html`.
