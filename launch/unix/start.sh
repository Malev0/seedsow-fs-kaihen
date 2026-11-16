#!/usr/bin/env bash
# Launch the manual Seedsow controller and open it in the default browser.
#
# Usage: launch/unix/start.sh        (or start-gui.sh / start-gui.command)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
GUI="$ROOT/gui"
PORT="${NS2_GUI_PORT:-31338}"
URL="http://127.0.0.1:$PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not on PATH. Install Node.js 20+ from https://nodejs.org/, then run this again."
  exit 1
fi

# Already listening? Then just open the page.
listening() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time 1 "$URL/api/state"
  else
    node -e 'const n=require("net").connect({host:"127.0.0.1",port:process.argv[1]});n.setTimeout(800);n.once("connect",()=>{n.destroy();process.exit(0)});n.once("timeout",()=>{n.destroy();process.exit(1)});n.once("error",()=>process.exit(1))' "$PORT"
  fi
}

if ! listening; then
  nohup node "$GUI/ns2-gui.cjs" > "$GUI/gui.log" 2> "$GUI/gui.err" &
  # Recorded so stop.sh can find the controller even when it no longer owns the
  # listening socket. It also falls back to the command line and the port.
  echo $! > "$GUI/gui.pid"
  i=0
  while [ "$i" -lt 30 ]; do
    listening && break
    i=$((i + 1))
    sleep 0.3
  done
fi

if ! listening; then
  echo 'controller did not start; see gui/gui.err'
  [ -f "$GUI/gui.err" ] && tail -n 10 "$GUI/gui.err"
  exit 1
fi

# One page and one server for the whole controller.
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 &
fi
echo "controller: $URL"
