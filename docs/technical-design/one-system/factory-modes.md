> Companion of [chapter 25, One engine](../25-one-engine.md). Where this document and [owner-decisions.md](owner-decisions.md) differ, the owner decisions win.

# Factory modes: Describe it, Workflow, Team

Status: design proposal for the product owner, 14 November 2026. Read against `origin/main` at `d11fb5205` ("feat(workflows): cancel reaches every lane of a plan run (#384)"). Companion to the workflow editor spec (`workflow-editor/UX-SPEC.md`, gaps G1 to G17) and the Deliver handoff design (`deliver-as-workflow.md`, gaps A1 to A16), both in this scratchpad. New gaps here are F1 to F22. The deliver doc was still being written when this was read (its section 2 was absent); references to it are to its sections 0 and 3 to 5 as they stood, and should be re-checked when it is final.

Nothing here is implemented. Claims about Bakery cite `origin/main` paths and lines. Claims about OpenRig cite `rig context get <skill>` (OpenRig 0.5.14), the exported `bakery-v1` rig spec, and `rig ps --nodes --rig bakery-v1`.

Framing, per the owner: **Bakery provides durable infrastructure and building blocks; people build their own factories from them.** Bakery cannot decide what a factory means to everybody, and cannot build a workflow for every person. So nothing below is a hard-coded "team feature" or a hard-coded "describe-it feature". Both are compositions of public primitives (section 2). Everything Bakery ships, including an OpenRig-style product team and the Deliver workflows, is a template built only from those primitives, with no private engine path. A separate architect owns the overall kernel and extension points; this document stays on team mode and the describe-it path and names where they need an extension point.

---

## 0. The answer in one paragraph

Yes, an OpenRig-style team is a workflow, as long as "workflow" means the definition and not one fixed sequence of steps. Bakery should have one definition format built from one set of public primitives: steps, seats, queues, handoff paths, rules, triggers, artifacts and approvals. The one thing that varies is **who picks the next step**. In a scripted workflow the engine picks it from a validated fact. In a team, the agent holding the work picks it at the end of its session, but only along the handoff paths the definition declares and only when the rules (WIP limits, gates, ping-pong and hop limits, budgets, approvals) allow it. A person can pick it too. A team is that same choice repeated at seats that persist, fed by a queue. It is not a second engine, and Bakery's own product team ships as a copyable template built from the same parts any customer can use. Teams and workflows nest: a seat can run a scripted workflow for each item (a developer seat runs Deliver), and a scripted workflow can later contain a routed block. Context follows "persistent role, fresh sessions": the seat keeps a brief, skills, sourced memory and a work history, while each visit to a work item is a new bounded session that starts from pinned artifacts and the previous seat's handoff summary. Nothing is ever compacted from one item to the next, so OpenRig's compaction-restore and seat-handover machinery is not needed. "Describe it" is the same model reached through words. The coordinator, which is already an organization-configurable agent, proposes edits to an unlisted definition draft that is drawn on the editor's diagram. Pressing Run freezes that draft into an immutable, unlisted version that is audited like any other, and "Save as workflow" copies it into the library. Most of the parts exist: versioned definitions, the compiler, artifacts, approvals, coordination plans, the read-only coordinator, and memory tables. The real gaps are the agent-chosen route node, seat state, cross-run rules, a coordinator effect that proposes definitions, and running an unpublished version.

## 1. Is an OpenRig-style team a workflow? The honest test

The owner thinks it should be. Test it against what a Bakery workflow is, property by property.

| Property | Scripted workflow today | OpenRig team | Same thing? |
| --- | --- | --- | --- |
| A versioned, reviewable definition | Draft, immutable published versions, digest, compiler pin | RigSpec YAML; the queue and culture live outside it | **Yes**, and a team gains from it: OpenRig's own spec skill names "spec instantiates topology but not workflow" as failure mode 1 (`specification-system`) |
| Typed artifacts between units of work | Pinned `ArtifactRef`s; kinds and validators proposed (deliver doc 4.1) | Qitem bodies plus snapshotted context packs | **Yes**: same snapshot principle |
| Human approvals | Approvals and questions exist; an approval step is proposed (A5) | Escalation to the human as a durable queue item | **Yes** |
| Budgets and limits | Per-run worst case computed by the compiler | Account limits; nothing per item | **Yes**: per item, plus a per-team daily limit |
| Triggers | Automations: schedules today; GitHub event triggers are parsed but not yet matched | The human or the orchestrator dispatches | **Yes**: a firing enqueues an item instead of starting a run |
| Who picks the next unit of work | The engine, from the definition and validated facts | The agent holding the baton, constrained by culture and loosely by edges | **No**. This is the real difference. |
| Lifetime | One run starts and ends | Standing: the rig runs for days and takes new work | **Different, but resolvable**: each work item is one bounded run; the standing parts (queue, seat memory, WIP counters) are state around runs |
| Agent sessions | One fresh session per step | One long-lived session per seat | **Bakery's model is better** (section 3.5) |
| Rules across units of work | None (each run is alone) | Informal: culture, the orchestrator watching | **New**: WIP limits, gates and concurrency span runs |

**Verdict.** A team is a workflow definition whose next step is chosen by an agent or a person instead of the engine. The choice is limited to declared paths and rules the engine enforces, and the definition runs once per work item under shared standing state. Two things make this more than a naming choice.

1. **The agent-chosen step can be expressed with the engine's own constructs.** A team's handling of one item is a bounded loop. Each round runs the current seat's session, and that session publishes a validated `handoff` fact naming the next seat. The next round branches on that fact. The compiler can therefore keep its central guarantee, a worst-case bound per run computed before anything starts: at most `maxHops` rounds, each costing at most the most expensive seat visit. Section 2.4 gives the lowering. It also shows why the route should be a native node rather than literal nested branches: the current bounds would cap a team at 8 hops.
2. **What does not fit one run belongs to standing state, not to a second engine.** The work queue, a seat's memory and the WIP counters live across runs. They are a small set of new state primitives (section 2.1) that the same admission path reads before dispatching a step, much as coordination-plan admission already reads plan state before letting a lane's run start (`coordination-admission.ts:70-196`).

What would make the answer "no": if teams needed open-ended agent behaviour the engine could not bound, such as unbounded hops, unbounded fan-out, or agents inventing seats or paths at run time. The design forbids all three. Hops are capped, splitting is capped and re-enters the same team, and paths come only from the definition.

## 2. The unified model: primitives, then compositions

### 2.1 The primitives

A factory, whether it is a fixed pipeline, a standing team or something a customer invents, is built from the parts below. Each one is public: it appears in the definition format, the validation endpoint and the code view, and Bakery's own templates use only these. The last column says whether a customer can use it today by configuration, or whether Bakery engineering must add it first.

Abbreviations: `WC/` = `packages/contracts/src/workflow-compiler/`, `WI/` = `packages/contracts/src/workflow-interpreter/`, `BPS` = `apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts`. Bare file names used throughout: `coordination-*.ts`, `run-command.ts`, `budget.ts`, `stage-policy.ts` and `plan-run-admission.ts` are in `apps/server/src/modules/work/`; `turn-runtime.ts`, `coordinator-worker.ts`, `plan-revisions.ts` and `approvals.ts` are in `apps/server/src/modules/conversation/`; `plan-admission.ts` is in `apps/server/src/modules/workflow-adapter/`; `shape.ts` is `WC/passes/shape.ts`; `automations/*` is `apps/server/src/modules/workflows/automations/`; `06-…md`, `10-tickets.md`, `14-artifacts.md`, `17-context-and-handoffs.md` and `01-data-model.md` are in `docs/technical-design/`; `TaskCoordinationPage.tsx` and `PlanProvenance.tsx` are in `apps/web/src/pages/task-coordination/`.

**Definition and flow**

| Primitive | What it is | On `origin/main` | A customer configures | Bakery must add |
| --- | --- | --- | --- | --- |
| **Definition** | Versioned document: one draft, immutable published versions, a separate "use this version" | Yes: drafts with CAS (`migrations/bakery/0126_workflow_drafts.sql`; `apps/server/src/modules/workflows/postgres.ts:569-640`), publish (`:700-825`), activate (`:827-897`); root keys `apiVersion, kind, inputs, limits, agents, cancel, steps` (`WC/passes/shape.ts:63-71`) | Everything in it | `mode`, `seats`, `team`, `charter` root keys (F1); `origin` and unlisted visibility (F15); no origin column or server copy exists today |
| **Step** | One action with an agent | Yes: node keys (`shape.ts:72-83`); agent precedence step, then `agents[action]`, then profile (`apps/server/src/modules/work/plan-run-admission.ts:73-88`); 9 runnable actions (`packages/contracts/src/implemented-actions.ts:517-533`) | Agent versions, `agent.freeform` prompts | Step skills (G13), named input and output slots (A1) |
| **Flow nodes** | sequence, branch, repeat (≤ 8), parallel (≤ 8 lanes), wait | Yes (`shape.ts:84-91`; `WC/limits.ts:26, 28`); event waits refused (`plan-admission.ts:130-131`) | Structure | `call` (G14), `forEach` (A3), `stop` (A7), approval node (A5) |
| **Route** | A point where the next step is chosen by the agent or person holding the work, among declared paths | **No.** The interpreter is deterministic and reads only recorded results (`WI/interpret.ts:27-51`) | Paths, conditions, exits, hop limit | **Yes (F2)**: one semantic node plus an interpreter revision |
| **Seat** | A durable role at a route: brief, agent, skills, capacity, role, kind (agent, workflow, person) | **No.** The only "roles" are repository aliases (`coordination-command.ts:148-218`) | All fields | **Yes (F1, F5)**: definition fields plus seat state (pause, capacity, memory scope) |
| **Handoff path and record** | An allowed move between seats with required outputs and fact conditions; a durable row per move | **No.** Only acyclic `needs` and lane prerequisites (`WC/passes/needs.ts:90-96`) | Paths, required outputs, conditions | **Yes (F3)**: the `bakery.handoff` kind and the record |

**Work, queues and triggers**

| Primitive | What it is | On `origin/main` | A customer configures | Bakery must add |
| --- | --- | --- | --- | --- |
| **Work item** | One task plus one run of a definition version | Yes: tasks and runs; run snapshot pins version and agents (`run-command.ts:247-299, 1197-1209`) | Brief, priority (0..100, `01-data-model.md:518`) | Nothing |
| **Queue (seat inbox)** | The runs waiting for a seat, ordered by priority then age | Partly: a `waiting_capacity` run status exists and the engine releases runs in it (`run-command.ts:228`; `BPS:2452-2457`), but nothing sets it | Order, entry seat | **Yes (F4)**: a seat dispatcher that parks runs and re-arms them when capacity frees |
| **Trigger** | What starts or enqueues work | Schedules wired (`apps/server/src/modules/workflows/automations/tick.ts`); event triggers parsed but not matched yet (`automations/firing.ts:36-40`); overlap `skip`, `queue_one` (`automations/tick-plan.ts:96-131`); firings start task plus run (`automations/start.ts`, `promote.ts`) | Cron, time zone, event and filter, budget | "Enqueue into a team" target and an unbounded queue overlap policy (F6); event matching (issue #36) |
| **Split** | One item becomes child items with prerequisites and typed artifact handoffs | Yes, as coordination plans (`coordination-plan.ts:13-70`), materialized as child tasks (`coordination-command.ts:751-905`) | Lanes, prerequisites, outputs | Children re-entering a team at a named seat, and the parent waiting for them (F7) |

**Rules, limits and people**

| Primitive | What it is | On `origin/main` | A customer configures | Bakery must add |
| --- | --- | --- | --- | --- |
| **Guards** (closed library) | Capacity, team concurrency, counter limit (WIP), gate before exit, ping-pong limit, hop limit | Only per-run limits and parallel `maxConcurrency` (`WC/limits.ts`; `WI/interpret.ts`); coordination `maxConcurrency` is not enforced (`coordination-plan.ts:75-78`) | Which guards, their parameters, which seats | **Yes (F8)**: the guard library, checked at step admission |
| **Counters** | Named numbers the guards read: open pull requests created by this team, items per seat, items waiting for people | **No** | Which counter a guard reads | **Yes (F9)**: a built-in counter catalog, plus an **extension point** so a provider or plugin can publish new counter sources (for example "Jira issues in review"). This is the one place customers will want something Bakery did not ship; the kernel architect should own the extension contract (D10) |
| **Budgets** | Spend ceilings | Installation-month, run and coordination-plan accounts (`apps/server/src/modules/work/budget.ts:640-700`) | Amounts | A team-per-day account scope (F10) |
| **Approvals and questions** | A person decides | Task stage policy and approval rows, human-only decisions (`stage-policy.ts:13-22`; `apps/server/src/modules/conversation/approvals.ts:138-153, 543`); not a node ("No approval step is inserted into the YAML", `06-workflows-delivery-and-acceptance.md:1497-1498`) | Audience, timeout | Approval node (A5), long waits beyond 24 h (A9; `WC/limits.ts:34`), the person seat (F11) |
| **Decisions record** | Append-only human decisions readable by later steps | No | | A8 (deliver doc) |
| **Watchdog signals** | Evidence that work is stuck | Leases fence attempts, attempts exhaust to `stalled` (`BPS:2256-2263`), an owner-lease cron re-arms the engine (`BPS:2524-2562`); no elapsed-time enforcement ("no code enforces elapsed run time today", `06-…md:1803-1804`) | Thresholds per signal | **Yes (F12)**: signals and the three-level policy |

**Artifacts, context and memory**

| Primitive | What it is | On `origin/main` | A customer configures | Bakery must add |
| --- | --- | --- | --- | --- |
| **Artifacts and refs** | Immutable versions handed off as `{artifactId, versionId, sha256}` | Yes (`14-artifacts.md`; lane inputs frozen at admission, `coordination-admission.ts:10-25`) | | |
| **Artifact kinds, validators, facts** | What a document must look like and what the engine may branch on | Proposed: deliver doc 4.1, organization kinds `org.<slug>.<name>` (deliver doc 4.7) | Their own kinds, templates, fact schemas | A2 (deliver doc). New validator *rule types* stay Bakery engineering, by design |
| **Context directory** | What a session receives: brief, decisions, pinned inputs as files plus an index | Proposed: deliver doc 4.4; `apps/server/src/modules/knowledge/context-budget.ts` exists but nothing imports it | | Deliver doc A-gaps, plus seat inputs: charter, brief, memory snapshot, inbound handoff (F13) |
| **Memory** | Scoped, sourced, versioned learning | Tables designed (`01-data-model.md:1637-1672`); `memory.promote` is registered but not implemented; nothing reads `memory_entries` | Review and retire entries | A seat scope beside the repository scope, a read path into the context directory, the promotion path (F14; issue #22) |

**Authoring**

| Primitive | What it is | On `origin/main` | A customer configures | Bakery must add |
| --- | --- | --- | --- | --- |
| **Coordinator** | The agent that turns words into proposals | Yes, as the organization's agent definition with slug `coordinator` (`apps/server/src/modules/conversation/postgres.ts:167-187`), so the customer chooses its agent version; effects are a closed set (`packages/contracts/src/coordinator-turn.ts:6-93`); its instructions are hard-coded in the worker (`apps/worker/src/claude-coordinator.ts`, `SYSTEM_TEXT`) and it loads no skills | Which agent version runs it | A `definitionProposal` effect (F16), workflow-scoped conversations (F17), and loading the coordinator agent's own skills so a customer can teach it their factory conventions (F18) |
| **Templates** | Locked, copyable definitions | Yes: locked `preset:` workflows (`workflows/postgres.ts:41, 298, 489`), copy in the client (`apps/web/src/pages/library/copy-workflow.ts`) | Copy and change | Nothing new; team templates follow once F1 to F12 exist |

**What genuinely needs Bakery engineering** is short: the route node, seats and their state, the seat dispatcher, the guard library with a counter catalog and its extension point, a team budget scope, the handoff kind, watchdog signals, seat memory, and three coordinator changes. Everything else a customer composes from what already exists, or from what the editor and deliver designs already propose.

**The no-private-paths rule**, stated so it can be tested:

1. Every built-in template (Deliver, the product team) is data in the public format. It must pass `POST /v1/workflow-validations`, open in the code view, and copy into an organization with no fields a customer cannot write.
2. The engine never branches on a template id, a seat id or a seat name. Seat behaviour comes only from the seat's declared fields.
3. Bakery's own counters (for example "open pull requests") are registered through the same counter extension contract a provider or plugin would use.
4. The coordinator changes definitions only through the same edit operations as the editor and Ask Bakery (issue #39).

**What a customer needs to build their own team shape or routing rules**, once F1 to F12 ship:

| To build | They use | Bakery engineering still needed? |
| --- | --- | --- |
| Any team shape: which roles exist, who can hand to whom, where work enters and ends | Seats, handoff paths, exits, entry and escalation seats, seat groups | No |
| Judgment-based routing ("bugs to Bug fix, UI to Web") | Seat briefs and the agent's choice among declared paths | No |
| Fact-based routing ("only to Reviewer when QA passed") | Path `when` conditions over facts of their own artifact kinds (`org.<slug>.*`, deliver doc 4.7) | No, once A2 exists |
| People in the loop | Person seats, approval paths | No, once A5 and A9 exist |
| Flow control: WIP, capacity, gates, loop limits, spend | The guard library with its parameters; built-in counters | No |
| A limit on something Bakery does not count ("Jira issues in review", "deployments today") | A new counter source | **Yes, or the counter extension point (F9, D10)** |
| A new kind of guard (for example "no two items touching the same file at once") | | **Yes**: guard types are a closed library by design |
| A new validator rule for their artifact kinds | | **Yes**: validator rule types are a closed library (deliver doc 4.1) |
| A queue order other than priority, then age (for example "oldest customer-reported first") | Priority set by a person or by intake mapping | **Yes**, if ever needed: an ordering-policy option |
| A new stuck signal | Thresholds on the built-in signals | **Yes**: signal types are engine-owned |
| A seat that does deterministic work without an agent | A `kind: workflow` seat running a workflow of non-model actions | No |

The pattern is deliberate. Shapes, paths, routing and parameters are data a customer writes. Anything that needs new code to evaluate safely, such as a new counter source, guard type or validator rule, goes through Bakery or a defined extension point. A customer never gets an escape hatch into arbitrary code.

### 2.2 Compositions

| What people call it | Built from |
| --- | --- |
| **Scripted workflow** | Trigger, steps, flow nodes, approvals, artifact kinds, budgets |
| **Team** | Trigger (enqueue), a route at the root, seats, handoff paths, guards, counters, a team budget, seat memory, watchdog thresholds |
| **A seat that runs a workflow** | A seat of kind `workflow`, whose visit is a child run of a pinned scripted workflow (2.4) |
| **Describe it** | The coordinator agent, `definitionProposal` patches, an unlisted draft, Run (freeze to an unlisted version), Save (copy to the library) |
| **Bakery templates** | Deliver (oneshot, lean, full, prd: deliver doc section 5), Product team (section 3.9), Review pair (OpenRig's "implementation pair": builder plus reviewer seats, `openrig-architect` pattern catalog), Triage desk (one triage seat routing into existing workflows) |

### 2.3 What a definition is

One document format, `apiVersion: bakery.dev/v1`, `kind: workflow`. The shared keys mean the same in both modes. The body differs.

```yaml
apiVersion: bakery.dev/v1
kind: workflow
mode: team                 # NEW. scripted (default, today's grammar) | team
name: ...                  # presentation, outside the digest (06…md:902-912)
inputs: {...}              # shared: what one run (one work item) receives
limits: {...}              # shared: per run (per work item): wallClock, maxCostUsd, maxAttempts; team adds maxHops
agents: {...}              # shared: default agent per action
artifactKinds: [...]       # shared (deliver doc A2)
# scripted body
steps: [...]
# team body (NEW)
charter: "..."             # team-wide instructions; in the digest
team: {entry, escalation, maxActiveItems, maxSessions, budget, rules: [...]}
seats: [...]
```

`mode: team` is not a separate engine. The compiler turns `seats` and `team` into one semantic node, `route`, at the root of an otherwise ordinary semantic document, so everything downstream (digest, compiler pin, plan, worst case, run snapshot, admission) is the existing pipeline (`WC/compile.ts:196-245`). Seat ids follow node id rules and stay stable across versions, so state keyed by seat id (memory, pause, capacity) survives a new version.

### 2.4 The route node, and why it is still a workflow

**Semantics, defined by lowering.** A `route` with seats S1..Sn, entry E, exits X and `maxHops` H means exactly this, written in today's constructs:

```yaml
- id: team
  repeat:
    max: H                                  # hop limit
    seed: {currentCandidate: {next: E}}
    until: $repeat.currentCandidate.next in X
    steps:
      - id: visit
        branch:                              # n-way, by nesting
          when: $repeat.currentCandidate.next == "S1"
          then: [S1's visit step]            # agent.freeform with role, inputs, outputs (deliver doc A1, A4)
          else: [ ... the same for S2..Sn ... ]
    outputs:
      currentCandidate: {next: <the visit's validated handoff fact: to>}
```

Two things make this sound. The interpreter stays pure, because the next seat comes from a recorded step result (the validated `bakery.handoff` artifact's `to` fact), which is exactly the kind of input the interpreter already reads (`WI/interpret.ts:27-51`). And the compiler can bound it: worst case = H x the most expensive seat visit, using the existing worst-case pass (`WC/passes/bounds.ts:65-116`).

**Why a native node and not the literal lowering.** The literal form breaks today's limits for any real team: `repeat.max` is at most 8 (`WC/limits.ts:26`), and an 11-seat team written as nested two-armed branches is 11 levels deep against a node depth of 8 (`WC/limits.ts:16`). So `route` is its own semantic node with its own bounds (H ≤ 50, seats ≤ 24), added at the documented extension points: shape keys and shapers (`shape.ts:84-91, 1213-1220`), the node union (`WC/schema.ts:351-357`), the flow, bounds and plan passes, a new interpreter revision (`WI/revisions.ts:17-34`: revisions are append-only and pinned per run), and the engine's unsupported-node check (`plan-admission.ts:122-147`). The lowering above stays as its specification and as a conformance test.

**What the interpreter does not decide.** Cross-run rules are not interpreter decisions, because the interpreter must not read a database (`WI/interpret.ts:27-31`). The interpreter only says "dispatch a visit to seat S". The engine's step admission (`BPS:1640-1808`, where budget is already reserved) then checks the guards. If a guard says no, the run is parked in `waiting_capacity` at seat S. That status exists and the engine already releases runs in it (`BPS:2452-2457`). The seat dispatcher re-arms the highest-priority, oldest parked run when capacity frees or a counter drops. This keeps the interpreter a pure function of one run, and puts everything about the team as a whole in admission, which is where coordination-plan lane admission already sits (`run-command.ts:1094-1106`).

**Seats that run a workflow.** A visit to a `kind: workflow` seat starts a **child run** of the pinned workflow version, linked to the item's run, and waits for its named outcome. It is not inlined like G14's `call`: a team item with 20 hops through a Deliver seat would exceed the 1000 expanded-step limit (`WC/limits.ts:22`) if Deliver's steps were copied into every hop. The child keeps its own limits, run record and run view; its worst-case cost counts toward the parent's.

### 2.5 How the modes nest

| Nesting | Answer | How |
| --- | --- | --- |
| A team seat runs a scripted workflow | **Yes, v1** | `kind: workflow` seat; child run; outcome mapped to a path with `on: {done: qa, needs_human: pm, ...}` |
| A scripted workflow calls another scripted workflow | Yes (G14) | `call`, inlined, two levels |
| A scripted workflow contains a routed block (agents decide inside one run) | **Later (D8)** | The same `route` node, not at the root; seats are ephemeral (no memory scope, no queue) |
| A scripted workflow hands an item to a standing team and waits | Later | A "Send to team" action that enqueues an item and waits for its outcome, like a child run |
| A team seat is another team | Later | The same "Send to team" action, as a seat of kind `workflow` |

The limit for all of them: two levels of nesting, and a parent pins exact published versions, so recursion is impossible by construction (UX-SPEC section 13, "Versioning").

### 2.6 What is the same in both modes

| Concern | Scripted | Team | Shared mechanism |
| --- | --- | --- | --- |
| Triggers | A firing starts a run | A firing enqueues an item at the entry seat | Automations (`automations/start.ts`); team overlap policy is always "queue" |
| Queues | Worker jobs only (`jobs`, pulled by hosts) | Seat inboxes on top, as parked runs | Run status `waiting_capacity`; task priority |
| Artifacts and handoffs | Step outputs wired by reference | The same, plus one `bakery.handoff` per visit | `ArtifactRef`, kinds, validators, facts; nothing but declared artifacts crosses a boundary (deliver doc 3.1) |
| Approvals | Approval node (A5) | Approval paths and person seats | The same approval rows and human-only decisions (`approvals.ts:138-153`) |
| Budgets | Per action, per run (worst case at compile time) | Per visit, per item (H x max visit), per team per day | `budget.ts` accounts plus a team scope |
| Versioning | Runs pin a version | Items pin a version; seat state keyed by stable seat id | Drafts, publish, use; run snapshot (`run-command.ts:247-299`) |
| Outcomes | Named outcome per run (A7) | Named outcome per item; seats map child outcomes to paths | One outcome vocabulary |
| Context | Fresh session per step | Fresh session per visit plus charter, brief, memory | Deliver doc context directory |
| Audit | Run, steps, artifacts | The same, plus handoff records | One run view; the item timeline is a run view |
| Editor | Steps diagram | Seats diagram | One editor, one panel, one code view (section 5) |
| Describe it | Coordinator proposes steps | Coordinator proposes seats and paths | One `definitionProposal` effect |

## 3. Team mode in depth

Everything in this section configures the primitives in 2.1: seats, routes, paths, guards, counters, memory. The defaults named here (ping-pong 3, capacity up to 8, 1,200-character summaries) are parameters a team definition can change. The product team in 3.9 is one possible composition, not a built-in behaviour.

### 3.1 Seats

A **seat** is a durable role in a team. It is declared in the definition and keeps a stable `id` across versions, which is OpenRig's "stable seat identity, fluid occupant identity" rule (`seat-continuity-and-handover`, SKILL.md "Core architectural decision"). A seat has:

| Part | What it is | Lives in |
| --- | --- | --- |
| `id`, `name` | Stable key; display name (G3 names) | Definition |
| `brief` | Role instructions: what this seat does, what done looks like for it, when to send work back. OpenRig's `guidance/role.md`. At most 8 KiB. | Definition, part of the digest |
| `agent` | Who does the work: an agent version (model, harness, tools, budget, its own skills). Falls back to the team's `agents` map, then the repository profile, as steps do today. | Definition |
| `skills` | Extra pinned skills for this seat (needs G13) | Definition |
| `kind` | `agent` (default), `workflow` (the seat runs a scripted workflow per item), or `human` (an approvals and questions inbox) | Definition |
| `role` | `writer` (default), `reviewer` (deliver doc rule 4 isolation applies), `recorder` | Definition |
| `handsTo` | The seats and exits this seat may hand a work item to (section 3.3) | Definition |
| `capacity` | How many items it works on at once (1..8). A seat is a role with a pool, not one process. | Definition; can be lowered at run time |
| `memory` | What the seat has learned: versioned entries, each sourced from an artifact (section 3.5) | State, keyed by team and seat `id`, survives new versions |
| status | Active, paused, draining | State |

**A seat is not a running agent.** There is no live occupant to keep warm, compact, hand over or restore. Each time a work item reaches the seat, the engine starts one fresh, bounded session (a **visit**) from the seat's definition, its memory and the item's artifacts. That is the core difference from OpenRig, where `orch-pm@bakery-v1` is one Claude Code process that has been running for three days (`rig ps --nodes --rig bakery-v1`: 11 sessions, "UPTIME 3d 1h").

The `capacity` change has a practical consequence. The live `bakery-v1` rig has `qa.qa`, `qapool.qa2` and `qapool.qa3`: three sessions of the same `local:agents/qa` spec, because one long-lived session can only do one thing at a time. In Bakery that is one **QA** seat with `capacity: 3`. Distinct seats are only needed where the roles differ in brief, agent, skills or memory, as `dev.server`, `dev.web`, `dev.workflows` and `dev.bugfix` do.

### 3.2 The work queue and routing

**A work item is one run of the team version, attached to one task.** Each item has exactly one holder at any time: a seat (queued in its inbox or in a visit), a person (a human seat or a pending approval), or an exit. This single-holder rule is OpenRig's hot potato (`queue-handoff`, "The hot-potato terminal-turn-rule"), but enforced by the data model.

- **Intake.** Work arrives through the same triggers workflows use (automations: a GitHub issue labeled `ready`, a schedule, a ticket source, by hand from a task, or a Describe-it conversation). For a team, a firing **enqueues** a work item at the team's `entry` seat instead of starting a standalone run. The overlap policy is always "queue". Ticket readiness rules (doc 10) decide what may enter; the team decides what happens next.
- **Seat inboxes.** An item handed to a seat waits in that seat's inbox until the seat has free capacity and every rule allows dispatch (WIP limits, team concurrency, budget, pause). The queue is not a separate store: it is the set of team runs whose current position is "waiting for seat X". Queue depth per seat is a count, not a new table.
- **Order.** Priority first (task `priority` 0..100 already exists, `01-data-model.md:518`), then age. A human can reorder. Agents cannot.
- **Dispatch.** The engine starts a visit when capacity frees. Nothing needs to be nudged. OpenRig's default-nudge semantics, `--no-nudge` footguns and "pull after hand-off" discipline (`queue-handoff`, "Default-nudge semantics" and "after you hand off, PULL") are all replaced by the scheduler.
- **Routing is the seat's decision, inside the declared paths.** The entry seat (typically Triage) decides which developer seat a new item goes to. Every later move is decided by the seat that holds the item, at the end of its visit.
- **Seat groups (optional).** A handoff target may be a group, such as "any developer". The engine assigns it to the member seat with the most free capacity. This is the useful part of OpenRig's pod, reduced to a routing convenience.
- **Splitting.** A seat with `may: [split]` (typically the PM) may end a visit by splitting the item into up to 8 child items. They become child tasks through the existing coordination-plan model (lanes, prerequisites and typed artifact inputs; `coordination-plan.ts:6-7, 48-70`). Each child enters the same team at a seat the split names. The parent waits until the children finish. This is the only fan-out in team mode; a single item never runs in two seats at once.

### 3.3 Handoff paths and the handoff record

**Allowed paths are declared and enforced.** Each seat lists `handsTo`. The engine refuses any handoff not on that list. Two paths are implicit on every seat: escalation to the team's `escalation` seat (default: the entry seat, or the human seat if there is one), and `blocked`. This is stricter than OpenRig, where edges "help agents understand the topology but don't constrain launch" except for ordering (`openrig-architect`, Step 5), and the queue enforces only that a closure reason exists.

**Every visit ends with exactly one handoff.** The seat's session must publish one artifact of kind `bakery.handoff` (a JSON kind in the deliver doc's kind model, section 4.1):

```json
{
  "to": "qa",                       // a seat in handsTo, an exit, "escalate" or "blocked"
  "reason": "ready_for_review",     // closed enum per path kind (below)
  "summary": "Implemented the retry cap; tests in apps/server/... pass. Unsure about the 24 h edge.",  // 1..1200 chars, shown to the next seat inline
  "outputs": {"pr": "<ArtifactRef>", "receipt": "<ArtifactRef>"},  // what this visit produced, by slot
  "blockedOn": null,                // a question, an approval or another item, when to = blocked
  "memory": []                      // optional memory proposals (section 3.5)
}
```

The server validates it in the publication transaction, like any kind: `to` must be on the seat's paths, the path's required outputs must exist and match their kinds, and its fact conditions must hold. Rules that forbid a move (exit gates, ping-pong and hop limits, 3.4) are checked here too. Rules that only delay a move (capacity, WIP limits, budget) never reject it: the item waits in the target seat's inbox. A session that ends without a valid handoff does not leave the item idle: it is a typed fault, the seat gets one retry with the diagnostic, and a second failure escalates. OpenRig's "drafted-park failure" and "agent ends a turn without a handoff" (`queue-handoff`, failure mode 1) cannot occur.

Handoff reasons are a small closed set, mapped from OpenRig's closure reasons (`queue-handoff`, "Durable handoff field shape"):

| Bakery `to` / reason | OpenRig `closure_reason` | Effect |
| --- | --- | --- |
| a seat, `ready_for_<x>` / `changes_needed` / `routed` | `handed_off_to` | Item moves to that seat's inbox |
| `blocked`, with `blockedOn` | `blocked_on` | Item parks; the engine wakes the same seat when the blocker resolves |
| `escalate` | `escalation` | Item moves to the escalation seat with the summary as the question |
| exit `done` | `no-follow-on` | Item ends; exit rules (gates) are checked first |
| exit `declined` | `denied` | Item ends with a named outcome, reason required |
| (human only) `cancel` | `canceled` | Item ends |

A **handoff record** row is written for every move: item, from, to, reason, summary, artifact refs, visit id, who (seat or principal), time. It is the item's history and the source for the board, the run view and the watchdog. It carries the resolved artifact refs, not live pointers, which is the same rule as OpenRig's `--body-context` snapshot ("the qitem stores the resolved content in its body plus the ref for provenance", `queue-handoff`).

**A path can carry conditions** in the definition:

```yaml
handsTo:
  - qa: {requires: [pr]}                  # must have produced a pr artifact
  - reviewer: {requires: [qa_report], when: "$facts.qa_report.status == 'passed'"}
  - human: {approval: true}               # this move asks a person (section 3.7)
```

`when` reads validated facts only (deliver doc rule 6). The agent chooses among the paths whose conditions hold.

### 3.4 Rules: what the engine enforces and what agents decide

| The engine enforces (deterministic, every time) | Agents decide (judgment, inside those bounds) |
| --- | --- |
| Which handoffs exist; a move off the declared paths is refused | Which declared path to take, and why |
| Every visit ends with one valid handoff; otherwise retry once, then escalate | What to write in the summary and the artifacts |
| Path requirements: required outputs, kinds, fact conditions | Whether the work is good enough to move on |
| **Gates before exits**: e.g. `done` requires a passing QA report and an approving review on the current candidate head | The QA verdict and the review findings themselves |
| **WIP limits** from a closed counter set: open pull requests created by the team, items held per seat, items waiting for people. A move into a limited seat waits in the inbox while the limit is reached (back-pressure, never failure). Example: `open_pull_requests <= 8` blocks dispatch to the four developer seats. | Triage priority suggestions (a human sets priority) |
| **Ping-pong limits**: at most N moves between the same two seats for one item (default 3), then escalate | Whether to send work back |
| **Hop limit**: at most `maxHops` visits per item; the per-item worst case cost is `maxHops` x the most expensive seat visit, so the compiler's worst-case guarantee still holds | |
| **Budgets**: per visit (seat agent limits), per item (`limits`), per team per day (new) | How to spend the visit's budget |
| Concurrency: seat `capacity`, team `maxActiveItems`, team `maxSessions` | |
| Reviewer isolation for `role: reviewer` seats (deliver doc section 3.1 rule 4) | |
| Approvals bound to the exact artifact digest; decisions only from authenticated people | |
| Candidate currency: a review or QA report on an old head does not satisfy a gate | |
| Splitting bounds: who may split, at most 8 children, children re-enter this team | How to split |
| Named outcome on every exit (deliver doc A7) | |

The rule set is closed and declarative on purpose. A team cannot run arbitrary code to decide what is allowed, for the same reason kind validators are a closed library (deliver doc 4.1).

### 3.5 Context: persistent role, fresh sessions

**Recommendation: adopt "persistent role, fresh sessions" outright.** The seat is durable; the session is not. Every visit is a fresh, bounded session, exactly the deliver doc's step rule ("A step is one fresh, bounded session", section 3.1 rule 1), with the seat adding a few inputs a scripted step does not have (charter, brief, memory, its own last summary on the item).

What a visit receives, resolved once at dispatch and frozen into the visit's input, so a retry sees the same thing:

1. **Team charter.** Team-wide instructions: how this team works, what "done" means, escalation norms. OpenRig's `CULTURE.md`. In the definition.
2. **Seat brief.** In the definition.
3. **Seat memory snapshot.** The seat's active memory entries at a pinned revision, as an index plus mounted files, inline-bounded (default 8 KiB inline). OpenRig's `LEARNED.md`.
4. **The work item's brief** (`bakery.brief`) and **decisions record** (`$run.decisions`, deliver doc 4.6).
5. **The item's artifacts**: the current version of each named artifact the item has accumulated (plan, PR description, review records, QA reports), as the deliver doc's read-only context directory with a generated index (deliver doc 4.4 option C). A `reviewer` seat sees only the kinds it may read.
6. **The inbound handoff**: the previous holder's summary, plus any human messages addressed to this seat about this item (section 3.7).
7. **Its own last visit on this item**, if it has had one: that visit's handoff summary. This is the "note to self" a developer gets when QA sends work back.
8. **The repository** at the item's candidate head.

What it does not receive: any earlier transcript, any other seat's live session, any "current" pointer. Transcripts are archived for people and never handed on (deliver doc rule 3).

**Seat memory** is the one genuinely new piece of context state. Doc 17 already defines the right rules ("Memory promotes evidence, never policy", `17-context-and-handoffs.md:403-415`): a promotion names its source artifact version, scope, author and conflict-scan result, and never changes permissions, workflow policy or agent instructions. The existing tables fit with one change: `memory_entries` is scoped by `repository_id`, which is required (`01-data-model.md:1639-1652`). Add an optional seat scope (team workflow id, seat id) beside it (F14). A visit may propose entries in its handoff (`memory: [...]`, each citing an artifact the visit produced or read); they land as `proposed` (`memory_entries.status`, same table). Who activates them is an owner decision (D5; recommendation: a person, in the seat's Memory tab, in the first version).

**What about rework and continuity?** When QA sends an item back, the developer seat starts a fresh visit with QA's summary, QA's report, its own previous summary and the current head. That is usually enough, because the work is in artifacts and git, not in the conversation. Where it is not, a seat may opt in to **warm rework**: the new visit exactly resumes the seat's own previous session *for the same item*, under doc 17's exact-resume rules ("Session continuity has two explicit modes", `17-context-and-handoffs.md:132-152`; issue #33), at most once per item. A different seat never resumes another's session.

**Compared with OpenRig:**

| Concern | OpenRig today | Bakery team mode |
| --- | --- | --- |
| Session lifetime | One long-lived session per seat, across all its work, for days | One session per visit; minutes to hours, capped by time, turns and cost |
| What carries knowledge across items | The live conversation, plus `LEARNED.md` (seat), pod `LEARNED.md`, mission `NOTES.md` (`openrig-operating-model` section 2) | Seat memory (versioned, sourced), the team charter, item artifacts |
| Context pressure | Compaction: a precompact hook writes a restore packet, a bridge injects one restore directive; `rig compact` is a ~180 s guided cycle (`session-compaction-and-restore`, "The three mechanisms") | Does not arise between visits. Inside one visit, compaction is bounded by doc 17's maximum count (`17-context-and-handoffs.md:449-453`) |
| Handoff payload | Qitem body plus an optional context pack snapshotted into the qitem | Handoff record plus pinned `ArtifactRef`s and a 1,200-character summary (same snapshot principle) |
| Replacing who does the work | Seat handover: candidate occupant (resume, fork, rebuild, fresh), binding, two independent outcomes, provenance, an 8-phase cutover SOP (`seat-continuity-and-handover`) | Change the seat's agent version in a new team version. In-flight items keep their pinned version. Memory stays with the seat id. No occupant to move. |
| Recovery after a crash | `rig up` restores sessions from snapshots; "If resume fails, say so loudly" | The visit's attempt is retried from its frozen input; the item never loses its holder |
| Failure modes | Compacted seat drops the hot potato; drafted park; idle with a stocked queue; restore packet loses intent (`session-compaction-and-restore`, failure modes) | Structurally excluded: no session outlives its visit, and every visit ends in a validated handoff |
| What is lost | | The warmth of a seat that has been "in the room" for days: cheap follow-up questions and unrecorded instincts. Mitigated by memory, summaries, and warm rework. OpenRig itself calls its current posture "Pets, not cattle (today)... Cattle support is on the roadmap" (`forming-an-openrig-mental-model`, "Cultural posture"). |
| Cost | Every turn re-reads a growing transcript | Each visit pays for its inputs once; memory and charter are re-read each visit, so both stay small |

### 3.6 Watchdog and stuck handling

Because sessions are bounded and every visit ends in a handoff, OpenRig's main stuck case, "the agent who finished and went idle without closing/handing off" (`orchestration-team`, "Monitoring & intervention"), does not exist. What remains is evidence-driven and owned by the engine, with OpenRig's three intervention levels (`watchdog`, "The 3-level intervention stack"):

| Signal (evidence, never cadence) | Level | Action |
| --- | --- | --- |
| A visit's attempt stops heart-beating or its lease expires | Wake | Reclaim and retry the attempt from its frozen input (the existing expired-attempt reclaim, `execution/coordination.ts:1146-1148`) |
| A visit hits its time, turn or cost cap without a handoff | Refocus | One new visit for the same seat with a refocus note: finish or hand off, the item's brief, the stop conditions. A second overrun escalates. |
| An invalid handoff (off-path, missing required output, failed validator) | Refocus | One retry with the diagnostic, then escalate |
| Ping-pong limit or hop limit reached | Alignment checkpoint | Escalate to the escalation seat or a person, with the move history |
| Upstream finished but the downstream artifact the path needs is missing | Refocus the producer | OpenRig's "producer-edge repair" (`watchdog`, "Artifact-pool loop edges"), here a path requirement |
| An item waits in an inbox past its SLA because of a WIP limit or capacity | None for agents | Shown on the team health strip. Not the agent's fault; nobody is woken. |
| A seat faults N times in a row (default 3) | Pause the seat | Notify the team owner; items stay queued |
| A blocked item's blocker resolves | Wake | Re-dispatch to the seat that parked it |

Scan and act are separate, as OpenRig prescribes, and quiet evaluations are not recorded. The watchdog never re-approves already-approved work ("Refocus becomes bureaucracy theater", `watchdog` failure mode 6) and never wakes a seat that has no item.

### 3.7 How people take part

- **Message a seat.** A composer on the seat's panel, "about item #123" or "for this seat".
  - About an item with a visit in progress: delivered into the running session as a steer (`sessions.steer` is already in the catalog, `17-context-and-handoffs.md:419`).
  - About an item that is queued or elsewhere: stored on the item and given to this seat at its next visit (input 6 above).
  - For the seat in general: becomes a proposed memory entry or a suggested charter or brief change. It never silently changes policy (doc 17).
  - Every message is durable and shows in the item's history. OpenRig's "Human escalation happens in chat but not as a durable attention item" (`queue-handoff` failure mode 5) is excluded by construction.
- **Human seat and approval paths.** A `human` seat is an inbox: when an item reaches it, Bakery opens an approval or question (the existing `bakery.questions` rows, kind `approval`, human-only decisions, `approvals.ts:138-153, 543`) whose options are that seat's `handsTo`. The person's decision picks the next path. A path marked `approval: true` does the same inline. Both need the deliver doc's `human.approval` (A5/G1) and long waits (A9/G5).
- **Steering.** Pause or drain the team or one seat; lower a seat's capacity; reorder an inbox; cancel an item; move an item to any seat (a person may leave the declared paths; the move is recorded in the decisions ledger with a reason; agents never can); raise a limit for one item (a `limit` decision, deliver doc 4.6).
- **Ask Bakery about the team.** "Why is #123 stuck?" goes to the coordinator, which reads the handoff history and watchdog events. OpenRig's `rig ask`.
- **Changing the team.** Seats, paths, rules and briefs are the definition: edit a draft, publish, use. In-flight items finish on the version they started with; new items get the new one. Run-time controls (pause, capacity down, reorder, move) are not definition changes.

### 3.8 OpenRig concepts and their Bakery equivalents

| OpenRig | What it is there | Bakery | Carry over? |
| --- | --- | --- | --- |
| **Rig** (RigSpec) | A topology of long-lived agents, booted and restored as one system | **Team**: a workflow definition in team mode, plus its intake. "Running" means its version is in use and intake is on. | Yes, as a definition, not a process |
| **Rig class** (kernel, project, ephemeral...) | Lifecycle policy | Not needed. A team is in use or not; a one-off pipeline is a run. | No |
| **Pod** | A context domain whose members share working context and `LEARNED.md` | Optional **seat group**: a handoff target ("any developer") and a visual grouping. No shared-context semantics. | Partly |
| **Seat / member** | A stable address with a live occupant session | **Seat**: stable role with brief, agent, skills, capacity, memory. No live occupant. | Yes, redefined |
| **Occupant**, seat handover, `continuityOutcome` | Who is in the seat; swapping them honestly | The seat's agent version, changed by publishing a new team version | No (nothing to swap) |
| **Edge** `delegates_to` | Primary work direction; affects launch order | `handsTo` path, enforced | Yes, enforced |
| **Edge** `escalates_to` | Informational | Implicit escalation path on every seat, enforced | Yes |
| **Edge** `can_observe` | Informational | A read grant: seat X's visits may read seat Y's artifact kinds on the same item. Later. | Later |
| **Edge** `collaborates_with` | Informational | "Consult": ask another seat a question without handing the item over. Later. | Later |
| **Queue / qitem** | Durable work handoff, `pending → in-progress → done` with closure reason | **Work item** (a run) and **handoff record** | Yes |
| **Nudge** | Wake-ping on a queue write | The scheduler dispatches when capacity frees | No |
| **`--body-context` packs** | Context snapshot riding the handoff | Pinned `ArtifactRef`s on the handoff | Yes |
| **Compaction restore** | Keeping a long session useful | Not needed between visits; bounded inside one | No |
| **Watchdog** | Wake, refocus, alignment checkpoint by evidence | Engine watchdog (3.6) | Yes |
| **Mission / slice** | Work tree: SPEC, PROGRESS, PROOF, NOTES | **Parent item / item** (split children); SPEC is the brief, PROGRESS is the run status and outcome, PROOF is the evidence artifacts, NOTES is the decisions record plus handoff summaries | Yes, as artifacts |
| **CULTURE.md** | Rig constitution | Team **charter** | Yes |
| **LEARNED.md** | Per-seat lived knowledge, written by the seat itself | Seat **memory** (sourced, versioned, proposed by the seat) | Yes |
| **AgentSpec / profile / skills** | Agent blueprint | Agent version, skill versions | Already exists |
| **Snapshots, `rig up`/`down`** | Restore sessions after shutdown | All state is in Postgres | No |
| **Chatroom** | Rig-wide broadcast | Team activity feed (read-only projection of handoffs and decisions) | Partly |
| **`rig capture` / `transcript`** | Look at a pane | The visit's live output stream and archived transcript | Already exists |
| **`proof judge`** | Attributed acceptance | Gates before exits, satisfied by reviewer and QA artifacts on the current head | Yes, as gates |
| **Permission policy** (`builtin:yolo` in bakery-v1) | Harness permissions | Agent `allowedCapabilities`, repository rules, effect policies | Already exists |

### 3.9 Worked example: the `bakery-v1` rig as a Bakery team

The real rig (`rig export`: 11 seats in 6 pods) becomes 9 agent and workflow seats, because the three QA sessions are one seat with capacity 3, plus a person seat for the product owner and a merge seat. Developer seats run the scripted Deliver workflow per item as a child run; Triage, PM, UX, QA and Reviewer are single agent visits. Every key below is a public primitive from section 2.1; nothing in it is specific to Bakery's own team.

```yaml
apiVersion: bakery.dev/v1
kind: workflow
mode: team                                   # NEW
name: bakery-product-team
charter: |
  We ship working software with honest evidence. Done means merged with a passing QA
  report and an approving review on the merged head. Send work back with specifics.
inputs:
  brief: {type: TaskBrief, required: true}   # one work item
limits:                                       # per work item
  maxHops: 20
  maxCostUsd: 120
  wallClock: 7d                              # needs A9
team:                                         # NEW: across work items
  entry: triage
  escalation: pm
  maxActiveItems: 12
  maxSessions: 8
  budget: {usdPerDay: 300}
  rules:
    - counterLimit: {counter: open_pull_requests, max: 8, seats: [server, web, workflows, bugfix]}   # the WIP limit
    - pingPong: {max: 3}
    - exitGate: {exit: done, requires: [{seat: qa, fact: "qa_report.status == 'passed'"}, {seat: reviewer, fact: "review.blocking == 0"}], onHead: current}
seats:
  - id: triage
    name: Triage
    agent: <economy agent>                   # was claude-haiku in the rig
    brief: Read the issue. Bugs with a clear repro go to Bug fix; UI work to Web; ...
    handsTo: [bugfix, pm, design]
  - id: pm
    name: Product manager
    agent: <strong agent>
    may: [split]
    handsTo: [server, web, workflows, design, owner]
  - id: design
    name: UX designer
    handsTo: [pm, web]
  - id: server
    name: Server, auth and contracts
    kind: workflow
    runs: {workflow: deliver-lean@3}         # a child run per visit (2.4)
    on: {done: qa, needs_human: pm, blocked: pm, no_progress: pm}
  - id: web
    name: Web UI
    kind: workflow
    runs: {workflow: deliver-lean@3}
    on: {done: qa, needs_human: pm, blocked: pm, no_progress: pm}
  - id: workflows
    name: Workflows, Inngest and CI
    kind: workflow
    runs: {workflow: deliver-lean@3}
    on: {done: qa, needs_human: pm, blocked: pm, no_progress: pm}
  - id: bugfix
    name: Bug fix
    kind: workflow
    runs: {workflow: deliver-bugfix@1}
    on: {done: qa, needs_human: pm, blocked: pm, no_progress: pm}
  - id: qa
    name: QA
    role: reviewer
    capacity: 3                              # was qa.qa, qapool.qa2, qapool.qa3
    outputs: {qa_report: {kind: bakery.verification@1}}
    handsTo:
      - reviewer: {when: "$facts.qa_report.status == 'passed'"}
      - server
      - web
      - workflows
      - bugfix
  - id: reviewer
    name: Independent reviewer
    role: reviewer
    outputs: {review: {kind: bakery.review-record@1}}
    handsTo: [owner, server, web, workflows, bugfix]
  - id: owner
    name: Product owner
    kind: human
    audience: task_owner
    handsTo: [merge, pm]
  - id: merge
    name: Merge
    kind: workflow
    runs: {workflow: merge-and-close@1}      # one delivery.merge step
    on: {done: done, blocked: pm}
```

The rig's `can_observe` edges (reviewer observes dev.server; pm observes qa) are dropped in the first version; the reviewer reads the item's artifacts anyway.

## 4. Describe it: from a conversation to a running, saveable pipeline

### 4.1 What exists today

Two separate systems exist, and nothing connects them.

**The conversational coordinator is a read-only model turn.**
- A message with intent `agent_request` queues a turn pinned to the organization's `coordinator` agent definition (`apps/server/src/modules/conversation/postgres.ts:167-187, 316-355`). An Inngest function runs one turn at a time per conversation (`turn-runtime.ts:743-776`), re-checks the requester's authority (`turn-runtime.ts:253-372`), and loads up to 1000 messages, open questions and the task's current plan revision (`turn-runtime.ts:374-472`).
- In production each turn is one `coordinator.turn` worker job (`coordinator-worker.ts:333-620`), Claude Code only, on a subscription route (`coordinator-worker.ts:421-443`), with tools `Read,Glob,Grep`, a JSON schema and a 180 s limit (`apps/worker/src/claude-coordinator.ts:28-32, 173-189`).
- It may emit only four effects: `reply`, `question`, `planRevision` (a title and 1..100 text steps) and `noop`, at most 20 per turn (`packages/contracts/src/coordinator-turn.ts:6-93`). Output is capped at 27,904 bytes (`coordinator-turn.ts`, `COORDINATOR_OUTPUT_MAX_BYTES`). Its prompt says "You can never approve a plan, start work, or act for a participant. Humans approve plans." (`claude-coordinator.ts:66-67`).
- Output is re-parsed server-side and applied in one fenced transaction; invalid output applies nothing (`coordinator-worker.ts:274-290`; `turn-runtime.ts:474-650`).
- A plan revision supersedes older ones and opens an approval only when the task's stage policy says `plan: human_approval` (`plan-revisions.ts:136-269, 229-240`; `stage-policy.ts:13-27`). Only a person can decide (`approvals.ts:138-153, 543`); the approved revision is consumed at run admission (`approvals.ts:791-884`).
- Questions and plan revisions require the conversation to have a task (`question_requires_task`, `turn-runtime.ts:530-556`). There is no workflow-scoped conversation.

**Coordination plans are a typed lane DAG for splitting one task into child tasks.**
- A lane has `key`, `repositoryAlias`, `title`, `instructions` (≤ 20,000 chars), `prerequisites`, typed `outputs` (`artifactType`) and `inputs` (`{fromLane, outputKey}`) (`apps/server/src/modules/work/coordination-plan.ts:13-70`). Limits: 32 lanes, concurrency 16 (`coordination-plan.ts:6-7`); `maxConcurrency` is recorded but not enforced (`coordination-plan.ts:75-78`). One lane per repository (`shared_writable_checkout`, `:335-373`).
- **A lane has no agent, skill, role, workflow or step structure.** Materializing makes one child task per lane with the instructions as its description (`coordination-command.ts:751-905, 823-830`). Running a lane is an ordinary `POST /v1/tasks/:id/runs` with a workflow version; nothing starts ready lanes automatically.
- Admission refuses a lane run until prerequisites complete and freezes the exact upstream artifact versions into the run snapshot (`coordination-admission.ts:70-196`; `run-command.ts:1094-1106, 1200`). Revisions reuse unchanged completed lanes (`coordination-reuse.ts:51-133`) and cancel in-flight lanes they do not keep (`coordination-command.ts:907-950`). A shared ceiling caps spend across the plan (`budget.ts:500-543`).
- `origin` is `ad_hoc`, `saved_workflow` or `ticket`, insert-only and outside every digest (`migrations/bakery/0141_coordination_plan_origin.sql:9-10`; `coordination-plan.ts:95-141`), shown by `PlanProvenance.tsx:26-42`.
- The e2e test proves one spec created as ad hoc, as ticket, or from a saved workflow has an equal digest, lanes and admission behaviour; only the origin differs (`tests/e2e/prove-saved-and-ad-hoc-coordination-use-the-same-semantics_test.ts:57-87, 120-151`). Lanes are completed by SQL in the test, not by agents (`tests/helpers/coordination-lanes.ts:157-193`).
- The only conversion is one way: a **published** workflow's `parallel` node becomes a plan, with lane steps flattened to prose and every output typed `patch` (`coordination-workflow.ts:9-11, 114-139, 151-249`). **No plan-to-workflow path exists**, and no conversation path creates a plan; the web client can only list and cancel plans (`apps/web/src/api/client.ts:3538, 3556`). The coordination page is a table, not a diagram (`TaskCoordinationPage.tsx:340-351`).

So doc 23's sentence, "The same coordinator supports ordinary tasks without a saved workflow ... optionally save a reusable workflow afterward" (`docs/technical-design/23-skills-and-evaluations.md:116`), and doc 10's "Without a saved workflow, the agent coordinates the task using the same durable plan" (`10-tickets.md:26`) describe intent, not code. What is real is the semantic-equivalence guarantee between ad-hoc and saved plans, and the pattern that makes it work: origin is provenance, not semantics.

### 4.2 The design: the informal pipeline is an unlisted definition, not a second model

The tempting route is to make the coordination plan the informal pipeline and convert it to a workflow on save. It does not work: a lane cannot say which agent, skill or role does the work, how steps loop or wait, or who hands to whom, so saving would invent structure, and the forward mapper already loses it by flattening steps into prose (`coordination-workflow.ts:114-139`). Keep coordination plans for what they are good at: splitting work across repositories and child tasks (the PM seat's `split`, Deliver's `epic` size).

Instead, apply the e2e test's principle one level up: **a described pipeline is a workflow definition with `origin: conversation`**. It is the same object the editor edits, compiles with the same compiler, runs on the same engine, and draws on the same diagram. "Nothing formal" means the person never sees or names a file, not that no definition exists.

Describe it is a composition too, not a feature with private powers. The coordinator can only emit the public edit operations, so any pipeline or team it builds is one a customer could build by hand in the editor, and the other way round. What it knows about building factories comes from its agent version's skills and the organization's library templates (F18, D11). Bakery's own know-how is a default skill and a few templates, which a customer can replace or extend with their own conventions.

```
conversation ──coordinator proposes──▶ draft of an unlisted definition (origin: conversation, not in the library)
     │                                         │  validated continuously, drawn on the diagram as a proposal
     │◀───────── person: Accept / Change ──────┘
     │
     ├── person: Run ──▶ freeze an unlisted version (immutable, digest, origin: conversation)
     │                     └─▶ run (scripted) or a team in trial mode, items added by hand (team)
     │
     └── person: Save as workflow / Save as team ──▶ library draft copied from that version
                                                        └─▶ the normal Publish ▶ Use this version (a team's intake can only be switched on here)
```

Step by step:

1. **Describe.** "When an issue gets the `ready` label, have an agent triage it. Bugs go to a bug-fixer, features to a PM who plans. Developers build with Deliver; QA tests; a reviewer approves; I approve merges. Never more than 8 open PRs." The coordinator decides the mode from the words (who decides next: fixed order → scripted; roles that pass work → team), and says which it chose and why in its reply.
2. **Propose.** A new coordinator effect, `definitionProposal`, carries a **patch** against the conversation draft (a list of edit operations, the same operations the editor's "+", panel and Ask Bakery produce, issue #39), not a whole file. A patch fits the 27,904-byte output cap; a whole team definition with briefs might not. The server applies it to a proposal copy, compiles it, and stores the result with its diagnostics. The conversation's side panel draws it with the proposal states (5.5). The reply says, in plain words, what it built, what each seat or step does, the per-run worst-case cost the compiler computed, and anything it guessed ("No designer agent is saved; using the default").
3. **Accept or change.** Accept applies the patch as one undoable edit. "Make QA stricter" or "add a designer before Web" produces the next patch against the accepted draft. A person can also edit the same draft directly on the diagram or in the code view; the coordinator's next turn receives the current draft, so words, diagram and code are three editors of one draft. Concurrent edits use the draft's existing precondition; a stale proposal shows "Refresh suggestion" (UX-SPEC section 7).
4. **Run.** Pressing Run is the human act that freezes the draft into an **unlisted version**: immutable, digested, `origin: {kind: conversation, conversationId, turnId}`, readable by the conversation's participants, absent from the library and from "Use this version". Scripted: a run of that version on this task. Team: the team starts in **trial mode** on that version: intake is off and items are added by hand ("run it on #212 and #215"). A team that takes work by itself must first be saved (step 5), because a standing team has to be findable in the library by everyone who might need to pause it; its intake is then switched on by the ordinary "Use this version".
5. **Save as workflow / Save as team.** Copies the unlisted version into a new library draft (the existing "Make a copy" flow, `apps/web/src/pages/library/copy-workflow.ts`), named by the person, with lineage back to the conversation. Then the normal Publish and Use this version (UX-SPEC section 5). Saving changes no running item; they stay on the unlisted version they started with.

**Round-trip.** Because the conversation draft is a real draft, round-tripping is a property, not a feature: the editor's diagram, outline and code view operate on the same tree (UX-SPEC sections 1 and 8), and the coordinator is a fourth editor that emits the same operations. A saved workflow can be opened in a conversation too ("Ask Bakery" on a library workflow binds a conversation to its draft, issue #39), so the words path works in both directions.

### 4.3 What the coordinator may do without asking

| Without asking | Only after a person's explicit act |
| --- | --- |
| Reply, ask questions, explain the pipeline | Accept a proposal into the draft (the person's Accept) |
| Propose patches; validate them; show the compiler's cost and problems | Run a pipeline: freezes the unlisted version and starts work |
| Read the draft, the library (workflows, agents, skills it may read), the team's live state and history | Switch a team's intake on: only after Save, through "Use this version", because intake starts work without anyone present |
| Suggest a mode, seats, rules and agents | Save to the library, publish, use a version |
| Say what a run would cost and what it would touch | Raise any limit or budget, grant any scope, choose a private skill, add a repository |
| Prepare a list of items for a trial team ("#212 and #215") as a one-click action | Add items to a trial team (the person confirms the prepared list); approve anything (plans, gates, merges) |

The same boundary already holds for plan revisions (`claude-coordinator.ts:66-67`) and is required by issue #39 ("nothing runs or activates without the corresponding authorized operation"). The coordinator stays a read-only model turn: every effect it emits is a typed, server-validated request, never a side effect.

### 4.4 Why informal runs stay safe and auditable

- **Same admission.** An unlisted version passes the same compiler, run admission, budget reservation, stage policy, repository rules and approvals as a published one. The only differences are `origin` and library visibility, both outside the digest, which is exactly the coordination-plan origin rule (`0141_coordination_plan_origin.sql:9-10`) applied to definitions.
- **Same record.** Every run pins a version digest, so "what did this run do and why" has one answer whether or not anyone pressed Save. The conversation turn that proposed it, the person who accepted it and the person who pressed Run are all recorded.
- **Same limits.** The per-run worst case is computed before Run is offered. A team in trial mode also has its daily budget and concurrency limits, with conservative defaults (decision D9).
- **Nothing standing without a decision.** An informal team never takes work on its own. Intake stays off until a person saves the team to the library and uses that version, so every standing team is a named library item someone owns.
- **Provenance travels.** A saved workflow records that it came from conversation X, version Y. A run from the unlisted version keeps pointing at it after the save.

### 4.5 What is missing for Describe it

Each is listed with its smallest change in section 6:
- **F17**: a workflow-scoped conversation.
- **F16**: the `definitionProposal` effect, which the server applies and compiles.
- **F15**: unlisted definitions with an `origin`.
- **F19**: running a frozen draft (UX-SPEC G7).
- **F18**: loading the coordinator's own skills, so customers can teach it their conventions.
- **F22**: the proposal diagram in the conversation panel, and Save as workflow via copy.

## 5. Visualization: one editor, two layouts

The workflow editor spec's principles hold unchanged: Bakery draws the diagram, nobody draws a line, "+" is the only way to add, one panel beside the diagram, diagram and outline are the same tree, code view edits the same draft (UX-SPEC sections 1, 2, 8). Team mode changes only what the body of the diagram is.

### 5.1 The page is the same

| Part | Scripted workflow | Team |
| --- | --- | --- |
| Top card | "How it starts" (trigger) | "How work arrives": the same trigger choices, plus "Entry seat: Triage". Says "Each start adds a work item to the queue." |
| Body | Steps top to bottom; branches and lanes as columns | **Seats** top to bottom by handoff distance from the entry seat; seats at the same distance side by side |
| Ends | The last step | **Exit pills**: Done, Declined, each showing its gate ("Needs: QA passed, Review approved") |
| "+" | On every connector | One "+ Seat" under each row of seats and at the bottom |
| Selected item | A step's panel | A seat's panel |
| Workflow settings | Limits, default agents | Same, plus **Team rules** (WIP limits, ping-pong, gates, daily budget, concurrency) |
| Mode switch | | "Workflow" or "Team" chosen when the item is created; switching a draft's mode is a code-view operation (decision D1) |

### 5.2 Drawing seats and paths without hand-drawn lines

Handoff paths are the content of a team, and they contain cycles (QA sends back to Web). Drawing every path as a line would recreate the spaghetti the editor spec rejects. The rule:

- **Layout is computed.** Rank each seat by the shortest path from the entry seat. Rank 0 at the top. Seats of equal rank sit side by side, ordered by declaration. A seat no path reaches shows in a final row with "Not reachable" (a validation problem).
- **Forward paths are lines.** A path to a higher rank is drawn as a connector, the way a step-to-step connector is drawn today.
- **Backward and sideways paths are chips, not lines.** A path to the same or a lower rank shows on the source card as one line of text: "Sends back to Server, Web, Workflows, Bug fix". The human seat's paths read "Asks Product owner".
- **Selection shows everything.** Selecting a seat outlines every seat it can hand to with the dashed outline the editor already uses for "Works from" (UX-SPEC section 2, "On selection"), and every seat that can hand to it with a dotted one. That one interaction replaces drawing a dense graph.
- **Cards stay one line**, as in UX-SPEC: icon, name, and either "Agent · Strong reviewer", "Runs Deliver (lean), version 3", or "Person · Product owner". Rules that touch the seat show as one badge: "WIP 8" on developer seats, "x3" for capacity.

### 5.3 The seat panel

Top to bottom, the same structure as the step panel (UX-SPEC section 4):

1. Name.
2. One sentence: what a seat is ("Work items wait here until this seat is free. Each item gets a fresh session.").
3. **Does the work:** "An agent decides" (default), "Runs a workflow" (picker of published workflows, the "Run a workflow" pattern from UX-SPEC section 13), or "A person decides".
4. **Brief:** the role instructions, a text area with a character count.
5. **Can hand to:** a checklist of the other seats and exits, in rank order, each with an optional "only when..." condition built from the same three controls as "If / otherwise" (UX-SPEC section 2). For a workflow seat this becomes **When the workflow ends:** one select per outcome (Done, Needs a person, Blocked, No progress).
6. **Agent** and **Skills**, exactly as UX-SPEC section 13.
7. **Advanced:** capacity, role (writer, reviewer), visit time, turn and spend limits, warm rework on or off, may split work.
8. Footer: Move up, Move down, Delete. Delete asks what happens to paths that point at the seat.

### 5.4 Live: the same diagram, with the queue on it

The Runs tab becomes **Live** for a team (it has one standing queue, not a list of independent runs), with the version in use drawn read-only.

- **Seat cards** show status as a word and a colour: "Working on #123 · 12 min", "2 working · 3 waiting", "Idle", "Paused", "Waiting for you" on a human seat. Queue depth is a number on the card, never only a colour.
- **The path an item just took** is highlighted for a few seconds after each handoff. Reduced motion shows a static "just now" label instead.
- **Rule badges** turn live: "Open PRs 7 of 8", amber at the limit, with "3 items waiting for this" in the panel.
- **A health strip** above the diagram: items in progress, waiting for people, blocked, finished today, spend today against the daily budget. Each number opens a filtered list.
- **Board view.** A toggle beside Diagram and Outline: one column per seat in rank order, plus Done; each card is a work item with its title, age and last handoff summary. It is the team's outline view on phones. It is also the natural starting point for issue #381 (tracker status moves drive work), where columns map to tracker statuses later.
- **A work item's own view** is a vertical timeline of its visits: one card per visit with seat, outcome, duration, cost and the handoff summary; a visit that ran a workflow expands into that workflow's run diagram (UX-SPEC section 13, "How a run shows nested progress"). That timeline is a scripted-run view of the path the item actually took, so a team item and a scripted run read the same way.
- **The seat panel in live mode** adds: its inbox (reorderable by people with permission), current visits with "Open the live output", "Message this seat", Pause, and a Memory tab (proposed and active entries, with sources).

### 5.5 Describe it on the same diagram

A pipeline proposed in a conversation is drawn by the same component in the conversation's side panel. It uses the editor's AI-proposal states (UX-SPEC section 7): new seats or steps dashed green, changed amber, removed struck through, and the bar "Bakery suggests 6 changes. Nothing runs until you choose Run." An unsaved pipeline carries a banner: "Not saved to the library. Runs from this conversation are recorded like any other." with **Save as workflow** (or **Save as team**) on it.

## 6. Gaps against the current code and contracts

Each gap names the smallest change that closes it. Gaps owned by the companion designs are referenced, not repeated: **G** = workflow editor spec, **A** = deliver-as-workflow. "Prereq" lists what must land first.

### Definition and compiler

**F1. No team keys in the definition.** Root keys are fixed at `apiVersion, kind, inputs, limits, agents, cancel, steps` (`WC/passes/shape.ts:63-71`), and the normalized document has no seats (`WC/schema.ts:552-595`).
*Smallest change:* add `mode`, `charter`, `team` and `seats` to the root key set and shapers. `mode: team` requires `seats` and forbids `steps`. Seat ids use the node id pattern. Briefs and charter are in the digest; names are not (G3). Add diagnostics: `seat_unreachable`, `path_unknown_seat`, `exit_gate_unsatisfiable`, `seat_agent_forbidden` (for person seats). Bump `compilerVersion` (`WC/schema.ts:553`; `WC/digest.ts:8`). Prereq: none.

**F2. No agent-chosen next step.** The interpreter is deterministic over recorded results (`WI/interpret.ts:27-51`). Containers are `steps | branch | repeat | wait | parallel` (`shape.ts:84-91`).
*Smallest change:* a semantic `route` node `{entry, seats[], paths, exits, maxHops}`, specified by the lowering in 2.4. Worst case in `WC/passes/bounds.ts` as `maxHops x max(seat visit)`. Plan steps keyed `team.<seat>@<hop>` in `WC/plan.ts`. Interpreter revision 3 = revision 2 plus `route`, reading the last visit's recorded `handoff.to` (`WI/revisions.ts:17-34`). Remove `route` from the engine's unsupported-node list (`plan-admission.ts:122-147`). Prereq: F3.

### Handoffs, seats and queues

**F3. No handoff contract.** Nothing records who passed work to whom, and nothing validates a move.
*Smallest change:* (a) a built-in JSON artifact kind `bakery.handoff@1` (fields in 3.3; facts `to`, `reason`), validated in the publication transaction against the seat's paths, the path's required outputs and its fact conditions. A failure becomes a typed attempt fault with a diagnostic the retry receives. (b) A `run_handoffs` table: `{runId, seq, fromSeat, toSeat, reason, summary, artifactRefs, visitStepKey, actor (seat or principal), at}`. It is append-only, and its rows come from the engine or an authenticated person. Prereq: A2 (kinds and facts).

**F4. No seat queue or dispatcher.** `waiting_capacity` exists and the engine releases runs in it (`run-command.ts:228`; `BPS:2452-2457`), but nothing sets it or re-arms such runs.
*Smallest change:* in step admission (`BPS:1640-1808`), when a visit to seat S is refused by a guard (F8), set the run to `waiting_capacity` with `waitingFor: {seat: S}` and release the run. Add a seat dispatcher, a per-minute cron plus an event on every visit end and handoff, like `automations/promote.ts:47-102`. It re-arms the highest-priority, oldest parked run per seat that now fits. Queue depth comes from this index on runs: `(workflow_id, waiting_seat, priority desc, created_at)`. Prereq: F2, F8.

**F5. No seat or team state.** Nothing persists a team's live state or per-seat controls.
*Smallest change:* `team_instances {workflowId, versionInUse, intake: off|trial|on, paused}` and `team_seats {workflowId, seatId, paused, capacityOverride}`, keyed by stable seat id. Runtime controls write these. Definition changes still need a new version. Prereq: F1.

**F6. Triggers cannot enqueue into a team.** Firings start a task plus run (`automations/start.ts`). Overlap is `skip | queue_one` (`automations/tick-plan.ts:96-131`). Event triggers are not matched yet (`automations/firing.ts:36-40`).
*Smallest change:* when the automation's target is a team version, the firing creates the task and a run that starts parked at the entry seat. Add an overlap policy `queue`, which the team's `maxActiveItems` bounds. "Add item" by hand uses the same path. Event matching stays with issue #36. Prereq: F4, F5.

**F7. Split does not re-enter a team.** Coordination plans make child tasks (`coordination-command.ts:751-905`) whose runs a caller must start (`tests/helpers/coordination-lanes.ts:128-142`).
*Smallest change:* a `split` handoff (on seats with `may: [split]`) creates a coordination plan whose lanes name an entry seat. Materializing it enqueues each ready child into the same team version. The parent run parks with `waitingFor: {children}` and resumes when the plan reaches a terminal projection. Coordination `maxConcurrency` (`coordination-plan.ts:75-78`) gets enforced by the same dispatcher. Prereq: F4, F6.

### Rules, budgets and people

**F8. No guards across runs.** Only per-run limits and in-run parallel concurrency exist.
*Smallest change:* a closed guard library evaluated at step admission. The types are `capacity` (per seat), `teamConcurrency` (`maxActiveItems`, `maxSessions`), `counterLimit {counter, max, seats}`, `exitGate {exit, requires: [{seat, fact}], onHead: current}`, `pingPong {max}` and `hopLimit` (from `maxHops`). Each guard is a declarative record with an evaluator in code. A refusal parks the run (F4) or escalates (`pingPong`, `hopLimit`), never fails it. Prereq: F2.

**F9. No counters.** The WIP example, "max 8 open PRs", needs a count Bakery does not keep.
*Smallest change:* a counter catalog. A counter is `{key, scope: team|seat, type: integer, source}`, kept current from domain events. The built-in counters are `open_pull_requests` (from delivery and GitHub facts), `items_held` and `items_waiting_people`. Expose the source as an **extension contract** for providers and plugins, owned with the kernel architect (D10). Bakery's own counters register through it. Prereq: F8; pull-request facts from #40 and #57.

**F10. No team budget scope.** Budget accounts are installation-month, run and coordination plan (`budget.ts:640-700`).
*Smallest change:* a `team_day` account keyed by `(workflowId, UTC date)`, reserved at visit admission beside the run account. When it is exhausted, new visits park and in-flight visits finish. Prereq: F5.

**F11. No person seat.** Approvals are task stage policy (`stage-policy.ts:13-22`), not nodes (`06-…md:1497-1498`). Waits stop at 24 h (`WC/limits.ts:34`).
*Smallest change:* a person seat's visit opens an approval or question row whose options are the seat's paths. The decision becomes that visit's `bakery.handoff`, written by the server and attributed to the person. Prereq: A5 (approval node semantics), A9 (long waits), A8 (decisions record).

**F12. No watchdog.** Leases, attempt exhaustion (`BPS:2256-2263`) and the owner-lease cron (`BPS:2524-2562`) exist. Elapsed run time is not enforced (`06-…md:1803-1804`). Sessions have no turn or cost cap (deliver doc A12).
*Smallest change:* a per-minute evaluator over parked runs, live visits and handoff records. It emits the signals in 3.6 and applies one of `wake | refocus | escalate | pause_seat`, writing only loud evaluations to a `team_watchdog_events` log. Thresholds are guard-like parameters in the definition. Prereq: F3, F4, A12.

### Context and memory

**F13. Visits do not get seat context.** There is no context pack on the server path. `context-budget.ts` is unimported, and lane handoff refs are frozen but not delivered to jobs (`coordination-admission.ts:10-25`).
*Smallest change:* extend the deliver doc's `CONTEXT.md` generator (deliver doc 4.4) with four sections: charter, seat brief, memory index, and inbound handoff plus the seat's own last summary on this item. All of them are resolved at visit admission and frozen into `run_steps.input`. Prereq: deliver doc context directory (A1, A2), F3, F14.

**F14. Memory has no seat scope and no reader.** `memory_entries.repository_id` is required (`01-data-model.md:1639-1652`), `memory.promote` is registered but not implemented, and nothing reads `memory_entries`.
*Smallest change:* make `repository_id` nullable when `(team_workflow_id, seat_id)` is set, with a check that exactly one scope is present. Handoff `memory` proposals create `proposed` entries that cite a source artifact version. Activation follows D5. The visit context reads active entries at a pinned revision. Prereq: issue #22 (promotion with provenance), F13.

### Describe it

**F15. Definitions have no origin and no unlisted state.** There is no origin column on `workflow_definitions` and no server-side copy. Copy is composed in the client (`apps/web/src/pages/library/copy-workflow.ts`).
*Smallest change:* add `workflow_definitions.visibility: library | unlisted` and an insert-only `origin` jsonb with the kinds `library`, `conversation {conversationId, turnId}` and `copy {fromVersionId}`. Like the coordination-plan origin (`0141_coordination_plan_origin.sql:9-10`), it stays outside every digest. An unlisted definition is readable by the conversation's participants and absent from library lists and "Use this version". Prereq: none.

**F16. The coordinator cannot propose a definition.** Its effects are `reply | question | planRevision | noop` (`coordinator-turn.ts:6-93`), and output is capped at 27,904 bytes (`COORDINATOR_OUTPUT_MAX_BYTES`).
*Smallest change:* add a `definitionProposal` effect `{draftId, baseRevision, ops: [...]}` carrying the editor's edit operations (issue #39's "typed proposed patch"). The server applies it to a proposal copy, compiles it with the existing validation, and stores `{ops, diagnostics, worstCase}` for the turn. Accepting is a separate human operation that applies the ops to the draft with its CAS (`workflows/postgres.ts:569-640`). Prereq: F17, the editor's operation set (UX-SPEC slices 2 and 3).

**F17. Conversations are task-scoped.** Questions and plan revisions fail with `question_requires_task` (`turn-runtime.ts:530-556`). The turn input has no draft (`turn-runtime.ts:374-472`).
*Smallest change:* let a conversation bind to a workflow, an existing one or a new unlisted one (F15). The turn input then carries the current draft (canonical JSON, bounded inside the existing 100,000-byte job input, `COORDINATOR_INPUT_MAX_BYTES`) and its latest diagnostics. Prereq: F15.

**F18. Customers cannot shape the coordinator.** Its instructions are hard-coded in `apps/worker/src/claude-coordinator.ts` (`SYSTEM_TEXT`), and its agent version's skills are not loaded.
*Smallest change:* keep the safety rules hard-coded (read-only, no approving, no starting work). Move factory know-how into a Bakery-published skill, and materialize the `coordinator` agent version's `skillBindings` for the turn, as edit runs do (deliver doc 4.4, "Skills"). Give it read access to the organization's library templates. A customer then teaches it their conventions with their own skill. Prereq: none.

**F19. An unpublished definition cannot run.** Runs start only from a published version, a preset or an active workflow (`run-command.ts:938-960`; G7).
*Smallest change:* Run in a conversation publishes the accepted draft as an immutable version of the unlisted definition (the existing publish path, `workflows/postgres.ts:700-825`, which already re-validates). The run then starts with `workflowVersionId`. A team in trial mode is `team_instances.intake = trial`, where items are added by hand only. Prereq: F15, F5 for teams.

**F20. People cannot talk to a seat or steer a team.** `sessions.steer` is in the catalog (`17-context-and-handoffs.md:419`), but nothing seat-shaped exists.
*Smallest change:* a seat message operation. It steers the live visit if one holds the item, and otherwise stores a note on the item for that seat's next visit (F13). Add run-time controls on F5 for pause, drain, capacity down, reorder and move. A move off the declared paths requires a reason and writes a decision (A8). Prereq: F5, A8.

### UI

**F21. No team rendering.** The editor spec draws steps only. The coordination page is a table (`TaskCoordinationPage.tsx:340-351`).
*Smallest change:* the seat layout, seat panel, live overlay, health strip and board in section 5, built on the editor's diagram component (UX-SPEC slice 1 onward). Prereq: UX-SPEC slices 1 to 4, F1.

**F22. No proposal diagram in a conversation, and no Save.**
*Smallest change:* render the stored proposal (F16) with the editor's AI-proposal states (UX-SPEC section 7) in the conversation's side panel. Add "Save as workflow" / "Save as team", which creates a library definition with `origin: copy` from the unlisted version (F15), using the existing copy flow. Prereq: F15, F16, UX-SPEC slices 1 and 9.

### Dependencies on the companion designs, in one list

A1 (named input and output slots), A2 (artifact kinds, validators, facts), A5 (approval node), A7 (named outcomes), A8 (decisions record), A9 (waits beyond 24 h), A12 (session turn and cost caps), the deliver doc's context directory, G3 (step names), G7 (run a draft, covered here by F19), G13 (step skills) and G14 (`call`). Team mode can start without G14, because seats use child runs (2.4).

## 7. Owner decisions

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Is a team a kind of workflow or a separate library item? | (a) One "Workflow" item with a mode chosen at creation; (b) a separate "Team" item | **(a)**, shown in the library as two filters, "Workflows" and "Teams", over one list. Same draft, publish, use, versions, permissions, copy. The mode is fixed at creation in the editor; changing it is a code-view edit, because a scripted body and a team body do not convert into each other mechanically. |
| D2 | Primitives first or features first? | (a) Ship the route node, seats, queue and rules as public definition primitives and build the product team as a template; (b) build a team feature, generalize later | **(a)**, per the owner's framing. The test is mechanical: every built-in template must pass the public validation endpoint, open in the code view and copy into an organization with no private fields; the engine never branches on a template id. |
| D3 | A seat is one session or a role with capacity? | (a) Role with `capacity` (pool of fresh visits); (b) one named long-lived session per seat, as OpenRig | **(a)**. Three QA sessions in `bakery-v1` become one QA seat with capacity 3. Separate seats only where brief, agent, skills or memory differ. |
| D4 | Fresh sessions per visit, or warm seats? | (a) Fresh always; (b) fresh by default, warm rework opt-in per seat (exact resume of the seat's own session for the same item, once, under doc 17 rules); (c) long-lived seat sessions | **(b)**. Fresh is the default because it is reproducible, cheap and immune to compaction loss. Warm rework covers the one case where continuity clearly pays, a send-back to the same author, without reopening long sessions. |
| D5 | Who activates seat memory? | (a) A person reviews proposals; (b) automatic when sourced and conflict-free; (c) the seat itself | **(a) in the first version**, in the seat's Memory tab. Revisit (b) once evaluations exist (#41, #44). Memory never changes policy (doc 17), whichever is chosen. |
| D6 | May agents split a work item? | (a) No; (b) only seats with `may: [split]`, up to 8 children, which re-enter the same team | **(b)**. Splitting is how OpenRig's PM dispatches parallel work; bounding it keeps the per-item worst case finite. Children use the existing coordination-plan model. |
| D7 | May people move work off the declared paths? | (a) Never; (b) yes, with a reason, recorded as a decision | **(b)**. People are the escape hatch; agents never are. |
| D8 | May a scripted workflow contain a routed (team) block? | (a) Not in v1; (b) yes, same node, ephemeral roles | **(a) for v1, (b) later.** The route node is designed to nest (it is an ordinary node with a worst case), so this is a validator relaxation, not new runtime. Ship teams at the root first. |
| D9 | Defaults that bound an informal team | | `maxActiveItems: 4`, `maxSessions: 4`, a required daily budget at Start (no default), intake off in trial mode. |
| D10 | How do customers get rules or counters Bakery did not ship? | (a) Closed rule and counter library only; (b) closed library plus a counter extension point (a provider or plugin publishes a named, typed counter); (c) arbitrary expressions or code in rules | **(b)**, coordinated with the kernel architect. Rule *types* stay closed and engine-owned, so every guard has known semantics and cost. Counter *sources* are the extension point, because "open PRs" is not the only thing a factory needs to limit (open Jira tickets in review, deployments today). Never (c). |
| D11 | Where does the coordinator get its factory know-how? | (a) Hard-coded prompt, as today; (b) the `coordinator` agent version's own skills and the organization's library templates | **(b)**. Bakery's knowledge of how to build a product team ships as a skill and a template, which a customer can replace or extend with their own conventions. |
| D12 | Can an unsaved pipeline run? | (a) Only after Save; (b) yes, from an unlisted immutable version frozen at Run | **(b)**. It honours "no formal file needed" without losing anything audit needs, because every run still pins a digest. A team that takes work by itself (intake on) must be saved first and then used, so every standing team is findable and owned. |
| D13 | Edge kinds beyond hands-to and escalation | `can_observe` (read another seat's artifacts), `collaborates_with` (consult without handing over) | Later. Hands-to plus implicit escalation covers the `bakery-v1` rig; the reviewer already reads the item's artifacts. |
| D14 | Name | "Team", "Rig", "Factory", "Crew" | "Team" in the product. "Factory" is the umbrella for what customers build, not an object in the UI. |

## 8. Build slices, in dependency order

Two tracks. **Describe it** (D) can start now and is useful for scripted workflows on its own. **Team** (T) starts when the deliver doc's artifact kinds exist. Each slice ships alone and leaves everything before it working. Issue numbers are open issues on `MarkTripoli/bakery` (`gh issue list`, 14 November 2026). Where none fits, the slice says "new", and the natural parent epic is #1 (E07, workflow authoring, execution and automations).

### Track D: Describe it

| # | Slice | Closes | Depends on | Issues | Done when |
| --- | --- | --- | --- | --- | --- |
| D1 | **Unlisted definitions and Run from a conversation** (scripted only) | F15, F19 | none | #39, #61, #66 | An accepted conversation draft runs from an immutable unlisted version; the run snapshot pins its digest; the library does not list it; `origin` is outside the digest |
| D2 | **Workflow-scoped conversations** | F17 | D1 | #39 | A conversation bound to a workflow carries the current draft and diagnostics into the turn; questions work without a task |
| D3 | **`definitionProposal` effect** | F16 | D2; UX-SPEC slices 2 and 3 (edit operations) | #39 (its checklist is this slice) | The coordinator proposes ops; the server compiles them and stores the diagnostics and worst case; Accept applies them as one undoable CAS edit; nothing runs or publishes |
| D4 | **Coordinator skills** | F18 | none | #39, #42 | The `coordinator` agent version's skill bindings reach the turn; Bakery's factory know-how ships as a skill; a customer skill changes its proposals |
| D5 | **Proposal diagram and Save as workflow** | F22 | D1, D3; UX-SPEC slices 1 and 9 | #67, #66 | The conversation panel draws the proposal as a diff; Save creates a library draft with `origin: copy`; the running item keeps its unlisted version |

After D5, "describe it, see it, run it, save it" works end to end for scripted pipelines.

### Track T: Team

| # | Slice | Closes | Depends on | Issues | Done when |
| --- | --- | --- | --- | --- | --- |
| T1 | **Team definitions compile** | F1, F2, F3(a) | A2 (kinds, facts) | #1, #30, new | A team definition validates, digests and pins; `route` worst case = hops x max visit; interpreter revision 3 passes a conformance test against the 2.4 lowering on small teams; diagnostics for unreachable seats and unknown paths. No runtime yet. |
| T2 | **Minimal team runtime, by hand** | F3(b), F4, F5, F8 (capacity and concurrency only), F19 for teams | T1 | new (under #1), #58 | Items added by hand move between agent seats on validated handoffs; seats park and re-arm by priority and age; trial mode; one holder per item at all times; restart and concurrent dispatch do not duplicate a visit |
| T3 | **Seat context** | F13 | T2; deliver doc context directory | #14, #6 | A visit's frozen input holds charter, brief, the item's artifacts, the inbound handoff and its own last summary, and nothing else; a reviewer seat cannot read writer-private kinds |
| T4 | **Seats that run workflows** | (2.4 child runs) | T2; A7 (named outcomes) | #62, #30 | A developer seat runs Deliver as a child run per visit; the child's outcome picks the path; child limits and run view are intact |
| T5 | **Rules: counters, gates, ping-pong, hops, daily budget** | F8 (rest), F9, F10 | T2; pull-request facts | #40, #57, new | "Max 8 open PRs" parks developer visits at the limit and releases them as PRs close; `done` refuses without the gate facts on the current head; ping-pong and hop limits escalate; the daily budget parks new visits |
| T6 | **Person seat and approval paths** | F11 | T2; A5, A8, A9 | #60 | An item at a person seat opens one approval whose options are the seat's paths; the decision moves the item and is recorded; a seven-day wait works |
| T7 | **Watchdog, messages and steering** | F12, F20 | T2, T5; A12 | #33 (for warm rework), new | Each signal in 3.6 produces its action and one log entry; a message steers a live visit or waits for the next; pause, drain, reorder and move work; off-path moves need a reason |
| T8 | **Intake from triggers and tickets** | F6 | T2 | #36, #31, #69, #58 | A schedule or a GitHub label enqueues an item at the entry seat; `maxActiveItems` bounds the queue; ticket readiness rules apply unchanged |
| T9 | **Seat memory** | F14 | T3 | #22, #72 | Handoffs can propose sourced entries; a person activates them in the seat's Memory tab; the next visit sees them at a pinned revision; memory never changes policy |
| T10 | **Split into child items** | F7 | T2, T8 | new | A PM visit splits an item into up to 8 children that re-enter the team; the parent resumes when they finish; coordination `maxConcurrency` is enforced |
| T11 | **Team editor, live view and board** | F21 | T1 (read-only diagram); T2 (live); UX-SPEC slices 1 to 4 | #67, later #381 | Seats laid out by rank with chips for back paths; seat panel; live status, queue depth and rule badges; board and item timeline; phone outline |
| T12 | **Describe it for teams** | | D3, D5, T1, T2 | #39 | "Set up a team that ..." proposes seats, paths and rules on the diagram; Run starts trial mode; Save as team copies it to the library |
| T13 | **Templates and the dogfood proof** | (no-private-paths rule, 2.1) | T1 to T8 | #35, #60 | Product team, Review pair and Triage desk ship as locked built-ins that pass the public validation, code view and copy checks; Bakery runs three real issues of its own backlog through the Product team in trial mode, replacing the `bakery-v1` rig for that work |

**The smallest useful team** is T1 + T2 + T3 + T4 with the read-only and live parts of T11: a person adds items by hand, agent and Deliver seats hand work along declared paths, and everyone can watch it. Rules (T5) and people in the loop (T6) make it safe to leave running; intake (T8) makes it standing.
