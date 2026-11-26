#!/usr/bin/env bash
set -euo pipefail
want=18
current=$(psql --version 2>/dev/null | sed -n 's/^psql (PostgreSQL) \([0-9]*\).*/\1/p' || true)
if [[ -n "$current" && "$current" -ge "$want" ]]; then
  exit 0
fi
as_root=()
[[ "$(id -u)" -eq 0 ]] || as_root=(sudo)
"${as_root[@]}" flock /var/lock/bakery-ci-apt.lock bash -euo pipefail -c '
  want=$1
  apt-get update -qq
  if ! apt-cache show "postgresql-client-$want" >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
  fi
  apt-get install -y --no-install-recommends "postgresql-client-$want"
' _ "$want"
installed=$(psql --version | sed -n 's/^psql (PostgreSQL) \([0-9]*\).*/\1/p')
if [[ "$installed" -lt "$want" ]]; then
  echo "POSTGRES_CLIENT_TOO_OLD: psql $installed, need $want or later" >&2
  exit 1
fi
