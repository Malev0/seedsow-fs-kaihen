#!/usr/bin/env bash
# macOS launcher: double-click in Finder (or run it from a terminal).
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch/unix/start.sh" "$@"
