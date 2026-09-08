# Deploy this portal

## What this app is

A small **Express + static** site:

- `public/` — the map, camera wall, and queues UI
- `GET /api/queues` — live truck/bus JSON from Ukraine’s official eQueue service
- `GET /api/media` — **long-lived HLS proxy** for Moldova Border Police camera streams

Location (“Nearest to me”) is computed **only in the browser**. It is never sent to our server.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:4173

## Is Netlify good enough?

**Netlify is good enough for the static frontend** (`public/index.html`, CSS, JS). It is **not a good primary host for this app as-is**.

Why: live camera playback goes through `/api/media`, which must stay connected and stream HLS playlists and video segments. Netlify Functions time out quickly (**about 10 seconds on free, about 26 seconds on Pro**). That is a poor fit for video.

`/api/queues` *could* be a Netlify Function (short JSON fetch). Cameras cannot.

### Where to deploy instead

Deploy the **whole Express app** (`npm start` / `node server.js`) on one of these, simplest first:

1. **[Render](https://render.com)** Web Service — connect the repo, start command `npm start`, instance with enough RAM for a tiny Node process.
2. **[Railway](https://railway.app)** — same idea; set start command `npm start`.
3. **[Fly.io](https://fly.io)** — good if you want a region closer to Ukraine/EU.

A cheap **VPS** (Hetzner, DigitalOcean) is a solid backup: install Node 22, `npm start` behind Caddy or nginx with HTTPS.

Point the custom domain at that service. The UI, queues, and camera proxy then all share one origin (no CORS headaches).

### If you insist on Netlify

- Publish `public/` as a static site (`netlify.toml` already does this).
- Optionally add a Function that implements `/api/queues` only.
- **Do not** proxy HLS through Functions. The camera wall should open the official Moldova pages (`https://border.gov.md/camere-web/...`) instead.

You will get a nice map and queue list, but **in-portal live video will not work** the way it does with the Node server.

## Render / Railway checklist

- Build: `npm install`
- Start: `npm start`
- Port: use the platform `PORT` env (the server already reads `process.env.PORT`)
- Health: `GET /api/health`
