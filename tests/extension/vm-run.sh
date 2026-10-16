#!/bin/sh
# Copy the extension + tests into the test VM and run one test script there.
# Nothing runs on the host except the copy.
#   tests/extension/vm-run.sh e2e.mjs [args...]
#   tests/extension/vm-run.sh --test           (unit tests)
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# VM name and guest paths: tests/extension/vm.env (local; copy vm.env.example).
[ -f "$ROOT/tests/extension/vm.env" ] && . "$ROOT/tests/extension/vm.env"
VM=${VM:-pacifier-test}
GUEST_NODE=${GUEST_NODE:-'~/pacifier-test/node/bin/node'}
GUEST_BRAVE=${GUEST_BRAVE:-'~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'}
limactl shell "$VM" -- rm -rf /tmp/pacifier /tmp/pacifier-ext /tmp/pacifier-tests
limactl copy -r "$ROOT/extension" "$VM:/tmp/pacifier-ext" >/dev/null
limactl copy -r "$ROOT/tests" "$VM:/tmp/pacifier-tests" >/dev/null
limactl shell "$VM" -- sh -c '
  node=$(printf %s "$1" | sed "s|^~|$HOME|"); brave=$(printf %s "$2" | sed "s|^~|$HOME|"); shift 2
  mkdir -p /tmp/pacifier && mv /tmp/pacifier-ext /tmp/pacifier/extension && mv /tmp/pacifier-tests /tmp/pacifier/tests
  cd /tmp/pacifier/tests/extension
  if [ "$1" = "--test" ]; then exec "$node" --test unit.test.mjs; fi
  script=$1; shift
  exec "$node" "$script" "$brave" /tmp/pacifier/extension "$@"
' sh "$GUEST_NODE" "$GUEST_BRAVE" "$@"
