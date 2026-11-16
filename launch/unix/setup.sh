#!/usr/bin/env bash
# Set up a freshly launched Seedsow boot: stop any old bridge/loop, upload and
# reload the console shim, refresh the per-boot mounts, start the bridge.
# Press Y in the game (HTTP server) before running this.
#
# Usage: launch/unix/setup.sh [-s]     (-s = slower, NS2_FAST=0)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
TOOLS="$ROOT/tools"
CONSOLE="$ROOT/console"

if [ "${1:-}" = "-s" ]; then NS2_FAST=0; else NS2_FAST="${NS2_FAST:-1}"; fi
export NS2_FAST

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH; install Node.js 20+."
  exit 1
fi

# Run a command up to $1 times, $2 seconds apart, until it succeeds.
retry() {
  tries=$1; delay=$2; shift 2
  i=0
  while [ "$i" -lt "$tries" ]; do
    if "$@"; then return 0; fi
    i=$((i + 1))
    [ "$i" -lt "$tries" ] && sleep "$delay"
  done
  return 1
}

echo '=== stop any running bridge + console RPC loop ==='
node "$TOOLS/rpc-tool.cjs" stop-all 2>&1 || true
sleep 0.8

# Right after stop-all the console's HTTP handler can reset or ignore the first
# request while the old serve loop unwinds. Retry instead of giving up.
echo '=== console check ==='
if ! retry 8 1.5 node "$TOOLS/post-eval.cjs" "$CONSOLE/test_eval.lua"; then
  echo 'console not reachable: /eval never answered.'
  echo 'If the game is running, its HTTP handler is wedged - close it, start it again and press Y.'
  exit 1
fi
echo 'console ok'

echo '=== re-upload/reload shim ==='
# The save upload endpoint rejects bodies over 28672 bytes (http.lua REQ_CAP),
# and it is the only way to put these files on the console. Fail here instead of
# after three 6 s timeouts.
for name in n2h_rpc.lua n2h_pump.lua; do
  size=$(wc -c < "$CONSOLE/$name" | tr -d ' ')
  if [ "$size" -gt 28672 ]; then
    echo "$name is $size bytes; the save upload limit is 28672. Split the file."
    exit 1
  fi
done
if ! retry 3 1 node "$TOOLS/upload-save.cjs" "$CONSOLE/n2h_rpc.lua" n2h_rpc.lua; then
  echo 'shim upload failed'
  echo 'If the console printed "[!] httpd: accept ...; server stopped", the launcher stopped its'
  echo 'HTTP server: common/http.lua treats any accept error other than EAGAIN as fatal and'
  echo 'never restarts it. That is per game process - relaunch Seedsow (Restart Game), do not'
  echo 'power-cycle, and try again.'
  exit 1
fi
if ! retry 3 1 node "$TOOLS/upload-save.cjs" "$CONSOLE/n2h_pump.lua" n2h_pump.lua; then
  echo 'pump upload failed'; exit 1
fi
if ! retry 3 1 node "$TOOLS/post-eval.cjs" "$CONSOLE/reload_rpc.lua"; then
  echo 'shim reload failed'; exit 1
fi

echo '=== refresh mounts (needs /eval, so before the RPC loop) ==='
if ! retry 3 1 node "$TOOLS/refresh-mounts.cjs"; then
  echo 'refresh mounts failed'; exit 1
fi
# Do not trust the exit code alone: the file is what the exploit needs.
MOUNTS="$ROOT/ns2jb-main/ns2jb-main/engine/switch2/app/mounts.json"
if [ ! -f "$MOUNTS" ]; then
  echo "refresh mounts produced no $MOUNTS"; exit 1
fi

echo '=== restart bridge ==='
# The bridge holds 127.0.0.1:31337. Stop a stale one first; lsof is the portable
# way on macOS, ss/pkill on Linux.
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti tcp:31337 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
else
  pkill -f 'seedsow-bridge\.cjs' 2>/dev/null || true
fi
sleep 0.5
# Redirect both streams to files so the bridge does not inherit the caller's
# pipes (a caller that waits for EOF would otherwise never see it).
nohup node "$TOOLS/seedsow-bridge.cjs" > "$ROOT/bridge.log" 2> "$ROOT/bridge.err" &
BRIDGE_PID=$!
sleep 3
echo "bridge pid=$BRIDGE_PID fast=$NS2_FAST"
[ -f "$ROOT/bridge.log" ] && tail -n 5 "$ROOT/bridge.log"
[ -f "$ROOT/bridge.err" ] && tail -n 5 "$ROOT/bridge.err"

echo '=== console RPC transport ==='
pong=''
i=0
while [ "$i" -lt 20 ]; do
  pong=$(node "$TOOLS/rpc-tool.cjs" ping 2>&1 || true)
  case "$pong" in *pong*) echo "$pong"; break ;; esac
  i=$((i + 1))
  sleep 0.5
done
case "$pong" in
  *pong*) ;;
  *) echo 'RPC listener did not come up; the bridge will use /eval' ;;
esac
node "$TOOLS/rpc-tool.cjs" status 2>&1 || true
