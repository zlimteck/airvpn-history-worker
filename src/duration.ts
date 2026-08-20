const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86400,
};

/** Parses strings like "24h", "7d", "30m" into seconds. Returns null if malformed. */
export function parseDurationSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * UNIT_SECONDS[unit];
}
