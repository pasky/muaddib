#!/usr/bin/env bash
# Wrapper that ensures vitest worker processes are cleaned up on interrupt/kill.
# Without this, Ctrl+C during `npm test` leaves zombie vitest workers at 100% CPU
# because npm's signal propagation to vitest's worker pool is unreliable.
#
# vitest respawns workers after SIGTERM, so we SIGKILL the entire process group.
set -euo pipefail

# Run vitest in its own process group so we can nuke the entire tree.
setsid npx vitest run --coverage <&0 &
PGID=$!

cleanup() {
  kill -9 -- -"${PGID}" 2>/dev/null || true
}
trap cleanup EXIT

# wait returns non-zero when the child is killed, which is expected during cleanup
wait "${PGID}" || exit $?
