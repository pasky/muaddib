#!/usr/bin/env bash
# Usage: scripts/cost-report.sh [MUADDIB_HOME] [DAYS] [COST_THRESHOLD]
# Example: scripts/cost-report.sh ~/.muaddib-profiles/MuaddibLLM 7

set -euo pipefail

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found in PATH" >&2
  exit 1
fi

MUADDIB_HOME="${1:?Usage: $0 <MUADDIB_HOME> [DAYS] [COST_THRESHOLD]}"
DAYS="${2:-7}"
COST_THRESHOLD="${3:-0.2}"
ARCS_DIR="$MUADDIB_HOME/arcs"

if [[ ! -d "$ARCS_DIR" ]]; then
  echo "Error: $ARCS_DIR not found" >&2
  exit 1
fi

# Compute cutoff date (ISO 8601 prefix for string comparison)
CUTOFF=$(date -d "-${DAYS} days" +%Y-%m-%dT00:00:00)
TODAY=$(date +%Y-%m-%d)
FROM_DATE=$(date -d "-${DAYS} days" +%Y-%m-%d)

echo "=== Cost Report: last $DAYS days ($FROM_DATE → $TODAY) ==="
echo

# Collect JSONL lines tagged with arc name.
# Emits cost records (cost != null) and user trigger records (r in ["u", "user"] with run set).
collect_lines() {
  for arc_dir in "$ARCS_DIR"/*/chat_history; do
    [[ -d "$arc_dir" ]] || continue
    arc=$(basename "$(dirname "$arc_dir")")
    for f in "$arc_dir"/*.jsonl; do
      [[ -f "$f" ]] || continue
      # Quick filename filter: only read files whose date >= cutoff date
      fname=$(basename "$f" .jsonl)
      [[ "$fname" > "$FROM_DATE" || "$fname" == "$FROM_DATE" ]] || continue
      jq -c --arg arc "$arc" \
        'select((.cost != null and .ts != null) or (((.r == "u") or (.r == "user")) and .run != null)) | . + {arc: $arc}' \
        "$f" 2>/dev/null || true
    done
  done
}

# Materialize once into temp files: all records, cost records, and trigger lookup
ALLFILE=$(mktemp)
TMPFILE=$(mktemp)
TRIGFILE=$(mktemp)
trap 'rm -f "$ALLFILE" "$TMPFILE" "$TRIGFILE"' EXIT

collect_lines | jq -c --arg cutoff "$CUTOFF" 'select(.ts >= $cutoff)' > "$ALLFILE"
jq -c 'select(.cost != null)' "$ALLFILE" > "$TMPFILE"
jq -c 'select(((.r == "u") or (.r == "user")) and .run != null)' "$ALLFILE" > "$TRIGFILE"

if [[ ! -s "$TMPFILE" ]]; then
  echo "(no cost data found for the last $DAYS days)"
  exit 0
fi

# --- Grand total ---
echo "--- Grand Total ---"
echo
jq -s '
  {
    total_cost: (map(.cost // 0) | add),
    input_tokens: (map(.inTok // 0) | add),
    output_tokens: (map(.outTok // 0) | add),
    calls: length
  }
' "$TMPFILE" | jq -r '
  "total_cost     input_tokens   output_tokens  calls",
  "-----------    ------------   -------------  -----",
  "\("$" + (.total_cost | . * 100 | round / 100 | tostring))          \(.input_tokens)          \(.output_tokens)           \(.calls)"
'

echo
echo "--- Per Channel ---"
echo
printf "%-30s  %10s  %6s  %12s  %12s\n" "channel" "cost" "calls" "input_tok" "output_tok"
printf "%-30s  %10s  %6s  %12s  %12s\n" "-------" "----" "-----" "---------" "----------"
jq -s '
  group_by(.arc) | map({
    arc: .[0].arc,
    cost: (map(.cost // 0) | add),
    calls: length,
    inTok: (map(.inTok // 0) | add),
    outTok: (map(.outTok // 0) | add)
  }) | sort_by(-.cost)[] |
  [.arc, .cost, .calls, .inTok, .outTok] | @tsv
' -r "$TMPFILE" | while IFS=$'\t' read -r arc cost calls inTok outTok; do
  printf "%-30s  \$%9.4f  %6s  %12s  %12s\n" "$arc" "$cost" "$calls" "$inTok" "$outTok"
done

echo
echo "--- Per User (total across channels) ---"
echo
printf "%-18s  %10s  %6s  %12s  %12s  %s\n" "user" "cost" "calls" "input_tok" "output_tok" "channels"
printf "%-18s  %10s  %6s  %12s  %12s  %s\n" "----" "----" "-----" "---------" "----------" "--------"
jq -s --slurpfile triggers "$TRIGFILE" '
  # Build lookup: (arc, run) -> triggering nick
  ($triggers | map({key: "\(.arc)|\(.run)", value: .n}) |
    from_entries) as $trig_lookup |
  # Resolve each cost record to the triggering user
  [.[] | . + {resolved_nick:
    (if .run then ($trig_lookup["\(.arc)|\(.run)"] // .n // "(unknown)")
     else (.n // "(unknown)") end)
  }] |
  group_by(.resolved_nick) | map({
    nick: .[0].resolved_nick,
    cost: (map(.cost // 0) | add),
    calls: length,
    inTok: (map(.inTok // 0) | add),
    outTok: (map(.outTok // 0) | add),
    channels: ([.[].arc] | unique | join(","))
  }) | sort_by(-.cost)[] |
  [.nick, .cost, .calls, .inTok, .outTok, .channels] | @tsv
' -r "$TMPFILE" | while IFS=$'\t' read -r nick cost calls inTok outTok channels; do
  printf "%-18s  \$%9.4f  %6s  %12s  %12s  %s\n" "$nick" "$cost" "$calls" "$inTok" "$outTok" "$channels"
done

echo
echo "--- Daily Trend ---"
echo
printf "%-12s  %10s  %6s\n" "day" "cost" "calls"
printf "%-12s  %10s  %6s\n" "---" "----" "-----"
jq -s '
  [.[] | . + {day: (.ts[:10])}] |
  group_by(.day) | map({
    day: .[0].day,
    cost: (map(.cost // 0) | add),
    calls: length
  }) | sort_by(.day)[] |
  [.day, .cost, .calls] | @tsv
' -r "$TMPFILE" | while IFS=$'\t' read -r day cost calls; do
  printf "%-12s  \$%9.4f  %6s\n" "$day" "$cost" "$calls"
done

echo
echo "--- Expensive Sessions (>\$${COST_THRESHOLD}) ---"
echo

LOGS_DIR="$MUADDIB_HOME/logs"

jq -s --argjson threshold "$COST_THRESHOLD" --slurpfile triggers "$TRIGFILE" '
  # Build lookup: (arc, run) -> triggering nick
  ($triggers | map({key: "\(.arc)|\(.run)", value: .n}) |
    from_entries) as $trig_lookup |
  [.[] | select(.cost > $threshold)] |
  [.[] | . + {
    trig_nick: (if .run then ($trig_lookup["\(.arc)|\(.run)"] // .n // "?") else (.n // "?") end),
    trig_ts: (.run // .ts)
  }] | sort_by(-.cost)[] |
  [.trig_ts[:10],
   (.trig_ts[11:19] | gsub(":"; "-")),
   .arc,
   .trig_nick,
   .cost,
   (.inTok // 0),
   (.outTok // 0)] | @tsv
' -r "$TMPFILE" | while IFS=$'\t' read -r dt tm arc nick cost inTok outTok; do
  # Find the log file: match by arc dir and closest time prefix
  arc_safe=$(echo "$arc" | tr '/' '_' | tr '\\' '_')
  arc_dir="$LOGS_DIR/$dt/$arc_safe"
  logfile="(no log found)"
  if [[ -d "$arc_dir" ]]; then
    # Log filenames start with HH-MM-SS; try exact match first.
    # Use find -quit instead of piping to head to avoid SIGPIPE under set -o pipefail.
    match=$(find "$arc_dir" -maxdepth 1 -name "${tm}-${nick}-*.log" -printf '%f\n' -quit 2>/dev/null || true)

    # Collect all logs by this nick once, sorted by filename/time.
    nick_matches=()
    while IFS= read -r candidate; do
      nick_matches+=("$candidate")
    done < <(find "$arc_dir" -maxdepth 1 -name "*-${nick}-*.log" -printf '%f\n' 2>/dev/null | sort)

    if [[ -z "$match" ]]; then
      # Find closest log by this nick at or after the trigger time.
      for candidate in "${nick_matches[@]}"; do
        if [[ "$candidate" > "$tm" || "$candidate" == "$tm"* ]]; then
          match="$candidate"
          break
        fi
      done
    fi

    if [[ -z "$match" && ${#nick_matches[@]} -gt 0 ]]; then
      # Last resort: latest log by this nick before the trigger time.
      match="${nick_matches[$((${#nick_matches[@]} - 1))]}"
    fi

    if [[ -n "$match" ]]; then
      logfile="logs/$dt/$arc_safe/$match"
    fi
  fi
  printf "\$%-8.4f  %-14s  %-18s  %s in/%s out  %s\n" "$cost" "$nick" "$arc" "$inTok" "$outTok" "$logfile"
done
