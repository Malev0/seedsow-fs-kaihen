#!/usr/bin/env bash
# Stop the controller and the node processes it owns.
#
# Closing the browser tab does not stop the controller: the GUI is started
# detached, and a run spawns setup -> hen -> pipeline as its children. Killing
# only the process that holds the listening socket misses those children, and
# misses everything once the socket is gone - that is why a plain lsof+kill
# sometimes left node running. This stops the GUI by pid file, by command line
# and by port, waits for it to disappear, and then stops the bridge and the
# console loop.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
PORT="${NS2_GUI_PORT:-31338}"
PID_FILE="$ROOT/gui/gui.pid"

pids=''
add_pid() {
  case " $pids " in *" $1 "*) ;; *) pids="$pids $1" ;; esac
}

# 1. The pid recorded by start.sh.
if [ -f "$PID_FILE" ]; then
  pid="$(head -n 1 "$PID_FILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$pid" ] && add_pid "$pid"
fi

# 2. Any node running the controller, including a copy started from another
#    folder. The command line is the reliable identity.
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f 'ns2-gui\.cjs' 2>/dev/null || true); do add_pid "$pid"; done
fi

# 3. Whoever owns a socket on the port.
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti "tcp:$PORT" 2>/dev/null || true); do add_pid "$pid"; done
fi

alive=''
for pid in $pids; do
  kill -0 "$pid" 2>/dev/null && alive="$alive $pid"
done

if [ -n "$alive" ]; then
  kill -TERM $alive 2>/dev/null || true
  still=''
  i=0
  while [ "$i" -lt 25 ]; do
    still=''
    for pid in $alive; do
      kill -0 "$pid" 2>/dev/null && still="$still $pid"
    done
    [ -z "$still" ] && break
    i=$((i + 1))
    sleep 0.2
  done
  if [ -n "$still" ]; then
    kill -KILL $still 2>/dev/null || true
    sleep 0.2
  fi
  left=''
  for pid in $alive; do
    kill -0 "$pid" 2>/dev/null && left="$left $pid"
  done
  rm -f "$PID_FILE"
  if [ -n "$left" ]; then
    echo "Controller did not stop: still running pid$left"
    exit 1
  fi
  echo 'Controller stopped.'
else
  rm -f "$PID_FILE"
  echo 'No controller was running.'
fi

# The bridge and the console loop are node processes from this folder too, and
# they outlive the controller. rpc-tool validates the bridge pid before killing
# it and falls back to the bridge port, so this never kills an unrelated process.
if [ -f "$ROOT/tools/rpc-tool.cjs" ] && command -v node >/dev/null 2>&1; then
  if node "$ROOT/tools/rpc-tool.cjs" stop-all >/dev/null 2>&1; then
    echo 'Bridge and console loop stopped.'
  else
    echo 'Bridge/console loop did not stop cleanly.'
  fi
fi
exit 0
