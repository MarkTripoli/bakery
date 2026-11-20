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

Packaging the command into the session image (#404) and signing in with the
session operation credential build on this package.
