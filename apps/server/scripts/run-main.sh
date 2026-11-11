#!/usr/bin/env bash
set -euo pipefail

readonly allowed_names=(
  BAKERY_ARTIFACT_DATA_DIRECTORY
  BAKERY_ARTIFACT_PREVIEW_ORIGIN
  BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT
  BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT
  BAKERY_ARTIFACT_COLLECTION_ENABLED
  HOME
  DENO_DIR
  XDG_RUNTIME_DIR
  DBUS_SESSION_BUS_ADDRESS
  BAKERY_APP_DATABASE_URL
  BAKERY_CONTAINER_BASE_URL
  BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD
  BAKERY_BUDGET_RESERVATION_TTL_SECONDS
  BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS
  BAKERY_ENV
  BAKERY_INNGEST_LOCAL_COMPOSE
  BAKERY_INNGEST_PRIVATE_HOST_SUFFIX
  BAKERY_PUBLIC_BASE_URL
  BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE
  BAKERY_SECRETS_KEY_FILE
  BAKERY_SECRETS_KEY_ID
  BAKERY_SERVER_HOST
  BAKERY_SERVER_PORT
  BAKERY_SERVER_SENTRY_DSN
  BAKERY_SENTRY_ENABLED
  BAKERY_SENTRY_ENVIRONMENT
  BAKERY_SENTRY_RELEASE
  BAKERY_SENTRY_TRACES_SAMPLE_RATE
  BAKERY_SKILL_FILE_ROOT
  BAKERY_TRUSTED_PROXY_CIDRS
  BAKERY_TRUSTED_REPOSITORIES_JSON
  BAKERY_VERSION
  BETTER_AUTH_SECRET
  BETTER_AUTH_SECRETS
  BETTER_AUTH_TELEMETRY
  BETTER_AUTH_TELEMETRY_DEBUG
  BETTER_AUTH_TELEMETRY_ENDPOINT
  BETTER_AUTH_TRUSTED_ORIGINS
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  INNGEST_SIGNING_KEY
  INNGEST_EVENT_KEY
  INNGEST_URL
  INNGEST_JOB_COMPLETION_TIMEOUT
  NODE_ENV
  NODE_PG_FORCE_NATIVE
  PGBACKOFF
  PGAPPNAME
  PGBINARY
  PGCLIENT_ENCODING
  PGCONNECT_TIMEOUT
  PGDATABASE
  PGDEBUG
  PGFETCH_TYPES
  PGHOST
  PGKEEP_ALIVE
  PGMAX_LIFETIME
  PGMAX_PIPELINE
  PGOPTIONS
  PGPASSWORD
  PGPORT
  PGPREPARE
  PGPUBLICATIONS
  PGREPLICATION
  PGSSL
  PGSSLMODE
  PGSSLNEGOTIATION
  PGTARGET_SESSION_ATTRS
  PGTARGETSESSIONATTRS
  PGUSER
  TEST
  USER
)

sanitized_environment=(PATH="$PATH" FORCE_COLOR=0)
for name in "${allowed_names[@]}"; do
  if declare -p "$name" &>/dev/null; then
    sanitized_environment+=("$name=${!name}")
  fi
done

read_permissions=()
write_permissions=()
if declare -p BAKERY_SKILL_FILE_ROOT &>/dev/null; then
  if [[
    -z "$BAKERY_SKILL_FILE_ROOT" ||
    "$BAKERY_SKILL_FILE_ROOT" != /* ||
    ${#BAKERY_SKILL_FILE_ROOT} -gt 4096 ||
    "$BAKERY_SKILL_FILE_ROOT" == *","* ||
    "$BAKERY_SKILL_FILE_ROOT" =~ [[:cntrl:]] ||
    "$BAKERY_SKILL_FILE_ROOT" == */../* ||
    "$BAKERY_SKILL_FILE_ROOT" == */.. ||
    "$BAKERY_SKILL_FILE_ROOT" == */./* ||
    "$BAKERY_SKILL_FILE_ROOT" == */.
  ]]; then
    printf '%s\n' 'SKILL_FILE_ROOT_INVALID' >&2
    exit 1
  fi
  read_permissions+=("--allow-read=$BAKERY_SKILL_FILE_ROOT")
  write_permissions+=("--allow-write=$BAKERY_SKILL_FILE_ROOT")
fi
for path_name in BAKERY_SECRETS_KEY_FILE BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE BAKERY_ARTIFACT_DATA_DIRECTORY; do
  if declare -p "$path_name" &>/dev/null && [[ -n "${!path_name}" ]]; then
    read_permissions+=("--allow-read=${!path_name}")
  fi
done
if declare -p BAKERY_TRUSTED_REPOSITORIES_JSON &>/dev/null; then
  trusted_read_paths="$(env -i "${sanitized_environment[@]}" \
    deno run --allow-env=BAKERY_TRUSTED_REPOSITORIES_JSON \
    scripts/trusted-repository-read-permissions.ts)"
  if [[ -n "$trusted_read_paths" ]]; then
    read_permissions+=("--allow-read=$trusted_read_paths")
  fi
fi

# Optional init wrapper (the container image sets BAKERY_RUN_MAIN_INIT=/tini).
# The variable is not in the allowlist, so only the sanitized environment ever
# reaches the wrapper. The wrapper is exec'd, so inside a container it becomes
# PID 1 with the same sanitized environment as the server: nothing readable at
# /proc/1/environ holds a variable this script dropped.
init_wrapper=()
if [[ -n "${BAKERY_RUN_MAIN_INIT:-}" ]]; then
  if [[ "$BAKERY_RUN_MAIN_INIT" != /* || "$BAKERY_RUN_MAIN_INIT" =~ [[:cntrl:][:space:]] || ! -x "$BAKERY_RUN_MAIN_INIT" ]]; then
    printf '%s\n' 'RUN_MAIN_INIT_INVALID' >&2
    exit 1
  fi
  init_wrapper=("$BAKERY_RUN_MAIN_INIT" -s --)
fi

exec env -i "${sanitized_environment[@]}" \
  "${init_wrapper[@]}" deno run --allow-env --allow-net --allow-run=/usr/bin/prlimit,/usr/bin/git,/usr/bin/stat,/usr/bin/systemd-run,/usr/bin/systemctl,/usr/bin/journalctl --allow-sys=uid,statfs,osRelease \
  "${read_permissions[@]}" "${write_permissions[@]}" src/main.ts
