# Verifier-line clobber check

**Status: proposed.** No validator change has landed. This is the design for a
check on pull request body edits; the next docs-PR implements it.

A follow-up to the `a-pr-reference-is-not-a-work-item` learning
(`learnings/a-pr-reference-is-not-a-work-item.xml`), same family: the body is a
shared surface.

## Why it exists

A pull request body is a shared surface. Any seat can rewrite any line, and
GitHub keeps no record: `validate.ts` reads only the current body and discards
the seat attribution at line 415 (`/^\s*\([^)]*\)/`), and a body edit produces
no timeline event and no revision content (verified on #569: events were
`closed,
commented, committed, head_ref_deleted, merged, renamed` and nothing
else).

Two incidents, same shape, opposite directions:

1. dev-agx1's script overwrote **other seats'** verifier lines, twice.
2. dev-web re-labelled **design-ux's** line on #568 to `758b95a00` before her
   review — the same seat, a different claim, no new verdict from that seat.

Incident 2 is the one a naive design misses, and it is the reason this draft has
a corroboration step rather than only a seat-change comparison.

## The check

Because nothing survives in the API, the check keeps its own snapshot.

### 1. The attribution becomes load-bearing

A verifier line must carry a literal seat name:

    - [x] Backend verified (reviewer): <claim>

Today this position is optional and discarded. It becomes required and read.

### 2. The ledger

After each clean run the validator writes a ledger — a machine-readable PR
comment (`<!-- bakery-authoring-ledger -->` with a JSON body) keyed by PR:

    { item, seat, claimHash, sha, firstSeenAt, lastSeenAt }

`claimHash` covers everything after the attribution, including any SHA the claim
names, because a re-label is usually a SHA change with the prose untouched.

### 3. Comparison on the next run

Per ledger entry, against the current body:

| item    | seat        | claimHash   | corroboration                           | verdict                                  |
| ------- | ----------- | ----------- | --------------------------------------- | ---------------------------------------- |
| same    | same        | same        | —                                       | unchanged                                |
| same    | same        | **differs** | verdict from that seat at/after new SHA | the seat revised its own claim — allowed |
| same    | same        | **differs** | **no such verdict**                     | **FLAG: unowned re-label**               |
| same    | **differs** | any         | —                                       | **FLAG: another seat took the line**     |
| missing | —           | —           | —                                       | **FLAG: line deleted**                   |
| new     | any         | —           | —                                       | append; reviewable as a diff             |

The third row is the second incident, and without it the check is blind to
tonight-twice.

### 4. A flag is an error, not a warning

- `Verification: the "<item>" line is attributed to <seat> but its claim changed
  and <seat> posted no verdict at <sha>; a body edit re-labelled another seat's
  claim.`
- `Verification: the "<item>" line was written by <seatA> and is now attributed
  to <seatB>.`

## Enforcement note

The validator already runs in CI (`scripts/authoring/github.ts check pr` in the
`pull-request` job). The ledger's write point is that validator's **clean-run
hook**: after `errors` is empty, upsert the ledger comment. Two consequences,
both deliberate:

- **The ledger is written only on a clean run, so a red run never advances the
  snapshot.** If a clobber also breaks a rule, the ledger keeps the pre-clobber
  state and the next green run flags the change.
- **The check cannot run locally against a fresh clone** — it needs the PR's
  ledger comment. Local `validate.ts` keeps working unchanged; the ledger step
  is additive, gated on a token and a PR number.

Idempotence: the ledger comment is upserted by its HTML marker, so repeated
clean runs update rather than append.

## Corroboration has a hard limit, and it is not a small one

**All seats share one GitHub account** (`Triippz` — verified on #568, where
every comment has the same author). So a verdict's seat is _claimed in prose_
(`## UX sign-off`, `## QA verdict @ <sha>`, `Verdict: Approve` / `Head: …`),
never proven by authorship. Consequences:

- The ledger parses the seat and SHA from the comment convention, not from
  `user.login`.
- A clobberer who also writes a plausible verdict comment defeats the check.
  That is a different act — writing a false verdict — not a silent re-label, so
  it is outside this check's aim, but it must be stated rather than implied.

## What this does NOT cover

- **First-run blindness.** A clobber before the first snapshot is undetectable.
- **Same-seat weakening with a real verdict.** If a seat genuinely re-reviews
  and weakens its own claim, the corroboration exists and the change passes.
  Claim _strength_ is a different check.
- **Silent no-op rewrites.** A wholesale rewrite that preserves item, seat,
  claim and hash verbatim is indistinguishable from no edit — correctly, because
  nothing was lost.
- **Who edited.** Only that a line changed hands. The API records no editor.
- **Verdict-comment forgery**, as above.
- **Title-only edits.** The rail reads the PR title; this check reads the body.
- **Anything outside the verification checklist.** Purpose, evidence and change
  outline are prose and are not snapshotted.
