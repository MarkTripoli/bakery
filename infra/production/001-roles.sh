#!/bin/sh
set -eu
for value in "$BAKERY_OWNER_PASSWORD" "$BAKERY_APP_PASSWORD" "$BAKERY_INNGEST_DATABASE_PASSWORD"; do
  case "$value" in ''|*[!A-Za-z0-9._~-]*) echo PASSWORD_MUST_BE_URI_SAFE >&2; exit 78;; esac
done
create_database() {
  role=$1 password=$2 database=$3
  printf '%s\n' "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'role', :'password') \\gexec" |
    psql -v ON_ERROR_STOP=1 -v role="$role" -v password="$password" -U postgres -d postgres
  if [ -n "$database" ]; then
    printf '%s\n' "SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'role') \\gexec" |
      psql -v ON_ERROR_STOP=1 -v database="$database" -v role="$role" -U postgres -d postgres
  fi
}
create_database bakery "$BAKERY_OWNER_PASSWORD" bakery
create_database bakery_app "$BAKERY_APP_PASSWORD" ''
create_database inngest "$BAKERY_INNGEST_DATABASE_PASSWORD" inngest
psql -v ON_ERROR_STOP=1 -U postgres -d bakery -c 'GRANT CONNECT ON DATABASE bakery TO bakery_app'
