#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi_dir="$root_dir/pi"

if [[ "${MUADDIB_PI_SYNC_RUNNING:-0}" == "1" ]]; then
  echo "Nested pi sync detected; skipping."
  exit 0
fi

if [[ ! -f "$root_dir/.gitmodules" ]]; then
  echo "No git submodules configured; skipping local pi sync."
  exit 0
fi

if ! grep -q '^\[submodule "pi"\]$' "$root_dir/.gitmodules"; then
  echo "No pi submodule configured; skipping local pi sync."
  exit 0
fi

if [[ ! -f "$pi_dir/package.json" ]]; then
  echo "pi submodule is missing at $pi_dir" >&2
  echo "Run: git submodule update --init --recursive" >&2
  exit 1
fi

echo "Installing pi submodule dependencies..."
HUSKY=0 npm --prefix "$pi_dir" install --no-fund --no-audit

echo "Building local pi packages..."
npm --prefix "$pi_dir" --workspace packages/tui run build
npm --prefix "$pi_dir" --workspace packages/ai run build
npm --prefix "$pi_dir" --workspace packages/agent run build
npm --prefix "$pi_dir" --workspace packages/coding-agent run build

echo "Linking local pi packages into muaddib..."
cd "$root_dir"
MUADDIB_PI_SYNC_RUNNING=1 npm install --no-save --package-lock=false --ignore-scripts --no-fund --no-audit \
  ./pi/packages/tui \
  ./pi/packages/ai \
  ./pi/packages/agent \
  ./pi/packages/coding-agent

echo "Local pi fork ready from $pi_dir"
