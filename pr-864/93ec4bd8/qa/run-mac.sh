#!/usr/bin/env bash
set -u
WT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864; OUT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864x/out3; SHA=93ec4bd8289dbcc829a048d80f791ddf67f53b9c
say() { echo "$(date -u +%T) $*" | tee -a $OUT/progress.txt; }
/home/marktripoli/Development/bakery-rig/bin/stack-gate >> $OUT/progress.txt 2>&1 || { say "mac: no slot"; exit 3; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
SP=$(free_port); WP=$(free_port)
node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({bootstrapped:true}))}).listen($SP,'127.0.0.1')" &
SHIM=$!
cleanup() { kill $SHIM 2>/dev/null; cd $WT && git clean -fq apps/web/tests/qa864-mac.spec.ts; say "mac teardown; head $(git rev-parse --short HEAD) status: $(git status --short | tr '\n' ' ')"; }
trap cleanup EXIT
export BAKERY_SERVER_PORT=$SP BAKERY_WEB_PORT=$WP BAKERY_WEB_PREVIEW=1
cd $WT; [ "$(git rev-parse HEAD)" = "$SHA" ] || { say "HEAD moved"; exit 5; }
for proj in desktop mobile; do mkdir -p $OUT/mac-$proj
  BAKERY_EVIDENCE_DIR=$OUT/mac-$proj BAKERY_STILLS_DIR=$OUT/mac-$proj timeout 600 pnpm --dir apps/web exec playwright test tests/qa864-mac.spec.ts --project=$proj --workers=1 > $OUT/mac-$proj.log 2>&1; say "MAC $proj exit=$? :: $(grep -a MAC_REPAIR_REQUESTS $OUT/mac-$proj.log | head -1)"
done
