#!/usr/bin/env bash
# Runs inside the container: a private D-Bus session with an unlocked Secret Service
# (the OS secret store), a virtual display, a registered bakery:// handler, then the scenario.
set -uo pipefail
export HOME=${HOME:-/tmp/spikehome}; mkdir -p "$HOME"
export XDG_DATA_HOME=$HOME/.local/share XDG_CONFIG_HOME=$HOME/.config XDG_RUNTIME_DIR=$HOME/run
mkdir -p "$XDG_DATA_HOME/applications" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"
# A real password creates the login collection (an empty one does not); the spike keeps
# nothing else in it.
printf "%s" "spike-keyring-password" | gnome-keyring-daemon --unlock --daemonize --components=secrets >/dev/null 2>&1
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
export DISPLAY=:99 GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
sleep 2
python3 /spike/${SPIKE_SCRIPT:-scenario.py}
RC=$?
# The container runs as root (the Secret Service needs a real user entry); hand the output back.
[ -n "${HOST_UID:-}" ] && chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" /out 2>/dev/null
exit $RC
