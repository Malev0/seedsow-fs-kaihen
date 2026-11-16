#!/usr/bin/env bash
# Stop the bridge + console RPC loop, re-upload/reload the shim, restart the
# bridge. Use it after a game relaunch when Start says the RPC is not reachable.
#
# Usage: launch/unix/restart-rpc.sh [-s]     (-s = slower, NS2_FAST=0)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
TOOLS="$ROOT/tools"
CONSOLE="$ROOT/console"

if [ "${1:-}" = "-s" ]; then NS2_FAST=0; else NS2_FAST="${NS2_FAST:-1}"; fi
export NS2_FAST

echo '=== stop bridge + console serve loop ==='
node "$TOOLS/rpc-tool.cjs" stop-all 2>&1 || true
sleep 0.8

echo '=== upload/reload shim ==='
node "$TOOLS/upload-save.cjs" "$CONSOLE/n2h_rpc.lua" n2h_rpc.lua || exit 1
node "$TOOLS/post-eval.cjs" "$CONSOLE/reload_rpc.lua" || { echo 'shim reload failed'; exit 1; }

# Mount accessor/service addresses are per boot: after any game relaunch this
# has to run again.
echo '=== refresh mounts ==='
node "$TOOLS/refresh-mounts.cjs" || exit 1

echo '=== restart bridge ==='
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti tcp:31337 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
else
  pkill -f 'seedsow-bridge\.cjs' 2>/dev/null || true
fi
sleep 0.5
nohup node "$TOOLS/seedsow-bridge.cjs" > "$ROOT/bridge.log" 2> "$ROOT/bridge.err" &
echo "bridge pid=$!"
sleep 3
[ -f "$ROOT/bridge.log" ] && tail -n 5 "$ROOT/bridge.log"
[ -f "$ROOT/bridge.err" ] && tail -n 5 "$ROOT/bridge.err"
node "$TOOLS/rpc-tool.cjs" status 2>&1 || true
