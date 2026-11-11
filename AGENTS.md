# Bakery agent rules

Short on purpose. Hard rules below, then the skills that carry the work. Detail
lives in the linked docs, not here.

## Hard rules

1. **Worktree or nothing.** Every change lands in its own `git worktree` on its
   own branch, one task one worktree. Never edit, commit, or start a stack in
   the primary clone. `git worktree list` shows the neighbours. Remove the
   worktree and its compose project once the branch merges.
2. **Work enters through `/deliver`** when the shared workflow skills are
   installed (see below); without them, follow the same shape by hand: scope,
   implement, verify, review. Read-only questions and one-command fixes (typo,
   dead link, formatting) skip it.
3. **Gate before done.** `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, then the
   narrowest relevant test lane. Never suppress a gate, weaken a test, or trade
   a failing check for a comment.
4. **Evidence or silence.** Record exact commands, exit codes, candidate SHA.
   Never claim a pass you did not run. Never approve your own work.
5. **Check the learnings first.** Before calling anything a local blocker, read
   [learnings/index.xml](learnings/index.xml); record durable corrections back
   into it, with no secrets and no transient status.

Write like this file: terse, technical substance kept, filler dropped (the
optional `caveman` skill enforces this style).

Optional: `/deliver` and some review skills can ask Jev, the TypeSafe System One
model, through `typed-judgment/judge.mjs`. The helper reads `TYPESAFE_API_KEY`
from the environment, else the file `TYPESAFE_API_KEY_FILE` names, else
`typesafe/api_key` under `$XDG_CONFIG_HOME`. With no key it exits 3 and routing
falls back to the skill's workflow table; never block work on it.

## North star: PR CI in 5 to 15 minutes

Pull request CI finishes in 5 to 15 minutes. A slower PR lane is a defect to fix
(shard, cache, trim queue wait). Fix the cause; never skip tests, weaken a gate
or drop a required lane to hit the number. Full lanes that PR CI skips
(dispatched by hand) are held to the same target.

## Skills carry the work

| Need                         | Skill                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Small verifiable change      | `/deliver` picks `oneshot`: implement, verify, commit, `/review-code`                   |
| Do not know where to start   | `/deliver` routes workflow, gates, first skill                                          |
| Understand before changing   | `/create-research-questions`, `/create-research`, `graft` (CLI, not a skill)            |
| Decide an approach           | `/create-design-discussion`, `/create-prd`, `/create-tdd`                               |
| Shape the work               | `/create-structure-outline`, `/create-plan`                                             |
| Build it                     | `/implement-plan`, `/implement-outline`, `/iterate-implementation`                      |
| Bug reported                 | `/reproduce-bug`, then `fix-bug`                                                        |
| Several deliverables         | `/create-epic-plan`, `/start-epic-delivery`                                             |
| Prove it works               | `/verify-implementation`, `/test-app`, `/record-evidence`                               |
| Review and land              | `/review-code`, `/fix-code-review`, `/describe-pr`, `/resolve-pr-reviews`, `/ci-commit` |
| Issue or PR prose            | `bakery-authoring` (repo-local)                                                         |
| Explain visually             | `/show-me`                                                                              |
| Typed judgments, AI features | `typed-judgment`, `typesafe-ai` (repo-local)                                            |
| Missing capability           | `find-skills`, `npx skills find <query>`                                                |

The shared skills install from `.agents/skills/README.md`; they are optional for
contributors. Each skill states its own steps and artifacts. Follow the skill;
do not re-derive its process here.

## Detail

- [Engineering rules](docs/engineering-rules.md): validation, Zod descriptions,
  UI and backend conventions.
- Per-worktree stack: `scripts/dev/compose-up.sh` / `compose-down.sh`.
- [Authoring templates](.github/AUTHORING.md) and
  [design records](docs/technical-design/README.md).

<!-- graft:start -->

## Graft — repo context graph

Optional. With the [graft](https://www.npmjs.com/package/@nanonets/graft) CLI
installed, `graft build` indexes this repo into `graft/` (gitignored): small
linked markdown nodes that explain each system and carry exact file:line spans.
Without it the `.claude/` hooks do nothing and the `graft` MCP server in
`.mcp.json` / `opencode.json` simply fails to start.

Use it to find where code lives or how something works before opening source
files, querying with literal identifiers you already have (symbol, error string,
file name). `graft map` gives an orientation of the repo.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape: for
  understanding or editing, the top node IS the answer — cite its `covers:`
  file:line spans and edit straight from `--source`. For exhaustive tasks
  ("every occurrence / every caller of this pattern"), ranked results are top-N,
  not complete — run `graft grep "<literal>"` instead (exhaustive over indexed
  files, grouped by enclosing symbol), falling back to raw `grep -rn` only for
  unindexed files.
- `graft skeleton <file>` → every definition's signature and span; use it to
  skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this. Add
  `--direction out` for what it calls, or `--depth N` to walk transitively for
  the full blast radius. For structural questions, skip ranking and use this
  directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.

If a returned span is truncated ("+N more lines"), open the file at that range
before relying on it. Refresh the index with `graft build` after large changes.

<!-- graft:end -->
