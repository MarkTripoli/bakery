# Contributing to Bakery

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Before you start

- Open an issue first for anything beyond a small fix, so scope can be agreed
  before you write code. Use the **Work item** form.
- Read [AGENTS.md](AGENTS.md) and
  [docs/engineering-rules.md](docs/engineering-rules.md). They apply to human
  and agent contributors alike.

## Setup

Follow the [README quickstart](README.md#quickstart), then install the git hooks
once:

```sh
pnpm hooks:install
```

## Making a change

1. Branch from `main`; one change per branch.
2. Before pushing: `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, then the test lane
   that covers your change (`pnpm test:unit`, `pnpm test:rails`,
   `pnpm test:integration`, ...).
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat: ...`, `fix(scope): ...`); the `commit-msg` hook checks this.
4. Open a pull request using the template. The description policy check
   validates its structure ([.github/AUTHORING.md](.github/AUTHORING.md)).

## CI for pull requests from forks

CI runs on self-hosted runners, which never execute code from forks. A
maintainer reviews fork pull requests and runs CI by pushing the change to a
branch in this repository. Expect that step before merge.

## Licence

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
