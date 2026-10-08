#!/bin/sh

FILES="${FILES:-/maps}"
PORT="${PORT:-3000}"
SERVER_URL="http://127.0.0.1:$PORT/internal/regenerate"
RETRY_SECONDS="${WATCHER_RETRY_SECONDS:-60}"

request_regeneration() {
  wget -q --post-data='' -O /dev/null "$SERVER_URL" 2>/dev/null || true
}

# inotifywait can die for host reasons (e.g. fs.inotify.max_user_watches too low). The catalog stays usable through the
# periodic reconcile, so the watcher retries instead of taking the container down with it.
while true; do
  echo "[watcher] Watching $FILES for collection changes..."
  inotifywait -m -r -q \
    -e close_write -e create -e delete -e moved_from -e moved_to \
    --format '%e' \
    "$FILES" | \
    while read -r events; do
      case "$events" in
        *Q_OVERFLOW*) echo "[watcher] inotify queue overflow; requesting full regeneration" ;;
      esac
      request_regeneration
    done

  echo "[watcher] inotifywait exited; retrying in ${RETRY_SECONDS}s (periodic reconcile still runs)"
  sleep "$RETRY_SECONDS"
  # Changes made while nothing was watching are picked up by one pass right away.
  request_regeneration
done
