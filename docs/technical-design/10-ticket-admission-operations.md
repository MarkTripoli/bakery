# Ticket admission operations

Bakery turns a labeled GitHub issue into at most one task and, when the source
policy allows it, one fixed-coding run. This chapter describes the operations of
ticket admission: what an administrator sets when configuring a ticket source,
and what an operator reads to learn why an issue was or was not admitted. The
records and API it runs on are in
[tickets, records and API contract](10-tickets.md#ticket-records-and-api-contract).
The GitHub webhook receipt and the reconciliation sweep that feeds the poll are
in [webhook intake](09-integrations.md#4-webhook-intake).

Fixtures, not live GitHub, back all of this. No GitHub App was connected when it
was built, so the connected GitHub acceptance gate (G3) is still open: the
[live checks](#live-checks) below have not run.

## What admission is

Every path ends in one function. `admitTicket` admits an issue that owns no
request, and `recheckTicket` re-judges the one that does. Both read GitHub first
with no database transaction open, then re-verify the source's authority, the
issue's update marker and the acting user under row locks. A GitHub answer is
evidence about one moment, never a grant.

| Path                    | Trigger                                                                                                                     | Acts as                                             | Stored `origin`                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `ticketRequests.create` | A person calls `POST /v1/external-tickets/{id}/requests`.                                                                   | The caller, who needs `task:write` and `run:write`. | `adoption` when the issue carries a request label, else `manual` |
| Signed webhook          | A verified `issues` delivery reaches the function `bakery-ticket-intake`.                                                   | The source's delegation principal.                  | `webhook`                                                        |
| Poll                    | The function `bakery-ticket-poll` runs every five minutes (`*/5 * * * *`). `ticketSources.sync` runs the same step by hand. | The source's delegation principal.                  | `poll`                                                           |

Webhook and poll admit only a label applied by an allowlisted GitHub user who
holds repository role `write` or `admin`, at or after the source's
`automatic.since`. A label applied earlier, or while automatic admission is off,
waits as `adoption_required` until a person adopts the issue with
`ticketRequests.create`. A label applied by a user who is not allowlisted, or
who lacks the role, waits with the matching `actor_*` reason. Neither path
starts anything from a label that existed before the source was switched on.

A new request starts `waiting`. A `start` intent under
`approval.plan: automatic` creates the run in the same transaction and moves to
`admitted`. A `start` under `human_approval` stays `waiting` until an approved
plan exists, and the next recheck starts the run. A `plan` intent never starts a
run. `waiting`, `admitted`, `active` and `suspended` hold the ticket's one slot
(`ticket_requests_one_nonterminal_idx`). `rejected`, `completed`, `failed` and
`canceled` end the request and free the slot, and the next admission is
generation N+1 with a new task.

## Source policy

An Admin creates a source with `ticketSources.create` and changes it with
`ticketSources.update` (`If-Match` with the source `version`). The policy is
strict data: no expression, no URL.

| Field                                                    | Meaning                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels.execute` (`ready for agent`)                     | Asks for `start`. It also covers planning.                                                                                                                                                  |
| `labels.planOnly` (`ready for planning`, or `null`)      | Asks for `plan`.                                                                                                                                                                            |
| `labels.hold` (`bakery:hold`)                            | Wins over every other label: nothing is admitted and a request suspends.                                                                                                                    |
| `delegation` (`null` or `{principalId, githubActorIds}`) | The Bakery principal that webhook and poll act as, and up to 25 GitHub user ids (decimal strings, not logins) whose label applications may trigger it. `null` means no automatic admission. |
| `automatic.enabled`, `automatic.since`                   | The switch and the instant before which a label application does not qualify.                                                                                                               |
| `readiness.requireAcceptanceCriteria` (`true`)           | The body needs an `Acceptance criteria` heading with at least one list item under it. Code fences and HTML comments do not count.                                                           |
| `approval.plan` (`human_approval`)                       | `automatic` or `human_approval`.                                                                                                                                                            |
| `preset`                                                 | Always `fixed-coding`.                                                                                                                                                                      |

Label names are GitHub display names, 1 to 50 characters, trimmed, matched
exactly and case-sensitively. The three labels must differ.

`delegation.principalId` must belong to the organization when the policy is
written (422 `delegation_principal_unknown`). Its `task:write` and `run:write`
are checked live on every admission.

**`automatic.since`.** The server stamps it; a value a client sends is ignored.

- It is set to now when a source is created with `automatic.enabled`, and again
  on every false-to-true flip of `automatic.enabled`. It stays while the switch
  stays on and is `null` while it is off.
- Enabling a disabled source whose policy has `automatic.enabled` set restamps
  it to now and advances `policy_revision`, so an issue labeled while the source
  was off waits for adoption. That update also re-checks that the delegation
  principal still belongs to the organization. If it left, send a replacement
  `delegation` in the same `PATCH`, or the answer is 422
  `delegation_principal_unknown`. The check covers membership only.

A changed policy advances `policy_revision`. `ticketRequests.create` and
`ticketReadiness.create` carry `expectedSourcePolicyRevision` and answer 412
after a change. A request keeps the origin, principal, authority evidence and
label basis it was admitted with, and its pinned preset and requirements digest
until a person re-pins it. Everything else in the policy is read live on every
recheck: label names, the allowlist, whether a delegation exists, the acceptance
rule and the automatic window (which gates only new admissions).

## Readiness reasons

A readiness report holds up to twelve checks, in this order: `source_live`,
`ticket_supported`, `not_held`, `intent_authorized`, `epic_excluded`,
`acceptance_present`, `dependencies_satisfied`, `no_active_admission`,
`repository_ready`, `preset_ready`, `authority_live`, `requirements_unchanged`.
Each is `pass`, `wait` (can clear by itself) or `reject` (needs a decision). The
verdict is `ready` only when all pass, `rejected` when any rejects, else
`waiting`. A request suspends on the reason of the first check that did not
pass.

**Auto-resumable.** A recheck resumes the request when the condition clears.

| Reason                                                                        | Check                    | What it means                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `held`                                                                        | `not_held`               | The hold label is on the issue.                                                                                                                  |
| `label_missing`                                                               | `intent_authorized`      | No request label, and no request exists yet.                                                                                                     |
| `label_withdrawn`                                                             | `intent_authorized`      | The request label was removed from an issue that has a request.                                                                                  |
| `predecessor_open`                                                            | `dependencies_satisfied` | A native blocker is still open.                                                                                                                  |
| `closed_unmerged`                                                             | `dependencies_satisfied` | A blocker closed without a pull request merged into the default branch.                                                                          |
| `proof_unavailable`                                                           | `dependencies_satisfied` | The merge proof of a blocker could not be established (event or pull request pages incomplete, closing event missing, blocker identity changed). |
| `inaccessible`                                                                | `dependencies_satisfied` | A blocker is in another repository, or is gone or moved. The read token reaches only the source repository.                                      |
| `links_truncated`                                                             | `dependencies_satisfied` | The blocker list was cut, or GitHub did not report the blocker or sub-issue count. Unknown is never read as zero.                                |
| `provider_unavailable`                                                        | most checks              | A GitHub read gave no answer: rate limit, timeout, error, lost token. The evidence names `provider:<reason>`.                                    |
| `no_delegation`                                                               | `authority_live`         | The source policy has no delegation.                                                                                                             |
| `actor_not_allowlisted`                                                       | `authority_live`         | The user who applied the label is not in `githubActorIds`.                                                                                       |
| `actor_role_insufficient`                                                     | `authority_live`         | That user's repository permission is `read` or `none`.                                                                                           |
| `actor_unverifiable`                                                          | `authority_live`         | Who applied the label, or their role, cannot be established: deleted account, incomplete event pages, user id mismatch, no role answer.          |
| `principal_inactive`                                                          | `authority_live`         | The acting principal does not hold `task:write` and `run:write` now.                                                                             |
| `source_disabled`                                                             | `source_live`            | `ticket_sources.enabled` is false. Automation does not record it for a request that exists: see [Disabling a source](#disabling-a-source).       |
| `connection_not_enabled`, `installation_not_enabled`, `resource_not_selected` | `source_live`            | The connection is disabled, the installation suspended or removed, or the repository deselected.                                                 |
| `repository_archived`, `no_active_profile`                                    | `repository_ready`       | The Bakery repository is archived or has no active profile.                                                                                      |
| `preset_setup_required`                                                       | `preset_ready`           | The fixed preset cannot start a run here yet.                                                                                                    |

**Explicit-only.** A recheck never resumes these. A person re-evaluates the
request with `ticketRequests.create`. A different reason found later never
replaces a stored one of this kind (rule 4 under
[Suspension and resume](#suspension-and-resume)), so a hold label that returns
after the ticket closed does not make the request resumable.

| Reason                                           | Status   | What it means                                                                                |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `acceptance_changed`                             | `wait`   | The requirements digest differs from the pinned one, or the acceptance criteria disappeared. |
| `ticket_closed`, `ticket_gone`, `ticket_moved`   | `reject` | The issue is closed, deleted, or transferred.                                                |
| `pull_request_not_ticket`, `repository_mismatch` | `reject` | The number is a pull request, or the issue is in another repository.                         |
| `requirements_too_large`, `has_sub_issues`       | `reject` | The body exceeds 65,536 code points, or the issue is an epic.                                |

**Never suspend a request.** `ok` marks a pass. `acceptance_missing`,
`active_request` and `adoption_required` appear only before a request exists. A
request that loses its acceptance criteria records `acceptance_changed`.

## Suspension and resume

On every recheck the first rule that applies wins:

1. A request ends when its run ends (`run_completed`, `run_failed`,
   `run_canceled`). Without a finished run it ends when its task is `completed`,
   `failed` or `canceled` (`task_*`).
2. Not ready and not suspended: suspend with the first failing reason.
3. Suspended, ready, requirements pin checked and the reason auto-resumable:
   resume to `waiting` (no run), `admitted` (run queued) or `active`.
4. Suspended, not ready, and the first failing reason differs from the stored
   one: record the new reason, unless the stored reason is explicit-only, which
   is never replaced.
5. Suspended and the request owns a run with no pause mark: pause.
6. Ready, `waiting`, `start` intent and an approved plan available: start the
   run.

A suspension keeps the task, the link, the run and every report. While it lasts,
`runs.create` on the task answers 409 `ticket_request_suspended`. A request that
owns a run is also paused when the run has a live attempt on a worker whose
adapter supports pause; `pause_requested_at` is set only when a command was
queued, and a pass that could not queue one looks again.

A recheck runs for a ticket's request on every poll step that reaches it, and on
every `issues` delivery for the issue. Explicit-only reasons clear when a person
with `task:write` and `run:write` calls `ticketRequests.create` again for the
ticket with the current `requirementsDigest`. If that digest differs from the
pinned one the request is re-pinned: the task text is rewritten from the new
snapshot and the request returns to `waiting`. A request that owns a run refuses
with 409 `ticket_request_has_run`, and one whose task holds an unused plan
approval refuses with 409 `ticket_request_has_approval`. A request admitted on a
label stays on it: a withdrawn label keeps it suspended.

### Decision D1: explicit resume of an authority suspension

The reasons `principal_inactive`, `actor_not_allowlisted`,
`actor_role_insufficient`, `no_delegation` and `actor_unverifiable` suspend an
automatic request because the authority it was admitted under is no longer live.
`ticketRequests.create` on such a request judges the caller's authority only.
The request keeps its recorded principal, origin and authority evidence. They
have no update grant (`0145_ticket_admission.sql:290-294`), and no operation
re-assigns them. The next poll or webhook recheck judges the recorded principal
again (`recordedContext`). An explicit resume of an automatic request suspended
for one of these reasons therefore lasts only until the next recheck. This fails
closed: no automatic run starts while the recorded authority is not live.

Worked case, `principal_inactive`. A source delegates to principal P and
requires human plan approval. The poll admitted issue #42 as generation 1
(`origin` `poll`, `authority_principal_id` P, `waiting`). P then left the
organization.

1. The next poll or webhook recheck suspends the request. Run query 4 below:
   `disposition` is `suspended` and `disposition_reason` is
   `principal_inactive`.
2. An administrator calls `ticketRequests.create`. The answer is the same
   request, now `waiting` with a null `dispositionReason` (a request that owns a
   run becomes `admitted` or `active`, and no run is started). Query 4 shows
   `authority_principal_id` still P and `origin` still `poll`.
3. The next recheck judges P again, finds P inactive and suspends the request
   with `principal_inactive` again. A request with a run is paused in that pass
   too, when its run has a live attempt on a worker whose adapter supports
   pause.

Recovery. Restore the recorded principal (membership and a role with
`task:write` and `run:write`), or the allowlist entry or role the recorded actor
needs. The next recheck resumes the request with no explicit call. A changed
`delegation.principalId` on the source does not reach an existing request,
because `recordedContext` judges `authority_principal_id`. A changed allowlist,
or a delegation set again after `no_delegation`, does reach it, because the
policy is read live.

If P is gone for good and the ticket should admit again, the request has to end.
A request ends when its run ends (`runs.control` cancel makes the run and its
task `canceled`) or, with no finished run, when its task is `completed`,
`failed` or `canceled` (`terminalOutcome`). The next recheck then records the
terminal disposition and frees the slot. Until then the nonterminal request
blocks the ticket through `ticket_requests_one_nonterminal_idx`. This release
has no operation that cancels a task that has no run (`tasks.update` changes
title, description, priority and planning-only only), so for such a request
restoring P is the supported exit. After the request has ended, the next poll
admits a new generation only if the source's delegation principal is live,
because a new admission judges the source's principal, not P. Query 4 shows the
ended generation and any new one.

### Disabling a source

Disabling a source stops automation for it and leaves what exists as it is. The
intake and the poll list only enabled sources, and `ticketSources.sync` refuses
a disabled one with 409 `source_disabled`, so no automatic recheck reaches its
requests. They are not suspended under `source_disabled`, and their runs are not
paused. A step that was already running when the source was disabled judges it
under its lock and can still record the reason. Otherwise a person's
`ticketRequests.create` is the only caller that records it: a repeat call on a
request a person admitted (origin `manual` or `adoption`) suspends it, and a
call on a request the automation admitted does not record it.

No automatic run starts for the source, because starting needs a recheck. To
stop a run that is already executing, pause or cancel it with `runs.control`.
Enabling the source again restamps the automatic window, and the next poll
rechecks its requests.

## Inspect with SQL

These read-only queries need database access. Replace the angle-bracket values.
`external_tickets.number` is text.

```sql
-- 1. Sources: health, automatic window, poll position and rate-limit wait.
select id, external_container_id, enabled, policy_revision, sync_health,
       last_synced_at, last_problem_code, policy -> 'automatic' as automatic,
       sync_checkpoint ->> 'attemptedAt' as last_attempt,
       sync_checkpoint ->> 'notBefore' as not_before,
       sync_checkpoint -> 'failure' as held_behind
  from bakery.ticket_sources order by created_at desc;

-- 2. Tickets of one source with the verdict of the newest report.
select t.number, t.state, t.last_observed_at, r.version as report, r.verdict,
       r.origin, r.evaluated_at
  from bakery.external_tickets t
  left join lateral (
    select * from bakery.ticket_readiness_reports
     where external_ticket_id = t.id order by version desc limit 1) r on true
 where t.ticket_source_id = '<source id>'
 order by t.number::int desc limit 50;

-- 3. Why a ticket is not ready: the failing checks of its reports, newest first.
select r.version, r.verdict, r.origin, r.evaluated_at, c ->> 'id' as check_id,
       c ->> 'status' as status, c ->> 'reason' as reason
  from bakery.external_tickets t
  join bakery.ticket_readiness_reports r on r.external_ticket_id = t.id
 cross join lateral jsonb_array_elements(r.checks) c
 where t.ticket_source_id = '<source id>' and t.number = '<issue number>'
   and c ->> 'status' <> 'pass'
 order by r.version desc, check_id limit 20;

-- 4. Requests of one ticket, newest generation first.
select r.id, r.generation, r.origin, r.intent, r.disposition,
       r.disposition_reason, r.workflow_run_id, r.pause_requested_at,
       r.authority_principal_id, r.authority_evidence ->> 'labelBasis' as basis,
       r.updated_at
  from bakery.ticket_requests r
  join bakery.external_tickets t on t.id = r.external_ticket_id
 where t.ticket_source_id = '<source id>' and t.number = '<issue number>'
 order by r.generation desc;

-- 5. Every suspended request, oldest first.
select t.ticket_source_id, t.number, r.generation, r.disposition_reason,
       r.workflow_run_id, r.updated_at
  from bakery.ticket_requests r
  join bakery.external_tickets t on t.id = r.external_ticket_id
 where r.disposition = 'suspended' order by r.updated_at;

-- 6. What happened to one request.
select created_at, operation, details ->> 'reason' as reason,
       details ->> 'disposition' as disposition
  from bakery.audit_events
 where resource_type = 'ticket_request' and resource_id = '<request id>'
 order by created_at;
```

`ticket_readiness_reports` is insert-only: a report is stored only when its
basis digest changed, so a repeat of the same verdict adds no row. The API shows
the newest report and the nonterminal request on `externalTickets.get`
(`latestReadiness`, `activeRequest`). The source projection omits
`sync_checkpoint`, so `attemptedAt` and `notBefore` are visible only in query 1.

## Sync behavior

One step looks at a bounded set of issue numbers of one source. The poll runs a
step for every enabled source that is not waiting out a rate limit, up to 100
sources per run, with 25 candidates each. The order is the instant of the
source's last attempt (`attemptedAt` in `sync_checkpoint`, stamped by every step
that writes, including one that stopped on lost authority), oldest first, then
the last completed sync, then the id. A source with no valid `attemptedAt`
counts as never attempted. A source that keeps stopping therefore does not hold
the front of the list and starve the sources behind it. `ticketSources.sync`
runs the same step with 10 candidates, because the registry runner reads them
before its transaction opens. `ticketSources.preview` records a snapshot and a
report for up to 25 open issues, one page, and admits nothing.

- **Candidates.** New issues come from the fact index that the
  [reconciliation sweep](09-integrations.md#4-webhook-intake) keeps, in
  provider-update order after the checkpoint. They get at most
  `max(1, floor(0.4 * limit))` slots, 10 of 25 and 4 of 10, so a long list of
  old requests cannot starve new issues. Known work takes the rest: tickets that
  own a nonterminal request, and tickets whose newest report is `waiting` while
  the snapshot still carries a request label and no hold label. Known work is
  taken in `number::int` order after a rotation cursor and wraps, so every one
  is reached within a few steps.
- **Dispatch.** A ticket that owns a request is rechecked. Any other ticket
  whose live labels carry a request label is admitted with origin `poll`.
  Everything else is left alone. Absence is never read as an answer: a number
  missing from the fact index closes and suspends nothing. An issue that GitHub
  reports gone, moved or closed is an answer: the recheck suspends its request
  under `ticket_gone`, `ticket_moved` or `ticket_closed`. A gone issue that owns
  no request is left alone.
- **Failures.** A failed new issue holds the checkpoint behind it and is read
  again. After 3 consecutive steps that fail on the same number with the same
  code, the checkpoint moves past it. A failure of the provider itself (timeout
  or error, not a fault of the issue) counts to 288, a day of five-minute polls,
  so an outage loses no new issue. `labels_truncated` counts to 3.
- **Unexpected error.** A step that dies on an unexpected error (a programming
  error, not a provider or policy fault) is recorded, not retried inside the
  same run: the source gets `sync_health` `degraded`, `last_problem_code`
  `internal` and a fresh `attemptedAt`; `last_synced_at` stays as it was and the
  poll goes on to the next source. A source stored as `auth_required` keeps that
  health and its problem code, because lost authority needs a person; the defect
  then shows only in the step output and the log line. The checkpoint, the
  rotation cursor and the failure counter never move, so each run starts at the
  same candidates and dies at the same issue: a defect stalls the rest of that
  source's candidates until the bug is fixed. Other sources are unaffected. The
  function's step output carries the error class as `errorName` and the issue
  number of the failing candidate as `candidateNumber` (absent when the error
  came from no candidate), and the server log has one `ticket_poll_step_defect`
  line with the source id, the code, the class name and the same
  `candidateNumber`. The message is deliberately not recorded, because it can
  hold issue text. Read `internal` as a bug to report, not a provider state, and
  start from the issue the line names. The source moves on again on the first
  run that completes cleanly after the fix.
- **Refusal.** A step can end before its first write with a refusal, a standard
  error that the step throws instead of a result. These are examples, not a
  closed list: the stored policy no longer parses
  (`ticket_source_policy_invalid`), the source's connection or resource row is
  missing (`resource_not_found`), or the stored `marker` is not a date
  (`validation_failed`). The step is a `failed` outcome with no health. If the
  source row still exists, the poll records the refusal in `last_problem_code`
  and stamps `attemptedAt`, so the source takes its turn behind the rest and
  does not hold the front of every run. `sync_health`, `last_synced_at`,
  `version` and `policy_revision` stay as they were. The rest of the checkpoint
  stays too when it is an object; a checkpoint that is not an object is replaced
  by the empty one plus the stamp. A source stored as `auth_required` keeps its
  problem code. The source still needs an operator. Its turn comes round and it
  is refused again, and the stamp moves. `ticketSources.get` shows the stored
  policy as it is, but `ticketSources.update` reads it under the current schema
  and refuses the same way, so the fix for a policy is an edit of the `policy`
  column in the database. A missing connection or resource cannot come from the
  API, because foreign keys hold both; it means a database edit bypassed them.
  If the write itself fails, the outcome is the same and the server log has one
  `ticket_poll_refusal_unrecorded` line with the source id, the code and the
  error class; the source then keeps the front until the write works. A
  credentials problem is not a refusal: credentials that are missing, do not
  match the installation or cannot be decrypted fail the read as a provider
  error, and the candidate reports `provider_unavailable`, as in an outage.
- **Corrupt checkpoint.** A stored `notBefore` that is not exactly an ISO
  instant with milliseconds and `Z` is treated as corrupt: the source is still
  listed, and its next step reads the whole checkpoint as empty (the fact
  position, the rotation cursor and the failure count are lost, so it walks the
  fact index again) and rewrites it. A stored `attemptedAt` that is not that
  shape, or not text, only counts as never attempted in the poll order; the
  position stays and the next step restamps it. Only manual edits of the column
  can cause either. A stored `marker` that is not a date is a different case:
  the checkpoint schema does not check it, so the checkpoint is kept as it is,
  every step refuses the source with `validation_failed` (see Refusal), and it
  stays refused until someone corrects the `marker` in the column.
- **Rate limit.** A rate-limited read stops the step, leaves the remaining
  candidates for the next step and sets `sync_health` to `degraded`,
  `last_problem_code` to `rate_limited` and `notBefore` in `sync_checkpoint` to
  now plus GitHub's wait (60 seconds when it names none, at most one hour).
  While `notBefore` is in the future the step reads nothing, and
  `ticketSources.sync` answers a `failed` receipt. A `forbidden` read (a token
  permission GitHub no longer grants, or lost authority over the source) stops
  the step and sets `sync_health` `auth_required`. The next step that completes
  cleanly sets `healthy`.
- The step writes only the source's checkpoint, health, last-sync time and
  problem code, never `version` or `policy_revision`, so a poll never refuses an
  administrator's `If-Match` update.

## API behavior

| Operation                                              | Role                                                  |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `ticketSources.create`, `.update`, `.preview`, `.sync` | Admin                                                 |
| `ticketSources.get`, `.list`                           | Developer. A Viewer or Guest gets 404.                |
| `externalTickets.get`, `.list`                         | Developer, and a Viewer reads them                    |
| `ticketReadiness.create`, `ticketTaskLinks.create`     | Developer                                             |
| `ticketRequests.create`                                | Developer who also holds `task:write` and `run:write` |

The Viewer role cannot read ticket sources because `ticketSource:read` is in
`viewerPermissionExclusions`: a source policy shows which principal Bakery acts
as and which GitHub users may trigger it. The catalog gives `ticketSources.get`
and `.list` Developer access.

When `ticketRequests.create` admits nothing it answers from the first check that
did not pass:

| Answer                   | When                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 409 `ticket_not_ready`   | `issues` lists the failing checks, at most 20, as `{path: ["checks", "<check id>"], code: "<reason>", message}`.            |
| 409 `labels_truncated`   | The issue has more than the 50 labels Bakery reads, so a hold or request label may be cut. Retrying cannot change it.       |
| 503, `retryAfterSeconds` | A GitHub read gave no answer, a rate limit among them. Retry after the wait (1 to 3600 seconds).                            |
| 412                      | `expectedSourcePolicyRevision` is stale, or `requirementsDigest` is not the stored digest. Read the source or ticket again. |

`ticketReadiness.create` never answers `ticket_not_ready`: it records the
report, a failed read included (`provider_unavailable`), and returns a
`completed` receipt, or 412 for a stale revision. `runs.create` on a task whose
request is suspended answers 409 `ticket_request_suspended`.

`ticketRequests.create` records nothing when the ticket is not ready. The
reports that explain a refusal come from `ticketReadiness.create`, rechecks and
automation.

## Known limits

- The label authorizes the issue text as it stood when the label was applied.
  GitHub REST exposes no body-edit history, so Bakery cannot tell whether the
  body changed between labeling and admission. It pins the text it reads at
  admission, and only later edits are detected (`acceptance_changed`).
- Request-level suspension stops the next `runs.create`. It does not stop a run
  that is already executing unless that run has a live attempt on a worker whose
  adapter can pause. The later stages that review, merge and deploy (#94, #97,
  #101) must re-read the request's disposition before they act.
- An explicit resume of a request suspended for an authority reason lasts until
  the next recheck (decision D1 above).
- Disabling a source does not suspend its requests or pause their runs (see
  [Disabling a source](#disabling-a-source)). Pause a run with `runs.control`.
- Label identity is by display name. A label renamed on GitHub changes what the
  policy means.
- GitHub documents no order for issue events. The reader sorts them by time and
  id, walks at most 5 pages of 100, and fails closed beyond that.
- The API shows only a ticket's nonterminal request, so earlier generations are
  read in the database. No operation cancels a task that has no run.

## Live checks

None of the seven checks that settle the connected GitHub acceptance gate (G3)
has run live. The fixture GitHub (`tests/helpers/fake-github-app.ts`) proves
what Bakery does with the shapes it was written against, but not that GitHub
answers with them. The checks are in
`learnings/ticket-admission-g3-live-checks.xml`. Record each result with the
date and the repository used.
