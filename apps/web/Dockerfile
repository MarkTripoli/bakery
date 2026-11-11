# Bakery web image: the static SPA plus a Caddy reverse proxy to the API.
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t bakery-web .
# Runtime variables: BAKERY_API_UPSTREAM (host:port of the API, required),
# PORT (default 8080), BAKERY_WEB_TRUSTED_PROXIES, BAKERY_WEB_CLIENT_IP_HEADER.
# Build variables: the Sentry ARG block before the Vite build; without them the
# bundle is uninstrumented.

# ---- build: Vite production bundle (same pinned Node/pnpm recipe as the server)
FROM denoland/deno:2.9.1@sha256:c40ad61ed0b40cca8fda05a2bbf44f8e02485bebec8ee4820bdb4b6fff42599d AS build

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

WORKDIR /workspace
COPY . /workspace
RUN pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store \
    --filter "@bakery/web..." \
  && rm -rf /tmp/pnpm-store
# Browser telemetry (#353). A Vite bundle bakes its DSN in at build time, and
# Railway hands a Dockerfile build its service variables only through ARG: an
# undeclared VITE_SENTRY_* is simply absent, so Sentry.init never runs and a
# browser failure on the deployed site is reported nowhere. Declared here rather
# than at the top of the stage so changing a value does not invalidate the
# install layer. Empty defaults keep an ordinary `docker build` uninstrumented;
# vite.config.ts decides from the values.
ARG VITE_SENTRY_ENABLED=""
ARG VITE_SENTRY_ENVIRONMENT=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=""
# Source-map upload. Reporting and upload are separate decisions: an
# instrumented build must declare SENTRY_UPLOAD_SOURCEMAPS true/1 or false/0,
# and the empty default below makes an instrumented build with no declaration
# fail at SENTRY_BUILD_UPLOAD_DECISION_REQUIRED rather than quietly ship
# minified frames. With it false the deployment reports browser failures
# without the organization auth token (#353, #523); the target and token below
# are then unused.
# `docker build --check` warns SecretsUsedInArgOrEnv here and its usual
# answer, RUN --mount=type=secret, is not available: Railway injects a service
# variable into a Dockerfile build as a build argument and nothing else. The
# token stays in this stage, which is discarded; the published image is the
# Caddy stage below and copies only dist, so no shipped layer holds it.
ARG SENTRY_UPLOAD_SOURCEMAPS=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SENTRY_AUTH_TOKEN=""
# VITE_SENTRY_RELEASE is deliberately not a build argument. The SDK and the
# uploaded maps must name the release the site actually serves, so it comes from
# the SHA the deploy stamped into .bakery-release-sha (deploy-qa.yml), never
# from a variable that can go stale against the bundle.
RUN set -eu; \
  if [ -n "$VITE_SENTRY_DSN" ] && [ -z "$VITE_SENTRY_ENVIRONMENT" ]; then \
    echo "VITE_SENTRY_DSN is set with no VITE_SENTRY_ENVIRONMENT: a production build defaults to the production telemetry environment, so QA events would be labelled production" >&2; \
    exit 1; \
  fi; \
  if [ -s /workspace/.bakery-release-sha ]; then \
    export VITE_SENTRY_RELEASE="bakery@$(tr -d '[:space:]' < /workspace/.bakery-release-sha)"; \
  elif [ -n "$VITE_SENTRY_DSN" ]; then \
    echo "VITE_SENTRY_DSN is set but .bakery-release-sha is missing or empty: an instrumented bundle must name the deployed SHA" >&2; \
    exit 1; \
  fi; \
  BAKERY_ENV=production pnpm --filter @bakery/web exec vite build; \
  test -s apps/web/dist/index.html; \
  test -z "$(find apps/web/dist -name '*.map' -print -quit)"

# ---- runtime: Caddy ---------------------------------------------------------
FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS runtime
# Caddy writes nothing durable (admin off, no autosave, no ACME), but it still
# wants writable XDG directories; point them at /tmp for the unprivileged user.
ENV XDG_DATA_HOME=/tmp/caddy-data \
    XDG_CONFIG_HOME=/tmp/caddy-config
COPY --from=build /workspace/apps/web/dist /srv/bakery
COPY infra/railway/Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /tmp/caddy-data /tmp/caddy-config \
  && chown -R 10001:10001 /tmp/caddy-data /tmp/caddy-config \
  && chmod -R a+rX /srv/bakery /etc/caddy
USER 10001:10001
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
