import { parseDurationSeconds } from "./duration";

const RAW_RETENTION_SECONDS = 7 * 24 * 3600;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface SnapshotRow {
  server_name: string;
  country_name: string | null;
  country_code: string | null;
  location: string | null;
  load_percent: number;
  bw_current: number | null;
  bw_max: number | null;
  users_count: number | null;
  health: string;
  recorded_at: number;
}

async function serverExists(db: D1Database, serverName: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM server_snapshots WHERE server_name = ? LIMIT 1`)
    .bind(serverName)
    .first();
  if (row) return true;
  const hourlyRow = await db
    .prepare(`SELECT 1 FROM server_snapshots_hourly WHERE server_name = ? LIMIT 1`)
    .bind(serverName)
    .first();
  return hourlyRow !== null;
}

interface WindowBounds {
  since: number;
  rawBoundary: number;
  rawSince: number;
  needsHourly: boolean;
}

/** Splits a requested lookback window into the raw-table and hourly-table
 * portions, since raw data only covers the last RAW_RETENTION_SECONDS. */
function computeWindowBounds(windowSeconds: number): WindowBounds {
  const now = Math.floor(Date.now() / 1000);
  const since = now - windowSeconds;
  const rawBoundary = now - RAW_RETENTION_SECONDS;
  return {
    since,
    rawBoundary,
    rawSince: Math.max(since, rawBoundary),
    needsHourly: since < rawBoundary,
  };
}

export async function handleHistory(db: D1Database, url: URL): Promise<Response> {
  const serverName = url.searchParams.get("server");
  if (!serverName) return error("Missing required 'server' query param", 400);

  const rangeParam = url.searchParams.get("range") ?? "24h";
  const rangeSeconds = parseDurationSeconds(rangeParam);
  if (rangeSeconds === null) {
    return error("Invalid 'range' format, expected e.g. 24h, 7d, 30m", 400);
  }

  if (!(await serverExists(db, serverName))) {
    return error(`Unknown server: ${serverName}`, 404);
  }

  const { since, rawBoundary, rawSince, needsHourly } = computeWindowBounds(rangeSeconds);

  const rows: SnapshotRow[] = [];

  if (needsHourly) {
    const hourlyResult = await db
      .prepare(
        `SELECT server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at
         FROM server_snapshots_hourly
         WHERE server_name = ? AND recorded_at >= ? AND recorded_at < ?
         ORDER BY recorded_at ASC`
      )
      .bind(serverName, since, rawBoundary)
      .all<SnapshotRow>();
    rows.push(...(hourlyResult.results ?? []));
  }

  const rawResult = await db
    .prepare(
      `SELECT server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at
       FROM server_snapshots
       WHERE server_name = ? AND recorded_at >= ?
       ORDER BY recorded_at ASC`
    )
    .bind(serverName, rawSince)
    .all<SnapshotRow>();
  rows.push(...(rawResult.results ?? []));

  return json({ server: serverName, range: rangeParam, points: rows });
}

export async function handleLatest(db: D1Database): Promise<Response> {
  const result = await db
    .prepare(
      `SELECT s.server_name, s.country_name, s.country_code, s.location, s.load_percent, s.bw_current, s.bw_max, s.users_count, s.health, s.recorded_at
       FROM server_snapshots s
       INNER JOIN (
         SELECT server_name, MAX(recorded_at) AS max_time
         FROM server_snapshots
         GROUP BY server_name
       ) latest
       ON s.server_name = latest.server_name AND s.recorded_at = latest.max_time
       ORDER BY s.server_name ASC`
    )
    .all<SnapshotRow>();

  return json({ servers: result.results ?? [] });
}

export async function handleRanking(db: D1Database, url: URL): Promise<Response> {
  const sortBy = url.searchParams.get("sortBy") ?? "load";
  if (sortBy !== "load") {
    return error(
      "Unsupported sortBy value. Only 'load' is available: ping is measured client-side by the app and is not historized by this service.",
      400
    );
  }

  const windowParam = url.searchParams.get("window") ?? "1h";
  const windowSeconds = parseDurationSeconds(windowParam);
  if (windowSeconds === null) {
    return error("Invalid 'window' format, expected e.g. 1h, 24h, 7d", 400);
  }

  const since = Math.floor(Date.now() / 1000) - windowSeconds;

  const result = await db
    .prepare(
      `SELECT
         server_name,
         MAX(country_name) AS country_name,
         MAX(country_code) AS country_code,
         MAX(location) AS location,
         AVG(load_percent) AS avg_load_percent,
         COUNT(*) AS sample_count
       FROM server_snapshots
       WHERE recorded_at >= ?
       GROUP BY server_name
       ORDER BY avg_load_percent ASC`
    )
    .bind(since)
    .all();

  return json({ sortBy, window: windowParam, servers: result.results ?? [] });
}

interface HealthCountRow {
  server_name: string;
  health: string;
  cnt: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function handleReliability(db: D1Database, url: URL): Promise<Response> {
  const windowParam = url.searchParams.get("window") ?? "24h";
  const windowSeconds = parseDurationSeconds(windowParam);
  if (windowSeconds === null) {
    return error("Invalid 'window' format, expected e.g. 24h, 7d, 30m", 400);
  }

  const { since, rawBoundary, rawSince, needsHourly } = computeWindowBounds(windowSeconds);

  const rows: HealthCountRow[] = [];

  if (needsHourly) {
    const hourlyResult = await db
      .prepare(
        `SELECT server_name, health, COUNT(*) AS cnt
         FROM server_snapshots_hourly
         WHERE recorded_at >= ? AND recorded_at < ?
         GROUP BY server_name, health`
      )
      .bind(since, rawBoundary)
      .all<HealthCountRow>();
    rows.push(...(hourlyResult.results ?? []));
  }

  const rawResult = await db
    .prepare(
      `SELECT server_name, health, COUNT(*) AS cnt
       FROM server_snapshots
       WHERE recorded_at >= ?
       GROUP BY server_name, health`
    )
    .bind(rawSince)
    .all<HealthCountRow>();
  rows.push(...(rawResult.results ?? []));

  const bucket = new Map<string, { ok: number; warning: number; error: number; total: number }>();
  for (const row of rows) {
    const entry = bucket.get(row.server_name) ?? { ok: 0, warning: 0, error: 0, total: 0 };
    const cnt = Number(row.cnt);
    if (row.health === "ok") entry.ok += cnt;
    else if (row.health === "warning") entry.warning += cnt;
    else if (row.health === "error") entry.error += cnt;
    entry.total += cnt;
    bucket.set(row.server_name, entry);
  }

  const servers = [...bucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server_name, e]) => ({
      server_name,
      ok_percent: round1((e.ok / e.total) * 100),
      warning_percent: round1((e.warning / e.total) * 100),
      error_percent: round1((e.error / e.total) * 100),
      sample_count: e.total,
    }));

  return json({ window: windowParam, servers });
}
