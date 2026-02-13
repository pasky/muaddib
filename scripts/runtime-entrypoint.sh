#!/usr/bin/env bash
set -euo pipefail

ensure_ts_build() {
  if [[ ! -f /app/dist/app/main.js ]]; then
    echo "[muaddib] TypeScript build missing; building dist..."
    npm run build --prefix /app
  fi
}

ensure_ts_build

if [[ "${1:-}" == "--message" ]]; then
  echo "[muaddib] Runtime=typescript CLI message mode"
  exec node /app/dist/cli/main.js "$@"
fi

echo "[muaddib] Runtime=typescript service mode"
exec node /app/dist/app/main.js "$@"
