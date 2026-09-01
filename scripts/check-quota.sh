#!/usr/bin/env bash
# Checks D1 usage against Cloudflare's free-tier daily limits and warns
# before they're exceeded. Exit codes: 0 = OK, 1 = warning (>=80%), 2 = over.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="airvpn-history"

# Free tier limits (Workers Paid plan raises these; adjust if you upgrade).
LIMIT_ROWS_READ=5000000
LIMIT_ROWS_WRITTEN=100000
LIMIT_STORAGE_BYTES=5000000000
WARN_THRESHOLD=80

info_json=$(pnpm exec wrangler d1 info "$DB_NAME" --json 2>/dev/null)

rows_read=$(echo "$info_json" | jq -r '.rows_read_24h')
rows_written=$(echo "$info_json" | jq -r '.rows_written_24h')
storage_bytes=$(echo "$info_json" | jq -r '.database_size')

status=0

pct() {
  # integer percentage of $1 / $2
  awk -v a="$1" -v b="$2" 'BEGIN { printf "%d", (a / b) * 100 }'
}

check() {
  local label="$1" used="$2" limit="$3" unit="$4"
  local p
  p=$(pct "$used" "$limit")

  local used_h="$used"
  local limit_h="$limit"
  if [ "$unit" = "bytes" ]; then
    used_h=$(awk -v b="$used" 'BEGIN { printf "%.2f GB", b / 1e9 }')
    limit_h=$(awk -v b="$limit" 'BEGIN { printf "%.0f GB", b / 1e9 }')
  fi

  if [ "$p" -ge 100 ]; then
    echo "OVER QUOTA  $label: $used_h / $limit_h (${p}%)"
    status=2
  elif [ "$p" -ge "$WARN_THRESHOLD" ]; then
    echo "WARNING     $label: $used_h / $limit_h (${p}%)"
    [ "$status" -lt 1 ] && status=1
  else
    echo "OK          $label: $used_h / $limit_h (${p}%)"
  fi
}

echo "D1 database: $DB_NAME (rolling 24h window)"
echo "---"
check "rows read/day   " "$rows_read" "$LIMIT_ROWS_READ" "count"
check "rows written/day" "$rows_written" "$LIMIT_ROWS_WRITTEN" "count"
check "storage         " "$storage_bytes" "$LIMIT_STORAGE_BYTES" "bytes"

exit "$status"
