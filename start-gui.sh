#!/usr/bin/env bash
# Linux launcher: starts the controller and opens it in the browser.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/launch/unix/start.sh" "$@"
