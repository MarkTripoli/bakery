#!/usr/bin/env bash
set -u

# Six hours is longer than normal lane teardown, while still short enough to
# stop one runner's leak from accumulating across many runs.
retention_seconds="${DOCKER_VOLUME_RETENTION_SECONDS:-21600}"
if [[ ! "$retention_seconds" =~ ^[0-9]+$ ]]; then
  echo "Invalid Docker volume retention: $retention_seconds; skipping."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed; skipping dangling volume reaper."
  exit 0
fi

now_epoch="$(date +%s 2>/dev/null || true)"
if [[ -z "$now_epoch" ]]; then
  echo "Could not read the current time; skipping dangling volume reaper."
  exit 0
fi
cutoff_epoch=$((now_epoch - retention_seconds))

print_volume_df_line() {
  local df_output

  if ! df_output="$(docker system df 2>/dev/null)"; then
    echo "Local Volumes line unavailable (docker system df failed)"
    return
  fi

  awk '
    $1 == "Local" && $2 == "Volumes" { print; found = 1 }
    END { if (!found) print "Local Volumes line unavailable" }
  ' <<<"$df_output"
}

volume_reclaimable_value() {
  local df_output line value

  if ! df_output="$(docker system df --format '{{json .}}' 2>/dev/null)"; then
    echo "0B"
    return
  fi

  while IFS= read -r line; do
    [[ "$line" == *'"Type":"Local Volumes"'* ]] || continue
    value="${line#*\"Reclaimable\":\"}"
    [[ "$value" != "$line" ]] || continue
    printf '%s\n' "${value%%\"*}" | sed 's/ (.*$//'
    return
  done <<<"$df_output"

  echo "0B"
}

human_to_bytes() {
  local value="$1"
  local number
  local multiplier

  case "$value" in
    *KiB)
      number="${value%KiB}"
      multiplier=1024
      ;;
    *MiB)
      number="${value%MiB}"
      multiplier=$((1024 * 1024))
      ;;
    *GiB)
      number="${value%GiB}"
      multiplier=$((1024 * 1024 * 1024))
      ;;
    *TiB)
      number="${value%TiB}"
      multiplier=$((1024 * 1024 * 1024 * 1024))
      ;;
    *kB)
      number="${value%kB}"
      multiplier=1000
      ;;
    *MB)
      number="${value%MB}"
      multiplier=$((1000 * 1000))
      ;;
    *GB)
      number="${value%GB}"
      multiplier=$((1000 * 1000 * 1000))
      ;;
    *TB)
      number="${value%TB}"
      multiplier=$((1000 * 1000 * 1000 * 1000))
      ;;
    *B)
      number="${value%B}"
      multiplier=1
      ;;
    *)
      echo 0
      return
      ;;
  esac

  awk -v number="$number" -v multiplier="$multiplier" \
    'BEGIN { printf "%.0f\n", number * multiplier }'
}

volume_reclaimable_bytes() {
  human_to_bytes "$(volume_reclaimable_value)"
}

echo "Docker volume usage before reaping:"
print_volume_df_line
before_reclaimable_bytes="$(volume_reclaimable_bytes)"

mapfile -t dangling_volumes < <(docker volume ls -f dangling=true -q 2>/dev/null || true)
echo "Dangling volumes enumerated: ${#dangling_volumes[@]}"

for volume in "${dangling_volumes[@]}"; do
  [[ -n "$volume" ]] || continue

  created_at="$(docker volume inspect --format '{{.CreatedAt}}' "$volume" 2>/dev/null || true)"
  if [[ -z "$created_at" ]]; then
    echo "Skipped $volume (volume disappeared before inspection)."
    continue
  fi

  created_epoch="$(date --date="$created_at" +%s 2>/dev/null || true)"
  if [[ -z "$created_epoch" ]]; then
    echo "Skipped $volume (invalid CreatedAt: $created_at)."
    continue
  fi

  if (( created_epoch < cutoff_epoch )); then
    # Docker rejects volume rm if a container acquired a reference after
    # enumeration, so an active lane's volume cannot be removed by this step.
    if docker volume rm "$volume" >/dev/null 2>&1; then
      echo "Removed $volume (created $created_at)."
    else
      echo "Skipped $volume (gone or no longer removable)."
    fi
  else
    echo "Kept $volume (created $created_at; newer than cutoff)."
  fi
done

echo "Docker volume usage after reaping:"
print_volume_df_line
after_reclaimable_bytes="$(volume_reclaimable_bytes)"
reclaimed_bytes=$((before_reclaimable_bytes - after_reclaimable_bytes))
if (( reclaimed_bytes < 0 )); then
  reclaimed_bytes=0
fi
printf 'Reclaimed bytes: %s\n' "$reclaimed_bytes"

exit 0
