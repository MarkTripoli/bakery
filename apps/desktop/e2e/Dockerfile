# The image the desktop app's package and update checks run in (docs/runbooks/desktop-packaging.md):
# the Rust toolchain, the web view and GTK development files the app is built against, and what the
# checks need to run the app without a screen (a virtual display, a message bus and a secret store).
#
#   docker build -t bakery-spike77-linux apps/desktop/e2e
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates pkg-config file git \
    libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libssl-dev libsecret-1-dev \
    librsvg2-dev libayatana-appindicator3-dev \
    xvfb xauth dbus dbus-x11 gnome-keyring libsecret-tools \
    xdg-utils desktop-file-utils shared-mime-info \
    procps jq netcat-openbsd python3 \
  && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# rustfmt and clippy are the two checks CI runs on the desktop crates, so they are here too.
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && rustup component add rustfmt clippy
WORKDIR /work
