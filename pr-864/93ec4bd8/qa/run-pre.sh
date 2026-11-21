#!/usr/bin/env bash
set -u
WT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864
OUT=/home/marktripoli/Development/bakery-wt/_qa/qa3-864x/out3; SHA=93ec4bd8289dbcc829a048d80f791ddf67f53b9c
say() { echo "$(date -u +%T) $*" | tee -a $OUT/progress.txt; }
/home/marktripoli/Development/bakery-rig/bin/stack-gate >> $OUT/progress.txt 2>&1 || { say "pre: no slot"; exit 3; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
SP=$(free_port); WP=$(free_port)
node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({bootstrapped:true}))}).listen($SP,'127.0.0.1')" &
SHIM=$!
cleanup() { kill $SHIM 2>/dev/null; cd $WT && git checkout -q $SHA -- apps/web/src packages/i18n && git clean -fdq apps/web/src packages/i18n; say "pre teardown; head $(git rev-parse --short HEAD) status: $(git status --short | tr '\n' ' ')"; }
trap cleanup EXIT
export BAKERY_SERVER_PORT=$SP BAKERY_WEB_PORT=$WP BAKERY_WEB_PREVIEW=1
cd $WT
[ "$(git rev-parse HEAD)" = "$SHA" ] || { say "HEAD moved"; exit 5; }
git fetch -q origin main
git checkout -q origin/main -- apps/web/src packages/i18n
git clean -fdq apps/web/src packages/i18n
say "PRE-CHANGE: head's specs on main's src+locales (main $(git rev-parse --short origin/main))"
timeout 900 pnpm --dir apps/web exec playwright test tests/machine-page.spec.ts tests/machines-add-wizard.spec.ts --project=desktop --workers=2 > $OUT/pre-desktop.log 2>&1; rc=$?
say "PRE DONE exit=$rc :: $(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' $OUT/pre-desktop.log | grep -E '^ +[0-9]+ (passed|failed|skipped|flaky)' | tr '\n' ' ')"
