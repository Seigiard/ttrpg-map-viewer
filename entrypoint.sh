#!/bin/sh
set -e

BUN_PORT="${PORT:-3000}"
FILES="${FILES:-/maps}"
DATA="${DATA:-/data}"
export BUN_PORT FILES DATA

mkdir -p "$DATA"

echo "[entrypoint] Configuring nginx..."
sed -e "s|\${BUN_PORT}|$BUN_PORT|g" -e "s|\${FILES}|$FILES|g" -e "s|\${DATA}|$DATA|g" \
  /app/nginx.conf.template > /etc/nginx/nginx.conf

echo "[entrypoint] Starting nginx..."
nginx &
NGINX_PID=$!

echo "[entrypoint] Starting Bun server on port $BUN_PORT..."
bun --smol run /app/src/server.ts &
BUN_PID=$!

echo "[entrypoint] Starting collection watcher..."
/app/src/watcher.sh &
WATCHER_PID=$!

cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$BUN_PID" 2>/dev/null || true
  kill "$WATCHER_PID" 2>/dev/null || true
  kill "$NGINX_PID" 2>/dev/null || true
  wait
  exit "${1:-0}"
}

trap cleanup SIGTERM SIGINT

while true; do
  kill -0 "$BUN_PID" 2>/dev/null || { echo "[entrypoint] Bun process died"; break; }
  kill -0 "$WATCHER_PID" 2>/dev/null || { echo "[entrypoint] Watcher process died"; cleanup 1; }
  kill -0 "$NGINX_PID" 2>/dev/null || { echo "[entrypoint] nginx process died"; break; }
  sleep 5
done

cleanup 1
