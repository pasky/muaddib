#!/usr/bin/env bash
# Usage: scripts/cost-report.sh [MUADDIB_HOME] [DAYS]
# Example: scripts/cost-report.sh ~/.muaddib-profiles/MuaddibLLM 7

set -euo pipefail

MUADDIB_HOME="${1:?Usage: $0 <MUADDIB_HOME> [DAYS]}"
DAYS="${2:-7}"
DB="$MUADDIB_HOME/chat_history.db"

if [[ ! -f "$DB" ]]; then
  echo "Error: $DB not found" >&2
  exit 1
fi

echo "=== Cost Report: last $DAYS days ($(date -d "-${DAYS} days" +%Y-%m-%d) → $(date +%Y-%m-%d)) ==="
echo

# --- Grand total ---
sqlite3 -header -column "$DB" "
  SELECT
    printf('\$%.2f', SUM(cost))       AS total_cost,
    SUM(input_tokens)                 AS input_tokens,
    SUM(output_tokens)                AS output_tokens,
    COUNT(*)                          AS calls
  FROM llm_calls
  WHERE timestamp >= datetime('now', '-${DAYS} days')
"

echo
echo "--- Per Channel ---"
echo
sqlite3 -header -column "$DB" "
  SELECT
    COALESCE(cm.channel_name, '(unknown)') AS channel,
    printf('\$%.4f', SUM(lc.cost))         AS cost,
    COUNT(lc.id)                           AS calls,
    SUM(lc.input_tokens)                   AS input_tok,
    SUM(lc.output_tokens)                  AS output_tok
  FROM llm_calls lc
  LEFT JOIN chat_messages cm ON cm.id = lc.trigger_message_id
  WHERE lc.timestamp >= datetime('now', '-${DAYS} days')
  GROUP BY cm.channel_name
  ORDER BY SUM(lc.cost) DESC
"

echo
echo "--- Per User (total across channels) ---"
echo
sqlite3 -header -column "$DB" "
  SELECT
    COALESCE(cm.nick, '(unknown)')                    AS user,
    printf('\$%.4f', SUM(lc.cost))                    AS cost,
    COUNT(lc.id)                                      AS calls,
    SUM(lc.input_tokens)                              AS input_tok,
    SUM(lc.output_tokens)                             AS output_tok,
    GROUP_CONCAT(DISTINCT cm.channel_name)            AS channels
  FROM llm_calls lc
  LEFT JOIN chat_messages cm ON cm.id = lc.trigger_message_id
  WHERE lc.timestamp >= datetime('now', '-${DAYS} days')
  GROUP BY cm.nick
  ORDER BY SUM(lc.cost) DESC
"

echo
echo "--- Daily Trend ---"
echo
sqlite3 -header -column "$DB" "
  SELECT
    date(timestamp)                  AS day,
    printf('\$%.4f', SUM(cost))      AS cost,
    COUNT(*)                         AS calls
  FROM llm_calls
  WHERE timestamp >= datetime('now', '-${DAYS} days')
  GROUP BY date(timestamp)
  ORDER BY day
"

COST_THRESHOLD="${3:-0.2}"
echo
echo "--- Expensive Sessions (>\$${COST_THRESHOLD}) ---"
echo

LOGS_DIR="$MUADDIB_HOME/logs"

# Query expensive calls: trigger date, trigger time (HH-MM-SS), arc (fs-safe), nick, cost, tokens
# Use trigger message timestamp (= log filename time), fall back to llm_call timestamp
sqlite3 -separator $'\t' "$DB" "
  SELECT
    COALESCE(date(cm.timestamp), date(lc.timestamp)),
    REPLACE(COALESCE(strftime('%H:%M:%S', cm.timestamp), strftime('%H:%M:%S', lc.timestamp)), ':', '-'),
    REPLACE(REPLACE(lc.arc_name, '/', '_'), '\\\\', '_'),
    COALESCE(cm.nick, '?'),
    printf('%.4f', lc.cost),
    lc.input_tokens,
    lc.output_tokens
  FROM llm_calls lc
  LEFT JOIN chat_messages cm ON cm.id = lc.trigger_message_id
  WHERE lc.timestamp >= datetime('now', '-${DAYS} days')
    AND lc.cost > ${COST_THRESHOLD}
  ORDER BY lc.cost DESC
" | while IFS=$'\t' read -r dt tm arc nick cost in_tok out_tok; do
  # Find the log file: match by arc dir and closest time prefix
  arc_dir="$LOGS_DIR/$dt/$arc"
  logfile="(no log found)"
  if [[ -d "$arc_dir" ]]; then
    # Log filenames start with HH-MM-SS; try exact match first
    match=$(find "$arc_dir" -maxdepth 1 -name "${tm}-${nick}-*.log" -printf '%f\n' 2>/dev/null | head -1)
    if [[ -z "$match" ]]; then
      # Find closest log by this nick at or after the trigger time
      match=$(find "$arc_dir" -maxdepth 1 -name "*-${nick}-*.log" -printf '%f\n' 2>/dev/null | sort | awk -v t="$tm" '$0 >= t { print; exit }')
    fi
    if [[ -z "$match" ]]; then
      # Last resort: closest log by this nick before the trigger time
      match=$(find "$arc_dir" -maxdepth 1 -name "*-${nick}-*.log" -printf '%f\n' 2>/dev/null | sort -r | head -1)
    fi
    if [[ -n "$match" ]]; then
      logfile="logs/$dt/$arc/$match"
    fi
  fi
  printf "\$%-8s  %-14s  %-18s  %s in/%s out  %s\n" "$cost" "$nick" "$arc" "$in_tok" "$out_tok" "$logfile"
done
