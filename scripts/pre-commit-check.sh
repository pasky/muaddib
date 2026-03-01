#!/usr/bin/env bash
# Pre-commit hook: run lint, typecheck, test, build in parallel.
# Output is captured per-stage; only failures are printed (last 30 lines).
set -u

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

npm run lint      >"$tmpdir/lint.out" 2>&1      & pid_lint=$!
npm run typecheck >"$tmpdir/tc.out" 2>&1         & pid_tc=$!
timeout 60 npm test >"$tmpdir/test.out" 2>&1     & pid_test=$!
npm run build     >"$tmpdir/build.out" 2>&1      & pid_build=$!

rc=0
for name_pid in lint=$pid_lint typecheck=$pid_tc test=$pid_test build=$pid_build; do
  name=${name_pid%%=*}
  pid=${name_pid##*=}
  if ! wait "$pid"; then
    echo ""
    echo "=== $name FAILED ==="
    tail -30 "$tmpdir/$name.out"
    echo ""
    rc=1
  else
    echo "  $name ok"
  fi
done

exit $rc
