#!/bin/sh
set -e

FILES="${FILES:-/maps}"
PORT="${PORT:-3000}"
SERVER_URL="http://127.0.0.1:$PORT/internal/regenerate"

echo "[watcher] Watching $FILES for collection changes..."
inotifywait -m -r -q \
  -e close_write -e create -e delete -e moved_from -e moved_to \
  --format '%e' \
  "$FILES" | \
  while read -r events; do
    case "$events" in
      *Q_OVERFLOW*) echo "[watcher] inotify queue overflow; requesting full regeneration" ;;
    esac
    wget -q --post-data='' -O /dev/null "$SERVER_URL" 2>/dev/null || true
  done

echo "[watcher] inotifywait exited"
exit 1
