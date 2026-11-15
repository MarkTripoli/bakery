# One engine: the Bakery kernel and its extension points

Status: design accepted by the product owner on 14 November 2026. Nothing here is
implemented yet. This chapter is the canonical statement of the one-system design.
Where another chapter disagrees with it, this chapter wins and the other chapter
should be corrected. No decision here is pending.

Companion documents, kept for their detail, live in [one-system/](one-system/):

- [Owner decisions](one-system/owner-decisions.md): the decision record. It wins
  over every companion where they differ.
- [Deliver as a workflow](one-system/deliver-as-workflow.md): artifacts, context
  and the Deliver templates (gaps A1 to A18).
- [Factory modes](one-system/factory-modes.md): teams and "describe it" (gaps F1
  to F22).
- [Integrations architecture review](one-system/integrations-architecture-review.md):
  provider packages, ports and guardrails.
- [Workflow editor UX spec](one-system/workflow-editor-ux-spec.md): the editor
  (gaps G1 to G17).

The full kernel proposal, with code citations against `origin/main` at
`d11fb5205`, was written as `one-system.md` in the same design handoff. This
chapter keeps its decisions and drops the evidence tables.

Decision numbers (O1 to O22) are the owner's. Each rule below cites the decision
it comes from.

## 1. Philosophy

**Bakery is a platform.** It runs durable infrastructure and provides primitives
and building blocks. People build their own factory from them. Bakery cannot
build every workflow for everyone, so extending it has to be easy at every skill
level: describe it in words, use the visual editor, copy a template, or write
code with the SDK. All four produce the same stored definition through the same
compiler.

**Domain-neutral kernel.** Bakery is not code-only. People build factories
for any kind of work, for example producing videos, and MCP servers, skills and
integrations all have a place inside workflows. The kernel knows work items,
documents, steps, sessions and rules; it does not know repositories, pull
requests or checks. Software delivery is one module and template pack beside
the kernel (O16), not part of it.

**One system.** New ways of working become plug-ins or new combinations of
existing pieces. They never need an architecture rewrite.

**The dogfooding rule.** Everything Bakery ships, including Deliver and an
OpenRig-style team template, is built only from the same public primitives
customers get. There are no private engine paths. Three mechanical tests make
this checkable:

1. Every template passes the public validation endpoint, opens in the code view
   and copies into an organization with no field a customer cannot write.
2. The engine never branches on a template, kind, seat or provider name.
3. A built-in action or provider registers through the same contract a package
   would.

A built-in that needs something a customer cannot use is a platform gap, and the
gap is closed for everyone.

### Layers

| Layer | Holds | Owner |
| --- | --- | --- |
| 4. Templates | Template packs. The software-delivery pack: Deliver (four sizes), Product team, Review pair, Triage desk, Board pipeline, the coordinator's factory skill | Bakery ships them; anyone copies them |
| 3. Compositions | Workflows, teams, boards, factories | Customers |
| 2. Primitives | The eleven primitives, one compiler, one interpreter, eight extension points | The kernel |
| 1. Infrastructure | Durable execution, workers and worktrees, sessions, artifact store, events and outbox, budgets, grants, effect ledger, audit, integration broker | Bakery runs it |

### How a run works

1. A start creates a run. The run pins everything it will use: workflow version,
   agents, skills, document kinds, rules and budget.
2. The engine picks the next step from the pinned workflow and the recorded
   results. Each step runs in a fresh, bounded session that sees only its
   declared inputs. Its outputs are validated documents.
3. Agents, people and plugins never drive the engine. They return typed results
   (a document, a fact, a handoff, a proposal). The engine checks each one
   against the pinned workflow and the rules before it acts.
4. Anyone with permission can watch any session live and steer it, with or
   without a workflow. Every steer is recorded before it is delivered.

## 2. One engine (O1)

The compiled interpreter is the only thing that decides what runs next. Today
three things decide: the flat preset executor, the plan interpreter and the
coordination lane gate. After convergence there is one.

- The **flat preset executor is retired**. The two presets (`fixed-coding`,
  `fixed-coding-reviewed`) are republished as ordinary compiled definitions.
  Ticket admission and the stage policy point at them. Existing flat runs drain
  on the flat loop, then that code is deleted. No live run is migrated.
- The **plan interpreter becomes the engine**. Its revisions stay append-only
  and pinned per run: revision 3 adds delivery facts and `forEach`, revision 4
  adds `route`.
- The **coordination lane gate becomes the split primitive** (section 5).

The interpreter is a pure function `(document, recorded results) -> next`. It
has no clock, no database and no model. Cross-run rules (capacity, counters) are
checked at step admission, never inside the interpreter.

"What runs next" is not pluggable (O3). There is no scheduler plugin or strategy
interface. Customers express strategy through decision actions (route, assign,
plan; extension point E6), whose output the engine validates before acting.

### Kernel rules

| Rule | Meaning |
| --- | --- |
| K1 Pin at admission | A run freezes every version it uses. Nothing resolves "latest" later |
| K2 Record, then act | The step row exists before dispatch; an effect is prepared in the ledger before it is sent; a firing is recorded before its run |
| K3 Results are data | Conditions read only typed action outputs and validated facts. No branch asks a model, reads free text or runs supplied code |
| K4 Nothing ambient | Every artifact, skill, capability, secret and dollar a step uses is declared and checked at admission and again at the effect |
| K5 Everything bounded | Steps, loops, hops, fan-out, time, money, context and artifact size have ceilings known before the run starts |
| K6 No silent influence | Every session can be watched, and every change to its course by a person or an agent is a recorded input |

Extensions attach only at five checkpoints (run admission, step admission,
result, effect, run end) plus compile time.

## 3. The eleven primitives

| # | Primitive | Responsibility |
| --- | --- | --- |
| 1 | Work item (task) | Carries intent and continuity: brief, scope (the workspaces its steps declare, which may be none; repository links are the software-delivery pack's workspace kind, O23), tracker link, parent and children, priority, its named documents and its decisions ledger. Outlives runs |
| 2 | Definition (workflow and its immutable versions; listed or unlisted) | Steps, order rules, inputs and outputs, limits, default agents, seats and starts. A version never changes. Bounded before it runs |
| 3 | Run | One execution of one pinned version on one work item, with snapshot, budget, status and a named outcome. Runs form a tree |
| 4 | Step (with attempts) | One invocation of one action with a frozen input and a typed result. Exactly one completer finishes it: a worker job, a timer, a person, or child runs |
| 5 | Session | One sitting of an agent. Every session has a live feed and accepts recorded steering (section 9) |
| 6 | Action | The contract of a step type: schemas, capabilities, effect policy, cancellation, retries, timeout, cost ceiling |
| 7 | Agent and skill | Immutable agent versions and digest-pinned skill versions. A seat is a standing role declared in a definition |
| 8 | Artifact | The only handoff channel: named documents with immutable versions. A kind says what a document must contain and which facts the engine may read. People and tools browse artifacts as files in one tree (section 17) |
| 9 | Event and start | Events record what happened; a start matches an event to a definition and creates a run through normal admission |
| 10 | Envelope | Grants, budgets, the effect ledger, rules (repository rules come from the software-delivery pack), human decisions and audit |
| 11 | Interpreter | Decides what happens next inside a run |

Seat, team, board, Deliver, the coordinator and the review loop are not
primitives. They are compositions or modules built on these eleven. Software
delivery (repositories, checks, code reviews, pull requests, merges, the
fixed-coding presets and Deliver) is a native module and template pack beside
the kernel, not inside it (O16: "a native module beside the kernel, not part of
it ... no engine code names a delivery reason"). The engine core does not import
it, so incident, evaluation, content or video factories are peers of software
delivery, not guests.

The user-facing vocabulary stays small (O12). "Workflow" (or "definition") is
what the engine runs. "Plan" means only the document an agent writes.
"Proposal" is what the coordinator suggests. "Split" and "lanes" replace
"coordination plan". "Execution plan" stays internal. O32 adds "Connection" to the user
vocabulary and says "revision" rather than "candidate" and "scope profile"
rather than "repository profile" in the kernel.

## 4. The eight extension points

| # | Extension point | What plugs in | Authored as |
| --- | --- | --- | --- |
| E1 | Actions | What a step does, including `tool.call` on a connection's tool | Data (an agent step preset), a workflow (`call`), a granted tool, or code in a package |
| E2 | Artifact kinds | What a document must contain and which facts it yields | Data: template, rules from platform rule types, fact schema |
| E3 | Start sources | What begins a run | Data (schedule, generic signed webhook) or a provider module |
| E4 | Connections (integration families and providers) | Native providers: trackers, chat, and pack-specific families such as code hosts and deploy (software delivery). MCP servers as a second connection kind | A provider module implementing a family port, or an MCP server definition with a pinned capability snapshot |
| E5 | Library | Agents, skills, seats, workflows, templates, step presets | Data, one lifecycle: draft, immutable version, copy with lineage, "update available", used-by |
| E6 | Decision actions | Who supplies a choice: route, assign, plan | An action whose output fits one of three contracts |
| E7 | Guards and counters | Limits across runs | A closed guard library; counters as data from kernel events, family projections, or values a step publishes |
| E8 | Execution environments | Where a session executes | A provider module of a `compute` family (section 8) |

Closed on purpose, extended only by a platform release: node forms and the
interpreter, step completers, guard types, validator rule types, feed item
kinds, steer kinds, the effect ledger and the checkpoints.

Extensions are data only for now (O6/O7, section 6). MCP needs no ninth extension point: under O24 it is a connection kind (E4) whose tools are actions (E1) bound through the library (E5).

## 5. Coordination plans become split (O2)

Coordination plans stop being a separate system. They become the engine's
**split** primitive: child work items joined by typed artifacts. Five changes:

1. A lane names what it runs (`run: {workflow}` plus inputs). Its
   `instructions` stay as the child's brief.
2. The engine starts ready lanes itself, bounded by a capacity key. Nobody else
   has to start them.
3. A parent run step owns the plan. A `parallel` whose lanes need separate
   child items (for example lanes on several repositories, in the software
   pack) and a split decision both create one, and the step completes
   from the plan's terminal projection.
4. The prose mapper that flattens lane steps into instruction text is replaced
   by a lossless lowering in both directions.
5. The plan spec becomes the fact schema of the `bakery.split` kind, so an
   agent's split and an author's lanes are one structure.

Kept as the implementation of split: the tables, lane digests that fold in
upstream digests, reuse of completed lanes across revisions, stale detection,
the shared budget and cancel that reaches every lane. People see lanes on the
diagram and child items in the run view; the term "coordination plan" goes away.

`forEach` and split stay distinct. `forEach` iterates inside one run. Split
creates child work items.

`call` has one contract with two bindings (O10): it is defined by the child-run
contract (declared inputs and outputs, own limits counted in the parent's worst
case, a named outcome, shared budget and cancel). The compiler inlines it first;
a child-run binding follows when workflow seats and split need it. An author
cannot tell the two apart. A parent pins a published child version, so
recursion is impossible by construction; nesting is limited to two levels.

## 6. Extensions are data only for now (O6, O7)

| Tier | Contents | Where it runs | Status |
| --- | --- | --- | --- |
| T0 Data | Definitions, kinds, skills, agents, step presets, start templates, generic webhook sources | Nowhere: it is validated data | Buildable now |
| T1 Sandboxed code | Code actions and checks, decision actions in code | Only in a worker sandbox, one step at a time | After the isolation tests pass |
| T2 Native | Platform modules and native providers | In the server process | Bakery, or the operator of a self-hosted installation |

- Customers may not supply validator code in the publication path (O6). A
  kind's validator is a composition of platform rule types. Custom logic is a
  sandboxed check action whose typed output drives control flow. Pure
  WebAssembly validators may come later if demand is real.
- Customer code arrives as T1 only once worker isolation is proven by
  hostile-fixture tests (O7). A self-hosted operator may enable T1 and deploy T2
  earlier, because operator and tenant are the same party.
- What never travels in a package: grants, credentials, connections, repository
  bindings, run history and active starts.

## 7. Starts live with the workflow (O8)

- A workflow's starts (triggers) are authored and exported with the workflow, in
  a `starts` list outside the digest. They are switched on only by "Use this
  version". Nothing standing switches on from a conversation.
- There is one start mechanism: an event matcher over provider-neutral events
  that targets a workflow. Ticket admission becomes the `work_item.ready`
  source, and the source policy names a workflow instead of the literal
  `fixed-coding` preset.
- **Readiness** is a generic rule that each provider declares: an item is ready
  when it carries a configured label **and** sits in a configured workflow
  status, matched by stable provider ids. A provider declares which trigger
  kinds it supports (`triggers: label | status`). The existing provenance checks
  (who applied the signal, when, with what role) apply to a status move exactly
  as to a label.
- When work depends on another ticket in a tracker without code, the blocker
  being Done is enough to start.
- A board runs one run per column visit (O9). Documents and decisions belong to
  the work item, not the run. Kanban-style building, where moving cards drives
  the work, comes after V2; only its seams are designed now.

## 8. The execution-environment seam (O22)

Remote VMs (E2B, Daytona, Modal, Fly Machines and similar) get the seam now as
extension point E8. No provider is built in v1.

The engine knows only the worker protocol. An environment provider's whole job
is to make a worker exist somewhere for one attempt: provision, prepare the
repository at the pinned commit, mount the context directory read-only, run the
worker with an attempt-scoped credential, collect outputs as artifacts and run
refs, tear down, and report cost. Six v1 choices keep the door open:

1. No engine code assumes a persistent host, a local path or a warm clone.
2. Placement is data: a step's requirements and an affinity key on the run. Host
   affinity for v1 is that recorded constraint, not an assumption in the
   harness.
3. Writers check out at the pinned candidate, end with a clean commit and name
   `{baseSha, headSha}`.
4. The context directory and the output directory are a step's only file
   contract.
5. Credentials are attempt-scoped and brokered; an agent can use the
   `api_metered` route, so no step depends on a host login unless its agent
   says so.
6. The session feed and steers travel over the lease-protected attempt routes,
   never a host-local socket. The usage ledger accepts a compute kind beside
   model usage.

Under O23, "repository at a pinned commit" reads "each declared
workspace at its pinned revision". The repository, commit and candidate details
above belong to the software-delivery pack; a non-code step's whole file contract is its context and
output directories.

An ephemeral box needs the `api_metered` route, and the provider is a
subprocessor that an Admin enables per repository scope.

In the software-delivery pack there is one linear candidate per repository per run tree (O15). Named
candidates for tournaments come later.

## 9. Watching and steering

Every session, in a workflow or not, has a live feed and a steering inbox (O17).
They are the same for a workflow step, a team seat visit, a plain task and the
coordinator. The shipped output envelope and steering are extended, not
replaced by a separate console.

**Live watch.** You can watch any running work live in the browser or elsewhere.
Click a running node to see its agent output streaming, like Claude Code, and
steer it from there. The feed is a typed, ordered, redacted log (message,
terminal, status, tool, file change, artifact, usage, delivered input). The
diagram is drawn from lifecycle events; the session panel reads the feed.

These rules replace O18 to O21 where they differ:

- **Agents steer and spawn.** Agents can steer other agents and spawn other
  agents or sub-work when they are authorized. Before it acts, the engine checks
  permission, budget, count and depth, and it records every steer and spawn
  exactly like a person's. This overrides the earlier O19 ("agents only message
  and interrupt").
- **Agents and decisions.** Agents may make decisions (approve, raise a limit,
  redirect, take over) only where a workflow explicitly grants it. Otherwise
  decisions are human-only.
- **Reviewer messaging (O18).** Messaging a reviewer is off by default. If a
  workflow turns it on, the review is labelled "steered" and does not count
  where an independent review is required. To overrule a reviewer, the owner
  records an "accept, with reason" decision in the open. A reviewer can still be
  paused or cancelled, and its questions answered.
- **Take over in v1 (O20).** The person becomes the step's completer. They
  provide the step's result themselves, or restart the step with a fresh agent
  and a note. Attaching live to the agent's session or terminal comes later,
  with workspaces and remote VMs.
- **Slack (O21).** Slack posts at milestones: started, waiting on you (with
  Approve and Reject buttons), stuck, failed, and done (with a link to the result, for example a PR). Each
  post links to the live view. Replying in the thread steers the agent, and the
  reply is recorded under the person's linked identity. The raw stream is not
  posted to Slack.

Every steer is recorded before delivery, in the session's inputs and in the work
item's decisions ledger. The interpreter never reads a message steer; it reads
only decisions. A steer adds text and readable artifact references; it cannot
add tools, grants, skills or a role.

## 10. Shapes built from the same parts

| Shape | Built from |
| --- | --- |
| Scripted workflow | Steps, if/otherwise, repeat, `forEach`, at the same time, `call` |
| Team (O4) | Seats plus a `route` node in the same definition format; fresh sessions per visit; no `mode` key and no long-lived seat sessions. No warm rework in the first version (O5) |
| Board (O9) | Starts bound to tracker statuses, steps per status, a set-status step |
| Described pipeline | An unlisted definition the coordinator proposed through the same edit operations as the editor |
| Deliver | Four templates (`deliver-oneshot`, `-lean`, `-full`, `-prd`) sharing two called workflows, built only from public primitives |
| Evaluations (O14) | Kernel runs with an `offline` environment, not a separate durable workflow |

### Loops

Every loop (`repeat`, the editor's prepared "Fix until it passes", and the
loops inside Deliver) has an optional **minimum** and **maximum** iteration
count, set in the loop's panel.

- **Minimum** means "run at least N times even if the exit condition is already
  met". The engine's `repeat` has no minimum today; `repeat.min` is a model gap.
- **Maximum** is `repeat.max`. It is bounded by the compiler's iteration cap,
  which is 1 to 8 today, and by the workflow's `limits.maxRepairCycles`. So
  `1 <= min <= max <= 8`. The compiler counts the worst case from `max`; `min`
  rounds count toward `max`.
- **Pausing for more rounds** (deliver-as-workflow D9) happens only below the
  maximum. A loop may start with a smaller allowance (`repeat.allow`). When it
  uses that allowance without meeting its exit condition, the run pauses for a
  person, who can allow more rounds, accept as is, or stop. More rounds can
  never go past `max`. When `max` is reached, the loop ends as exhausted and the
  run ends `needs_human` with `limit_reached`. Raising the cap of 8 is not part
  of this decision.

## 11. Workflow editor decisions

- The editor is as simple to edit as HubSpot and shows an n8n-style visual
  diagram. The layout runs top to bottom, which replaces the approved
  left-to-right Paper reference; #67's visual check needs a new approved
  reference.
- Publish is never disabled. Pressed with problems, it lists them with "Show me"
  beside each. "Publish and use" is the primary button, with "Publish only" as a
  secondary option.
- The editor shows and edits the workflow's starts as a list at the top.
- Approvals offer Approve, Request changes (sent back with notes) and Reject.
  The workflow owner is the default approver. A wait lasts up to 7 days.
- Two parallel steps that may both write to the same repository or workspace
  are blocked in v1, with a clear message. The rule is decided by what each
  step is allowed to write, whatever its action type: an Implement step and a
  custom agent task with write access both count.
- The step picker shows step types first. Skills and saved workflows appear
  under "From your library". Step names follow the editor spec, for example
  "Implement" and "Fix problems".
- One ready-made loop, "Fix until it passes". Other loops are written in the
  code view.
- "Test workflow" is dropped. To try a workflow, publish it without "Use" and
  run it on one task.
- A step may add skills on top of the ones its agent already has.
- Sub-workflows ("Run a workflow") are built after the core editor slices. A
  called workflow uses its own agents and may contain approvals and waits.
- Private skills can be attached to shared workflows. Attaching one asks for
  confirmation and grants use to everyone who can see or run the workflow. This
  reverses the earlier rule in [chapter 23](23-skills-and-evaluations.md). The
  skill's bytes are never browsable by others; a run's transcript may quote
  them, and the owner is told so at attach time.

## 12. Integration seams

Under O24, integrations and MCP servers are both **connections**
(section 15.4): one broker, one grant model and one effect ledger.


Issue handling is provider-neutral. Providers come in this order: GitHub, then
Linear, then GitLab, then Jira. Users set up integrations in the UI.
Self-hosted providers (GitLab self-managed, GitHub Enterprise Server, Jira Data
Center) are in scope, but not for v1. API tokens are allowed as well as OAuth
and app installs.

Each integration is a self-contained module in `packages/integration-<slug>/`,
with UI, backend and manifest together. Boundaries are enforced mechanically:
import rules, no provider names in core code, a conformance suite and registry
checks. Providers are pure adapters (O13): core owns all the neutral tables, and
provider packages contain no SQL. Families are `tickets` and `chat`, plus the
software-delivery pack's `code` and `deploy`; other packs add their own. Provider webhooks normalize into the neutral event vocabulary that the
one start mechanism reads.

The detailed design is section 12 of [Integrations](09-integrations.md).

## 13. Convergence plan

In dependency order. Each step leaves everything before it working. Steps 2, 3
and the Deliver proof are software-delivery pack work; the rest is kernel. Steps 1 to 3
are the keystone: they make "one engine" true and remove four private paths.

1. **Declare the kernel.** Record one interpreter, the flat executor frozen and
   coordination plans as split. Add rails tests: every built-in definition
   compiles with `apiVersion`; engine modules never compare a template slug or
   import the presets; ticket admission names no preset. Fix the vocabulary
   (O1, O2, O12).
2. **Review decision in compiled workflows.** Resolve `$delivery` for plan runs;
   run the review hook and independence check for every reviewer step; let the
   plan's `repeat` drive repair (#62) (O1, O16).
3. **Presets become compiled templates.** Repository rules read compiled plans;
   republish `fixed-coding` and `fixed-coding-reviewed` as ordinary
   definitions; point ticket admission and the stage policy at them; drain and
   delete the flat path (O1).
4. **Artifacts reach sessions.** A read-only context directory, named input and
   output slots, step skills, step roles, and a real `agent.freeform` on the
   harness adapters.
5. **Watch any session.** Typed feed items, feeds addressed by session, a
   server-sent-events stream for the CLI, the session panel and the live overlay
   (O17).
6. **One start mechanism.** The event matcher over neutral events; `starts` in
   the definition and the editor (O8).
7. **Tickets on the start mechanism.** The source policy names a workflow;
   readiness by label and status with stable ids; Done-blocker admission for
   trackers without code; outbound comment and status through family actions
   (O8).
8. **Family ports and provider modules.** `tickets` and `code` ports; GitHub
   lifted behind them; Linear next (O13).
9. **People and endings.** `human.approval`, the decisions ledger on the work
   item, waits up to 7 days outside the active clock, named outcomes and
   `workflow.stop`.
10. **Steer any session.** Steering keyed on the session; steers recorded as
    step inputs and decisions; notes for steps not yet started; take over as
    completer; the reviewer rule; agent steering and spawning under permission,
    budget, count and depth checks; Slack milestones with linked identities
    (O18 to O21, as replaced in section 9).
11. **Kinds and facts.** The kind definition API for organizations, rule types,
    facts and validation at publication (O6).
12. **`forEach`, `call` and loop bounds.** Interpreter revision 3; `call`
    inlined with workflow outputs; `repeat.min` (O10).
13. **Unlisted definitions and proposals.** `origin` and visibility on
    definitions; run a frozen conversation draft; the `definitionProposal`
    coordinator effect; coordinator skills; save as workflow.
14. **Split: lanes run definitions.** The five changes in section 5, capacity
    keys and the dispatcher (O2).
15. **Teams.** `route` (revision 4), seats, the handoff kind, guards and
    counters, person and workflow seats, stuck signals, seat memory (O4, O5).
16. **Boards.** Status starts, overlap per work item, event provenance, the board
    view (O9). After V2.
17. **Packages.** T0 export and import with lineage now; T1 after the sandbox is
    proven (O7).
18. **Evaluations on the kernel.** Offline run environment enforced by the
    effect ledger and broker (O14).
19. **Execution-environment seam.** Placement as data and the `compute` family
    contract; no provider in v1 (O22).

Section 15.7 adds the domain-neutral slices.

The first customer-visible proof is Deliver shipped as a template after steps 1
to 12.

## 14. What not to build

- A second engine for teams, an agent message bus or long-lived seat sessions.
- A pluggable scheduler, customer code in the server process, or dynamic import
  of providers.
- A free graph editor with hand-drawn wires, or unbounded cycles.
- A condition that asks a model or reads free text.
- A separate durable evaluation workflow or a separate board engine.
- Engine code that names a kind, template, seat or provider.
- Session resume across steps, or any transcript handoff.
- Provider-owned tables that the engine reads.
- An exposed terminal as the way to watch or steer, or any steering path that is
  not recorded.
- Raw token streams relayed into chat.
- A cloud VM provider in v1.

## 15. Domain-neutral kernel, workspaces and MCP connections (O23 to O33)

This section states section 10 of the kernel proposal (`one-system.md`). The
owner approved its decisions, O23 to O33, as recommended.

### 15.1 Code-only assumptions and their neutral form (O23)

| Assumption today | Neutral form in the kernel | Software-delivery pack keeps |
| --- | --- | --- |
| A run needs a repository; four fixed task types | A run needs exactly the workspaces its steps declare, which may be none. Work type is an organization label the kernel never branches on | The four software work types as default labels |
| Every session gets "the repository at a pinned revision" | Each declared workspace at a pinned **revision**, an opaque content address the workspace kind supplies | Git commits as the `repository` kind's revision |
| Worktrees | A workspace **mount** per attempt: read-only or writable, prepared at a revision, captured into a new revision | Clones, worktrees and run refs |
| One candidate per repository (O15) | One linear revision chain per workspace per run tree | "Candidate", `$delivery.*`, checks, review and merge gate |
| Actions are code verbs | Neutral actions: the agent step, `tool.call`, `human.approval`, `workflow.stop`, `workflow.noop`, `task.brief`, `artifact.publish`, `counter.set`, `memory.promote`. Packs register others under their namespace | `harness.*`, `quality.check`, `review.independent`, `delivery.*`; `rpi.*` become step presets |
| Artifacts are small text | Binary formats, large bytes in the object store, media rule types checked by a platform probe, a subject that names a workspace revision | Deliver's document kinds |
| Lanes name a repository | A lane names a workspace alias, or none | Repository aliases and roles |
| Step defaults come from the repository profile | A **scope profile** at project level; a repository profile is its code form | Check commands, repository rules |
| Effect policy `repository_revision` | `workspace_revision` | none |
| The review loop is about code | A neutral **review loop module** (O30): findings and status facts, rounds per checkpoint, a progress rule, caps and `limit` decisions | Repository checks as evidence; the merge gate |

Readiness stays as decided: a label AND a workflow status (section 7).

### 15.2 The workspace

A workspace is where a step reads or changes files. It is optional.

| Kind | What it is | Revision |
| --- | --- | --- |
| `repository` (software-delivery pack) | A git checkout | A commit |
| `files` (kernel) | A plain tree of files, such as a video project folder or a dataset; a folder in the storage tree (section 17) | The digest of a manifest of paths, artifact versions and hashes (a folder snapshot) |
| none | Tool calls and documents only | n/a |

A workspace kind implements four verbs: prepare a mount at a revision, capture a
writable mount into a new revision, describe the difference between two
revisions (for `file_change` feed items), and move a revision between machines.
The kernel rules:

- A step declares `workspace: {name, access: read | write}`. Reviewer-role steps
  get read-only mounts.
- One linear revision chain per workspace per run tree; a writer starts at the
  current revision and names `{baseRevision, revision}`.
- At most one writer at a time per workspace. This is the neutral form of the
  decided parallel-writer rule (section 11).
- `$workspace.<name>.revision` is the neutral reference root; `$delivery.*`
  belongs to the software-delivery pack.

Many non-code factories need no workspace: their evolving output is a named
document on the work item, already versioned with compare-and-swap.

### 15.3 Kernel, review loop module and packs

| Layer | Owns |
| --- | --- |
| Kernel | The primitives, the workspace contract and the `files` kind, the revision chain and one-writer rule, roles and reviewer isolation, the neutral actions, blob-backed artifacts and media probes, the scope profile, connections, tools and bindings |
| Review loop module (native, neutral; O30) | Findings convention, checkpoints and rounds, the progress rule, caps |
| Software-delivery pack (native) | The `repository` workspace kind, candidates and `$delivery.*`, `harness.*`, `quality.check`, `review.independent`, `delivery.*`, repository profiles and rules, the `code` family port, Deliver's kinds and templates |
| Other packs, later | For example a media pack: media kinds, a render check, a publish family |

The boundary test: no kernel module imports the delivery pack, and no kernel
table has a column that only means something for git (today `tasks.base_sha` and
`artifact_versions.subject_head_sha` fail it).

### 15.4 MCP servers as connections (O24 to O27, O31)

MCP needs no new extension point (O24). E4 becomes **connections**, with two
provider kinds: native providers (hand-written actions, webhooks and neutral
events, family ports) and MCP servers (tools discovered and pinned as a
snapshot; no events, so a start still needs a provider, a generic webhook or a
schedule). An MCP server can stand in for a family port only through a declared
mapping from port verbs to tools.

| Concern | Rule |
| --- | --- |
| Registering | A server definition and connections. Global catalog of known servers (no credentials); Organization connections registered by an Admin; Personal connections usable in a member's own runs. A personal connection on a shared workflow needs the owner's explicit use grant, is labelled as acting for that person, and is refused for unattended starts (O27) |
| Pinning | Server definition revision, capability snapshot digest (names, schemas, descriptions) and, for local servers, the launch artifact digest. A workflow version pins the snapshot. Drift on a used tool refuses admission and shows "update available"; nothing updates on its own |
| Credentials | Only through the broker; no credential enters the session |
| Grants | Exact tool names against the pinned schema, never wildcards: tools an Admin enabled, the subset a workflow, agent, seat or step binds, and what the run principal may invoke. A grant may fix arguments. Reviewer-role sessions get read tools only unless the definition says otherwise |
| Reaching a session | Brokered only (O25). The worker exposes a **tool gateway**, a local MCP endpoint listing exactly the session's effective tools; every call goes through the lease-protected tool route. Native integration actions reach agents through the same gateway |
| `tool.call` | A deterministic step with no agent. `with` is type-checked against the pinned input schema; output is typed when the tool declares a schema, otherwise opaque until published as an artifact of a kind. `tool.call` replaces `integration.action` |
| Side effects | An Admin classifies each enabled tool (O26): read; write, idempotent (names its effect-key argument); write, reconcilable (paired with a read tool); write, opaque (default: at most once, an unknown outcome waits for a person). Server hints are suggestions only |
| Long-running tools | The grant declares the asynchronous form; one step waits durably and the ledger's reconcile read polls |
| Feed and cost | A `tool` feed item per call; produced files as `artifact` items. A per-call cost ceiling is reserved and settled like model usage |
| Local or remote | Remote servers are called by the server-side broker; local (`stdio`) servers are launched by the worker from a pinned command, as a placement requirement. Third-party local servers run under the T1 sandbox or an operator allowlist |
| Trust | Results never carry authority, are schema-validated and size-bounded. Tools only first (O31): resources later as read tools; sampling, elicitation and roots stay off |

### 15.5 Skills, integrations and MCP tools in a workflow

| Building block | Attaches to | Pinned by |
| --- | --- | --- |
| Skill | Agent version, seat, or step (adds to the agent's) | Skill version and digest |
| Integration action | A `tool.call` step; an agent, seat or step as a tool; a start as its event source; the engine for family write-backs | Action id and version, connection and resource |
| MCP tool | A `tool.call` step, or a binding on an agent, seat or step | Server revision and snapshot digest |
| Workflow `tools` section | Named connections with allowed tools, referenced by steps and seats | The workflow digest |

One record backs every binding: the designed `capability_bindings` table, with
its repository owner generalised to a scope and seats addressed as a workflow
version plus seat id.

### 15.6 Example: a video-production factory

Brief, script, script review (the review loop module), storyboard, a `forEach`
over scenes calling image and image-to-video tools with `tool.call`, a voiceover
tool call, assembly by a render tool, a person approving or requesting changes
with an editor agent re-cutting, then publishing through a video platform
integration with an effect key. It uses no repository and nothing from the
software-delivery pack. Its document kinds (brief, script, storyboard, image,
clip, audio, cut, review, publish receipt) are customer data; binary kinds are
validated by platform probes (O29) and stored in Bakery's object store (O28).
The same factory can be a team of producer, writer, editor, reviewer and owner
seats. The worst-case cost is known before the run, every tool call is granted
by name, recorded and keyed where it writes, and the person can watch and steer.

### 15.7 Gaps and slices

| Slice | Closes |
| --- | --- |
| A | Runs without a repository; scope profile defaults |
| B | MCP connections: tables, discovery, snapshots, drift; `tool.call` for remote servers; effect classification; feed items. `paper` on `rpi.design` becomes an ordinary binding |
| C | Tool gateway; bindings on agents, seats and steps; the `tools` section |
| D | Blob-backed artifacts, binary kinds, probes, previews |
| E | The workspace contract and the `files` kind; neutral names; kernel free of git columns |
| F | Asynchronous tools, per-call cost, `forEach` with `collect` and parallel iterations |
| G | Review loop module split from delivery (with #62) |
| H | Local stdio servers; third-party local servers under the T1 sandbox |
| I | The non-code proof: a text-only content factory first, then the video factory (O33) |

Families stay `tickets`, `code`, `chat` and `deploy`; `storage` (section 17.4) and `publish` are
added when the first template needs them, and the long tail goes through MCP.

## 16. Decisions O23 to O33

Approved by the owner on 14 November 2026, as recommended.

- **O23:** the kernel is domain-neutral, with software delivery as a pack; the
  kernel gains the workspace, the revision chain and the one-writer rule.
- **O24:** MCP is a second connection kind under E4, with tools as actions (E1)
  bound through the library (E5); no new extension point.
- **O25:** harnesses never connect to MCP servers directly; tools reach a session
  only through Bakery's gateway.
- **O26:** an Admin classifies each tool's side effects when enabling it;
  unclassified tools are writes that run at most once.
- **O27:** personal MCP connections on shared workflows only with the owner's
  explicit use grant, labelled as acting for that person, never for unattended
  starts.
- **O28:** large media files live in Bakery's object store as ordinary artifact
  versions.
- **O29:** binary documents are validated by platform probes run in the sandbox;
  no customer code.
- **O30:** a neutral review loop module, split from the software-delivery pack.
- **O31:** MCP tools only first; resources later as read tools; sampling,
  elicitation and roots off.
- **O32:** add "Connection" to the vocabulary; say "revision" and "scope profile"
  in the kernel.
- **O33:** the first non-code proof is a text-only content factory, then the
  video factory.

## 17. Storage as a navigable file tree (O28, O34 to O43)

Bakery's storage looks and navigates like a file system, though it is not
literally one: a virtual, hierarchical tree over the object store, with folders,
paths and sensible default top-level areas. Users, agents, the API and CLI, and
the UI navigate the same tree. Underneath, bytes stay immutable and
content-addressed, runs pin versions and never paths, and every area has a
policy for who writes, what is kept and what may be deleted. This is the owner's
callout on O28, designed in section 11 of `one-system.md`.

### 17.1 The model

| Layer | What it is | Changes? |
| --- | --- | --- |
| Entry | A folder or file at a place in the tree: stable id, name, parent, a pointer to its current version, its history | Name, parent and pointer change; the id never does |
| Version | One immutable state of a file: digest, size, media type, kind, facts, producer | Never |
| Blob | The bytes, stored once per organization under their SHA-256 | Never |

**A path is a name, not an identity (O34).** A path resolves to an entry, and the
entry's pointer to a version. So:

- Runs pin versions (`ArtifactRef` has no path). A path in a workflow or start is
  stored as the entry id with the path as a label, resolved at admission and
  frozen (K1).
- A rename or move changes one row; no pinned reference, history, comment or
  "used by" list breaks.
- A copy inside Bakery is a new entry pointing at the same blob.
- A folder used as an input is pinned as a **snapshot**: an immutable manifest
  of paths, versions and digests. A `files` workspace revision (section 15.2)
  and a skill version are both snapshots.

Every write makes a new version. Areas differ only by the **folder policy**
their children inherit:

| Policy | Record areas (artifacts, run outputs) | Working areas (assets, shared, personal, attachments) | Scratch |
| --- | --- | --- | --- |
| Who writes | Steps through declared outputs; people only into `attachments` | People and granted steps | Its owner |
| Versions kept | All, under retention | Last 20 by default, plus any a run pinned | Latest only |
| Rename and move | No: names are the workflow's document names | Yes | Yes |
| Delete | No; an Admin purge leaves a tombstone | To trash, then removed | Expires |
| Retention | Evidence or transient | Kept until deleted | 30 days |

Folders are real entries, so empty folders exist and policies and grants have
somewhere to attach.

### 17.2 The default layout (O35)

```text
/projects/<project>/
    artifacts/<work item>/          one folder per work item, made by Bakery
        plan.md, script.md, cut.mp4 the item's named documents
        attachments/                files people add to this item
        runs/<run>/<step>/          unnamed step outputs, evidence, transcripts
    workspaces/<name>/              file workspaces: live head and snapshots
    assets/                         the project's reference files and templates
/shared/                            organization-wide assets
/library/                           read-only mirror of skills, workflows, agents, kinds, packages
/users/<member>/                    personal: uploads/, scratch/, private files
/connections/<connection>/          outside storage, read through
/trash/                             deleted working files, kept 30 days
/system/                            Admin only: outputs with no work item, quarantine
```

- Project first, so one folder carries the project's grant. "All artifacts",
  "All workspaces" and "Runs" are views across projects, not top-level folders.
- Artifacts are grouped by work item, then name, then run and step. Kind is a
  filter, not a folder level.
- An upload lands where it has context: a work item's `attachments`, the folder
  being browsed, or the person's own `uploads`.
- `/library` is a mirror (O37): authoring stays in the library, with one
  lifecycle.
- `/connections` holds files Bakery does not store.
- Top-level folders, `/library`, and the artifacts area are created by Bakery;
  people add folders only in `assets`, `attachments`, `/shared`, workspaces and
  their personal folder. Names are unique per folder, compared
  case-insensitively after normalization; `.` and `..` are refused.

### 17.3 Permissions

- One tree per organization. Every entry, version and blob key carries the
  organization; deduplication never crosses organizations (O43), and no error,
  count, listing or search result leaks another organization.
- Folder grants (view, edit, manage) inherit downward; a restricted folder stops
  inheritance.
- `/projects/<project>` takes the project's grants. The artifacts area stays
  task-scoped with no per-folder overrides (O36); folder grants apply to assets,
  shared, workspaces and personal folders.
- Personal folders are owner only. An Admin sees size and can transfer or delete
  on offboarding, audited, without reading contents (O41).
- `/library` follows the catalog's Global, Organization and My scopes. A private
  skill attached to a shared workflow is usable by its runs but stays a
  placeholder in the tree for everyone but its owner.
- A session never browses with a person's authority. Its view is a mount of the
  versions pinned at admission, where the run principal's read and write rights
  are checked. Kind rules (writer-private kinds) still bind reviewer steps.
- Secrets and credentials are never in the tree. No public links in the first
  version; previews use the separate preview origin.

### 17.4 Access paths over the same tree

| Path | What it offers |
| --- | --- |
| File browser | Navigate, preview (video and audio by byte range), version history, "Produced by" (run, step, session), "Used by" (every pinned reference), kind, validator verdict and facts, comments on a version |
| API and CLI | `ls`, `stat`, `cat`, `get`, `put`, `cp`, `mv`, `rm`, `history`, `pin`. A path reads the current version; `path@<version>` or a digest reads an immutable one. `put` uses `If-Match`, `cp` is by reference, `mv` changes only the entry, `rm` trashes in working areas and is refused in record areas |
| Agent sessions | The context directory is a read-only mounted subtree of pinned versions and snapshots, with an index of kind, size, digest and headings. A workspace is a mounted snapshot of its folder. Outputs become new versions at the step's declared destinations. Large files are fetched lazily by range; nothing outside the mount is visible |
| MCP inward | An optional built-in connection, "Bakery Files", through the tool gateway (section 15.4): list, stat, read by range, search, write to granted destinations. Off by default (O39); every file read is recorded on the step with its version and digest |
| MCP outward | Bakery's own MCP server exposes the tree under its OAuth scopes |
| Integrations | A `storage` family: list, stat, read by range, write, change events. Connections mount under `/connections`, read through. Using an outside file ingests it into a version; one-way sync is a workflow; writing out is a keyed effect; no two-way sync in the first version (O38) |

### 17.5 Lifecycle

- **Retention** follows folder policy. Record areas keep today's rules (30 days
  transient, 180 days evidence, collected only when expired, terminal, unpinned
  and unreferenced, leaving a tombstone).
- **Deleting a pinned file** removes the entry from the tree; the pinned versions
  stay for their runs, shown as "deleted from <path>; kept for this run".
- **Purge** is an audited Admin action for leaked secrets or legal demands, and
  the only early removal from a record area.
- **Large files** use resumable uploads with a server-checked digest, and range
  downloads. Transfers go through Bakery first; signed links only if measured
  throughput needs them (O40). Small text stays inline in Postgres so kind
  validators run in the publish transaction.
- **Binary publishing** is staged, then current: the kind's probe (O29) runs on
  staged bytes.
- **Dedup** is per organization by SHA-256 with put-if-absent.
- **Quotas** per organization, project and personal folder, warning at 75% and
  pausing new writes at 90%.
- **Search** by name, path, kind, facts, media type, size, date, digest, work
  item and producer, obeying permissions.
- **Defaults** (O42): 20 versions kept in working areas, 30 days in trash, 30
  days for scratch, 5 GiB maximum file size; all are organization settings.

### 17.6 Slices

| Slice | Delivers |
| --- | --- |
| F1 | Organization blob store keyed by digest (skills become one user); versions that name a blob; resumable upload; range download |
| F2 | Entries and folders; the default layout; existing artifacts projected under their work items with no data moved |
| F3 | Read-only file browser, API and CLI |
| F4 | Session mounts from pinned versions and snapshots; lazy large files; outputs to destinations |
| F5 | Working areas: upload, move, rename, trash, folder policies, `kept` and `scratch` retention classes, quotas |
| F6 | Folder grants and restricted folders |
| F7 | File workspaces as folder snapshots |
| F8 | "Bakery Files" tools through the gateway |
| F9 | The `storage` family: mount, ingest, one-way sync, export as an effect |
| F10 | Search and metadata; the `/library` mirror |

F2 and F3 are useful without large files and can ship before F1. F1 to F4 are
what the video factory needs.

### 17.7 Decisions O34 to O43

- **O34:** a path is a name, not an identity.
- **O35:** project-first layout with `/shared`, `/library`, `/users`,
  `/connections`; no top-level `/runs` or `/uploads`.
- **O36:** the artifacts area stays task-scoped with no per-folder overrides.
- **O37:** the library appears as a read-only mirror.
- **O38:** outside storage is mounted read-through and ingested on use; one-way
  sync as a workflow; no two-way sync in the first version.
- **O39:** agents browsing the tree is off by default; granted reads are
  recorded on the step.
- **O40:** large transfers go through Bakery first.
- **O41:** personal folders are owner only.
- **O42:** default limits as in 17.5, all organization settings.
- **O43:** deduplication within one organization only.
