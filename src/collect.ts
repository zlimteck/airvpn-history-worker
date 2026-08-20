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

  const stmt = db.prepare(
    `INSERT INTO server_snapshots
      (server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = status.servers.map((server) =>
    stmt.bind(
      server.public_name,
      server.country_name,
      server.country_code,
      server.location,
      Math.round(server.currentload),
      Math.round(server.bw),
      Math.round(server.bw_max),
      server.users,
      server.health,
      recordedAt
    )
  );

  if (batch.length === 0) return;

  try {
    await db.batch(batch);
  } catch (err) {
    console.error("D1 write failed, skipping this cycle", err);
  }
}
