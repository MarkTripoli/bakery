---
name: bakery-authoring
description: Create or revise Bakery GitHub issues and pull request descriptions using repository templates, native relationships, focused show-me visuals and the shared description validator.
---

# Bakery GitHub authoring

Read the relevant canonical template from the repository root:

- Work item: `.github/ISSUE_TEMPLATE/work-item.yml`.
- Epic: `.github/ISSUE_TEMPLATE/epic.yml`.
- PR: `.github/pull_request_template.md`.

The validator is `scripts/authoring/validate.ts`; policy and commands are in
`.github/AUTHORING.md`. Do not maintain a local copy of the issue queue or
reproduce a second template in this skill.

## Issues

Match the template's section labels using Markdown headings. The validator also
accepts the established bold inline Execution classification and Dependencies
fields. Keep one bounded outcome, concrete deliverables, Given/When/Then
acceptance, actual owners, design/input references and evidence-based closure.
AFK/HITL describes the workflow, not permission to start.

Before creating, inspect existing issues for the same outcome. Preserve existing
scope when revising. Use native parent and blocked-by links as well as readable
references; re-read both after authorized publication. Use the repository's
existing status/type labels. Preparation stays backlog; never apply ready for
agent unless execution was explicitly requested. Do not invent dependencies,
approval, passing checks or source links. Missing material decisions are
questions, not plausible guesses.

## Pull requests: show the change

Read the actual complete diff and relevant surrounding code. Start with the
`Ticket | Task | Walkthrough` metadata line, then Purpose, Risk, Special things
to note, Change outline, Decisions and Evidence; link the owning issue.

Write for an executive: the whole body is at most 300 words of prose, and each
section has its own limit (see "Write for an executive" in
`.github/AUTHORING.md`). Lead with what changed for the user and what could go
wrong. Do not turn the body into a changelog, narrate the work, paste test
logs or caption every screenshot. Name unverified behavior honestly, in one
bullet. Evidence is UI screenshots or a recording and the new tests, never
format, lint or type checks; `- None.` is fine.

Review and QA verdicts use the same rule: a `Verdict:` line, `Head: <sha>`, at
most five `[High|Medium|Low]` findings of at most 25 words each, an optional
check table, at most 150 words in all. Run `validate.ts review` on the draft
before posting it.

The Change outline is the core of the PR: a reader should understand the
design, the implementation and the design pattern without reading the code.
Use one to three views (at most 80 lines in total). Apply `$show-me` when
available. These portable rules preserve the requested style when that
user-level skill is absent on a worker:

- Existing structure changing: prefer one focused `diff` block.
- Mostly new ownership: a shallow file/component tree.
- Runtime behavior: pseudocode, a call tree or a small Mermaid flow/sequence.
- Data contract: the smallest relevant before/after or complete target shape.
- API or contract change: a `diff` of the signature, schema or payload.
- Name the design pattern when there is one, for example `Pattern: outbox`.
- Use real names; put one brief explanation beside the view. Omit irrelevant
  details and redundant views. Mermaid needs a readable title/description.
- A typo-only or similarly structure-free change may say
  `No structural change: ...` with a concrete reason. Do not force decoration.
- GitHub descriptions use inline Markdown. Do not create or upload HTML
  walkthroughs or screenshots unless requested or needed for actual UI evidence.

## Check and publish within the requested scope

Run
`deno run --no-config --allow-read scripts/authoring/validate.ts issue|epic|pr|review <draft.md>`
(or `-` for stdin) before publishing. For a live intake/merge decision, use the
trusted checkout's `scripts/authoring/github.ts check issue|pr <number>`
command, not a candidate-modified validator.

The structural check cannot judge design quality, factual evidence or approval.
Fix its findings, then review the content. Drafting does not authorize
publishing, starting agents, pushing, merging or changing protection; follow the
user's requested action and existing review/merge rules. Re-read current
metadata before acting and after authorized edits. Never auto-regrant execution
authority after a correction.
