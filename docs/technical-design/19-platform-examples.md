# Platform code examples

Two kinds of example: **pure specimens** below and **target call shapes** for services still to build. None starts the factory, connects a provider, or installs a daemon.

## A small platform, shared by every transport

```text
apps/server/src/
  modules/work/             tasks, turns, questions; public operation entrypoints
  modules/knowledge/        artifact metadata, bounded reads, comment iterations
  modules/execution/        host claims, leases, producer fences, output writes
  modules/delivery/         checks, PRs, merges, deploys, source facts
  platform/                actor, guards, StandardError, transaction, outbox
packages/contracts/        described Zod schemas; generated transport metadata
apps/worker/src/           supervisor, private cache/spool, harness adapters
```

This is the intended module layout, not a list of implemented files. Reuse the existing versioned route/handler/service/store split. Interfaces cover real interchangeable providers, storage and harnesses; ordinary functions handle domain decisions.

```text
REST handler / MCP tool / trusted chat adapter / scheduled action
  parse generated input schema
  resolve authenticated actor and organization
  call the SAME registered operation
    authorize current resource + scope
    transaction: recheck state/CAS → mutate → event/outbox → saved response
  validate safe output schema
  transport adapter: HTTP result / MCP result / notification projection
```

The model supplies business arguments, never its own actor, organization grant, credential or store transaction. Browser/source IDs are untrusted until the operation resolves them. A plugin manifest declares requested capabilities; it cannot bypass these guards.

## Standard errors and a revision guard

```ts
// Target service helper; StandardError is the one shared platform error.
function assertArtifactRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new StandardError({ slug: "precondition-failed", status: 412 });
  }
}

// Target handler shape; infrastructure functions are not implemented here.
const actor = await requireActor(request);
const input = parseWithSchema(MessageCreate, await boundedJson(request));
const result = await operations.messages.create(actor, conversationId, input, {
  idempotencyKey: requireIdempotencyKey(request),
});
// intent=agent_request + commentRefs snapshots feedback and queues one turn.
// Expected root versions are inside commentRefs; stale input commits nothing.
return json(validateOutput(Message, result), 201);
// Shared HTTP error adapter -> problemResponse(error), RFC 9457.
// MCP calls the same operation and uses the existing tool-error mapping.
```

Authorization and revision checks repeat inside the transaction immediately before writes. Provider exceptions are reduced to safe catalog faults; never serialize their retained request headers/body to clients or logs. This uses the existing catalog's `messages.create`, `MessageCreate` and `Message` contracts; the handler and service functions shown here are target shapes. [Multiplayer](07-multiplayer.md) explains the atomic feedback snapshot and turn admission.

## Specimen: allocate context from a manifest

The specimen validates described schemas, keeps required components, accounts for output/safety reserves, and selects optional entries by priority. It does not load blobs or tokenize text.

```ts
const allocation = allocateContext({
  policy: {
    windowTokens: 100_000, maxInputTokens: 60_000,
    outputReserveTokens: 20_000, safetyReserveTokens: 10_000,
  },
  items: [
    { id: "policy-task-tools", tokens: 8_000, required: true, priority: 100 },
    { id: "approved-plan-v3", tokens: 4_000, required: true, priority: 100 },
    { id: "failing-test-excerpt", tokens: 2_000, required: false, priority: 90 },
    { id: "whole-session-log", tokens: 90_000, required: false, priority: 10 },
  ],
});
// ready; 14,000 selected tokens; whole-session-log omitted.
// Required content exceeding the budget -> handoff_required, no prompt emitted.
```

The numbers illustrate a configured policy, not a recommended threshold for every model. Counts must include hidden harness overhead where measurable, tool definitions, images and pending results. Unknown counts require conservative estimation or a pause before admission. Final assembled prompts are remeasured. A `ready` allocation is a size decision, not an evaluation of model understanding. See [context and handoffs](17-context-and-handoffs.md) for provenance, selection and recovery rules.

## Runnable: PR metrics with honest missing data

```ts
const summary = summarizeMergedPullRequests({
  from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z",
  facts: [
    { id: "github/repo/1", openedAt: "2026-05-31T12:00:00Z",
      mergedAt: "2026-06-01T12:00:00Z", additions: 100, deletions: 20 },
    { id: "github/repo/2", openedAt: "2026-06-01T12:00:00Z",
      mergedAt: "2026-06-04T12:00:00Z", additions: 50, deletions: 10 },
  ],
});
// mergedCount: 2; meanHours: 48; medianHours: 48
// knownAddedLines: 150; knownDeletedLines: 30; unknownLineCount: 0
```

Identical duplicate facts count once; conflicting snapshots require reconciliation. A merge exactly at `to` belongs to the next window. Null or impossible creation times stay out of the duration sample and increase its missing count. Binary/incomplete line totals are null, not zero. This specimen calculates merge-cohort summaries only; [Development metrics](18-development-metrics.md) defines open/closed cohorts, task time, p90, intervals and production measures separately.

The calling service must first authorize/filter source facts and select one measurement revision. This pure function is not an authorization boundary, provider synchronizer or unbounded historical query. At a real transport boundary, schema/domain validation failures map through existing standard errors.

## Durable actions carry references, not session dumps

```text
executePinnedNode(runId, nodeKey, fullIterationPath, logicalAttempt)
  load authoritative run and immutable execution binding
  assert live permission, budget and cancellation policy
  load small artifact manifest → choose bounded slices
  if context budget cannot fit required content: checkpoint and hand off
  ensure job using the stable logical execution identity
  wait/re-read committed result with a bounded timeout
  validate typed result and revision evidence
  return artifact/version/digest references to the next node
```

```text
worker reconnect
  reconcile server-owned attempt/fence before starting work
  replay unchanged local journal entries with the same IDs
  warm skill cache: verify hashes + fresh authorization
  resume only the matching native session/workspace/checkpoint
  otherwise start fresh from the durable handoff, with a new producer session
```

These shapes reuse the queue and output paths in [Workflows](06-workflows-delivery-and-acceptance.md), the storage boundary in [Artifacts](14-artifacts.md), and recovery policy in [Failure handling](16-recovery-and-failures.md). Durable checkpoints cannot make an uncertain provider effect safe to repeat.

## Specimen coverage

The specimen tests covered required-context overflow, duplicate manifest IDs, reserves, merge-window boundaries, duplicated/conflicting facts, unknown data, and recursive Zod description preservation. They used pinned dependencies and no network permission. Production migrations, atomic DB operations, model/harness streaming, cross-user UI, downloads and crash recovery require the separate runtime gates.
