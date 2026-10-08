#!/usr/bin/env bash
set -u

IMG=ttrpg49-rf2-prod
PORT=18200
VOL=ttrpg49-rf2-data
FIX=/private/tmp/ttrpg49-rf2-fixture
BIN=/private/tmp/ttrpg49-rf2-bin
CTRL=/private/tmp/ttrpg49-rf2-control
E=ttrpg49-rf2-engine
PIT="czepuku/CZEPEKU%20Fantasy%20Maps/Monster%20Fighting%20Pit"
fail=0

ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
check() { if ( eval "$2" ); then ok "$1"; else bad "$1"; fi; }
cleanup() { docker rm -f $E >/dev/null 2>&1; docker volume rm $VOL >/dev/null 2>&1; rm -rf "$FIX" "$BIN" "$CTRL"; }
wait_http() { for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = 200 ] && return 0; sleep 1; done; return 1; }
trigger() { docker exec $E wget -q --post-data='' -O /dev/null "http://127.0.0.1:3000/internal/regenerate$1"; }

cleanup
mkdir -p "$FIX" "$BIN" "$CTRL"
W=$(bun -e 'import {createWorkspace} from "./test/engine/collection-fixture.ts"; console.log((await createWorkspace()).root)')
cp -R "$W/collection/." "$FIX/"
rm -rf "$W"
cat > "$BIN/ffmpeg" <<'SH'
#!/bin/sh
touch /control/entered
while [ ! -f /control/release ]; do sleep 1; done
exec /usr/bin/ffmpeg "$@"
SH
chmod +x "$BIN/ffmpeg"
docker volume create $VOL >/dev/null

echo "== cold start publishes indexes while Rain preview is held"
docker run -d --name $E -p $PORT:80 -e RECONCILE_INTERVAL=3600 -e PATH=/fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -v "$BIN":/fake:ro -v "$CTRL":/control -v "$FIX":/maps:ro -v $VOL:/data $IMG >/dev/null
check "held preview started" "for _ in \$(seq 1 60); do [ -f '$CTRL/entered' ] && exit 0; sleep 1; done; exit 1"
check "category index served before held preview releases" "wait_http http://127.0.0.1:$PORT/_catalog/czepuku/CZEPEKU%20Fantasy%20Maps/index.json"
check "search served before held preview releases" "wait_http http://127.0.0.1:$PORT/_catalog/search.json"
touch "$CTRL/release"
check "status available and completed after release" "for _ in \$(seq 1 90); do S=\$(docker exec $E wget -qO- http://127.0.0.1:3000/internal/status); echo \"status: \$S\"; echo \"\$S\" | grep -q '\"available\":true' && echo \"\$S\" | grep -q '\"completed\":true' && exit 0; sleep 1; done; exit 1"

echo "== nginx and API routes"
check "SPA route served" "curl -fsS http://127.0.0.1:$PORT/$PIT >/tmp/ttrpg49-rf2-spa.html && grep -q '<main id=\"app\"></main>' /tmp/ttrpg49-rf2-spa.html"
check "catalog map URL served" "curl -fsS 'http://127.0.0.1:$PORT/_catalog/$PIT/index.json' | grep -q 'Monster Fighting Pit'"
check "original source served" "curl -fsS 'http://127.0.0.1:$PORT/_original/$PIT/Empty%20Day.jpg' >/tmp/ttrpg49-rf2-original.bin && test -s /tmp/ttrpg49-rf2-original.bin"
check "download route serves attachment" "curl -fsSI 'http://127.0.0.1:$PORT/_download/$PIT/Empty%20Day.jpg' | grep -qi 'content-disposition: attachment'"
check "ZIP API streams map archive" "curl -fsS 'http://127.0.0.1:$PORT/api/map-zip?path=czepuku%2FCZEPEKU%20Fantasy%20Maps%2FMonster%20Fighting%20Pit' >/tmp/ttrpg49-rf2-map.zip && test -s /tmp/ttrpg49-rf2-map.zip"
check "print-image API serves printable image" "curl -fsSL 'http://127.0.0.1:$PORT/api/print-image?path=czepuku%2FCZEPEKU%20Fantasy%20Maps%2FMonster%20Fighting%20Pit&variant=Empty%20Day.jpg' >/tmp/ttrpg49-rf2-print.bin && test -s /tmp/ttrpg49-rf2-print.bin"

echo "== unreadable subfolder trigger"
chmod 000 "$FIX/Mixed/Inner"
trigger ""
check "pass remains available after chmod-000 subtree" "for _ in \$(seq 1 60); do S=\$(docker exec $E wget -qO- http://127.0.0.1:3000/internal/status); echo \"status: \$S\"; echo \"\$S\" | grep -q '\"available\":true' && echo \"\$S\" | grep -q '\"completed\":true' && exit 0; sleep 1; done; exit 1"
check "prior unreadable subtree output remains served" "curl -fsS 'http://127.0.0.1:$PORT/_catalog/Mixed/Inner/index.json' | grep -q 'Inner'"
chmod 755 "$FIX/Mixed/Inner"

echo "== forced resync"
trigger "?force=1"
check "forced resync completes with available output" "for _ in \$(seq 1 60); do S=\$(docker exec $E wget -qO- http://127.0.0.1:3000/internal/status); echo \"\$S\" | grep -q '\"available\":true' && echo \"\$S\" | grep -q '\"completed\":true' && exit 0; sleep 1; done; exit 1"

echo "== graceful stop"
docker stop -t 15 $E >/dev/null
check "engine container exits 0 after SIGTERM" "[ \"\$(docker inspect -f '{{.State.ExitCode}}' $E)\" = 0 ]"
docker rm $E >/dev/null
cleanup
[ $fail = 0 ] && echo "SMOKE_RESULT=PASS" || echo "SMOKE_RESULT=FAIL"
exit $fail
