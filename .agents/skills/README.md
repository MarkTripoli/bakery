# Repository skills

Agent skills that live in this repository:

- `bakery-authoring`: Bakery issue and pull request authoring.
- `typesafe-ai`: typed AI judgments from `typesafe-ai/skills`, tracked in
  `skills-lock.json`.

The Graft skill in `.claude/skills/graft/` is also repository-local.

## Optional shared workflow skills

The workflow skills named in [AGENTS.md](../../AGENTS.md) (`/deliver`,
`/review-code`, and so on) are maintained separately in
[`MarkTripoli/skills`](https://github.com/MarkTripoli/skills) and are not
vendored here. They are optional: contributors without them follow the same
shape by hand (scope, implement, verify, review).

To install them for supported agent runtimes:

```sh
npx github:MarkTripoli/skills all --global --yes
```

Start a new agent session after installing or updating.
