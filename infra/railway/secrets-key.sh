#!/usr/bin/env bash
# Sourced by server-entrypoint.sh (api mode). Defines materialise_secrets_key.
#
# Railway has no secret-file mounts, so the 32-byte AES key travels as the
# base64 variable BAKERY_SECRETS_KEY_B64. This writes it to a 0600 file, exports
# BAKERY_SECRETS_KEY_FILE for run-main.sh (which grants the Deno read on it) and
# removes the base64 variable from the environment before anything else starts.
#
# BAKERY_SECRETS_KEY_B64 unset or empty: nothing is written and credential
# writes stay disabled (the server treats an absent key pair as "off").
# Invalid input exits 78 with SECRETS_KEY_INVALID; the value is never printed.
# BAKERY_SECRETS_KEY_ID is part of every ciphertext's AAD: never change it once
# data exists.

materialise_secrets_key() {
  local dir="${1:-/home/deno/.bakery}"
  if [[ -z "${BAKERY_SECRETS_KEY_B64:-}" ]]; then
    unset BAKERY_SECRETS_KEY_B64
    return 0
  fi
  if [[ ! "${BAKERY_SECRETS_KEY_ID:-}" =~ ^[A-Za-z0-9._-]{1,100}$ ]]; then
    unset BAKERY_SECRETS_KEY_B64
    printf '%s\n' 'SECRETS_KEY_INVALID' >&2
    exit 78
  fi
  local target="$dir/secrets.key"
  (
    umask 077
    mkdir -p "$dir"
    local staging size
    staging="$(mktemp "$dir/.secrets.key.XXXXXX")"
    trap 'rm -f "$staging"' EXIT
    # printf is a shell builtin, so the value never reaches an argv.
    if ! printf '%s' "$BAKERY_SECRETS_KEY_B64" | base64 --decode > "$staging" 2> /dev/null; then
      exit 1
    fi
    size="$(stat -c %s "$staging")"
    [[ "$size" == 32 ]] || exit 1
    chmod 0600 "$staging"
    mv -f "$staging" "$target"
    trap - EXIT
  ) || {
    unset BAKERY_SECRETS_KEY_B64
    printf '%s\n' 'SECRETS_KEY_INVALID' >&2
    exit 78
  }
  unset BAKERY_SECRETS_KEY_B64
  export BAKERY_SECRETS_KEY_FILE="$target"
}
