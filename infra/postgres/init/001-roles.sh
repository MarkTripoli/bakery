#!/bin/sh
set -eu

validate_password() {
  name="$1"
  value="$2"
  case "$value" in
    *[!A-Za-z0-9._~-]*)
      printf '%s\n' "$name must contain only URI-safe local password characters" >&2
      exit 78
      ;;
  esac
}

create_role() {
  role="$1"
  password="$2"
  if ! psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1 FROM pg_roles WHERE rolname = '$role'" | grep -q 1; then
    printf '%s\n' "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password') \\gexec" |
      psql -v ON_ERROR_STOP=1 -v role="$role" -v password="$password" -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  fi
}

create_database() {
  database="$1"
  owner="$2"
  if ! psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -q 1; then
    printf '%s\n' "SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'owner') \\gexec" |
      psql -v ON_ERROR_STOP=1 -v database="$database" -v owner="$owner" -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  fi
}

validate_password BAKERY_LOCAL_BAKERY_PASSWORD "$BAKERY_LOCAL_BAKERY_PASSWORD"
validate_password BAKERY_LOCAL_INNGEST_PASSWORD "$BAKERY_LOCAL_INNGEST_PASSWORD"
validate_password BAKERY_LOCAL_REDIS_PASSWORD "${BAKERY_LOCAL_REDIS_PASSWORD:-bakery-local-redis}"

create_role bakery "$BAKERY_LOCAL_BAKERY_PASSWORD"
create_role bakery_app "${BAKERY_LOCAL_APP_PASSWORD:-bakery-local-app}"
create_role inngest "$BAKERY_LOCAL_INNGEST_PASSWORD"
create_database bakery bakery
create_database inngest inngest
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d bakery -c "GRANT CONNECT ON DATABASE bakery TO bakery_app"
