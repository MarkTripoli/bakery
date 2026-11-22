# @bakery/cli

The `bakery` command line (#445, slice F3 of the file tree): read the storage
tree with an access token. It is a thin client over the same API the web files
page uses.

```sh
export BAKERY_URL=https://bakery.example.com
export BAKERY_ORGANIZATION=<organization id>
export BAKERY_TOKEN_FILE=~/.config/bakery/token   # or BAKERY_TOKEN; there is no --token flag

deno run -A packages/cli/src/main.ts files ls /projects
deno run -A packages/cli/src/main.ts files history /projects/web/plan.md
deno run -A packages/cli/src/main.ts files cat /projects/web/plan.md@2
deno run -A packages/cli/src/main.ts files open <version id>
```

`ls`, `stat`, `history`, `uses`, `cat`, `get`, `open` and `search` are
read-only. `put`, `cp`, `mv`, `rm` and `pin` are the write half (F5) and are not
here. Exit codes: 0 done, 1 the server or the path said no, 2 the command line
was not understood.

## Inside a session (#404)

Bakery runs this same command inside a session, and the difference is only how
it signs in. The worker writes the attempt's session operation credential to an
owner-only file and puts two variables in the child environment:

```sh
BAKERY_URL=https://bakery.example.com
BAKERY_SESSION_CREDENTIAL_FILE=<attempt-private path>
```

The credential itself is never in the environment: a value there is a value in
`ps`, in `/proc/<pid>/environ` and in a crash dump. Because the file's path is
what says "I am a session", no flag is needed and no script has to choose. The
command then speaks the gateway's two routes - `GET .../session-tools` and
`POST .../session-call` - with the host credential in `authorization` and the
session credential in `x-session-credential`. Both are required and neither
stands in for the other.

```sh
bakery tools                      # exactly what this session may call
bakery files ls /projects/web
bakery files search plan          # library.search, the session's search
```

What changes for a session:

- `search` uses `library.search`, which searches by name; the person's
  `files.search` filters by path and media type, and a session asks for those
  two filters rather than getting a silently wider answer.
- `pin` is refused with the reason: how long a record keeps a file is an
  administrator's decision, not an agent's.
- An operation this session was not granted is named before the call, so the
  message says which grant is missing instead of "denied".

## In the session image

The image builds `bakery` with `deno compile` and installs it at
`/opt/bakery/bin/bakery`. The native action's sandbox binds that one file
read-only and puts its directory on the child's `PATH`, so nothing is mounted
from the host:

`scripts/build-session-image.sh` does that build and checks the result: the
binary answers `--help`, it is the only executable added, and no host path is
mounted into a session.
