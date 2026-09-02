#!/usr/bin/env bash
# Checks D1 usage against Cloudflare's free-tier daily limits and warns
# before they're exceeded.
#
# Shows two different views on purpose, since they can diverge a lot right
# after a spike (a rolling window keeps "remembering" a bad hour for a full
# day after it happened, a calendar-day view resets cleanly at midnight UTC):
#   1. Today, UTC calendar day (GraphQL Analytics) - the headline answer to
#      "is today okay?"
#   2. Rolling 24h window (`wrangler d1 info`)      - what Cloudflare actually
#      enforces right now (can still reflect yesterday for a few hours)
#   3. Last 7 calendar days, for a trend at a glance
#
# Exit codes: 0 = OK, 1 = warning (>=80% on the rolling window), 2 = over.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="airvpn-history"

# Free tier limits (Workers Paid plan raises these; adjust if you upgrade).
LIMIT_ROWS_READ=5000000
LIMIT_ROWS_WRITTEN=100000
LIMIT_STORAGE_BYTES=5000000000
WARN_THRESHOLD=80

RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

pct() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%d", (a / b) * 100 }'; }

status=0

# label a single metric as OK/WARNING/OVER, print it, and bump $status
check() {
  local label="$1" used="$2" limit="$3" unit="$4"
  local p used_h="$used" limit_h="$limit"
  p=$(pct "$used" "$limit")

  if [ "$unit" = "bytes" ]; then
    used_h=$(awk -v b="$used" 'BEGIN { printf "%.2f GB", b / 1e9 }')
    limit_h=$(awk -v b="$limit" 'BEGIN { printf "%.0f GB", b / 1e9 }')
  fi

  if [ "$p" -ge 100 ]; then
    echo "${RED}OVER QUOTA${RESET}  $label: $used_h / $limit_h (${p}%)"
    status=2
  elif [ "$p" -ge "$WARN_THRESHOLD" ]; then
    echo "${YELLOW}WARNING${RESET}     $label: $used_h / $limit_h (${p}%)"
    [ "$status" -lt 1 ] && status=1
  else
    echo "${GREEN}OK${RESET}          $label: $used_h / $limit_h (${p}%)"
  fi
}

# --- gather rolling-24h numbers (always available, needs no extra auth) ---
info_json=$(pnpm exec wrangler d1 info "$DB_NAME" --json 2>/dev/null)
rolling_read=$(echo "$info_json" | jq -r '.rows_read_24h')
rolling_written=$(echo "$info_json" | jq -r '.rows_written_24h')
storage_bytes=$(echo "$info_json" | jq -r '.database_size')
database_id=$(echo "$info_json" | jq -r '.uuid')

# --- gather today's calendar-day (UTC) numbers via GraphQL, best-effort ---
today_read=""
today_written=""
trend_json=""

token_file=""
for candidate in \
  "$HOME/Library/Preferences/.wrangler/config/default.toml" \
  "$HOME/.config/.wrangler/config/default.toml"
do
  [ -f "$candidate" ] && token_file="$candidate" && break
done

if [ -n "$token_file" ]; then
  oauth_token=$(grep '^oauth_token' "$token_file" | head -1 | cut -d'"' -f2)
  account_id=$(pnpm exec wrangler whoami --json 2>/dev/null | jq -r '.accounts[0].id')

  if [ -n "$oauth_token" ] && [ -n "$account_id" ] && [ -n "$database_id" ]; then
    today=$(date -u +%Y-%m-%d)
    week_ago=$(date -u -v-6d +%Y-%m-%d 2>/dev/null || date -u -d "6 days ago" +%Y-%m-%d)

    gql="query { viewer { accounts(filter: {accountTag: \"$account_id\"}) { d1AnalyticsAdaptiveGroups(limit: 8, filter: {databaseId: \"$database_id\", date_geq: \"$week_ago\"}, orderBy: [date_ASC]) { dimensions { date } sum { rowsWritten rowsRead } } } } }"
    payload=$(jq -n --arg q "$gql" '{query: $q}')

    response=$(curl -s -X POST "https://api.cloudflare.com/client/v4/graphql" \
      -H "Authorization: Bearer $oauth_token" -H "Content-Type: application/json" \
      -d "$payload" 2>/dev/null)

    trend_json=$(echo "$response" | jq -c '.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]?' 2>/dev/null || echo "")

    if [ -n "$trend_json" ]; then
      today_written=$(echo "$response" | jq -r --arg d "$today" '.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]? | select(.dimensions.date == $d) | .sum.rowsWritten')
      today_read=$(echo "$response" | jq -r --arg d "$today" '.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]? | select(.dimensions.date == $d) | .sum.rowsRead')
    fi
  fi
fi

# --- headline: is today okay? ---
echo "${BOLD}== Quota du jour ($(date -u +%Y-%m-%d), UTC) ==${RESET}"
if [ -n "$today_written" ] && [ -n "$today_read" ]; then
  check "rows written" "$today_written" "$LIMIT_ROWS_WRITTEN" "count"
  check "rows read   " "$today_read" "$LIMIT_ROWS_READ" "count"
else
  echo "${DIM}(pas encore de donnée pour aujourd'hui, ou vue calendaire indisponible - voir la fenêtre glissante ci-dessous)${RESET}"
fi

echo
echo "${BOLD}== Fenêtre glissante 24h (ce que Cloudflare applique réellement) ==${RESET}"
check "rows read/day   " "$rolling_read" "$LIMIT_ROWS_READ" "count"
check "rows written/day" "$rolling_written" "$LIMIT_ROWS_WRITTEN" "count"
check "storage         " "$storage_bytes" "$LIMIT_STORAGE_BYTES" "bytes"

if [ -n "$trend_json" ]; then
  echo
  echo "${BOLD}== Tendance 7 derniers jours ==${RESET}"
  printf "%-12s %14s %14s\n" "date" "rows_written" "rows_read"
  echo "$response" | jq -r '.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]? | [.dimensions.date, .sum.rowsWritten, .sum.rowsRead] | @tsv' \
    | awk -F'\t' '{ printf "%-12s %14s %14s\n", $1, $2, $3 }'
fi

exit "$status"
