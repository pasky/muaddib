#!/usr/bin/env bash
# Backfill missing chat_history cost/token fields by patching existing JSONL lines
# using runtime logs. Never appends new lines; edits existing lines only.
#
# Usage:
#   scripts/cost-backfill.sh <MUADDIB_HOME> [--since YYYY-MM-DD] [--arc ARC]... [--write]
#
# Examples:
#   scripts/cost-backfill.sh ~/.muaddib-profiles/MuaddibLLM --since 2026-02-27 --arc IRCnet##linux-cs
#   scripts/cost-backfill.sh ~/.muaddib-profiles/MuaddibLLM --since 2026-02-27 --write

set -euo pipefail

usage() {
  cat <<'EOF'
Backfill missing chat_history cost/token fields from runtime logs.

Usage:
  scripts/cost-backfill.sh <MUADDIB_HOME> [--since YYYY-MM-DD] [--arc ARC]... [--write]

Options:
  --since YYYY-MM-DD  Inclusive lower bound on dates (default: 2026-02-27)
  --arc ARC           Restrict to one arc; can be repeated
  --write             Apply edits in-place (default: dry-run)
  --dry-run           Preview only (default)
  -h, --help          Show this help

Safety:
  - Edits existing JSONL lines only (no appended rows).
  - Before any file write, creates/overwrites <file>.jsonl~ backup.
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

MUADDIB_HOME="$1"
shift

SINCE_DATE="2026-02-27"
APPLY=0
ARCS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      if [[ $# -lt 2 ]]; then
        echo "Error: --since requires a value" >&2
        exit 1
      fi
      SINCE_DATE="$2"
      shift 2
      ;;
    --arc)
      if [[ $# -lt 2 ]]; then
        echo "Error: --arc requires a value" >&2
        exit 1
      fi
      ARCS+=("$2")
      shift 2
      ;;
    --write)
      APPLY=1
      shift
      ;;
    --dry-run)
      APPLY=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$MUADDIB_HOME" ]]; then
  echo "Error: MUADDIB_HOME '$MUADDIB_HOME' does not exist" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required" >&2
  exit 1
fi

ARC_FILTERS=""
if [[ ${#ARCS[@]} -gt 0 ]]; then
  ARC_FILTERS=$(printf "%s\n" "${ARCS[@]}")
fi

CB_HOME="$MUADDIB_HOME" \
CB_SINCE="$SINCE_DATE" \
CB_APPLY="$APPLY" \
CB_ARCS="$ARC_FILTERS" \
python3 - <<'PY'
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

home = Path(os.environ["CB_HOME"])
since_date = os.environ["CB_SINCE"]
apply_changes = os.environ["CB_APPLY"] == "1"
arc_filters = [a for a in os.environ.get("CB_ARCS", "").splitlines() if a]
local_tz = datetime.now().astimezone().tzinfo


def arc_safe(arc: str) -> str:
    return arc.replace("/", "_").replace("\\", "_")


def parse_iso_utc(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def parse_json_blocks_after_marker(text: str, marker: str) -> List[dict]:
    blocks: List[dict] = []
    idx = 0
    while True:
        pos = text.find(marker, idx)
        if pos < 0:
            break
        start = text.find("{", pos + len(marker))
        if start < 0:
            idx = pos + len(marker)
            continue

        depth = 0
        in_string = False
        escaped = False
        end = None
        i = start
        while i < len(text):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            i += 1

        if end is None:
            idx = pos + len(marker)
            continue

        chunk = text[start:end]
        try:
            blocks.append(json.loads(chunk))
        except Exception:
            pass
        idx = end

    return blocks


@dataclass
class DayFile:
    path: Path
    raw_lines: List[str]
    objs: List[Optional[dict]]
    had_trailing_newline: bool
    line_count_before: int


@dataclass
class ArcState:
    day_files: Dict[str, DayFile]
    runs_index: Dict[str, List[Tuple[str, int]]]
    trigger_runs: Dict[Tuple[str, str, str], List[str]]


@dataclass
class RunData:
    cost: float
    in_tok: Optional[int]
    out_tok: Optional[int]


@dataclass
class PatchPlan:
    run: str
    day: str
    line_idx: int
    cost: float
    in_tok: Optional[int]
    out_tok: Optional[int]


@dataclass
class ArcSummary:
    arc: str
    logs_with_run_complete: int = 0
    runs_extracted: int = 0
    unmatched_logs: int = 0
    plans: int = 0
    changed_lines: int = 0
    token_rows: int = 0
    touched_days: int = 0


if arc_filters:
    arcs = arc_filters
else:
    arcs_base = home / "arcs"
    if not arcs_base.is_dir():
        raise SystemExit(f"Error: {arcs_base} does not exist")
    arcs = sorted([p.name for p in arcs_base.iterdir() if p.is_dir()])

if not arcs:
    print("No arcs selected.")
    raise SystemExit(0)

summaries: List[ArcSummary] = []

global_changed = 0
global_plans = 0
global_tokens = 0
global_cost = 0.0

for arc in arcs:
    summary = ArcSummary(arc=arc)
    hist_dir = home / "arcs" / arc / "chat_history"
    if not hist_dir.is_dir():
        summaries.append(summary)
        continue

    day_files: Dict[str, DayFile] = {}
    runs_index: Dict[str, List[Tuple[str, int]]] = {}
    trigger_runs: Dict[Tuple[str, str, str], List[str]] = {}

    for path in sorted(hist_dir.glob("*.jsonl")):
        day = path.stem
        if day < since_date:
            continue

        content = path.read_text(encoding="utf-8")
        raw_lines = content.splitlines()
        had_trailing_newline = content.endswith("\n")
        objs: List[Optional[dict]] = []

        for idx, raw in enumerate(raw_lines):
            trimmed = raw.strip()
            if not trimmed:
                objs.append(None)
                continue
            try:
                obj = json.loads(trimmed)
            except Exception:
                obj = None
            objs.append(obj)

            if not isinstance(obj, dict):
                continue

            run = obj.get("run")
            if isinstance(run, str):
                runs_index.setdefault(run, []).append((day, idx))

            if obj.get("r") in ("user", "u") and isinstance(obj.get("n"), str) and isinstance(obj.get("ts"), str) and isinstance(run, str):
                try:
                    dt_local = parse_iso_utc(obj["ts"]).astimezone(local_tz)
                except Exception:
                    continue
                key = (dt_local.strftime("%Y-%m-%d"), dt_local.strftime("%H-%M-%S"), obj["n"])
                trigger_runs.setdefault(key, []).append(run)

        day_files[day] = DayFile(
            path=path,
            raw_lines=raw_lines,
            objs=objs,
            had_trailing_newline=had_trailing_newline,
            line_count_before=len(raw_lines),
        )

    if not day_files:
        summaries.append(summary)
        continue

    run_complete_re = re.compile(
        rf'^(\d{{4}}-\d{{2}}-\d{{2}} \d{{2}}:\d{{2}}:\d{{2}}),\d+ - .*Agent run complete arc={re.escape(arc)}.* cost=\$(\d+\.\d+)',
        re.M,
    )
    received_re = re.compile(
        rf'^(\d{{4}}-\d{{2}}-\d{{2}} \d{{2}}:\d{{2}}:\d{{2}}),\d+ - .*Received command arc={re.escape(arc)} nick=([^ ]+) content=',
        re.M,
    )

    run_data: Dict[str, RunData] = {}

    for day_dir in sorted((home / "logs").iterdir()):
        if not day_dir.is_dir() or day_dir.name < since_date:
            continue
        arc_log_dir = day_dir / arc_safe(arc)
        if not arc_log_dir.is_dir():
            continue

        for log_path in sorted(arc_log_dir.glob("*.log")):
            text = log_path.read_text(encoding="utf-8", errors="replace")
            m_run = run_complete_re.search(text)
            if not m_run:
                continue
            summary.logs_with_run_complete += 1

            cost = float(m_run.group(2))
            if cost <= 0:
                continue

            m_recv = received_re.search(text)
            if not m_recv:
                summary.unmatched_logs += 1
                continue

            recv_local = datetime.strptime(m_recv.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=local_tz)
            nick = m_recv.group(2)

            candidates: List[str] = []

            def add_candidates(dt_obj: datetime) -> None:
                key = (dt_obj.strftime("%Y-%m-%d"), dt_obj.strftime("%H-%M-%S"), nick)
                arr = trigger_runs.get(key, [])
                for run_id in arr:
                    if run_id not in candidates:
                        candidates.append(run_id)

            add_candidates(recv_local)
            for delta in (1, 2, 3):
                add_candidates(datetime.fromtimestamp(recv_local.timestamp() - delta, tz=local_tz))
                add_candidates(datetime.fromtimestamp(recv_local.timestamp() + delta, tz=local_tz))

            if not candidates:
                summary.unmatched_logs += 1
                continue

            if len(candidates) == 1:
                run_id = candidates[0]
            else:
                run_id = min(
                    candidates,
                    key=lambda run: abs((parse_iso_utc(run).astimezone(local_tz) - recv_local).total_seconds()),
                )

            usage_blocks = parse_json_blocks_after_marker(text, "llm_io response agent_stream ")
            usage_candidates: List[Tuple[float, int, int]] = []
            for block in usage_blocks:
                if not isinstance(block, dict):
                    continue
                usage = block.get("usage")
                if not isinstance(usage, dict):
                    continue
                cost_obj = usage.get("cost")
                if not isinstance(cost_obj, dict):
                    continue
                vals = [
                    cost_obj.get("total"),
                    usage.get("input"),
                    usage.get("output"),
                    usage.get("cacheRead"),
                    usage.get("cacheWrite"),
                ]
                if not all(isinstance(v, (int, float)) for v in vals):
                    continue
                total = float(cost_obj["total"])
                in_tok = int(usage["input"] + usage["cacheRead"] + usage["cacheWrite"])
                out_tok = int(usage["output"])
                usage_candidates.append((total, in_tok, out_tok))

            picked_in: Optional[int] = None
            picked_out: Optional[int] = None
            if usage_candidates:
                rounded = [u for u in usage_candidates if round(u[0], 4) == round(cost, 4)]
                if rounded:
                    rounded.sort(key=lambda u: abs(u[0] - cost))
                    _, picked_in, picked_out = rounded[0]
                else:
                    usage_candidates.sort(key=lambda u: abs(u[0] - cost))
                    best = usage_candidates[0]
                    if abs(best[0] - cost) <= 0.0015:
                        _, picked_in, picked_out = best

            existing = run_data.get(run_id)
            if existing is None:
                run_data[run_id] = RunData(cost=cost, in_tok=picked_in, out_tok=picked_out)
            else:
                # Keep first cost; fill tokens later if previously missing and now available.
                if existing.in_tok is None and picked_in is not None:
                    existing.in_tok = picked_in
                    existing.out_tok = picked_out

    summary.runs_extracted = len(run_data)

    plans: List[PatchPlan] = []
    for run_id in sorted(run_data):
        refs = runs_index.get(run_id, [])
        if not refs:
            continue

        rows: List[Tuple[str, int, dict]] = []
        for day, idx in refs:
            obj = day_files[day].objs[idx]
            if isinstance(obj, dict):
                rows.append((day, idx, obj))
        if not rows:
            continue

        target: Optional[Tuple[str, int, dict]] = None

        for day, idx, obj in rows:
            msg = obj.get("m")
            if obj.get("r") in ("assistant", "a") and isinstance(msg, str) and msg.startswith("(this message used "):
                target = (day, idx, obj)
                break

        if target is None:
            assistant_rows: List[Tuple[str, int, dict]] = []
            for day, idx, obj in rows:
                msg = obj.get("m")
                if obj.get("r") in ("assistant", "a") and isinstance(msg, str):
                    if msg.startswith("[internal monologue]"):
                        continue
                    if msg.startswith("(fun fact:"):
                        continue
                    assistant_rows.append((day, idx, obj))
            if assistant_rows:
                target = assistant_rows[-1]

        if target is None:
            continue

        day, idx, obj = target
        data = run_data[run_id]

        changed = False
        existing_cost = obj.get("cost")
        if not isinstance(existing_cost, (int, float)) or abs(float(existing_cost) - data.cost) > 1e-12:
            changed = True

        if data.in_tok is not None and obj.get("inTok") != data.in_tok:
            changed = True
        if data.out_tok is not None and obj.get("outTok") != data.out_tok:
            changed = True

        if not changed:
            continue

        plans.append(PatchPlan(
            run=run_id,
            day=day,
            line_idx=idx,
            cost=data.cost,
            in_tok=data.in_tok,
            out_tok=data.out_tok,
        ))

    summary.plans = len(plans)
    global_plans += len(plans)

    changes_by_day: Dict[str, int] = {}
    cost_sum_arc = 0.0

    for plan in plans:
        day_file = day_files[plan.day]
        raw_line = day_file.raw_lines[plan.line_idx]
        obj = day_file.objs[plan.line_idx]
        if not isinstance(obj, dict):
            continue

        obj["cost"] = plan.cost
        cost_sum_arc += plan.cost
        if plan.in_tok is not None:
            obj["inTok"] = plan.in_tok
            if plan.out_tok is not None:
                obj["outTok"] = plan.out_tok
            summary.token_rows += 1
        elif plan.out_tok is not None:
            obj["outTok"] = plan.out_tok

        # Preserve JSON formatting style from the original line.
        # Detect spacing from the first key/value separator only, so message
        # content containing ": " doesn't force pretty spacing.
        compact_style = re.match(r'^\{\s*"[^"]+":\s', raw_line) is None
        if compact_style:
            new_raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        else:
            new_raw = json.dumps(obj, ensure_ascii=False)

        if new_raw != raw_line:
            day_file.raw_lines[plan.line_idx] = new_raw
            changes_by_day[plan.day] = changes_by_day.get(plan.day, 0) + 1

    summary.changed_lines = sum(changes_by_day.values())
    summary.touched_days = len(changes_by_day)
    global_changed += summary.changed_lines
    global_tokens += summary.token_rows
    global_cost += cost_sum_arc

    if apply_changes:
        for day in sorted(changes_by_day):
            day_file = day_files[day]
            backup = Path(str(day_file.path) + "~")
            shutil.copy2(day_file.path, backup)
            output = "\n".join(day_file.raw_lines)
            if day_file.had_trailing_newline:
                output += "\n"
            day_file.path.write_text(output, encoding="utf-8")

    summaries.append(summary)

mode = "WRITE" if apply_changes else "DRY-RUN"
print(f"=== cost-backfill ({mode}) since {since_date} ===")
for s in summaries:
    if s.runs_extracted == 0 and s.logs_with_run_complete == 0 and s.plans == 0 and s.changed_lines == 0:
        continue
    print(
        f"{s.arc}: logs={s.logs_with_run_complete} runs={s.runs_extracted} "
        f"plans={s.plans} changed={s.changed_lines} token_rows={s.token_rows} "
        f"unmatched={s.unmatched_logs} touched_days={s.touched_days}"
    )

print(
    f"TOTAL: plans={global_plans} changed={global_changed} token_rows={global_tokens} "
    f"cost_backfilled=${global_cost:.4f}"
)
PY
