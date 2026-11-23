#!/bin/sh
# Bakes the `bakery` command into a session image (#404).
#
# A session reaches Bakery the way a person does, through the gateway, with the
# session operation credential. That only works if the command is *there*, so it
# is compiled into the image and installed read-only on the session's PATH. No
# host bind-mount: a session on a machine does not get a copy of the host's
# checkout, and an image cannot depend on what a host happens to have.
#
# The build is deliberately boring so the image layer is reproducible:
#
#   deno compile --frozen --lock deno.lock   ->   /opt/bakery/bin/bakery
#
# The check afterwards is the point of the script. "The image has a bakery" is
# exactly the kind of claim that rots: a missing binary, a binary that is not this
# package, or a layer that quietly re-mounts a host path all look green.
set -eu

: "${IMAGE:?set IMAGE to the image to bake the command into, e.g. bakery-session:dev}"
: "${DENO_BIN:=deno}"
REPO=${REPO:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
BINARY=/opt/bakery/bin/bakery
ENTRY=packages/cli/src/main.ts

cd "$REPO"

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# `--allow-read` and `--allow-net` and nothing else: the command reads a token
# file it is told about and calls one URL. It has no reason to run a program or
# write a file, and the compiled binary should say so in its own permissions
# rather than inherit the worker's.
"$DENO_BIN" compile \
  --allow-net --allow-read --allow-env \
  --lock=deno.lock \
  --frozen \
  --no-prompt \
  --output="$OUT/bakery" \
  "$ENTRY"

test -x "$OUT/bakery" || { echo "deno compile produced no binary" >&2; exit 1; }

# The image must already exist: this adds a layer, it does not define one, so the
# runtime the sandbox needs stays the image owner's decision. The binary goes in
# 0555 and root-owned; the sandbox binds this one file read-only and puts its
# directory first on PATH, so nothing is mounted from the host.
# `PATH` is set here, in the image, because the worker hands its own `PATH` to
# every harness child: a directory that is only added at run time would reach the
# action's sandbox and not the agent's shell.
docker build -q -t "$IMAGE" -f - . <<EOF
FROM ${IMAGE}
COPY --chmod=0555 bakery ${BINARY}
ENV PATH=/opt/bakery/bin:\$PATH
RUN test -x ${BINARY} && command -v bakery
EOF

echo "baked ${BINARY} into ${IMAGE}"
echo "the session's sandbox binds ${BINARY} read-only and puts /opt/bakery/bin on PATH"