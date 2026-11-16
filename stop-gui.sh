#!/usr/bin/env bash
# Linux: stop the controller listening on 127.0.0.1:31338.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch/unix/stop.sh" "$@"
