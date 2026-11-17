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

PRs use the `Ticket | Task | Walkthrough` metadata line, then Purpose, Risk,
Special things to note, Change outline, Decisions and Evidence. A `## Evidence
@ <sha>` heading is accepted. Show the change's shape with one useful diff,
tree, pseudocode or Mermaid view, not a slideshow. A concrete `No structural
change: ...` explanation is fine for a structure-free edit.
`Walkthrough: not requested` is honest metadata and does not mean verification
was skipped.

## Write for an executive

Descriptions and review verdicts are read by someone deciding, not studying.
Plain words, short sentences, no filler, no restating the diff. If a sentence
doesn't change a decision, cut it. The validator enforces:

| part | limit |
|---|---|
| whole PR description | 300 words of prose (code, tables, links and comments don't count) |
| Purpose | one sentence, at most 40 words |
| Risk | `Level: Low`, `Medium` or `High`, then one to three bullets of at most 25 words: what could break, who it hits, how to roll back |
| Special things to note | one to four bullets of at most 25 words, or `- None.` |
| Change outline | one to three show-me views, 80 lines of view in all, plus at most 40 words of prose outside the views |
| Decisions | one to three bullets of at most 30 words ("Chose X over Y because Z"), or `- None.` |
| Evidence | at most 60 words: UI screenshots or a recording (at most four images) and the new tests, one line each; no format, lint or type checks, which CI shows; `- None.` when there is nothing to show |

Review and QA verdict comments follow the same rule:

```markdown
Verdict: Approve | Changes requested | Blocked
Head: `<sha>`

- [High] One finding: what is wrong and where.
- [Low] At most five findings, at most 25 words each.

| check | result |
|---|---|
| new test `issue-settings_test.ts` | refuses a stale save |
```

At most 150 words of prose in all. No praise, no narration of what was
read, no repeating the PR description. Check a draft with
`validate.ts review <draft.md>`.

## Verification checklist (the merge gate)

Every PR ends with a Verification checklist. The author leaves it unticked;
each verifier ticks their own box during review, or replaces it with
`N/A: <reason>`. The description check stays red until every box is resolved,
so a PR cannot merge unverified.

| item | verifier | checks |
|---|---|---|
| Backend verified | reviewer | contracts, data, permissions and errors behave as described |
| UI verified | design-ux | no duplicate of an existing screen or component; fits the navigation; consistent patterns; desktop and phone, light and dark |
| Implementation clean | reviewer | follows existing patterns, no duplicated logic, no dead code, nothing outside the ticket |
| Tests cover the change | qa | new behavior has tests that fail without it |

Ticking a box is a claim: the verifier did the check at the PR head. A
problem found here is fixed in the same PR, not filed as a follow-up.

## Local checks

From a trusted checkout:

```sh
deno run --no-config --allow-read scripts/authoring/validate.ts issue draft.md
deno run --no-config --allow-read scripts/authoring/validate.ts epic epic.md
deno run --no-config --allow-read scripts/authoring/validate.ts pr pr.md
deno run --no-config --allow-read scripts/authoring/validate.ts review verdict.md
pnpm test:unit -- tests/unit/authoring_test.ts
```

The validator checks required sections, duplicate/missing headings, unfinished
placeholders, concrete checkboxes/acceptance, a useful structural-view shape and
the length limits above.
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
