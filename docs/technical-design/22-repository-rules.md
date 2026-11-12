# Repository rules and organization inheritance

Members need to configure how Bakery writes
code and prepares commits and pull/merge requests. Organization rules supply a
shared baseline for every repository in that Bakery organization, including
repositories connected later. This chapter owns the proposed rules contract;
the new storage, API and evidence fields still need catalog reconciliation and
runtime implementation. Existing repository profiles and delivery checks remain
the execution boundary.

## Where people configure rules

| Surface | Purpose |
| --- | --- |
| Organization → Repository rules | Configure defaults, lock requirements, preview affected repositories and publish a revision. This is organization administration, outside personal settings. |
| Application → Repository → Settings → Rules | Inspect the effective configuration, its organization source and repository overrides; customize allowed rules or restore inheritance. |
| Rule editor | Edit a typed preset, its enforcement and options; preview a title, commit, description or code example before saving. |
| Task delivery → Checks | See the failed rule, source, expected format, evidence and repair action. Show warnings, failures and unavailable checks separately. |

Admin publishes organization rules and repository profiles under the current
authorization model. Developers can read rules for their permitted repositories
and fix resulting findings; they cannot publish policy or bypass a lock. Future
custom roles may grant these operations explicitly, without adding a new role
model here. Repository reads expose only the inherited values needed for that
repository, not the organization directory or other repositories.

The editable [Paper mocks](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/Z-0)
extend the existing Bakery shell. [The manifest](repository-rules-mocks/paper-manifest.json)
indexes organization, repository and description-editor screens at desktop and
phone sizes. All identities, revisions and check results in those frames are
illustrative.

## First rules

Each rule has a stable key, enabled state, mode (`guide`, `warn`, `require`),
bounded typed options and an optional explanation. Organization entries also
specify whether repositories may override them. Free-text guidance cannot claim
deterministic enforcement. A disabled rule is distinct from an absent override.

| Rule key | Configuration and behavior |
| --- | --- |
| `commits.semantic` | Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), with configured types, optional/required scopes and subject-length limit. Preserve breaking-change syntax. Explicitly choose all introduced commits or the final squash commit; record treatment of merge/revert commits. Validate the selected range and the actual message Bakery will submit. |
| `changeRequest.semanticTitle` | Apply the configured type/scope/subject convention independently to PR/MR titles. “Titles” means pull/merge request titles here, not task or issue names. Example: `feat(api): add repository rules`. Recheck after external title edits. |
| `changeRequest.description` | Edit a Markdown template, required non-empty sections and writing guidance. Example sections: Summary, Changes, Validation. Optional sections can cover risks, screenshots or related issues. Preview with sample evidence. Required sections containing only template prompts/comments do not pass. Guidance about writing quality remains review evidence, not a parser claim. |
| `code.magicNumbers` | Require meaningful named constants for unexplained numeric literals in selected code paths. Configure the language/check binding, numeric allowlist and path exclusions. Examples distinguish a timeout with units from an array index. Named constant declarations are allowed. |
| `code.magicStrings` | Require named constants/enums for selected repeated domain values, statuses and protocol tokens. Configure language/check binding, AST contexts and explicit literal/path exceptions. Imports, user-facing prose and test data are not indiscriminately banned; their treatment is visible in the options. |

The Conventional Commits source defines message structure; Bakery's chosen type
list, length limits, commit range and reuse for PR/MR titles are configurable
product policy. Description preview never invents passing tests or evidence.
It can say “Not run” when that is the actual validation state.

Use the repository's existing lint/check command where it supports the selected
rule. Magic values need language-aware checks; searching every quoted string or
number is not a sufficient validator. `require` with no working checker is
**Unavailable — blocks delivery**, never a pass. Publication previews list
unsupported repositories so an Admin can adjust coverage or knowingly publish a
blocking requirement. No new general-purpose policy language or plugin runtime
is needed for these presets.

## Inheritance and publication

1. Resolve the latest published organization revision and the repository's
   active immutable profile in one consistent read. No organization revision
   means an empty baseline; rules are opt-in, not silently enabled on upgrade.
2. An absent repository entry inherits the organization entry. For an unlocked
   rule, an explicit repository entry replaces the complete typed entry; arrays
   and template sections never merge implicitly. A repository can add a rule
   absent from the organization baseline.
3. A locked organization entry always wins, including its options, exceptions
   and enforcement mode. The repository editor disables customization and
   explains who owns it. The server rejects attempts to replace or disable it.
   Rule settings cannot weaken Bakery's independent security or delivery gates.
4. “Restore organization rule” removes the repository override. Disabling an
   inherited unlocked rule instead creates an explicit disabled override. Show
   **Inherited**, **Repository override**, **Repository only**, or **Locked by
   organization** with source revision on every effective row.
5. If a new organization revision locks a previously overridden rule, the lock
   takes effect and the saved override becomes inactive. Preserve it in history
   and show it as superseded. If that lock is later removed, the saved override
   becomes effective again; the publish preview must identify that change.
6. Publish validates the draft, expected organization revision and expected
   repository profile together. A concurrent change returns a precondition
   failure and preserves the editor draft for comparison. Publication records
   the actor and before/after revision in the existing audit/event path. Restoring
   an earlier revision publishes a new revision; history stays immutable.

Organization publication applies to current and future repositories without
copying defaults into each profile. Its preview counts inherited, overridden,
newly locked and unsupported repositories using only authorized data. Preview
has no provider side effect. Saving repository rules publishes a profile
revision while retaining its other runtime/check configuration.

## Execution and enforcement

Resolve once through the shared server operation used by web, MCP, workflows
and worker preparation. Pin the organization revision, repository profile,
effective entries, provenance, checker versions and canonical digest in the run
snapshot. Feed those exact rules into implementation, repair, review and commit/
PR preparation. Repository `AGENTS.md`, imported skills and task prose may add
context but cannot disable published requirements or grant permissions.

| Mode | Runtime behavior |
| --- | --- |
| Guide | Include in agent context and review instructions; show that it is guidance. |
| Warn | Run the configured checker and retain findings; a failed/unavailable warning does not block delivery by itself. |
| Require | The authoritative checker must pass. Failed, skipped, errored or unavailable evidence blocks the relevant Bakery operation and merge. |

Commit validation runs before Bakery submits commits; title/description checks
run before it creates or updates a PR/MR and again at merge. Code checks run on
the candidate revision through the existing check runner. Reuse `check_runs`,
review findings and evidence artifacts, including rule key, checker/version,
source and safe diagnostics. There is no second check scheduler.

Delivery evidence binds head, base, effective policy digest, commit selection,
PR/MR title/body digest and final merge/squash message where applicable. Before
dispatch, re-read provider metadata and current effective rules. A changed head,
base, title, body, merge message or effective policy invalidates the affected
evidence even if the commit SHA stayed the same. An organization change that
does not alter effective rules is provenance-only and need not rerun checks.

An active run keeps its original snapshot for reproducibility. When current
requirements differ, delivery pauses with **Rules changed — revalidate**; a
linked continuation pins current rules and reruns affected checks/review without
editing the old snapshot or replaying confirmed effects. Recheck again at the
trusted effect broker before dispatch. Policy publication and effect admission
serialize their version checks; already dispatched effects are reconciled, not
retroactively undone. Existing bounded repair and budget limits still apply.

**Implemented by the run pinning slice:** repository-mode run admission
resolves the latest organization baseline against the pinned profile's overrides
in one statement and freezes `repositoryRules` (organization revision, profile
id and revision, entries with provenance, digest) inside the snapshot's
`repositoryProfile`, beside the fixed-policy pins. Every job of the run carries
that pin; claim-time admission and the worker recompute its digest and refuse a
mismatch, through the fixed-policy path and no second one. Admission never reads
rules again, so a later organization or profile revision, or a lock, only
affects runs admitted afterwards. Stored rules that fail their schema or digest
refuse admission with `STATE_CONFLICT repository_rules_unavailable`.

_Stage binding._ The design binds no rule key to a workflow stage by name; the
one binding it gives is the checker (`checkBinding`, a fixed-policy command id),
and "Code checks run on the candidate revision through the existing check
runner". So a `require` entry that is enabled and has a `checkBinding` needs a
`quality.check` stage that lists that command literally (matching the id
exactly) and runs after the last stage that changes the repository revision
(`harness.implement`, `harness.repair`). A stage with an `if` condition may
be skipped, and "Failed, skipped, errored or unavailable evidence blocks", so a
conditional check satisfies nothing. The design gives no order between a code
check and `delivery.*` stages (commit, title and description checks belong to
the delivery and effect-broker work), so none is enforced here. A workflow with no such stage has no
candidate revision to check (noop, freeform, cloud-only) and is not bound.
`commits.semantic` and the `changeRequest.*` keys bind to delivery and
effect-broker checks, which this slice does not touch. The guard binds three
places: workflow version publication and activation (organization baseline only,
since overrides are per repository and unknown at publication time; both take
the organization lock and read through the one org-bound reader) and run
admission (the pinned effective entries, so repository-only `require` rules bind
too). Refusal is `UNPROCESSABLE repository_rule_stage_missing` or
`repository_rule_stage_before_revision`, naming the rule key, with nothing
written. Admission evaluates only the run being admitted against the pin being
written; runs already admitted are never re-evaluated.

_Consequence to know._ In an organization with an enabled `require` rule that
has a `checkBinding`, the built-in `fixed-coding` preset (brief and implement,
no check stage) and any workflow version published or activated before the rule
existed are refused at run start until a workflow containing the check stage is
active. `ensurePresetWorkflowVersion` still inserts the preset version directly,
so the preset is held by the admission check and not by the publish guard; the
preset is deliberately not changed. A worker advertises `quality.check` only
when a coding harness repository is configured (see the deterministic checks
note below), so in an organization with a bound `require` rule a run whose
workers lack that setting stops at its check step and fails closed; with a
locked rule like that, coding work in that organization is blocked until one
worker is configured. Checker execution, the "Rules changed, revalidate"
continuation and pinning rules into workflow versions are not part of this
slice.

_Availability._ `GET /v1/workflow-presets?repositoryId=` evaluates the same pin
and the same stage check as admission and lists `required_check_missing` when a
bound `require` rule would refuse the preset. If the stored organization rules
are corrupt (unreadable, or a digest that does not match), it answers 409
`STATE_CONFLICT` `repository_rules_unavailable` (fail closed, as admission
does), not 200.

_Size._ The job input is bounded at 100,000 bytes and carries the profile config
and the pin. Organization publication therefore bounds the canonical entries to
32,000 UTF-8 bytes (`repository_rules_too_large`; control characters count as
their six-byte JSON escape), which leaves at least 30,000 bytes of the input for
everything else even with maximal overrides. Admission also checks job-input fit
for non-preset repository runs and names the pinned rules
(`repository_rules_too_large` at `repositoryRules`) when they alone exceed the
bound, so an oversized run is refused instead of being admitted and stuck.

_Rollout._ Server and workers must deploy together: the execution-context schema
is strict, so a worker built before this slice rejects repository jobs that
carry `repositoryRules` and fails closed. Roll workers out first or together
with the server. Runs queued before the deploy carry no pin; claim-time
admission treats an absent pin as the pre-pinning shape and verifies nothing
more for them, so they run under the rules they were admitted under (none),
which is what AC4 requires: no retroactive blocking or weakening. A rule
publication can commit between the pin read and the run commit; the guarantee is
that the snapshot holds exactly one published revision, consistent with its
digest, that was the latest at the pin read, not that it is still the latest at
commit.

**Implemented by the deterministic checks slice:** `quality.check` runs
fixed policy commands against the candidate commit and records every outcome as
an immutable `check_runs` row bound to the identities it was observed under.
Commit, title, description and merge-message rules are evaluated by a server
service from a trusted metadata snapshot. No scheduler is added: the rows are
evidence for the trusted aggregate and for delivery decisions, which read them
through `evaluateDeliveryChecks`. The independent review and bounded repair loop
(#94) is its production caller: `evaluateReviewedChecks` judges a reviewed
candidate's command checks with it when a review is recorded.
`evaluateDeliveryCandidate` is the merge gate that judges them again right
before a merge; its caller is the merge consumer (#97), so only tests call it
today. A failed required check is the evidence a
repair receives (see
[independent review and bounded repair](06-workflows-delivery-and-acceptance.md#independent-review-and-bounded-repair)).
The metadata checks (commit, title, description and merge message) still have no
production caller: a run has no pull request until #97. `GET
/v1/runs/{id}/checks` lists a run's rows (`check:read`); `failed` and
`unavailable` stay distinct in the list.

_Where a check runs._ A worker advertises `quality.check` only when a coding
harness repository is configured (`BAKERY_CODEX_HARNESS`,
`BAKERY_CLAUDE_HARNESS` or `BAKERY_PI_HARNESS` set to `1` with the matching
`_HARNESS_REPOSITORY`, in the environment of `scripts/run-worker.sh`; the
`pnpm start` wrapper's fixed list carries no harness setting; the per-command
deadline is that harness's `_HARNESS_TIME_LIMIT_MS`). The job's `revision` must be a full, lowercase
40-character commit id; admission and the worker both refuse a ref, so the
worker cannot choose what it tests. The worker adds a detached `git worktree`
of that commit to the configured operator repository under its private state
directory, proves `HEAD` equals the revision, runs the commands and removes the
worktree and the attempt root afterwards, on success, failure and cancel. Only
the `argv` of the fixed policy runs, never anything the job names. Each command
gets its own process group, a deadline, a 4 MiB combined output cap and a
closed environment: `PATH`, `DENO_DIR`, and an empty `HOME` and `TMPDIR` inside
the attempt root.

Time is bounded twice, by limits fixed in code (`CHECK_RUNNER_LIMITS` in
`apps/worker/src/check-runner.ts`) that a job cannot enlarge. The checkout has a
5 minute deadline. The whole attempt (checkout, tool probes and every command)
shares a 4 hour budget, and each command runs for the harness time limit or what
is left of the budget, whichever is shorter.

_What decides a result._ Process facts only. Exit 0 is `passed` with reason
`verified`; a non-zero exit is `failed/exit_nonzero`; a signal is
`failed/signal`; the deadline, including the end of the attempt budget while a
command runs, is `failed/deadline`; the output cap is `failed/output_limit`. Output text never changes a result, so a command that
prints `PASS` or forged JSON and then exits 1 is `failed`. The worker publishes
the redacted tail of both streams as a `check` artifact and reports its digest
as the row's evidence.

_Unavailable is not failed._ `unavailable` means no trustworthy observation
exists, and it blocks a required check exactly like `failed`. The reasons are
`tool_missing` (the executable does not resolve in the worktree or on the child
`PATH`), `revision_unavailable` (the commit is not in the operator repository,
or the checkout passed its deadline; it is a property of the whole attempt, so
it is the reason of every command in the report and wins over
`rule_binding_ambiguous` for a command two rules bind), `unsupported_checker`,
`rule_binding_ambiguous` and `skipped` from the worker. A worker reports
`skipped` for every check it had not started when the attempt budget ran out:
`unavailable`, no exit code, zero duration, and it blocks a required check like
any other missing evidence. The metadata service adds `metadata_missing`,
`metadata_too_large`, `rule_unbound`, `unsupported_checker` and `skipped` (a
merge or revert commit a rule exempts); the delivery verdict adds
`policy_missing` when no requirement reaches it. `pending` and `canceled` never
satisfy a required check either.

_Magic-value rules use an existing command._ There is no bundled checker. When
exactly one enabled pinned rule names a command in `checkBinding`, the worker
adds two variables to that command's environment and to no other:

| Variable | Value |
| --- | --- |
| `BAKERY_CHECK_RULE_KEY` | The rule key, `code.magicNumbers` or `code.magicStrings`. |
| `BAKERY_CHECK_RULE_OPTIONS` | Canonical JSON of that pinned entry's options (binding, allowlist, path exclusions). |

They are set together or not at all, and the command reads them to apply the
rule. The server holds the same single-binding rule: a row's `ruleKey` must be
the one enabled pinned rule bound to the command, or null. Two enabled rules
bound to one command are `unavailable/rule_binding_ambiguous` and nothing runs.
A bound executable whose name is a text-search tool (`grep`, `egrep`, `fgrep`,
`ggrep`, `rg`, `ag`, `ack`, `sed`, `gsed`, `awk`, `gawk`, `mawk`, `nawk`) is
`unavailable/unsupported_checker`: searching every quoted string or number is
not a language-aware check. An enabled magic-value rule with no binding records
`unavailable/rule_unbound`. An enabled rule that is bound also makes its command
a requirement, with the rule's mode, so a required bound rule blocks until that
command has run and passed; two rules bound to one command give one requirement
with the stricter mode. The fixed policy names the same command, so a caller
joins the two lists with `mergeRequirements` (one entry per kind and check id,
`require` over `warn` over `guide`) instead of judging the command twice.

_The server decides, not the worker._ The result transaction recomputes the
pins from the job's own stored input and verifies the report against them
before it writes anything. The observations must be exactly the selected
commands in input order; each reason must explain its result (a pass needs exit
0 and `verified`, an unavailable check carries no exit code); row ids must be
new; durations must fit the attempt window; and each evidence reference must be
an artifact version of the job's own step whose digest equals the observation's.
The server then derives `allRequired` and `failedCheckIds` from the fixed policy
decisions (a `require` command counts only as `passed`) and requires them, the
head, the base and the effective policy digest to equal what the worker
reported. Any difference answers `VALIDATION_FAILED` (`check_output_mismatch`,
`check_evidence_invalid` or `check_policy_missing`), rolls the report back to a
savepoint and leaves no row or step output, and the job, attempt and step stay
as they were. The identities in a row come from the server's pins; the worker
contributes only what a process can have observed. The accepted report is
audited as `delivery.checkRuns.record`. A refused report is audited under the
same operation with outcome `denied` and details `{ code, reason }`, so an
operator can tell which comparison failed; the problem body sent to the worker
carries the code only, and the audit entry holds no digest, id or worker text.

_What a row is bound to._ Every kind is bound to the head and the base, so a
changed head or base makes every recorded pass stale, and each kind is bound to
what it judges:

| Kind | Bound parts |
| --- | --- |
| `command` | head, base, profile, checker, subject (the fixed command and the rule entry bound to it) |
| `commits` | head, base, commit selection, subject (the rule entry) |
| `title` | head, base, title, subject |
| `description` | head, base, body, subject |
| `merge_message` | head, base, merge message, subject |

A part the current identity cannot supply counts as changed, so missing
information never keeps evidence fresh. The effective policy digest is stored on
every row but not compared: an unrelated rule change must not stale a title
check, and a changed command or rule entry reaches its own row through the
subject. An organization revision bump over equal entries changes nothing.
Only a pass can go stale. A row that recorded `failed`, `unavailable` or
`canceled` keeps that status when the candidate moves, so failures stay visible
and a metadata row that could not record a digest never reads as stale; a
required one blocks either way. `evaluateDeliveryChecks` reads the newest row
per check, blocks a `require` check that is not a fresh pass, and treats a
requirement with no row, or an empty requirement list, as blocking.

_Metadata reader port._ `CandidateMetadataReader.read(ref)` returns the commit
messages, title, body and merge message from a source the candidate cannot
write. No HTTP operation accepts a snapshot, because the caller would be
judged on text it supplied. A null or throwing reader, or a malformed snapshot,
records `unavailable/metadata_missing`. A snapshot over the preview bounds (20
commit messages, 2,000 characters each, a 300-character title, an 8,000-character
body) records `unavailable/metadata_too_large` and is never judged on a
truncated copy. A description that is empty, or equals the template once its
comments are removed and its whitespace is normalized (runs of spaces and tabs
collapse, blank lines and trailing space drop, line endings are unified), is
`failed/description_placeholder` even when the rule lists no sections. **Fixture versus live:** only fixture readers exist, in the
unit, integration and end-to-end proofs. There is no live GitHub reader; it
belongs to the receipts work, and live proof of title, body and
merge-message reads stays open.

_Trust boundary, stated plainly._ The worker is the trust root: the server
believes a report only after recomputing it, but it cannot see inside the worker.

- Candidate commands run as the worker user with a scrubbed environment, not in
  a sandbox. A malicious command can read the worker's credential files in the
  state directory and could post its own result. The attempt root is a fresh
  `0700` directory and no child variable names a credential path, but where it
  sits is not a defense.
- The checker's own configuration and baselines live in the candidate commit. The
  fixed policy pins the `argv` and the trusted checker digest, not the lint,
  test or visual-baseline files the command reads, so candidate code can
  neutralize its own check. Fixed visual thresholds and baseline integrity
  belong to the trusted aggregate, not to this slice.
- The commit must exist in the single operator repository the worker is
  configured with. A candidate committed by another worker is
  `unavailable/revision_unavailable`.
- A fresh worktree has no installed dependencies, so a profile lists its own
  install command first (as a `guide` command; later commands run regardless).
- Defended: output text, an agent's or harness's self-reported pass, forged
  identities, replayed row ids and foreign or purged evidence references.

This enforces Bakery-managed work. It does not claim to block direct pushes or
merges outside Bakery. Repository-wide enforcement also requires the Git
provider's required checks/protected-branch configuration, with its own explicit
setup and verification. The UI labels provider protection as not configured,
verified or unknown independently of Bakery rule status.

## Proposed model and operation additions

**Implemented by the organization rule version slice:** the
`organization_repository_rule_versions` table and the three operations marked
*Implemented* below. Publication takes the expected revision in the request body
(a strong ETag cannot express revision zero) plus an `Idempotency-Key`; reads
return the revision in the body with no ETag. Everything else stays proposed.

**Implemented by the repository override slice:** optional
`repositoryRules` in the v1 profile config (v2 inherits it and the server-built
v2 carries it forward; profiles without it keep their bytes and digest), the
profile publication extension below, and `GET /v1/repositories/{id}/rules`
(Developer access, own permission `repositoryEffectiveRule:read`, org-wide like
`repositoryProfiles.list`, 404 for any repository outside the caller's
organization). Publication with a non-empty `repositoryRules` requires
`expectedOrganizationRulesRevision` in the body, takes the shared organization
lock and re-checks live authority before the application/repository row locks,
returns 412 for a stale organization revision and a typed 422 naming every
locked rule key otherwise, and rejects configs that could never fit the
inspection budget (`repository_rules_too_large`; the bound reserves the bytes
onboarding adds to the config plus room for a fixed allowance of
source-derived checks, against the 32,000-byte worker result limit the
inspection report must fit). **Activation mirrors `fixedPolicy`:** a publication
activates itself and requires the repository `If-Match` version (428 missing,
412 stale, before any write) when it states a `repositoryRules` key at all
(even `entries: []`, an explicit "no overrides") or when the currently active
profile carries non-empty overrides, because overrides and their removal must
take effect and PATCH cannot replace an observed active profile. To restore
the organization rules, publish a revision with `repositoryRules: {entries: []}`
or without the field while the active profile carries overrides. A publication
with no key on a repository whose active profile has no overrides is unchanged.
**Changed authority for replacing activation:** every publication that
auto-activates over an existing active profile (carrying a `fixedPolicy`, a
`repositoryRules` key, restoring over active overrides, or replacing a
strict-v1 profile whose base branch no longer matches the repository default
branch) now requires `repository:manage`, like PATCH activation, checked before
any If-Match comparison. Only the first profile of a repository with no active
profile is exempt. Previously `repositoryProfile:manage` alone could replace an
active fixed policy. A plain non-activating publication is unchanged.

**Rules-only activation retains the baseline and needs `repository:manage`:**
an activation caused by `repositoryRules` (a stated key, or restoring over
active overrides) over ANY active profile, observed or not, additionally
requires `repository:manage` (what PATCH activation needs), because publishing
needs only `repositoryProfile:manage`. The new `workflow`, `branches`,
`worktree`, `agentBindings` must equal the active profile's and the active
`fixedPolicy` must be carried; otherwise the publication is refused before any
write with 422 `repository_rules_must_retain_config`, naming the changed
fields, so rule settings cannot weaken delivery gates. An active config that
does not parse is refused with 409 `configuration_profile_unavailable`. A
config carrying its own `fixedPolicy` keeps the existing fixed-policy
semantics. Saving rules changes rules only: other configuration changes go
through normal publication and PATCH activation. The size bound for a config
with `repositoryRules` is about 14.6 KB of canonical config bytes (derived from
the reserved onboarding overhead and the 32,000-byte worker result cap).
Residual
consequence: the replaced observed profile's inspection evidence
(`checkPolicy`) is superseded until the Admin re-runs onboarding, which derives
a fresh v2 from the new active baseline and carries the overrides. A stale profile revision stays the endpoint's existing 409
`revision_not_next`. The audit row records `organizationRulesRevision`.

Keep repository overrides in the existing `RepositoryProfile.config` as
`repositoryRules`. Add one immutable `organization_repository_rule_versions`
table with organization FK, positive revision, typed config, digest, author and
created timestamp. Enforce unique `(organization_id, revision)` and same-tenant
references. With publication as the only insertion path, the highest committed
revision is active; an organization with no rows has no defaults. Serialize
publication per organization, validate an expected prior revision (zero for
initial publication), and never put application policy in Better Auth metadata.

| Operation | Contract |
| --- | --- |
| `GET /v1/organizations/{id}/repository-rules` | **Implemented.** Admin read; current immutable revision in the body, or the empty baseline at revision zero. |
| `POST /v1/organizations/{id}/repository-rule-previews` | **Implemented.** Admin-only, side-effect-free validation and inheritance impact with cursor-paginated affected repositories; binds the draft digest and current revision. |
| `POST /v1/organizations/{id}/repository-rule-versions` | **Implemented.** Admin publication; idempotency key, body `expectedRevision` and strict rule schema; publishes one audited revision. Impact revalidation arrives with previews. |
| `GET /v1/organizations/{id}/repository-rule-versions` | **Implemented.** Admin cursor-paginated history, newest first. |
| `GET /v1/repositories/{id}/rules` | **Implemented.** Effective projection of the active profile: organization revision, entries with provenance, superseded overrides, digest; `checkers` availability (`configured`/`unavailable`/`not_required` with the unavailable rule keys); `providerProtection` (`unknown` with reason `provider_not_connected` or `not_checked` until Bakery reads provider protection); and `ETag: "v<repositoryVersion>"`, the If-Match value of profile activation. |
| `POST /v1/repositories/{id}/rule-previews` | **Implemented.** Repository Admin dry run for proposed overrides and bounded sample input; never runs arbitrary shell or sends sample text to a provider. |
| `POST /v1/repositories/{id}/profiles` | **Implemented.** Existing publication extended with typed overrides, `expectedOrganizationRulesRevision`, lock-conflict rejection and fixedPolicy-style `If-Match` activation. |

The corresponding MCP tools use the same registry/guards. Rule changes use the
existing organization/repository event and outbox path to invalidate cached
effective views. History is the cursor-paginated read of immutable versions above.

Before code generation, reconcile the proposed table, profile/snapshot schemas,
effective projection, preview/publication operations, evidence digests and event
payloads into `data-model.json`, `api-catalog.json` and `transport-schemas.json`
together. Every authored Zod field, nested option, enum and derived schema must
have a meaningful description per [backend contract rails](04-backend-and-errors.md).
Only the operations and table marked implemented above ship; the rest are design work.

**Implemented by the rule preview slice:** the two `*-previews`
operations above, both Admin access with the new permission key
`repositoryRule:preview`. They are queries carried by POST (`ActionKind.Query`,
catalog idempotency `read`): no `Idempotency-Key`, no replay record, no audit
row, domain event or outbox row, no lock; they run in one `REPEATABLE READ`
snapshot and every statement carries `organization_id = $n` bound to the
authorized organization, so a foreign or unknown organization or repository
answers one identical 404 (the organization route is browser-session only like
the other organization routes; the repository route accepts scoped tokens, and
the `preview` verb needs `bakery:operate` or wider).

- **Organization preview.** Body `expectedRevision`, `entries` (typed like
  publication), optional `limit` (1..100, default 25) and `cursor`. A stale
  `expectedRevision` is 412, an invalid draft a typed 422, both before any scan.
  `draftDigest` is `repositoryRuleVersionDigest(expectedRevision + 1, entries)`,
  the digest publication stores. The classification covers every active,
  non-archived repository of the organization against its ACTIVE profile's
  overrides (no profile = no overrides): `newly_locked` when an override that is
  effective under the current rules is superseded under the draft, else
  `overridden` when an override stays effective, else `inherited`;
  `unsupported` is an additional flag for an enabled `require` magic-literal
  rule whose `checkBinding` is null or names no `fixedPolicy` command of the
  profile. Counts stream over keyset batches of 1000 repositories (memory is the
  batch plus the page); only the fields classification reads leave the
  database (per override: rule key, enabled, mode and checker binding, and the
  active profile's command ids a binding could name), never whole configs.
  One request is bounded four ways: at most 20,000 repositories (typed 422
  `too_many_repositories`), at most 12 MiB of that summarized data (typed 422
  `preview_too_large`; counted in UTF-16 code units of the serialized
  summaries, not UTF-8 bytes), a transaction-local `statement_timeout` of 5
  seconds applied to each statement (a whole scan is bounded by the 10 second
  request deadline; both answer a typed 504 `DEPENDENCY_TIMEOUT`), and
  in-process admission of one scan per organization, one per principal and two
  per process (typed 503 `DEPENDENCY_UNAVAILABLE`; the `retryAfterSeconds`
  field is a body hint, there is no `Retry-After` header). Admission is per
  server process, not per cluster, and a refused request is not queued; two
  Admins of different organizations can still hold both process slots. Every
  page repeats the scan, so a walk costs one bounded scan per page. Items are
  a signed-cursor page ordered by repository id; items also list `reactivatedRules`, the saved overrides a
  lock the draft removes would wake up (design step 5: the preview identifies
  that change); the cursor is bound to the organization, the principal and the
  draft digest, so a cursor from another draft, principal or organization is
  `INVALID_CURSOR`.
- **Repository preview.** Body `overrides` and an optional `sample`. Lock
  conflicts are returned in the body (`conflicts`, `effective: null`) with the
  same rule keys and reasons publication refuses with; without conflicts
  `effective` is the resolver output (provenance, digest) against the latest
  organization revision. The sample is evaluated by pure linear validators for
  `commits.semantic` (first line, Conventional Commits 1.0.0, `range` decides
  which messages apply, merge and revert commits per option),
  `changeRequest.semanticTitle` and `changeRequest.description` (required
  sections need non-template content; headings match case-insensitively, a
  heading inside an HTML comment is not a section, the first of duplicate
  headings decides, setext headings are out of scope, a checkbox tick or an
  empty code fence is not content). Duplicate rule keys in `overrides` answer
  422 like profile publication. `code.magicNumbers` and
  `code.magicStrings` are always `not_evaluated`: the preview never claims a
  pass it did not compute. Sample text is never stored, logged or audited and
  findings carry fixed codes and messages, not sample text.

## Acceptance and mock states

- A new repository inherits organization rules. An allowed override replaces
  one entry; restoring it follows the next organization revision. Empty defaults
  and repository-only rules resolve correctly.
- A locked rule cannot be weakened through UI, REST, MCP, profile import or
  worker input. Cross-organization rule reads/references fail; a Developer can
  inspect permitted effective rules but cannot publish them.
- A new lock supersedes an existing override; removing the lock previews its
  reactivation. Concurrent Admin edits retain the losing draft and return a
  precondition failure without partial publication.
- Valid and invalid commit/title samples, empty/template-only description
  sections, named constants, configured literal exceptions and unsupported
  languages produce the documented statuses. Squash-only and all-commit modes
  prove different results on the same commit range.
- Editing a PR/MR title/body with the same head, or changing the effective
  organization rules during a run, invalidates evidence before merge. A
  continuation preserves previous evidence and does not repeat confirmed effects.
- Desktop and phone show inheritance source, locks with explanations, a local
  override and restore action, preview feedback and save/publish ownership.
  Include empty/loading, read-only, unsupported checker, stale publication and
  failed save states in implementation; errors preserve drafts and never show a
  false success. Status is conveyed in text, controls have labels and 44px touch
  targets, focus is visible, and save/error feedback is announced.
- Build this with repository onboarding and controlled delivery (slices 5–6 in
  [Implementation readiness](15-implementation-readiness.md)); do not enable
  automatic merge with required rules that are only prompt instructions.
