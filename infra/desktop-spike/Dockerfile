# Linux build-and-run environment for the #77 desktop compatibility spike.
# Debian 12 ships WebKitGTK 4.1 (the webview Tauri 2 uses on Linux). Runs headless:
# Xvfb is the display, a private D-Bus session carries the Secret Service, and
# gnome-keyring is the OS secret store the app must keep its credential in.
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
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo PATH=/opt/rust/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
  && rustc --version && cargo --version
WORKDIR /work
