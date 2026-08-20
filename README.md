# airvpn-history-worker

Cloudflare Worker that polls AirVPN's public network status API on a schedule,
stores server snapshots in D1, and exposes an HTTP API for historical trends
and load-based rankings. Built to back the Air-Dash iOS app's server list.

Stays within Cloudflare's free tier: Workers (100k req/day), D1 (5 GB, 5M
rows read / 100k rows written per day). At a 5-minute collection interval and
~80 AirVPN servers, that's ~23k rows written per day.

## How it works

- **Collection** (`*/5 * * * *`): fetches `POST https://airvpn.org/api/status/`
  and inserts one row per server into `server_snapshots`. On network failure
  or HTTP 429, the cycle is skipped and logged; the next cron run retries.
- **Maintenance** (`0 3 * * *`, daily): aggregates `server_snapshots` rows
  older than 7 days into hourly averages in `server_snapshots_hourly`, then
  deletes the aggregated raw rows. Hourly rows older than 30 days are purged.
- **API** (`fetch`): three read-only JSON routes, CORS-enabled for all
  origins.

No ping/latency is stored — the AirVPN status API doesn't provide it, and the
iOS app already measures ping client-side, so `sortBy=ping` on the ranking
route returns `400`.

## Routes

- `GET /servers/history?server=<name>&range=24h` — time series for one
  server. `range` accepts `<n>m`, `<n>h`, `<n>d` (e.g. `30m`, `24h`, `7d`).
  Automatically blends raw (last 7 days) and hourly (7-30 days) data. `404`
  if the server name is unknown.
- `GET /servers/latest` — most recent snapshot for every server.
- `GET /servers/ranking?sortBy=load&window=1h` — servers ranked by average
  load over the window, ascending (lowest load first). `window` accepts the
  same format as `range`.

## Setup

```bash
pnpm install

# Create the D1 database (once) and paste the returned database_id into
# wrangler.jsonc under d1_databases[0].database_id
npx wrangler d1 create airvpn-history

# Apply schema locally and remotely
pnpm db:init:local
pnpm db:init:remote
```

## Local dev

```bash
pnpm dev
```

Scheduled handlers aren't triggered automatically in local dev. Trigger them
manually:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"   # collection
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+3+*+*+*"     # maintenance
```

## Deploy

```bash
pnpm deploy
pnpm tail   # watch logs / verify the cron fires
```
