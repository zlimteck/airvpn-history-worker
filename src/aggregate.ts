const RAW_RETENTION_SECONDS = 7 * 24 * 3600;
const HOURLY_RETENTION_SECONDS = 30 * 24 * 3600;

export async function aggregateAndCleanup(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rawCutoff = now - RAW_RETENTION_SECONDS;
  const hourlyCutoff = now - HOURLY_RETENTION_SECONDS;

  const aggregateStmt = db.prepare(
    `INSERT INTO server_snapshots_hourly
      (server_name, country_name, country_code, location, load_percent, bw_current, bw_max, users_count, health, recorded_at)
     SELECT
       server_name,
       MAX(country_name),
       MAX(country_code),
       MAX(location),
       CAST(ROUND(AVG(load_percent)) AS INTEGER),
       CAST(ROUND(AVG(bw_current)) AS INTEGER),
       CAST(ROUND(AVG(bw_max)) AS INTEGER),
       CAST(ROUND(AVG(users_count)) AS INTEGER),
       CASE MAX(CASE health WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
         WHEN 3 THEN 'error'
         WHEN 2 THEN 'warning'
         ELSE 'ok'
       END,
       (recorded_at / 3600) * 3600
     FROM server_snapshots
     WHERE recorded_at < ?
     GROUP BY server_name, (recorded_at / 3600) * 3600`
  ).bind(rawCutoff);

  const purgeRawStmt = db
    .prepare(`DELETE FROM server_snapshots WHERE recorded_at < ?`)
    .bind(rawCutoff);

  const purgeHourlyStmt = db
    .prepare(`DELETE FROM server_snapshots_hourly WHERE recorded_at < ?`)
    .bind(hourlyCutoff);

  try {
    // db.batch runs as a single D1 transaction: if the aggregate insert
    // fails, the deletes never run, so raw rows are never lost without
    // having been aggregated first.
    await db.batch([aggregateStmt, purgeRawStmt, purgeHourlyStmt]);
  } catch (err) {
    console.error("D1 aggregate/cleanup batch failed, will retry on next run", err);
  }
}
