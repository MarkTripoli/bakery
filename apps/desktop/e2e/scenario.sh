#!/usr/bin/env bash
# Runs inside the container: a private D-Bus session with an unlocked Secret Service (the operating
# system's secret store), a virtual display, then the end-to-end scenario.
set -uo pipefail
export HOME=${HOME:-/tmp/e2ehome}; mkdir -p "$HOME"
export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config XDG_RUNTIME_DIR=$HOME/run
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"
# A real password creates the login collection; an empty one does not.
printf "%s" "e2e-keyring-password" | gnome-keyring-daemon --unlock --daemonize --components=secrets >/dev/null 2>&1
# The screen is kept in a file (the X dump format), which is how a screenshot is taken without a tool.
mkdir -p /tmp/xfb
Xvfb :99 -screen 0 1280x800x24 -fbdir /tmp/xfb >/dev/null 2>&1 &
export DISPLAY=:99 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
sleep 2
python3 /app/e2e/scenario.py
RC=$?
# The container runs as root (the Secret Service needs a real user entry); hand the output back.
[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" /out 2>/dev/null
exit $RC
