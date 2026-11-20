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
Special things to note, Change outline, Decisions and Evidence. A
`## Evidence
@ <sha>` heading is accepted. Show the change's shape with one
useful diff, tree, pseudocode or Mermaid view, not a slideshow. A concrete
`No structural
change: ...` explanation is fine for a structure-free edit.
`Walkthrough: not requested` is honest metadata and does not mean verification
was skipped. A PR body may carry one `Head: <sha>` line directly under the
metadata line (the same line review verdicts use). The check ignores it; it is
not part of the Walkthrough value. The head the evidence belongs to is the
`@ <sha>` in the Evidence heading.

## Write for an executive

Descriptions and review verdicts are read by someone deciding, not studying.
Plain words, short sentences, no filler, no restating the diff. If a sentence
doesn't change a decision, cut it. The validator enforces:

| part                   | limit                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| whole PR description   | 300 words of prose (code, tables, links and comments don't count)                                                                                                                               |
| Purpose                | one sentence, at most 40 words                                                                                                                                                                  |
| Risk                   | `Level: Low`, `Medium` or `High`, then one to three bullets of at most 25 words: what could break, who it hits, how to roll back                                                                |
| Special things to note | one to four bullets of at most 25 words, or `- None.`                                                                                                                                           |
| Change outline         | one to three show-me views, 80 lines of view in all, plus at most 40 words of prose outside the views                                                                                           |
| Decisions              | one to three bullets of at most 30 words ("Chose X over Y because Z"), or `- None.`                                                                                                             |
| Evidence               | at most 60 words: UI screenshots or a recording (at most four images) and the new tests, one line each; no format, lint or type checks, which CI shows; `- None.` when there is nothing to show |

Review and QA verdict comments follow the same rule:

```markdown
Verdict: Approve | Changes requested | Blocked Head: `<sha>`

- [High] One finding: what is wrong and where.
- [Low] At most five findings, at most 25 words each.

| check                             | result               |
| --------------------------------- | -------------------- |
| new test `issue-settings_test.ts` | refuses a stale save |
```

At most 150 words of prose in all. No praise, no narration of what was read, no
repeating the PR description. Check a draft with
`validate.ts review <draft.md>`.

## Verification checklist (the merge gate)

Every PR ends with a Verification checklist. The author leaves it unticked; each
verifier ticks their own box during review, or replaces it with `N/A: <reason>`.
The description check stays red until every box is resolved, so a PR cannot
merge unverified.

| item                   | verifier  | checks                                                                                                                       |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Backend verified       | reviewer  | contracts, data, permissions and errors behave as described                                                                  |
| UI verified            | design-ux | no duplicate of an existing screen or component; fits the navigation; consistent patterns; desktop and phone, light and dark |
| Implementation clean   | reviewer  | follows existing patterns, no duplicated logic, no dead code, nothing outside the ticket                                     |
| Tests cover the change | qa        | new behavior has tests that fail without it                                                                                  |

Ticking a box is a claim: the verifier did the check at the PR head. A problem
found here is fixed in the same PR, not filed as a follow-up.

## Structured PR bodies (use this, do not hand-write the body)

A PR body is data, not prose to hand-format. Write a small JSON spec; the tool
renders the exact template, runs the real validator, and reports which field is
wrong before anything reaches GitHub. Wording, section order and limits come
from `validate.ts`, so they cannot drift.

```sh
P="deno run --allow-read --allow-run=gh --allow-env scripts/authoring/pr-body.ts"
$P example > spec.json                 # starter spec: edit the fields
$P render spec.json > body.md          # validated body; exit 1 names the field
$P publish spec.json --create --title "feat(x): ..."   # ready PR; add --draft for a draft
$P publish spec.json --pr 123          # update; keeps verifiers' ticks
$P verify ui --tick --sha <head> --claim "desktop and phone, light and dark" --pr 123
$P verify tests --na "Docs only; no behavior to test." --pr 123
$P verify backend --reset --pr 123     # head moved: reopen a stale tick
```

Add `--dry-run` to `publish` or `verify --pr` to print the new body without
editing the PR.

- The author writes the spec and never ticks a box. Open boxes are reported as
  `pending`, not as errors: pending means "awaiting sign-off", and the
  description check stays red on purpose until each verifier acts.
- `verify` changes exactly one line. It refuses a tick with no claim or no SHA,
  an N/A that means "not yet", a tick for a SHA that is no longer the PR head,
  and a write when the body changed while it ran. Re-read, then run it again.
- `publish --pr` carries ticked and N/A lines over from the live body, so a new
  push never erases a verifier's work. Set `evidence.head` to the new head SHA;
  a verifier then re-checks at that head with `verify --reset` then `--tick`.
- `closes: false` writes `Refs #n` for a slice so the issue stays open.

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
the length limits above. Headings in comments, code or quotations do not supply
required fields. It cannot establish truth, design quality, native dependency
completion or consent.

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
- Verification lines nobody has ticked yet are pending, not errors. The
  `verification` job (it writes nothing and needs no extra permission) is
  skipped while any line is open, and the `pull-request` job's run summary lists
  what is open; once every line is ticked or marked N/A it succeeds. A tick
  counts only when its `@ <sha>` is the PR head; a tick at an older commit, or
  with no commit, is open again, so an edit after a push cannot turn the job
  green. Only format errors fail `pull-request`.
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

Before merge, maintainers confirm that `Description policy / pull-request`, the
`Description policy / verification` job (success, not skipped) and
`Bakery CI / required / full-stack aggregate` passed on the exact PR head, and
review every change to workflows, CI policy, required jobs and credential
handling. A green CI run cannot independently certify edits to its own checks.

See
[GitHub issue form syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
and
[workflow event security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).
