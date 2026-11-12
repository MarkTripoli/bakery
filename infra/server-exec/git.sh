#!/bin/sh
# The only way the Bakery server may run git (--allow-run names this path,
# never /usr/bin/git: git runs arbitrary commands through `-c alias.x=!cmd`,
# core.sshCommand, --upload-pack and similar). It takes an operation name, an
# absolute git directory and validated operands, ignores its environment and
# every other argument, and execs exactly one fixed git command line with
# hooks and fsmonitor off and system/global config ignored. Exit 64 on any
# input it does not recognise. The server's call sites map to these
# operations in apps/server/src/platform/server-exec.ts.
[ "$#" -ge 2 ] || exit 64
op=$1
dir=$2
shift 2

h='[0-9a-f]'
oid40="$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h"
is_oid() {
  case "$1" in
    $oid40 | $oid40$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h$h) return 0 ;;
  esac
  return 1
}
is_type() {
  case "$1" in blob | tree | commit | tag) return 0 ;; esac
  return 1
}

# The git directory: absolute, plain characters, no dot segments.
case "$dir" in /*) ;; *) exit 64 ;; esac
case "$dir" in *[!A-Za-z0-9._/+-]* | */./* | */../* | */. | */..) exit 64 ;; esac

set_environment() {
  protocols=$1
  ENVIRONMENT="PATH=/usr/bin:/bin HOME=/nonexistent XDG_CONFIG_HOME=/nonexistent LC_ALL=C"
  ENVIRONMENT="$ENVIRONMENT GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null"
  ENVIRONMENT="$ENVIRONMENT GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false"
  ENVIRONMENT="$ENVIRONMENT GCM_INTERACTIVE=never GIT_PROTOCOL_FROM_USER=0"
  ENVIRONMENT="$ENVIRONMENT GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1"
  ENVIRONMENT="$ENVIRONMENT GIT_ALLOW_PROTOCOL=$protocols"
}

# Local reads run under a 256 MiB address-space limit: a hostile repository
# cannot make git allocate without bound.
local_git() {
  set_environment ""
  # shellcheck disable=SC2086 # ENVIRONMENT is a fixed list of NAME=value words.
  exec /usr/bin/env -i $ENVIRONMENT \
    /usr/bin/prlimit --as=268435456:268435456 -- \
    /usr/bin/git --git-dir="$dir" \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never \
    "$@"
}

case "$op" in
  cat-file-type)
    [ "$#" -eq 1 ] && is_oid "$1" || exit 64
    local_git cat-file -t "$1"
    ;;
  cat-file-size)
    [ "$#" -eq 1 ] && is_oid "$1" || exit 64
    local_git cat-file -s "$1"
    ;;
  cat-file)
    [ "$#" -eq 2 ] && is_type "$1" && is_oid "$2" || exit 64
    local_git cat-file "$1" "$2"
    ;;
  is-bare)
    [ "$#" -eq 0 ] || exit 64
    local_git rev-parse --is-bare-repository
    ;;
  is-shallow)
    [ "$#" -eq 0 ] || exit 64
    local_git rev-parse --is-shallow-repository
    ;;
  verify-commit)
    [ "$#" -eq 1 ] || exit 64
    { is_oid "$1" || [ "$1" = FETCH_HEAD ]; } || exit 64
    local_git rev-parse --verify --end-of-options "$1^{commit}"
    ;;
  hash-object)
    [ "$#" -eq 1 ] && is_type "$1" || exit 64
    local_git hash-object -t "$1" --stdin --no-filters
    ;;
  init-bare)
    [ "$#" -eq 0 ] || exit 64
    local_git init --bare --quiet
    ;;
  ls-tree)
    [ "$#" -le 1 ] || exit 64
    if [ "$#" -eq 1 ]; then
      # A relative path inside the tree: no option, no dot segments.
      case "$1" in "" | -* | /* | *[[:cntrl:]]* | ./* | ../* | */./* | */../* | */. | */..) exit 64 ;; esac
      local_git ls-tree -r -z --full-tree FETCH_HEAD -- "$1"
    fi
    local_git ls-tree -r -z --full-tree FETCH_HEAD --
    ;;
  fetch)
    [ "$#" -eq 2 ] || exit 64
    url=$1
    revision=$2
    case "$url" in *[[:space:][:cntrl:]]*) exit 64 ;; esac
    case "$url" in
      https://[A-Za-z0-9]*) protocols=https ;;
      # Loopback HTTP exists only for injected test sources; the server
      # refuses such a locator itself unless that mode is on.
      http://127.0.0.1:[0-9]*/*) protocols=https:http ;;
      *) exit 64 ;;
    esac
    case "$revision" in "" | -* | *[!A-Za-z0-9._/-]* | *..*) exit 64 ;; esac
    set_environment "$protocols"
    # shellcheck disable=SC2086 # ENVIRONMENT is a fixed list of NAME=value words.
    exec /usr/bin/env -i $ENVIRONMENT \
      /usr/bin/git --git-dir="$dir" \
      -c core.hooksPath=/dev/null -c core.fsmonitor=false \
      -c credential.helper= -c core.askPass= -c http.followRedirects=false \
      -c protocol.version=2 \
      fetch --no-tags --depth=1 --filter=blob:none -- "$url" "$revision"
    ;;
  *)
    exit 64
    ;;
esac
