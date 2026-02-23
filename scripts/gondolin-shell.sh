#!/usr/bin/env bash
set -euo pipefail

# Open an interactive shell inside a Gondolin VM for a given arc.
#
# The VM is started with the arc's /workspace mounted (from
# $MUADDIB_HOME/workspaces/<arcId>/) and, if a checkpoint exists, resumed
# from $MUADDIB_HOME/checkpoints/<arcId>.qcow2.
#
# Usage:
#   ./scripts/gondolin-shell.sh <ARC_NAME>
#   ./scripts/gondolin-shell.sh --list
#
# ARC_NAME is the full arc identifier, e.g. "irc-freenode#mychannel".
# The arc ID is the first 16 hex chars of sha256(ARC_NAME), matching
# the normalizeArcId() function in gondolin-tools.ts.
#
# Options:
#   --list    List known arcs (workspace directories) and exit
#   --ssh     Also open an SSH port forward for external access
#
# Environment:
#   MUADDIB_HOME   Override data directory (default: ~/.muaddib)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUADDIB_HOME="${MUADDIB_HOME:-$HOME/.muaddib}"
GONDOLIN="${SCRIPT_DIR}/../node_modules/.bin/gondolin"

if [ ! -x "$GONDOLIN" ]; then
  echo "error: gondolin not found at $GONDOLIN — run 'npm ci' first" >&2
  exit 1
fi

# ── --list mode ─────────────────────────────────────────────────────────────

if [ "${1:-}" = "--list" ]; then
  WORKSPACES_DIR="$MUADDIB_HOME/workspaces"
  CHECKPOINTS_DIR="$MUADDIB_HOME/checkpoints"
  if [ ! -d "$WORKSPACES_DIR" ]; then
    echo "No workspaces found in $WORKSPACES_DIR"
    exit 0
  fi
  echo "Known arc workspaces ($WORKSPACES_DIR):"
  echo ""
  printf "  %-18s  %-10s  %s\n" "ARC ID" "CHECKPOINT" "ARC NAME"
  printf "  %-18s  %-10s  %s\n" "------" "----------" "--------"
  for dir in "$WORKSPACES_DIR"/*/; do
    [ -d "$dir" ] || continue
    arcId=$(basename "$dir")
    checkpoint="$CHECKPOINTS_DIR/${arcId}.qcow2"
    arcName=""
    [ -f "$dir/.arc-name" ] && arcName=$(cat "$dir/.arc-name")
    if [ -f "$checkpoint" ]; then
      size=$(du -h "$checkpoint" | cut -f1)
      printf "  %-18s  %-10s  %s\n" "$arcId" "yes (${size})" "$arcName"
    else
      printf "  %-18s  %-10s  %s\n" "$arcId" "no" "$arcName"
    fi
  done
  exit 0
fi

# ── Validate arguments ──────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  echo "Usage: $0 <ARC_NAME>       Open shell in arc's sandbox" >&2
  echo "       $0 --list           List known arc workspaces" >&2
  echo "" >&2
  echo "ARC_NAME examples:" >&2
  echo "  irc-libera#mychannel" >&2
  echo "  discord-myserver#general" >&2
  echo "  cli#default" >&2
  exit 1
fi

SSH_FLAG=""
ARC_NAME=""
for arg in "$@"; do
  case "$arg" in
    --ssh) SSH_FLAG="--ssh" ;;
    --list) ;; # handled above
    *) ARC_NAME="$arg" ;;
  esac
done

if [ -z "$ARC_NAME" ]; then
  echo "error: no arc name provided" >&2
  exit 1
fi

# ── Compute arc ID (must match normalizeArcId in gondolin-tools.ts) ─────────

ARC_ID=$(echo -n "$ARC_NAME" | sha256sum | cut -c1-16)
WORKSPACE_DIR="$MUADDIB_HOME/workspaces/$ARC_ID"
CHECKPOINT_PATH="$MUADDIB_HOME/checkpoints/${ARC_ID}.qcow2"

echo "Arc:        $ARC_NAME"
echo "Arc ID:     $ARC_ID"
echo "Workspace:  $WORKSPACE_DIR"

if [ ! -d "$WORKSPACE_DIR" ]; then
  echo ""
  echo "warning: workspace directory does not exist yet, creating it" >&2
  mkdir -p "$WORKSPACE_DIR"
fi

# ── Set up custom guest image if available ──────────────────────────────────

CUSTOM_IMAGE_DIR="$MUADDIB_HOME/gondolin-image"
if [ -z "${GONDOLIN_GUEST_DIR:-}" ] && [ -d "$CUSTOM_IMAGE_DIR" ]; then
  export GONDOLIN_GUEST_DIR="$CUSTOM_IMAGE_DIR"
  echo "Image:      $CUSTOM_IMAGE_DIR"
fi

# ── Build gondolin bash arguments ───────────────────────────────────────────

GONDOLIN_ARGS=(
  bash
  --mount-hostfs "$WORKSPACE_DIR:/workspace"
  --cwd /workspace
)

if [ -f "$CHECKPOINT_PATH" ]; then
  echo "Checkpoint: $CHECKPOINT_PATH ($(du -h "$CHECKPOINT_PATH" | cut -f1))"
  echo ""
  echo "NOTE: This opens a fresh VM with the workspace mounted."
  echo "      The checkpoint is NOT resumed (only muaddib itself does that)."
  echo "      Filesystem contents in /workspace are shared and persistent."
else
  echo "Checkpoint: (none)"
fi

if [ -n "$SSH_FLAG" ]; then
  GONDOLIN_ARGS+=(--ssh)
fi

echo ""
echo "Starting Gondolin shell… (Ctrl-] to detach)"
echo ""

exec "$GONDOLIN" "${GONDOLIN_ARGS[@]}"
