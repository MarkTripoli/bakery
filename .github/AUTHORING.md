# Issue and pull request authoring

GitHub issue bodies and native relationships own planning. These repository
files define reusable writing rules, not a local issue map.

## Templates and local skill

Use the Work item form for features, bugs, tests and CI work; use Epic for
groups. Both produce ordinary Markdown. Agents using the API must supply the
same fields. The repository-local `bakery-authoring` skill reads those forms and
the PR template.

Work items keep Description, Execution classification, Dependencies, Checklist,
Technical details, Acceptance criteria, Design and UX, Verification and closure,
and Sources. Use meaningful content; N/A must explain why. Existing bold inline
Execution classification / Dependencies fields are accepted. Epics have their
own shorter template and are not executable.

PRs use the `Ticket | Task | Walkthrough` metadata line, then Purpose, Special
things to note and Change outline. The linked issue holds evidence. Show the
change's shape with one useful diff, tree, pseudocode or Mermaid view, not a
mandatory slideshow. A concrete `No structural change: ...` explanation is
appropriate for a structure-free edit. The linked issue holds detailed
verification records. `Walkthrough: not requested` is honest metadata and does
not mean verification was skipped.

## Local checks

From a trusted checkout:

```sh
deno run --no-config --allow-read scripts/authoring/validate.ts issue draft.md
deno run --no-config --allow-read scripts/authoring/validate.ts epic epic.md
deno run --no-config --allow-read scripts/authoring/validate.ts pr pr.md
pnpm test:unit -- tests/unit/authoring_test.ts
```

The validator checks required sections, duplicate/missing headings, unfinished
placeholders, concrete checkboxes/acceptance and a useful structural-view shape.
Headings in comments, code or quotations do not supply required fields. It
cannot establish truth, design quality, native dependency completion or consent.

## Description policy workflow

`.github/workflows/description-policy.yml` runs with read-only token
permissions. It checks out only default-branch code; descriptions are API data,
never interpolated shell commands. Neither job checks out nor executes PR head
code.

- Issue open/edit/reopen/label events validate current metadata and fail the
  `issue` job on invalid or unreadable data. No comment is posted and no label
  is changed automatically.
- PRs targeting main: open/edit/reopen/head updates validate the current
  description and linked work item, then re-read both before success. Invalid,
  missing or changed metadata fails the `pull-request` job.
- An issue edit does not rerun every PR linking that issue; edit the PR (or push
  to it) to re-run the check.
- Other labels and native parent/dependency links are preserved.
- Templates are guidance and form validation, not an API access restriction.

## Checking live metadata

The same read-only implementation can check a live issue or PR:

```sh
GITHUB_REPOSITORY=MarkTripoli/bakery deno run --no-config --allow-read --allow-env --allow-net=api.github.com scripts/authoring/github.ts check issue 169
GITHUB_REPOSITORY=MarkTripoli/bakery deno run --no-config --allow-read --allow-env --allow-net=api.github.com scripts/authoring/github.ts check pr 170
```

Supply `GH_TOKEN` or `GITHUB_TOKEN` with read access. Numbers above illustrate
invocation only. A successful check prints the inspected head/base and metadata
fingerprint. It does not prove dependencies, tests, review or approval, and it
never starts work or merges anything.

Before merge, maintainers confirm that `Description policy / pull-request` and
`Bakery CI / required / full-stack aggregate` passed on the exact PR head, and
review every change to workflows, CI policy, required jobs and credential
handling. A green CI run cannot independently certify edits to its own checks.

See
[GitHub issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
and
[workflow event security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).
