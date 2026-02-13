#!/usr/bin/env bash
set -euo pipefail

runtime="${MUADDIB_RUNTIME:-ts}"
rollback_until="${MUADDIB_TS_ROLLBACK_UNTIL:-2026-03-31T23:59:59Z}"

ensure_ts_build() {
  if [[ ! -f /app/ts/dist/app/main.js ]]; then
    echo "[muaddib] TS runtime build missing; building dist..."
    npm --prefix /app/ts run build
  fi
}

if [[ "$runtime" == "python" ]]; then
  echo "[muaddib] Runtime=python (rollback path). Rollback window closes at ${rollback_until}."
  exec uv run python -m muaddib.main "$@"
fi

if [[ "$runtime" != "ts" ]]; then
  echo "[muaddib] Unsupported MUADDIB_RUNTIME='${runtime}'. Expected 'ts' or 'python'." >&2
  exit 2
fi

ensure_ts_build

if [[ "${1:-}" == "--message" ]]; then
  echo "[muaddib] Runtime=ts CLI message mode. Rollback window closes at ${rollback_until}."
  exec node /app/ts/dist/cli/main.js "$@"
fi

echo "[muaddib] Runtime=ts service mode. Rollback window closes at ${rollback_until}."
exec node /app/ts/dist/app/main.js "$@"
