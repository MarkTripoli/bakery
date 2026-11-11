FROM denoland/deno:2.9.1@sha256:c40ad61ed0b40cca8fda05a2bbf44f8e02485bebec8ee4820bdb4b6fff42599d

ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.33.0
ARG PNPM_SHA512=10568bb4a6afb58c9eb3630da90cc9516417abebd3fabbe6739f0ae795728da1491e9db5a544c76ad8eb7570f5c4bb3d6c637b2cb41bfdcdb47fa823c8649319
ARG TARGETARCH

USER root
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends --yes \
    ca-certificates=20250419 \
    curl=8.14.1-2+deb13u5 \
    git=1:2.47.3-0+deb13u1 \
    xz-utils=5.8.1-1+deb13u1 \
  && case "${TARGETARCH}" in \
    amd64) node_arch=x64; node_sha=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37 ;; \
    arm64) node_arch=arm64; node_sha=1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    --output /tmp/node.tar.xz \
  && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum --check --status - \
  && tar --extract --file /tmp/node.tar.xz --strip-components=1 --directory /usr/local \
  && curl --fail --silent --show-error --location --retry 3 \
    "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" \
    --output /tmp/pnpm.tgz \
  && echo "${PNPM_SHA512}  /tmp/pnpm.tgz" | sha512sum --check --status - \
  && npm install --global --ignore-scripts --no-audit --no-fund /tmp/pnpm.tgz \
  && rm -f /tmp/node.tar.xz \
  && rm -f /tmp/pnpm.tgz \
  && rm -rf /var/lib/apt/lists/*

USER deno
