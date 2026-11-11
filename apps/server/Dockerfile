# Self-contained Bakery server image: API, dispatcher, pre-deploy and CLI tasks
# all run from this one image (infra/railway/server-entrypoint.sh picks the
# mode). Build from the repository root:
#   docker build -f apps/server/Dockerfile -t bakery-server .
# The build context needs a non-empty .bakery-release-sha (the deploy writes the
# commit SHA there before upload); the build fails without it.
#
# Dependency install is filtered to the server workspace. If
# `deno cache` ever fails to resolve an npm package under the filtered tree,
# rebuild with --build-arg BAKERY_INSTALL_SCOPE=full (the complete workspace
# install) and record the failing specifier. Nothing has needed the fallback
# so far; sizes of both trees are recorded in the P5 evidence.

# ---- shared tooling: Deno base + git + pinned Node/pnpm -------------------
FROM denoland/deno:2.9.1@sha256:c40ad61ed0b40cca8fda05a2bbf44f8e02485bebec8ee4820bdb4b6fff42599d AS tooling

ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.33.0
ARG PNPM_SHA512=10568bb4a6afb58c9eb3630da90cc9516417abebd3fabbe6739f0ae795728da1491e9db5a544c76ad8eb7570f5c4bb3d6c637b2cb41bfdcdb47fa823c8649319

USER root
# git: pinned like the original server image. ca-certificates rolls forward (git
# clones over HTTPS need it). No curl/xz-utils: Debian security updates broke
# their exact-version pins within weeks, so archives come down through Deno and
# Node's .tar.gz, each verified against a pinned sha (nodejs.org SHASUMS256.txt).
RUN set -eu; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends --yes \
    ca-certificates \
    git=1:2.47.3-0+deb13u1; \
  rm -rf /var/lib/apt/lists/*; \
  case "$(dpkg --print-architecture)" in \
    amd64) node_arch=x64; node_sha=c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744 ;; \
    arm64) node_arch=arm64; node_sha=25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be ;; \
    *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  download() { \
    for attempt in 1 2 3; do \
      DOWNLOAD_URL="$1" DOWNLOAD_OUT="$2" deno eval \
        'const r = await fetch(Deno.env.get("DOWNLOAD_URL")); if (!r.ok) throw new Error(String(r.status)); await Deno.writeFile(Deno.env.get("DOWNLOAD_OUT"), new Uint8Array(await r.arrayBuffer()));' \
        && return 0; \
      sleep 2; \
    done; \
    return 1; \
  }; \
  download "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz" /tmp/node.tar.gz; \
  echo "${node_sha}  /tmp/node.tar.gz" | sha256sum --check --status -; \
  tar --extract --gzip --file /tmp/node.tar.gz --strip-components=1 --directory /usr/local; \
  download "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" /tmp/pnpm.tgz; \
  echo "${PNPM_SHA512}  /tmp/pnpm.tgz" | sha512sum --check --status -; \
  npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz; \
  rm -f /tmp/node.tar.gz /tmp/pnpm.tgz; \
  test -x /usr/bin/git && test -x /usr/bin/bash && test -x /usr/bin/prlimit && test -x /usr/bin/stat

# ---- build: install dependencies and warm the Deno cache ------------------
FROM tooling AS build
ARG BAKERY_INSTALL_SCOPE=filtered
USER root
ENV DENO_DIR=/deno-dir
WORKDIR /workspace
COPY . /workspace
# A missing file fails the build instead of shipping a server that cannot report
# which commit it runs.
RUN test -s /workspace/.bakery-release-sha
# --ignore-scripts: the root `prepare` script rewrites git config (CI does the
# same). The store lives outside the image layers.
RUN set -eu; \
  if [ "$BAKERY_INSTALL_SCOPE" = full ]; then \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store; \
  else \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store \
      --filter "@bakery/server..."; \
  fi; \
  rm -rf /tmp/pnpm-store /root/.cache /root/.local
# Every entrypoint the image runs, including the dispatcher child (see
# scripts/deploy/runtime.sh).
RUN deno cache --frozen --node-modules-dir=manual \
    apps/server/src/main.ts \
    apps/server/src/dispatch.ts \
    apps/server/src/tasks.ts \
    apps/server/scripts/run-dispatch.ts \
    apps/server/scripts/bootstrap-database.ts \
    apps/server/src/modules/knowledge/draft-import-worker.ts \
  && chmod -R go-w,a+rX /workspace /deno-dir

# ---- runtime ---------------------------------------------------------------
FROM tooling AS runtime
USER root
ENV DENO_DIR=/deno-dir
# /workspace stays root-owned and read-only for the deno user; only the Deno
# cache and the secrets-key directory are writable by it.
COPY --from=build /workspace /workspace
COPY --from=build --chown=deno:deno /deno-dir /deno-dir
RUN install -d -o deno -g deno -m 0700 /home/deno/.bakery
USER deno
WORKDIR /workspace
# Drop the Deno base ENTRYPOINT (/tini -- docker-entrypoint.sh): it would keep the
# full container environment (superuser URL, passwords, key base64) in PID 1,
# readable by the server's own uid through /proc/1/environ. The modes in
# server-entrypoint.sh exec /tini themselves with a sanitized environment.
ENTRYPOINT []
CMD ["bash", "/workspace/infra/railway/server-entrypoint.sh", "api"]
