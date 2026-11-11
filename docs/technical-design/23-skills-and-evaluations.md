# Skills and evaluations

**Proposed design · 8 September 2026.** This chapter owns the new Skills navigation area and the evaluation implementation plan. It extends the [existing skill and evaluation records](01-data-model.md), [workflow contracts](06-workflows-delivery-and-acceptance.md), [artifact storage](14-artifacts.md) and [backend schema rails](04-backend-and-errors.md). These are planned service/catalog changes, not implemented runtime capabilities.

[Revised Paper designs](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/10-0) and the [interactive prototype](workflow-studio/index.html) demonstrate the UI. Prototype scores are explicitly illustrative; no evaluator, cloud agent or external tool runs.

## Product and navigation

Skills is a main navigation item beside Workflows. A skill has a stable identity, a mutable authoring draft and immutable published versions. Instructions, required inputs, compatible actions and expected outcomes form the reusable unit. Workflow steps pin published skill versions; editing or publishing a skill never silently changes existing workflows or runs.

| Library scope | Ownership and visibility | Editing and reuse |
| --- | --- | --- |
| Global | Bakery-maintained packages made available through each organization's installed catalog | Read, inspect versions, evaluate within authorized organization resources, or copy. Content stays locked even for organization Admins. |
| Organization | Shared within the current organization subject to its grants | Authorized authors create drafts; authorized publishers publish versions. Every reader can request an editable copy to an allowed destination. |
| My skills | Private to the current principal **within the current organization** | Author and evaluate privately. Sharing creates an explicit organization copy with provenance. Personal drafts never appear in another member's search or AI context. |

Global is a catalog presentation scope, not an exception to tenant isolation. Keep the existing non-null organization ownership and composite foreign keys. An installed Global package records Bakery provenance and immutable package digest. Do not introduce unauthenticated cross-tenant reads or infer authority from a skill's prose.

An organization workflow cannot bind a private user skill that its collaborators or run principal cannot read. Offer **Create organization copy**, then bind that published copy. Disabling a skill blocks new admission according to policy; historical version evidence remains readable to authorized readers. Existing runs retain their pinned bytes and follow explicit revocation/cancellation policy.

The library has All skills, Global, Organization and My skills filters, search, version, latest comparable evaluation and status. One row represents a skill identity, not each revision. Skill details contain Instructions, Test cases, Evaluations and Versions, plus compatible action, requirements and Used by references. Versions shows the full immutable history and draft status. A workflow's Setup panel offers an explicit version update with compatibility validation and Undo.

## Authoring and workflow continuity

1. Start from a library skill, create an organization/personal copy, or select **Create skill** from an empty workflow search. Preserve the query, selected step and workflow draft.
2. Enter purpose and instructions. The registered action owns input/output schemas and side effects. A freeform agent action still has a typed envelope; instructions do not invent new capabilities.
3. Save the draft independently of publication. Use the existing collaborative document contract for production editing; do not add a second draft sync system. Exact skill-file inventory and descriptions must validate before publication.
4. Add representative test cases, including missing inputs, ambiguous repository roles, untrusted content, service interruption and cross-repository dependencies. A saved edit creates a new immutable dataset revision for evaluation.
5. Run an evaluation against a content-addressed draft snapshot or published version. Inspect individual outputs and scoring evidence before publishing. A draft can be evaluated without becoming bindable by ordinary production workflows.
6. Publish a version, then explicitly link or upgrade a workflow step. Existing references retain the old version. A copy has a new identity and source lineage; source content, evaluations and runs stay intact.

Bakery-provided Research, Plan and Implement workflows remain separate immutable sources. Every readable workflow can be cloned into an inactive organization draft. New, copied and imported workflows are independent records; opening a built-in must never replace an organization's draft. Preserve source definition/version/digest lineage. Exclude credentials, grants, execution history and active triggers from copies. Import must validate the typed JSON, reference visibility, bounded graph and compatible contracts before publication; invalid source remains recoverable.

## What an evaluation measures

A test case supplies typed input, optional expected output, required behavior, context fixtures and tags. The target is an exact skill snapshot plus its action/agent configuration, or a published workflow version. A dataset is an immutable set of case revisions. Scoring rules and pass thresholds are versioned independently of the dataset and target.

| Evaluator | Initial implementation | Evidence and interpretation |
| --- | --- | --- |
| Deterministic checks | Registered code checks: output schema, required citations, candidate/repository identity, prohibited effects, bounded loop/timeout compliance | Exact observed result and reason. Invalid output is a completed check failure; a checker crash is an execution error. |
| Rubric judgment | A configured model scorer with pinned rubric, provider/model, parameters and output schema | Score, rationale, rubric dimensions and provenance. Judge output must validate; missing or malformed scores remain unscored/error. |
| Human review | An authorized review artifact linked to the case/result | Reviewer, rubric revision, decision and explanation. Keep this alongside machine scores; never overwrite measured history. Initial UI can link the review artifact rather than add another review engine. |

Use deterministic checks first. Add model scoring where correctness needs a rubric, such as evidence quality or instruction adherence. A model's confidence does not replace a deterministic safety or repository check. Use an explicit pass rule per required scorer; never average a failed required check into a passing aggregate.

Mastra supports code/model scorers and evaluation of agent or workflow outputs. Its experiment model supplies useful dataset and comparison conventions. Bakery will adapt the scorer boundary to its existing runtime rather than adopt another durable workflow scheduler. [Mastra evaluations](https://mastra.ai/docs/evals/overview), [Mastra experiments](https://mastra.ai/docs/evals/experiments).

## Execution and persistence

```mermaid
flowchart LR
  UI[Run evaluation] --> Admit[Authorize and pin manifest]
  Admit --> Store[Batch record and budget reservation]
  Store --> Outbox[Existing outbox]
  Outbox --> Inngest[Durable evaluation workflow]
  Inngest --> Target[Execute each target and case]
  Target --> Output[Immutable output artifact]
  Output --> Score[Registered checks and model scorers]
  Score --> Results[Results, evidence and usage]
  Results --> UIResult[Case comparison and gate decision]
```

Inngest remains the only durable scheduler. It coordinates bounded case concurrency, cancellation, retries and terminal state through existing operations/jobs. A cloud target runs through the configured Mastra agent boundary; a native harness target uses the existing worker protocol and isolated worktree. Score the retained output artifact; a judge retry must not rerun the target or repeat its external effects.

The admitted manifest pins organization/principal, target kind and content digest, action/agent versions, model/provider parameters, skill/file digests, repository bindings and exact commits, dataset and case revisions, scorer revisions/thresholds, tool fixtures or allowed connections, timeout/concurrency/repetition limits and budget. Server authorization is rechecked at effect boundaries. Descriptions aid agents; they never grant access.

Default offline evaluations use deterministic mock tools and isolated repository fixtures with external writes disabled. A live integration evaluation is an explicit environment choice with authorized connections, effect limits and its own budget. Do not reuse live production webhook subscriptions or create active triggers when evaluating/importing a workflow. Sanitize captured examples before inclusion; expose real artifact contents only through existing authorized reads.

Use one parent budget reservation across target execution and all scorers, including provider retries. Persist reported/estimated/unknown usage through the existing ledger; unknown cost is not zero and does not release an unsettled hold. A bounded retry appends an attempt to the same case/scorer result identity. Duplicate queue delivery cannot produce duplicate target effects, results or cost settlement. Cancel prevents new case admission, propagates to admitted attempts, and preserves completed results.

## Model and operation changes to implement

Reuse `skills`, `skill_versions`, `skill_files`, `evaluation_definitions`, `evaluation_cases`, `evaluation_runs`, `evaluation_results`, artifact versions, usage records, budgets and the outbox. Do not create a parallel score store or put file bytes in metadata rows.

| Change | Proposed contract and constraint |
| --- | --- |
| Skill scope | Add `catalog_scope` (global/organization/user), nullable owner principal, and source-copy lineage to `skills`. User requires a same-organization owner; other scopes omit it. Global installation provenance is host-managed and immutable. Slug uniqueness must include organization, scope and applicable owner. |
| Draft snapshots | Reuse collaborative drafts. Evaluation resolves one immutable skill/artifact snapshot digest; subsequent edits do not mutate it. Publication creates the existing immutable skill version only after file verification. |
| Dataset and suite manifests | Reuse typed artifact versions for an immutable ordered set of case revisions and an immutable ordered set of evaluator definitions/thresholds. Validate every referenced case/evaluator belongs to the organization. Each has a stable identity plus revision/digest. |
| Evaluation batch | Add one `evaluation_batches` record grouping the candidate/baseline target manifests, dataset/suite versions, execution environment, reservation, state and author. This is product state for the existing Inngest workflow, not a new job queue. |
| Evaluator runs | Add batch identity and candidate/baseline role to existing `evaluation_runs`; retain `definition_id` per pinned scorer. Each case target executes once; its retained output can feed multiple scorers. Add cancellation and completion-with-errors semantics without treating unscored cases as completed passes. |
| Results | Retain per-case score, passed, explanation, error and usage. Add output artifact reference, scorer dimensions, attempt/trace references and measurement status. Uniqueness is batch/target/case revision/evaluator revision/repetition; retries preserve identity and attempt history. |
| Comparisons | Compare only compatible dataset, case and scorer revisions. Pin both target manifests; display differences in model/tools/skill configuration. Missing matches are explicitly unpaired. Never synthesize zero for absent scores. |

Every authored Zod schema, child field, union member and composed schema requires a meaningful non-empty description. Preserve these through generated JSON Schema, REST, MCP and forms. Derive TypeScript contracts from described schemas; the prototype's handwritten small model is not the production contract. Update chapter 01, structured model/API catalogs and generated artifacts together during implementation; this chapter records the proposed delta until that reconciliation lands.

Operations belong to the existing catalog/evaluation services and shared authenticated operation boundary:

- List/read skills and versions with scope and owner filtering; create/save/copy/publish/disable skill; read Used by references. Enforce Global immutability server-side for every role and adapter.
- Create/read/copy dataset and suite artifact revisions; add/edit cases by producing a new revision. Preserve imported source and diagnostics on failure.
- Estimate/admit/cancel/read evaluation batch; list runs/results with cursor pagination; compare two compatible batches; attach an authorized human review artifact.
- Every mutation has a typed response, idempotency key and optimistic revision guard where it changes a draft. REST and MCP share the same handlers, permissions and described contracts. Publish/start is separate from draft save.

Member read/author/evaluate actions follow current grants and budgets; publication, organization sharing and disabling require their existing policy checks. Admin does not confer permission to rewrite Global packages. Personal data and evaluation artifacts stay owner-restricted unless explicitly copied into an allowed shared scope. A connection or imported skill reference is not an authorization grant.

## Comparison and recovery UI

| Result | Score | What the user sees |
| --- | --- | --- |
| Passed | Measured | Required checks passed for the pinned case and target. |
| Failed | Measured, possibly zero | Completed quality check did not meet its requirement; show the evidence/rubric reason. |
| Error | Null | Target/provider/checker failed before a valid measurement; show an eligible retry with the original manifest. |
| Not scored | Null | Output exists without a valid judge result, or the case has not run; explain which stage is missing. |
| Canceled/skipped | Null | Explicit cancellation or policy reason; keep the case in coverage counts. |

Show measured coverage beside pass/fail/error/unscored counts. Averages use measured comparable cases only and always display the denominator. A required release gate is incomplete until every required case/check has the required measurements; an empty, canceled, partially scored or budget-exhausted batch cannot pass. Optional online samples do not alter delivery acceptance unless a versioned policy explicitly makes them required. Required checks are never sampled away.

The desktop comparison has Baseline, Candidate, Change and Result columns. Phones retain the baseline → candidate and delta beneath each case name, then open Input, Expected, Actual output and scorer explanation in a focused detail view. No baseline removes the baseline and delta presentation. Filters do not change totals or hide missing coverage from the gate decision.

LLM scores vary. Allow a bounded repeated-run count when the suite requires it and retain every observation; report spread with the configured aggregation rule. Do not label a single improved sample a statistically proven improvement. Comparing outputs can reveal a useful change without claiming causation when model, prompts or tools changed together.

## Multi-repository evaluation cases

Repository roles such as frontend and backend are annotations resolved to authorized repositories. They do not grant access or imply work readiness. Test zero matches, multiple matches, repository removal and denied access. Include a case that establishes an API contract, fans out independent implementation, and joins **both exact candidates** for acceptance. A dependency failure prevents downstream work while preserving successful sibling evidence.

The same coordinator supports ordinary tasks without a saved workflow. Record its repository plan, dependencies and child progress through the existing task/run model; optionally save a reusable workflow afterward. Evaluate that coordinator behavior as well as saved workflows. The UI prototype illustrates parallel branches, but its compact sample validator is not proof of multi-repository scheduling or acceptance.

## Implementation sequence and acceptance

1. **Catalog and authoring:** reconcile described schema/catalog deltas, scope/owner grants, immutable Global installs, personal-to-organization copies, draft/version history and Used by upgrades. Verify no cross-tenant or private-skill leaks through search, generated MCP or AI context.
2. **Deterministic offline evaluation:** immutable dataset/suite manifests, one batch admission, pinned target output, registered checks and persisted results. Verify duplicate delivery, cancel, target failure, malformed output, immutable revisions and no external effects in mock mode.
3. **Model scoring adapter:** pin versions and prove the current scorer interface in the chosen Deno runtime; exercise structured judge output, timeout/retry, malformed score, redaction and budget settlement. Do not adopt a Node-only experiment runner without this compatibility result.
4. **Comparison and gates:** compatible paired case revisions, complete coverage accounting, nullable measurement states, fixed thresholds, per-case drill-down and required release policy. Verify errors/unscored/empty batches cannot pass and a failed required check cannot be averaged away.
5. **Optional online sampling:** stable sampling by run/output identity, bounded asynchronous execution and no impact on task completion when an optional judge/provider fails. Retain the immutable source artifact and authorized provenance.

The local check is `rtk proxy node docs/technical-design/workflow-studio/verify.mjs`. Browser review covers authoring and recovery interactions only. Production acceptance additionally requires Deno/provider compatibility, server permission tests, durable restart/replay, budget settlement, multi-repository isolation and actual evaluator evidence. Paper screenshots, prototype scores and UI tests do not close those runtime gates.
