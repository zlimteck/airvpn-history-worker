import { fetchAirVpnStatus, AirVpnFetchError } from "./airvpn";

export async function collectSnapshot(db: D1Database): Promise<void> {
  let status;
  try {
    status = await fetchAirVpnStatus();
  } catch (err) {
    if (err instanceof AirVpnFetchError) {
      console.error(`AirVPN fetch failed (status ${err.status ?? "n/a"}): ${err.message}`);
    } else {
      console.error("AirVPN fetch failed with unexpected error", err);
    }
    return;
  }

  const recordedAt = Math.floor(Date.now() / 1000);

  const insertStmt = db.prepare(
    `INSERT INTO server_snapshots
      (server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const upsertLatestStmt = db.prepare(
    `INSERT INTO server_latest
      (server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_name) DO UPDATE SET
       country_name = excluded.country_name,
       country_code = excluded.country_code,
       location = excluded.location,
       load_percent = excluded.load_percent,
       bw_current = excluded.bw_current,
       bw_max = excluded.bw_max,
       users_count = excluded.users_count,
       health = excluded.health,
       recorded_at = excluded.recorded_at`
  );

  const batch = status.servers.flatMap((server) => {
    const args = [
      server.public_name,
      server.country_name,
      server.country_code,
      server.location,
      Math.round(server.currentload),
      Math.round(server.bw),
      Math.round(server.bw_max),
      server.users,
      server.health,
      recordedAt,
    ] as const;
    return [insertStmt.bind(...args), upsertLatestStmt.bind(...args)];
  });

  if (batch.length === 0) return;

  try {
    await db.batch(batch);
  } catch (err) {
    console.error("D1 write failed, skipping this cycle", err);
  }
}
