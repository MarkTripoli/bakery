#!/usr/bin/env bash
# Run the refusal Playwright case against each wiring mutant qa3 named.
set -u
cd "$(dirname "$0")/../.." || exit 1
cd apps/web || exit 1
set -a
source ../../.env.bakery-437-stills
set +a
export BAKERY_SERVER_PORT=32843 BAKERY_WEB_PORT=5199
umask 022

FD=src/pages/files/FileDetails.tsx
FP=src/pages/files/FilePreview.tsx
cp "$FD" /tmp/mut-FD.bak
cp "$FP" /tmp/mut-FP.bak

run() {
  local name="$1"
  echo "=== $name"
  pnpm exec playwright test tests/files.spec.ts \
    -g "a refusal stays on the file it was found on" 2>&1 |
    grep -E "^ +[0-9]+ (passed|failed)|Error: |Locator: " | head -4
  echo "=== end $name"
  cp /tmp/mut-FD.bak "$FD"
  cp /tmp/mut-FP.bak "$FP"
}

# M4: FileDetails forgets to pass the refusal to the preview.
python3 - <<'PY'
p='src/pages/files/FileDetails.tsx'
s=open(p).read()
s=s.replace("          downloadRefused={bytesMismatch}\n", "", 1)
open(p,'w').write(s)
PY
run "M4 FileDetails does not pass downloadRefused"

# M5: FilePreview ignores the panel's refusal.
python3 - <<'PY'
p='src/pages/files/FilePreview.tsx'
s=open(p).read()
s=s.replace("const mismatchKnown = refusedAsMismatch || downloadRefused;",
            "const mismatchKnown = refusedAsMismatch;", 1)
open(p,'w').write(s)
PY
run "M5 FilePreview ignores downloadRefused"

# M6: the panel does not record the refusal from its own Download.
python3 - <<'PY'
p='src/pages/files/FileDetails.tsx'
s=open(p).read()
s=s.replace('if (refusedDownload(result.error) === "mismatch") {\n        setBytesMismatch(true);\n        return;\n      }',
            'if (refusedDownload(result.error) === "mismatch") {\n        setDownloadFailed(true);\n        return;\n      }', 1)
open(p,'w').write(s)
PY
run "M6 FileDetails does not record the refusal"

# M7: the new-file reset is removed, so the refusal latches.
python3 - <<'PY'
p='src/pages/files/FileDetails.tsx'
s=open(p).read()
old='''  const subject = mismatchSubject(file.id, revision);
  const [mismatchFor, setMismatchFor] = useState(subject);
  if (mismatchFor !== subject) {
    setMismatchFor(subject);
    setBytesMismatch(false);
    setDownloadFailed(false);
    setMoreOpen(false);
  }
'''
assert old in s
s=s.replace(old, "", 1)
open(p,'w').write(s)
PY
run "M7 no reset when another file is opened"
