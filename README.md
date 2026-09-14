# CoupleGame

Private, consent-first two-player couple game (MVP). Built as a **mobile-first static web app** (HTML, CSS, JavaScript) with **MongoDB Atlas** and **Netlify Functions** so it deploys on Netlify.

## What you can do

- Create a private room and share a secure invite link
- Partner joins (optional PIN) — a third visitor is refused
- 18+ confirmation, nicknames (no accounts)
- Mutual ready → mode agreement (Love Making / Roleplay) → private intensity (Soft / Playful / Intimate)
- 10 knowledge questions each; wrong answers open 4 optional challenges
- Skip / replace never changes score
- End-of-game story report and session history
- Reconnect restores the same round (not a restart)

## Local run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use two browser profiles (or a phone + desktop) to play both seats.

## Netlify deploy

1. Connect this GitHub repo to Netlify (publish directory `public`, functions `netlify/functions`).
2. `netlify.toml` is already configured, including `/api/*` redirects.
3. In Netlify → Site settings → Environment variables, set:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Your Atlas SRV URI, including `/couplegame` |
| `SESSION_SECRET` | A long random string |

The MongoDB driver runs only in serverless functions — credentials never ship to the browser.

In Atlas, allow network access from anywhere (`0.0.0.0/0`) so Netlify’s serverless IPs can connect.

## Stack note

The FSD describes Next.js / NestJS / PostgreSQL / Socket.IO for a later scale-out. This MVP keeps that **product behavior** on a Netlify-friendly stack: HTML/CSS/JS + MongoDB + short polling for two-player sync.
