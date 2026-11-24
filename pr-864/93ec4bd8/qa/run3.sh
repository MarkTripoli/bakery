#!/usr/bin/env bash
set -u
WT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864
OUT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864x/out3; mkdir -p $OUT; : > $OUT/progress.txt
SHA=93ec4bd8289dbcc829a048d80f791ddf67f53b9c
say() { echo "$(date -u +%T) $*" | tee -a $OUT/progress.txt; }
/home/marktripoli/Development/bakery-rig/bin/stack-gate >> $OUT/progress.txt 2>&1 || { say "stack-gate: no slot"; exit 3; }
say "slot ok"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
SP=$(free_port); WP=$(free_port)
node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({bootstrapped:true}))}).listen($SP,'127.0.0.1')" &
SHIM=$!
cleanup() { kill $SHIM 2>/dev/null; say "teardown done; head $(git -C $WT rev-parse --short HEAD)"; }
trap cleanup EXIT
export BAKERY_SERVER_PORT=$SP BAKERY_WEB_PORT=$WP BAKERY_WEB_PREVIEW=1
cd $WT
guard() { [ "$(git rev-parse HEAD)" = "$SHA" ] || { say "HEAD moved"; exit 5; }; }
SPECS="tests/machine-page.spec.ts tests/machines-add-wizard.spec.ts tests/machines-touch-targets.spec.ts tests/machine-agents.spec.ts tests/machines-frame.spec.ts tests/machines-list-layout.spec.ts tests/machines-list-states.spec.ts"
for proj in desktop mobile; do
  guard; say "RUN $proj head=$(git rev-parse --short HEAD)"; t0=$(date +%s); mkdir -p $OUT/stills-$proj
  BAKERY_EVIDENCE_DIR=$OUT/stills-$proj BAKERY_STILLS_DIR=$OUT/stills-$proj timeout 1500 pnpm --dir apps/web exec playwright test $SPECS --project=$proj --workers=2 > $OUT/head-$proj.log 2>&1; rc=$?
  say "DONE $proj exit=$rc secs=$(( $(date +%s)-t0 )) :: $(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' $OUT/head-$proj.log | grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' | tr '\n' ' ')"
done
say "ALL DONE"
