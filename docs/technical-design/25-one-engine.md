# One engine: the Bakery kernel and its extension points

Status: design accepted by the product owner on 14 November 2026. Nothing here
is implemented yet. This chapter is the canonical statement of the one-system
design. Where another chapter disagrees with it, this chapter wins and the other
chapter should be corrected. No decision here is pending.

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

**Domain-neutral kernel.** Bakery is not code-only. People build factories for
any kind of work, for example producing videos, and MCP servers, skills and
integrations all have a place inside workflows. The kernel knows work items,
documents, steps, sessions and rules; it does not know repositories, pull
requests or checks. Software delivery is one module and template pack beside the
kernel (O16), not part of it.

**Agent-first parity.** Everything a person can do in Bakery, an agent can do
through the same operations (API, CLI or MCP), subject to the same grants,
budgets and audit. There is one operation registry, and the web app is one
client of it among several. An agent's action is attributed to the principal it
acts for (the person or start that began the run, or the seat's own identity)
and is always labelled as an agent's action (O50). Four things stay with people
on purpose (O51): entering secrets and giving consent, administering who holds
authority, irreversible destruction (an agent prepares, a person confirms), and
nothing for oneself. Some agent powers are off by default and switched on per
workflow or seat (O52): decisions, publishing, "Use this version", switching on
a start, widening its own file scope, and steering other agents. Where a rule
below names a person, read it as the default holder of a grant an agent can also
hold, unless it is one of the four exceptions. Section 18 has the audit.

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

| Layer             | Holds                                                                                                                                                     | Owner                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 4. Templates      | Template packs. The software-delivery pack: Deliver (four sizes), Product team, Review pair, Triage desk, Board pipeline, the coordinator's factory skill | Bakery ships them; anyone copies them |
| 3. Compositions   | Workflows, teams, boards, factories                                                                                                                       | Customers                             |
| 2. Primitives     | The eleven primitives, one compiler, one interpreter, eight extension points                                                                              | The kernel                            |
| 1. Infrastructure | Durable execution, workers and worktrees, sessions, artifact store, events and outbox, budgets, grants, effect ledger, audit, integration broker          | Bakery runs it                        |

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

The decision is recorded in
[chapter 6, "Decision record: one interpreter"](06-workflows-delivery-and-acceptance.md#decision-record-one-interpreter-15-november-2026),
with the rails tests that enforce it.

The interpreter is a pure function `(document, recorded results) -> next`. It
has no clock, no database and no model. Cross-run rules (capacity, counters) are
checked at step admission, never inside the interpreter.

"What runs next" is not pluggable (O3). There is no scheduler plugin or strategy
interface. Customers express strategy through decision actions (route, assign,
plan; extension point E6), whose output the engine validates before acting.

### Kernel rules

| Rule                   | Meaning                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| K1 Pin at admission    | A run freezes every version it uses. Nothing resolves "latest" later                                                            |
| K2 Record, then act    | The step row exists before dispatch; an effect is prepared in the ledger before it is sent; a firing is recorded before its run |
| K3 Results are data    | Conditions read only typed action outputs and validated facts. No branch asks a model, reads free text or runs supplied code    |
| K4 Nothing ambient     | Every artifact, skill, capability, secret and dollar a step uses is declared and checked at admission and again at the effect   |
| K5 Everything bounded  | Steps, loops, hops, fan-out, time, money, context and artifact size have ceilings known before the run starts                   |
| K6 No silent influence | Every session can be watched, and every change to its course by a person or an agent is a recorded input                        |

Extensions attach only at five checkpoints (run admission, step admission,
result, effect, run end) plus compile time.

## 3. The eleven primitives

| #  | Primitive                                                            | Responsibility                                                                                                                                                                                                                                                                     |
| -- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Work item (task)                                                     | Carries intent and continuity: brief, scope (the workspaces its steps declare, which may be none; repository links are the software-delivery pack's workspace kind, O23), tracker link, parent and children, priority, its named documents and its decisions ledger. Outlives runs |
| 2  | Definition (workflow and its immutable versions; listed or unlisted) | Steps, order rules, inputs and outputs, limits, default agents, seats and starts. A version never changes. Bounded before it runs                                                                                                                                                  |
| 3  | Run                                                                  | One execution of one pinned version on one work item, with snapshot, budget, status and a named outcome. Runs form a tree                                                                                                                                                          |
| 4  | Step (with attempts)                                                 | One invocation of one action with a frozen input and a typed result. Exactly one completer finishes it: a worker job, a timer, a person, or child runs                                                                                                                             |
| 5  | Session                                                              | One sitting of an agent. Every session has a live feed and accepts recorded steering (section 9)                                                                                                                                                                                   |
| 6  | Action                                                               | The contract of a step type: schemas, capabilities, effect policy, cancellation, retries, timeout, cost ceiling                                                                                                                                                                    |
| 7  | Agent and skill                                                      | Immutable agent versions and digest-pinned skill versions. A seat is a standing role declared in a definition                                                                                                                                                                      |
| 8  | Artifact                                                             | The only handoff channel: named documents with immutable versions. A kind says what a document must contain and which facts the engine may read. People and tools browse artifacts as files in one tree (section 17)                                                               |
| 9  | Event and start                                                      | Events record what happened; a start matches an event to a definition and creates a run through normal admission                                                                                                                                                                   |
| 10 | Envelope                                                             | Grants, budgets, the effect ledger, rules (repository rules come from the software-delivery pack), human decisions and audit                                                                                                                                                       |
| 11 | Interpreter                                                          | Decides what happens next inside a run                                                                                                                                                                                                                                             |

Seat, team, board, Deliver, the coordinator and the review loop are not
primitives. They are compositions or modules built on these eleven. Software
delivery (repositories, checks, code reviews, pull requests, merges, the
fixed-coding presets and Deliver) is a native module and template pack beside
the kernel, not inside it (O16: "a native module beside the kernel, not part of
it ... no engine code names a delivery reason"). The engine core does not import
it, so incident, evaluation, content or video factories are peers of software
delivery, not guests.

The user-facing vocabulary stays small (O12). "Workflow" (or "definition") is
what the engine runs. "Plan" means only the document an agent writes. "Proposal"
is what the coordinator suggests. "Split" and "lanes" replace "coordination
plan". "Execution plan" stays internal. O32 adds "Connection" to the user
vocabulary and says "revision" rather than "candidate" and "scope profile"
rather than "repository profile" in the kernel.

## 4. The eight extension points

| #  | Extension point                                  | What plugs in                                                                                                                                           | Authored as                                                                                                 |
| -- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| E1 | Actions                                          | What a step does, including `tool.call` on a connection's tool                                                                                          | Data (an agent step preset), a workflow (`call`), a granted tool, or code in a package                      |
| E2 | Artifact kinds                                   | What a document must contain and which facts it yields                                                                                                  | Data: template, rules from platform rule types, fact schema                                                 |
| E3 | Start sources                                    | What begins a run                                                                                                                                       | Data (schedule, generic signed webhook) or a provider module                                                |
| E4 | Connections (integration families and providers) | Native providers: trackers, chat, and pack-specific families such as code hosts and deploy (software delivery). MCP servers as a second connection kind | A provider module implementing a family port, or an MCP server definition with a pinned capability snapshot |
| E5 | Library                                          | Agents, skills, seats, workflows, templates, step presets                                                                                               | Data, one lifecycle: draft, immutable version, copy with lineage, "update available", used-by               |
| E6 | Decision actions                                 | Who supplies a choice: route, assign, plan                                                                                                              | An action whose output fits one of three contracts                                                          |
| E7 | Guards and counters                              | Limits across runs                                                                                                                                      | A closed guard library; counters as data from kernel events, family projections, or values a step publishes |
| E8 | Execution environments                           | Where a session executes                                                                                                                                | A provider module of a `compute` family (section 8)                                                         |

Closed on purpose, extended only by a platform release: node forms and the
interpreter, step completers, guard types, validator rule types, feed item
kinds, steer kinds, the effect ledger and the checkpoints.

Extensions are data only for now (O6/O7, section 6). MCP needs no ninth
extension point: under O24 it is a connection kind (E4) whose tools are actions
(E1) bound through the library (E5).

## 5. Coordination plans become split (O2)

Coordination plans stop being a separate system. They become the engine's
**split** primitive: child work items joined by typed artifacts. Five changes:

1. A lane names what it runs (`run: {workflow}` plus inputs). Its `instructions`
   stay as the child's brief.
2. The engine starts ready lanes itself, bounded by a capacity key. Nobody else
   has to start them.
3. A parent run step owns the plan. A `parallel` whose lanes need separate child
   items (for example lanes on several repositories, in the software pack) and a
   split decision both create one, and the step completes from the plan's
   terminal projection.
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
cannot tell the two apart. A parent pins a published child version, so recursion
is impossible by construction; nesting is limited to two levels.

As built (#418), the inline binding is a compiler pass. A `call` node names a
published version (`call: {workflow: <version id>, with: {<input>: <value>}}`)
and a workflow declares what a caller may read in a root `outputs` map. The
compiler replaces the call with the child's steps under the call's id, binds the
child's inputs to the values the call passes, and rewrites a caller's read of
`$step.<call>.<output>` to the step output the child declared. The child keeps
its own agents, and its approvals and waits come along and count in the caller's
worst case. A caller reads only declared outputs, never an inner step, and the
branching "named outcome" waits for the child-run binding. The versions a call
may name are loaded from the caller's own organization; any other id is simply
unavailable. A called workflow cannot use `tool.call` yet.

## 6. Extensions are data only for now (O6, O7)

| Tier              | Contents                                                                                   | Where it runs                                | Status                                                |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------- |
| T0 Data           | Definitions, kinds, skills, agents, step presets, start templates, generic webhook sources | Nowhere: it is validated data                | Buildable now                                         |
| T1 Sandboxed code | Code actions and checks, decision actions in code                                          | Only in a worker sandbox, one step at a time | After the isolation tests pass                        |
| T2 Native         | Platform modules and native providers                                                      | In the server process                        | Bakery, or the operator of a self-hosted installation |

- Customers may not supply validator code in the publication path (O6). A kind's
  validator is a composition of platform rule types. Custom logic is a sandboxed
  check action whose typed output drives control flow. Pure WebAssembly
  validators may come later if demand is real.
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
   `api_metered` route, so no step depends on a host login unless its agent says
   so.
6. The session feed and steers travel over the lease-protected attempt routes,
   never a host-local socket. The usage ledger accepts a compute kind beside
   model usage.

Under O23, "repository at a pinned commit" reads "each declared workspace at its
pinned revision". The repository, commit and candidate details above belong to
the software-delivery pack; a non-code step's whole file contract is its context
and output directories.

An ephemeral box needs the `api_metered` route, and the provider is a
subprocessor that an Admin enables per repository scope.

In the software-delivery pack there is one linear candidate per repository per
run tree (O15). Named candidates for tournaments come later.

## 9. Watching and steering

Every session, in a workflow or not, has a live feed and a steering inbox (O17).
They are the same for a workflow step, a team seat visit, a plain task and the
coordinator. The shipped output envelope and steering are extended, not replaced
by a separate console.

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
- **Agents and decisions.** Agents use the same steering operations as people.
  Agents may make decisions (approve, raise a limit, redirect, take over) only
  where a workflow explicitly grants it. Otherwise decisions are human-only.
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
  Approve and Reject buttons), stuck, failed, and done (with a link to the
  result, for example a PR). Each post links to the live view. Replying in the
  thread steers the agent, and the reply is recorded under the person's linked
  identity. The raw stream is not posted to Slack.

Every steer is recorded before delivery, in the session's inputs and in the work
item's decisions ledger. The interpreter never reads a message steer; it reads
only decisions. A steer adds text and readable artifact references; it cannot
add tools, grants, skills or a role.

## 10. Shapes built from the same parts

| Shape              | Built from                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripted workflow  | Steps, if/otherwise, repeat, `forEach`, at the same time, `call`                                                                                                           |
| Team (O4)          | Seats plus a `route` node in the same definition format; fresh sessions per visit; no `mode` key and no long-lived seat sessions. No warm rework in the first version (O5) |
| Board (O9)         | Starts bound to tracker statuses, steps per status, a set-status step                                                                                                      |
| Described pipeline | An unlisted definition the coordinator proposed through the same edit operations as the editor                                                                             |
| Deliver            | Four templates (`deliver-oneshot`, `-lean`, `-full`, `-prd`) sharing two called workflows, built only from public primitives                                               |
| Evaluations (O14)  | Kernel runs with an `offline` environment, not a separate durable workflow                                                                                                 |

### Loops

Every loop (`repeat`, the editor's prepared "Fix until it passes", and the loops
inside Deliver) has an optional **minimum** and **maximum** iteration count, set
in the loop's panel.

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
- Agents author through the editor's own operations: drafts, edits and
  validation by default; publish and "Use this version" only where a workflow or
  seat grants them (O52).
- Publish is never disabled. Pressed with problems, it lists them with "Show me"
  beside each. "Publish and use" is the primary button, with "Publish only" as a
  secondary option.
- The editor shows and edits the workflow's starts as a list at the top.
- Approvals offer Approve, Request changes (sent back with notes) and Reject.
  The workflow owner is the default approver. A wait lasts up to 7 days.
- Two parallel steps that may both write to the same repository or workspace are
  blocked in v1, with a clear message. The rule is decided by what each step is
  allowed to write, whatever its action type: an Implement step and a custom
  agent task with write access both count.
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

Under O24, integrations and MCP servers are both **connections** (section 15.4):
one broker, one grant model and one effect ledger.

Issue handling is provider-neutral. Providers come in this order: GitHub, then
Linear, then GitLab, then Jira. Users set up integrations in the UI. Self-hosted
providers (GitLab self-managed, GitHub Enterprise Server, Jira Data Center) are
in scope, but not for v1. API tokens are allowed as well as OAuth and app
installs.

Each integration is a self-contained module in `packages/integration-<slug>/`,
with UI, backend and manifest together. Boundaries are enforced mechanically:
import rules, no provider names in core code, a conformance suite and registry
checks. Providers are pure adapters (O13): core owns all the neutral tables, and
provider packages contain no SQL. Families are `tickets` and `chat`, plus the
software-delivery pack's `code` and `deploy`; other packs add their own.
Provider webhooks normalize into the neutral event vocabulary that the one start
mechanism reads.

The detailed design is section 12 of [Integrations](09-integrations.md).

## 13. Convergence plan

In dependency order. Each step leaves everything before it working. Steps 2, 3
and the Deliver proof are software-delivery pack work; the rest is kernel. Steps
1 to 3 are the keystone: they make "one engine" true and remove four private
paths.

1. **Declare the kernel.** Record one interpreter, the flat executor frozen and
   coordination plans as split. Add rails tests: every built-in definition
   compiles with `apiVersion`; engine modules never compare a template slug or
   import the presets; ticket admission names no preset. Fix the vocabulary (O1,
   O2, O12).
2. **Review decision in compiled workflows.** Resolve `$delivery` for plan runs;
   run the review hook and independence check for every reviewer step; let the
   plan's `repeat` drive repair (#62) (O1, O16).
3. **Presets become compiled templates.** Repository rules read compiled plans;
   republish `fixed-coding` and `fixed-coding-reviewed` as ordinary definitions;
   point ticket admission and the stage policy at them; drain and delete the
   flat path (O1).
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
    budget, count and depth checks; Slack milestones with linked identities (O18
    to O21, as replaced in section 9).
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
16. **Boards.** Status starts, overlap per work item, event provenance, the
    board view (O9). After V2.
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

| Assumption today                                         | Neutral form in the kernel                                                                                                                                                                                       | Software-delivery pack keeps                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A run needs a repository; four fixed task types          | A run needs exactly the workspaces its steps declare, which may be none. Work type is an organization label the kernel never branches on                                                                         | The four software work types as default labels                                                |
| Every session gets "the repository at a pinned revision" | Each declared workspace at a pinned **revision**, an opaque content address the workspace kind supplies                                                                                                          | Git commits as the `repository` kind's revision                                               |
| Worktrees                                                | A workspace **mount** per attempt: read-only or writable, prepared at a revision, captured into a new revision                                                                                                   | Clones, worktrees and run refs                                                                |
| One candidate per repository (O15)                       | One linear revision chain per workspace per run tree                                                                                                                                                             | "Candidate", `$delivery.*`, checks, review and merge gate                                     |
| Actions are code verbs                                   | Neutral actions: the agent step, `tool.call`, `human.approval`, `workflow.stop`, `workflow.noop`, `task.brief`, `artifact.publish`, `counter.set`, `memory.promote`. Packs register others under their namespace | `harness.*`, `quality.check`, `review.independent`, `delivery.*`; `rpi.*` become step presets |
| Artifacts are small text                                 | Binary formats, large bytes in the object store, media rule types checked by a platform probe, a subject that names a workspace revision                                                                         | Deliver's document kinds                                                                      |
| Lanes name a repository                                  | A lane names a workspace alias, or none                                                                                                                                                                          | Repository aliases and roles                                                                  |
| Step defaults come from the repository profile           | A **scope profile** at project level; a repository profile is its code form                                                                                                                                      | Check commands, repository rules                                                              |
| Effect policy `repository_revision`                      | `workspace_revision`                                                                                                                                                                                             | none                                                                                          |
| The review loop is about code                            | A neutral **review loop module** (O30): findings and status facts, rounds per checkpoint, a progress rule, caps and `limit` decisions                                                                            | Repository checks as evidence; the merge gate                                                 |

Readiness stays as decided: a label AND a workflow status (section 7).

### 15.2 The workspace

A workspace is where a step reads or changes files. It is optional.

| Kind                                  | What it is                                                                                                    | Revision                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `repository` (software-delivery pack) | A git checkout                                                                                                | A commit                                                                            |
| `files` (kernel)                      | A plain tree of files, such as a video project folder or a dataset; a folder in the storage tree (section 17) | The digest of a manifest of paths, artifact versions and hashes (a folder snapshot) |
| none                                  | Tool calls and documents only                                                                                 | n/a                                                                                 |

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

| Layer                                     | Owns                                                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel                                    | The primitives, the workspace contract and the `files` kind, the revision chain and one-writer rule, roles and reviewer isolation, the neutral actions, blob-backed artifacts and media probes, the scope profile, connections, tools and bindings |
| Review loop module (native, neutral; O30) | Findings convention, checkpoints and rounds, the progress rule, caps                                                                                                                                                                               |
| Software-delivery pack (native)           | The `repository` workspace kind, candidates and `$delivery.*`, `harness.*`, `quality.check`, `review.independent`, `delivery.*`, repository profiles and rules, the `code` family port, Deliver's kinds and templates                              |
| Other packs, later                        | For example a media pack: media kinds, a render check, a publish family                                                                                                                                                                            |

The boundary test: no kernel module imports the delivery pack, and no kernel
table has a column that only means something for git (today `tasks.base_sha` and
`artifact_versions.subject_head_sha` fail it).

The review loop module landed in `apps/server/src/modules/review-loop/` (#440):
the findings convention, the progress rule and caps, the rounds a decision
appends, the step lookup of a loop and reviewer isolation. A rail
(`tests/unit/review-loop-module-stays-neutral_test.ts`) fails if it imports the
delivery pack or integrations, names a git-only field, or exports a repository
concept. The pack keeps the review tables' single writer (`review-store.ts`),
the finalizer that binds candidate facts to the loop, repository checks and the
merge gate.

### 15.4 MCP servers as connections (O24 to O27, O31)

MCP needs no new extension point (O24). E4 becomes **connections**, with two
provider kinds: native providers (hand-written actions, webhooks and neutral
events, family ports) and MCP servers (tools discovered and pinned as a
snapshot; no events, so a start still needs a provider, a generic webhook or a
schedule). An MCP server can stand in for a family port only through a declared
mapping from port verbs to tools.

| Concern            | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registering        | A server definition and connections. An agent with the grant registers a server, drafts a connection and requests tools; entering the secret and the consent step stay with a person (O51). Global catalog of known servers (no credentials); Organization connections registered by an Admin; Personal connections usable in a member's own runs. A personal connection on a shared workflow needs the owner's explicit use grant, is labelled as acting for that person, and is refused for unattended starts (O27) |
| Pinning            | Server definition revision, capability snapshot digest (names, schemas, descriptions) and, for local servers, the launch artifact digest. A workflow version pins the snapshot. Drift on a used tool refuses admission and shows "update available"; nothing updates on its own                                                                                                                                                                                                                                       |
| Credentials        | Only through the broker; no credential enters the session                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Grants             | Exact tool names against the pinned schema, never wildcards: tools an Admin enabled, the subset a workflow, agent, seat or step binds, and what the run principal may invoke. A grant may fix arguments. Reviewer-role sessions get read tools only unless the definition says otherwise                                                                                                                                                                                                                              |
| Reaching a session | Brokered only (O25). The worker exposes a **tool gateway**, a local MCP endpoint listing exactly the session's effective tools; every call goes through the lease-protected tool route. Native integration actions reach agents through the same gateway                                                                                                                                                                                                                                                              |
| `tool.call`        | A deterministic step with no agent. `with` is type-checked against the pinned input schema; output is typed when the tool declares a schema, otherwise opaque until published as an artifact of a kind. `tool.call` replaces `integration.action`                                                                                                                                                                                                                                                                     |
| Side effects       | An Admin classifies each enabled tool (O26): read; write, idempotent (names its effect-key argument); write, reconcilable (paired with a read tool); write, opaque (default: at most once, an unknown outcome waits for a person). Server hints are suggestions only                                                                                                                                                                                                                                                  |
| Long-running tools | The grant declares the asynchronous form; one step waits durably and the ledger's reconcile read polls                                                                                                                                                                                                                                                                                                                                                                                                                |
| Feed and cost      | A `tool` feed item per call; produced files as `artifact` items. A per-call cost ceiling is reserved and settled like model usage                                                                                                                                                                                                                                                                                                                                                                                     |
| Local or remote    | Remote servers are called by the server-side broker; local (`stdio`) servers are launched by the worker from a pinned command, as a placement requirement. Third-party local servers run under the T1 sandbox or an operator allowlist                                                                                                                                                                                                                                                                                |
| Trust              | Results never carry authority, are schema-validated and size-bounded. Tools only first (O31): resources later as read tools; sampling, elicitation and roots stay off                                                                                                                                                                                                                                                                                                                                                 |

### 15.5 Skills, integrations and MCP tools in a workflow

| Building block           | Attaches to                                                                                                          | Pinned by                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Skill                    | Agent version, seat, or step (adds to the agent's)                                                                   | Skill version and digest                       |
| Integration action       | A `tool.call` step; an agent, seat or step as a tool; a start as its event source; the engine for family write-backs | Action id and version, connection and resource |
| MCP tool                 | A `tool.call` step, or a binding on an agent, seat or step                                                           | Server revision and snapshot digest            |
| Workflow `tools` section | Named connections with allowed tools, referenced by steps and seats                                                  | The workflow digest                            |

One record backs every binding: the designed `capability_bindings` table, with
its repository owner generalised to a scope and seats addressed as a workflow
version plus seat id.

#### What landed (#436)

**The workflow `tools` section.** A workflow names MCP connections and the exact
tools it may use from each. A seat listed on an entry gets all of the entry's
tools; a step's `tools` list names an entry (all its tools) or one tool of it as
`entry.tool`. The compiler refuses a malformed section
(`workflow_tools_invalid`) and a reference to a missing entry or a tool the
entry does not allow (`action_tools_invalid`). The section is digest-bearing; a
workflow without one keeps its digest.

```yaml
tools:
  design:
    connectionId: 4f6c... # an MCP connection
    allow: [create_artboard, write_html]
    seats: [designer] # every step running as designer gets both
steps:
  - id: mock
    uses: rpi.design
    role: designer
  - id: notes
    uses: workflow.noop
    tools: [design.write_html] # this step gets one tool
```

**Pinning.** Publishing a version pins each entry to its connection's latest
snapshot and writes one `capability_bindings` row per seat (`seat_key`) and per
step (`step_key`), with the exact tool names. Publication is refused when an
entry names a connection that is off, personal without its owner's grant, or has
no snapshot, or allows a tool the server does not offer (`tools_tool_unknown`)
or an Admin has not enabled (`tools_tool_not_enabled`). A tool.call step takes
no `tools` list; it pins its one tool as before. A version's bindings are never
changed or removed: a changed pin is a new version.

**Agent bindings.** An Admin grants an agent version exact tools on an
organization connection with `capabilityBindings.create`
(`POST /v1/capability-bindings`), lists them with keyset pagination and
withdraws one with `capabilityBindings.delete`. A withdrawal is its own
append-only row (`capability_binding_revocations`); the binding row stays, so
bindings remain select-and-insert only. Wildcards are refused.

**Effective tools.** A session's effective tools are the tools bound by exact
name to its step, its seat or its agent version, where the connection is enabled
(and, if personal, usable for this run), the tool is enabled, and the binding's
pinned snapshot is still the connection's latest. A reviewer-role session (the
step's role is `reviewer` or its action needs the reviewer capability) gets only
tools an Admin classified as reads. A bound tool the session cannot call is
reported with its reason, for example `update_available` after drift; nothing
re-pins on its own.

**The gateway.** The worker opens a loopback MCP endpoint for each Claude
freeform session (`apps/worker/src/tool-gateway.ts`), with a random bearer that
lives as long as the session. It lists what
`POST /v1/worker/attempts/{id}/effective-tools` returns and sends each call to
`worker.invokeTool` (`POST /v1/worker/attempts/{id}/tool-invocations`); both
routes prove the lease, fence and worker session first and read the scope from
the attempt's own rows. The server's broker sends the call through the same
pinned-tool door as a `tool.call` step, so the remote credential never enters
the session. Each call is recorded in `tool_gateway_calls` before it is sent: a
replayed Idempotency-Key answers what happened, and a write whose outcome is
unknown stays `sent` and is refused (`tool_call_outcome_unknown`) rather than
sent twice. An Admin who has checked the outside system settles such a call with
`toolGatewayCalls.settle` (`POST /v1/tool-gateway-calls/{id}/settlement`,
`completed` or `failed`): only a `sent` call, only once, scoped to the
organization and audited.

**Paper as a binding.** `rpi.design` still requires `paper`, and a host meets it
with `paper` or with `tool-gateway`, which a worker running the Claude harness
advertises (`HOST_CAPABILITY_SUBSTITUTES`). On the Claude harness the design
step has its design tool exactly when its session's gateway lists a bound tool,
so a Paper connection bound to the step, its seat or its agent is the design
tool. A Pi or Codex host without `paper` never claims the step.

Not yet served: native integration actions through the gateway (the route
refuses `integrationConnectionId` with
`tool_invocation_integration_unsupported`), local stdio servers (slice H), the
Pi and Codex harnesses (they still use the worker's `paper` capability), a feed
item per gateway call and per-call cost.

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

| Slice | Closes                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Runs without a repository; scope profile defaults                                                                                                                            |
| B     | MCP connections: tables, discovery, snapshots, drift; `tool.call` for remote servers; effect classification; feed items. `paper` on `rpi.design` becomes an ordinary binding |
| C     | Tool gateway; bindings on agents, seats and steps; the `tools` section                                                                                                       |
| D     | Blob-backed artifacts, binary kinds, probes, previews                                                                                                                        |
| E     | The workspace contract and the `files` kind; neutral names; kernel free of git columns                                                                                       |
| F     | Asynchronous tools, per-call cost, `forEach` with `collect` and parallel iterations                                                                                          |
| G     | Review loop module split from delivery (with #62)                                                                                                                            |
| H     | Local stdio servers; third-party local servers under the T1 sandbox                                                                                                          |
| I     | The non-code proof: a text-only content factory first, then the video factory (O33)                                                                                          |

Families stay `tickets`, `code`, `chat` and `deploy`; `storage` (section 17.4)
and `publish` are added when the first template needs them, and the long tail
goes through MCP.

## 16. Decisions O23 to O33

Approved by the owner on 14 November 2026, as recommended.

- **O23:** the kernel is domain-neutral, with software delivery as a pack; the
  kernel gains the workspace, the revision chain and the one-writer rule.
- **O24:** MCP is a second connection kind under E4, with tools as actions (E1)
  bound through the library (E5); no new extension point.
- **O25:** harnesses never connect to MCP servers directly; tools reach a
  session only through Bakery's gateway.
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
- **O32:** add "Connection" to the vocabulary; say "revision" and "scope
  profile" in the kernel.
- **O33:** the first non-code proof is a text-only content factory, then the
  video factory.

## 17. Storage as a navigable file tree (O28, O34 to O43)

Bakery's storage looks and navigates like a file system, though it is not
literally one: a virtual, hierarchical tree over the object store, with folders,
paths and sensible default top-level areas. Users, agents, the API and CLI, and
the UI navigate the same tree. Agents browse by default within their grants, and
can upload and write files (O39, section 17.6). Underneath, bytes stay immutable
and content-addressed, runs pin versions and never paths, and every area has a
policy for who writes, what is kept and what may be deleted. This is the owner's
callout on O28, designed in section 11 of `one-system.md`.

### 17.1 The model

| Layer   | What it is                                                                                                      | Changes?                                           |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Entry   | A folder or file at a place in the tree: stable id, name, parent, a pointer to its current version, its history | Name, parent and pointer change; the id never does |
| Version | One immutable state of a file: digest, size, media type, kind, facts, producer                                  | Never                                              |
| Blob    | The bytes, stored once per organization under their SHA-256                                                     | Never                                              |

**A path is a name, not an identity (O34).** A path resolves to an entry, and
the entry's pointer to a version. So:

- Runs pin versions (`ArtifactRef` has no path). A path in a workflow or start
  is stored as the entry id with the path as a label, resolved at admission and
  frozen (K1).
- A rename or move changes one row; no pinned reference, history, comment or
  "used by" list breaks.
- A copy inside Bakery is a new entry pointing at the same blob.
- A folder used as an input is pinned as a **snapshot**: an immutable manifest
  of paths, versions and digests. A `files` workspace revision (section 15.2)
  and a skill version are both snapshots.

Every write makes a new version. Areas differ only by the **folder policy**
their children inherit:

| Policy          | Record areas (artifacts, run outputs)                          | Working areas (assets, shared, personal, attachments) | Scratch     |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| Who writes      | Steps through declared outputs; people only into `attachments` | People and granted steps                              | Its owner   |
| Versions kept   | All, under retention                                           | Last 20 by default, plus any a run pinned             | Latest only |
| Rename and move | No: names are the workflow's document names                    | Yes                                                   | Yes         |
| Delete          | No; an Admin purge leaves a tombstone                          | To trash, then removed                                | Expires     |
| Retention       | Evidence or transient                                          | Kept until deleted                                    | 30 days     |

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
- A session's declared inputs are a mount of the versions pinned at admission,
  where the run principal's read and write rights are checked. Beyond the mount,
  an agent browses and writes within its own grants (O39), never with a person's
  authority unless it acts for them under a recorded grant. Kind rules
  (writer-private kinds) still bind reviewer steps.
- Secrets and credentials are never in the tree. No public links in the first
  version; previews use the separate preview origin.

### 17.4 Access paths over the same tree

| Path           | What it offers                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File browser   | Navigate, preview (video and audio by byte range), version history, "Produced by" (run, step, session), "Used by" (every pinned reference), kind, validator verdict and facts, comments on a version                                                                                                                                                                    |
| API and CLI    | `ls`, `stat`, `cat`, `get`, `put`, `cp`, `mv`, `rm`, `history`, `pin`. A path reads the current version; `path@<version>` or a digest reads an immutable one. `put` uses `If-Match`, `cp` is by reference, `mv` changes only the entry, `rm` trashes in working areas and is refused in record areas                                                                    |
| Agent sessions | The context directory is a read-only mounted subtree of pinned versions and snapshots, with an index of kind, size, digest and headings. A workspace is a mounted snapshot of its folder. Outputs become new versions at the step's declared destinations. Large files are fetched lazily by range; nothing outside the mount is visible                                |
| MCP inward     | A built-in connection, "Bakery Files", through the tool gateway (section 15.4): list, stat, read by range, search, upload and write within the agent's grants. On by default (O39); every read and write is recorded on the step with its version and digest. Agents also use the CLI, the API and step outputs; writes are versioned and stay within grants and quotas |
| MCP outward    | Bakery's own MCP server exposes the tree under its OAuth scopes                                                                                                                                                                                                                                                                                                         |
| Integrations   | A `storage` family: list, stat, read by range, write, change events. Connections mount under `/connections`, read through. Using an outside file ingests it into a version; one-way sync is a workflow; writing out is a keyed effect; no two-way sync in the first version (O38)                                                                                       |

**Outside storage as shipped (F9, #452).** A storage connection is an
integration connection whose provider serves the storage family. An Admin mounts
it as a record-area folder under `/connections/<connection>`; listing, stat and
range reads go through the provider's port and copy nothing. Using a file
ingests it into an artifact version keyed by mount, remote path and remote
revision, so using it again returns the same version. One-way sync is a workflow
over that ingest, driven by the provider's change feed, and a remote deletion
leaves ingested versions alone. Writing out is a keyed external effect, written
with `If-Match` on the remote revision. Access is the connection's permission
(read, invoke, manage), the tree's read rule on the mount folder, and a live
connection.

The first provider is **local disk**. The operator sets one root
(`BAKERY_STORAGE_LOCAL_ROOT`, read through `RuntimeConfig`, server only), and a
connection with provider `local-disk` reads and writes only
`<root>/<organization>/<connection>`. A remote path is absolute with no empty,
`.` or `..` segment, and is resolved with `realpath`. An answer outside the
connection folder reads as missing. Listing and the change feed skip symbolic
links, and a link in place of the organization or connection folder is never
followed. A read checks that the file it opened is the one it resolved. With no
root set, a `local-disk` connection answers `STORAGE_PROVIDER_UNAVAILABLE`, like
any provider that is not deployed.

### 17.5 Lifecycle

- **Retention** follows folder policy. Record areas keep today's rules (30 days
  transient, 180 days evidence, collected only when expired, terminal, unpinned
  and unreferenced, leaving a tombstone).
- **Deleting a pinned file** removes the entry from the tree; the pinned
  versions stay for their runs, shown as "deleted from <path>; kept for this
  run".
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

### 17.6 Agents in the tree (O39, O44 to O49, O53)

An agent is not limited to its step's mount. By default it can browse and write
as a person in its position could, cut down by the grants of the principal it
acts for.

| Area                                                                     | Read by default                        | Write by default                                                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared inputs and context directory                                    | Yes, pinned                            | No                                                                                                                                                  |
| The step's outputs and writable workspace                                | Yes                                    | Yes                                                                                                                                                 |
| The work item's folder                                                   | Yes                                    | No. With a declared section or grant: free-form files under `runs/<run>/<step>/`, and `attachments`. Named documents only through a declared output |
| The rest of the project (other items' artifacts, `assets`, `workspaces`) | Yes                                    | No. With a declared section or grant: `assets` and `workspaces`, under the one-writer rule                                                          |
| `/shared`                                                                | Yes                                    | Only with a grant                                                                                                                                   |
| `/library`                                                               | Published items the principal may read | Not by file write; drafts through the library's own operations                                                                                      |
| `/connections/<connection>`                                              | Only connections the step binds        | Only as a keyed external effect                                                                                                                     |
| `/users/<member>`, including the starter's own                           | No, unless that member grants it       | No                                                                                                                                                  |
| `/trash`, `/system`                                                      | No                                     | No                                                                                                                                                  |

These defaults are O44 (read) and O45 (write). They describe what a `files`
section may declare, not what a claim hands out: a step with no section, or a
section without `write`, writes only its outputs and workspace. The run folder,
`attachments`, `assets` and `workspaces` need a declared section or a person's
grant (#448). A definition, seat or step may carry a `files` section to change
them:

- **Narrow freely.** `read: [inputs]` makes a **sealed step** that sees only its
  pinned inputs. Sealed steps are available to any definition and are the
  default for evaluation runs (O53). `write: [outputs]` stops side-writes.
- **Widen only with a grant** from someone who manages the target folder,
  recorded, pinned with the version and revocable. Widening its own file scope
  is off by default (O52).
- **Never beyond the principal.** Widening adds scope, not authority.

**Binding connections (O44, #452).** A step binds storage connections in its
`files` section: `files: { read: [connections, ...], connections: [<id>] }`, at
most 16 ids. The workflow SDK takes the same section as an action step's `files`
option. The compiler lower-cases and sorts the ids and refuses a repeat, a value
that is not an id, or a binding whose `read` does not name `connections`. A
sealed step cannot bind. When a run is admitted, each bound connection must be
mounted in the run's organization, readable by the person starting the run, and
live. Otherwise the start is refused with `storage_connection_not_bindable`, or
`connection_unavailable` for a disabled or archived connection. At claim the
session gets `files.read:connections` and one `files.read:connection:<id>` scope
per bound connection. It also gets the mount's list, stat and read tools. The
read guard opens `/connections` itself, showing only the bound mounts, and
everything under a bound mount. Any other connection is refused with
`agent_file_connection_not_bound` unless a person granted the workflow that
folder. A step that binds nothing never sees `/connections`, even when its
`read` names the area.

**Reads (O46).** Each file an agent opens joins the step's **read set** (entry,
version, digest, feed position). A read returns the version current when the
step was admitted, so a retry sees the same tree; the agent's own writes are
visible to it. The latest version is available on request and recorded as such.

**Writes.** Three ways, all producing ordinary versions: declared outputs (the
only writes the engine can branch on, K3), the workspace captured at step end,
and Bakery Files (the gateway's tools, the `bakery` CLI and the API: make a
folder, upload, write, copy, move, rename, delete to trash).

| Topic           | Rule                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning      | `If-Match` on the version read; a conflict returns to the agent. Identical bytes change nothing, so a retried step is idempotent                                                                            |
| Limits (O49)    | 2 GiB and 2,000 files per step by default, as organization settings, counted with the step's bounds; quotas apply; exceeding one is a typed fault, never truncation                                         |
| Large binaries  | Staged, digest-checked, probed, then current. A step cannot complete while a declared output is staged or invalid                                                                                           |
| Recording (O48) | The step's **write set** (entry, operation, previous and new version), feed items, provenance and audit. Writes inside Bakery are not external effects; writes to outside storage are, keyed and reconciled |
| Undo            | "Revert this step's writes" restores previous versions and trashes created files; a failed attempt's stray writes are reverted the same way                                                                 |
| Kinds           | A file written by path has a kind only when its folder or the write names one; then the validator runs before it becomes current                                                                            |

A later step pins a written version either as a wired declared output or by
opening it, which records it in that step's read set. Only declared outputs with
a kind yield facts for control flow.

**Reviewer isolation (O47).** A reviewer-role session never receives, in a read,
listing or search result, a writer-private kind, a transcript, or any version
written by a writer step of the same run tree, unless it is a declared output of
a kind readable by anyone or the workspace revision under review. A reviewer
writes only its declared outputs. These filters use version provenance, not
folder location or name.

### 17.7 Slices

| Slice | Delivers                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| F1    | Organization blob store keyed by digest (skills become one user); versions that name a blob; resumable upload; range download |
| F2    | Entries and folders; the default layout; existing artifacts projected under their work items with no data moved               |
| F3    | Read-only file browser, API and CLI                                                                                           |
| F4    | Session mounts from pinned versions and snapshots; lazy large files; outputs to destinations                                  |
| F5    | Working areas: upload, move, rename, trash, folder policies, `kept` and `scratch` retention classes, quotas                   |
| F6    | Folder grants and restricted folders                                                                                          |
| F7    | File workspaces as folder snapshots                                                                                           |
| F8    | "Bakery Files" tools through the gateway                                                                                      |
| F9    | The `storage` family: mount, ingest, one-way sync, export as an effect                                                        |
| F10   | Search and metadata; the `/library` mirror                                                                                    |

F2 and F3 are useful without large files and can ship before F1. F1 to F4 are
what the video factory needs.

### 17.8 Decisions O34 to O43

- **O34:** a path is a name, not an identity.
- **O35:** project-first layout with `/shared`, `/library`, `/users`,
  `/connections`; no top-level `/runs` or `/uploads`.
- **O36:** the artifacts area stays task-scoped with no per-folder overrides.
- **O37:** the library appears as a read-only mirror.
- **O38:** outside storage is mounted read-through and ingested on use; one-way
  sync as a workflow; no two-way sync in the first version.
- **O39 (changed by the owner):** agents browse and read the tree by default
  within their grants, not only their step's mounts, and can upload and write
  files through Bakery Files, the CLI or API, and step outputs. Every read and
  write is recorded; writes are versioned and stay within grants and quotas.
- **O40:** large transfers go through Bakery first.
- **O41:** personal folders are owner only.
- **O42:** default limits as in 17.5, all organization settings.
- **O43:** deduplication within one organization only.

## 18. Agent-first parity audit (O44 to O53)

### 18.1 The mechanism

Bakery has one typed operation registry shared by REST and its MCP server, and a
scope never promotes the principal. What is missing is a way for an agent
**inside a session** to use it: an outside MCP client acts as a person, and the
worker's credential authenticates only the enrolled host and its protocol
operations. The fix is one credential and one connection:

- **A session operation credential**, bound to the attempt's lease and fence, to
  the principal the agent acts for (O50) and to the definition's scopes. It dies
  with the lease. Every call is audited with both identities: the principal and
  the session that made the call.
- **Bakery as a connection to itself.** The tool gateway (section 15.4) offers
  Bakery's own operations as tools beside outside connections. The `bakery` CLI
  and the API inside the session use the same credential. Nothing new is
  exposed: these are the operations the web app already calls.

Budgets apply as to a person's actions. A call that starts work reserves from
the parent run or the principal's allowance, and the engine checks permission,
budget, count and depth before it acts.

### 18.2 The audit

| Capability                                                      | An agent today                             | With this design                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Browse and read files                                           | Cannot read any artifact                   | On by default within its scope; every read recorded (17.6)                                             |
| Upload, create and edit files and folders                       | Publishes its own attempt's artifacts only | Outputs, workspace and Bakery Files (17.6)                                                             |
| Search                                                          | Not available to anyone                    | The same search, same permission filter                                                                |
| Create and edit workflows                                       | The coordinator cannot                     | Drafts with the editor's own operations; publish and "Use this version" where granted                  |
| Create and edit skills, agents and document kinds               | None from a session                        | Drafts by default; publishing where granted. A run is pinned, so an agent cannot change itself mid-run |
| Start runs and spawn work                                       | None                                       | Where authorized, with permission, budget, count and depth checks                                      |
| Steer a session; pause, cancel, retry runs                      | None                                       | Where authorized, recorded exactly like a person's                                                     |
| Approve and decide                                              | Human-only in code                         | Only where a workflow grants it, and never on its own output                                           |
| Ask a person a question                                         | Coordinator only, to all participants      | Any step, addressed to a role or audience the definition names                                         |
| Create and update work items; comment on documents              | Child tasks only through split             | The same operations as people                                                                          |
| Manage connections                                              | None                                       | Register a server, draft a connection, request tools; secret and consent stay with a person            |
| Manage starts                                                   | Automation subjects are refused grants     | Where granted; off by default                                                                          |
| Watch a session, read a transcript                              | None                                       | With `session:observe` (for example a watchdog or PM seat); never for a reviewer-role step             |
| Raise a limit or budget                                         | n/a                                        | Only for another role's work, where granted; never its own                                             |
| Members, roles, organization, billing                           | None                                       | Stays with people                                                                                      |
| Purge bytes, delete a project or organization, revoke a machine | None                                       | An agent prepares; a person confirms                                                                   |

### 18.3 The deliberate exceptions (O51)

| Exception                                                                                                                                  | Why                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Secrets and consent. An agent prepares the connection and asks; a person completes it                                                      | A secret must never enter model context, and consent binds a person's or an organization's legal identity |
| Who holds authority: members, roles, organizations, billing                                                                                | These define every other grant                                                                            |
| Irreversible destruction: purge, deleting a project or organization, revoking a machine. An agent prepares; a person confirms              | It cannot be undone, and the write-set undo does not cover it                                             |
| Nothing for oneself: an agent cannot grant itself access, raise its own limit or budget, approve its own output, or steer its own reviewer | Separation of duties. It binds people too                                                                 |

Everything else is a matter of grants. The off-by-default powers (O52) are on in
Bakery templates that need them and always labelled as an agent's action.

### 18.4 Earlier wording, read through parity

| Where                                                                                 | Read it as                                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| "A person accepts a proposal, presses Run and saves" (describe it, E6 plan decisions) | A person by default; an agent with the grant may accept, run and save. Publishing and switching on a start are off by default |
| "Decision rows carrying authority come only from people"                              | From people, or from an agent the workflow explicitly authorized, labelled as such                                            |
| "A human can reorder an inbox; agents cannot" (factory modes)                         | A seat with the grant can                                                                                                     |

### 18.5 Slices

| Slice | Adds                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Session operation credential; Bakery as a connection in the gateway, read operations first: browse, search, read work items, runs and library items from inside a session |
| P2    | Write operations for agents: files, folders, comments, work items, connection drafts                                                                                      |
| P3    | Library drafts by agents: workflows, skills, agents and document kinds through the editor's own operations                                                                |
| P4    | Spawn, steer, run control and granted decisions, with count, depth and budget checks and the "agent's action" label                                                       |
| P5    | The `bakery` CLI in the session image                                                                                                                                     |

### 18.6 Decisions O44 to O53

- **O44:** default read scope is the project tree, `/shared`, `/library` and the
  connections the definition binds; never a personal folder without that
  member's grant.
- **O45:** a step writes its outputs and workspace by default. The step's own
  run folder, `attachments`, and the project's `assets` and `workspaces` need a
  declared `files` section or a person's grant (#448); `/shared` with a grant;
  the library only through library operations.
- **O46:** a browsing read returns the version current at step admission; the
  latest on request; both recorded.
- **O47:** reviewers never see side-writes of the work under review and write
  only their declared outputs, enforced from provenance.
- **O48:** writes inside Bakery go to the step's write set, with undo; the
  effect ledger is for writes that leave Bakery.
- **O49:** 2 GiB and 2,000 files per step by default, as organization settings.
- **O50:** an agent acts with the run's principal or the seat's own identity,
  always labelled as an agent's action.
- **O51:** exactly four exceptions: secrets and consent, who holds authority,
  irreversible destruction, nothing for oneself.
- **O52:** off by default, granted per workflow or seat: decisions, publishing,
  "Use this version", switching on a start, widening one's own file scope,
  steering other agents.
- **O53:** sealed steps are available to any definition and the default for
  evaluation runs.

## 19. Tagging people (O54 to O63)

The owner wants workflows to tag people, to review, take control or anything
else, without over-engineering it. **A tag is who, what you need from them, and
a link to the exact run or step**, with an optional short note and due time. It
adds no new way to decide anything: it is how a person is addressed and reached
for what the design already has, which is human steps, steering and take over
(section 9), comments, and the inbox of
[chapter 24](24-mentions-and-notifications.md). Chapter 24's rules hold: text
never tags, a mention needs sharing authority, and there is one inbox item per
recipient.

### 19.1 The tag (O54)

| Part           | Meaning                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who            | A member, a group or role (`@design-reviewers`), or a recipient worked out from the run: the starter, the workflow's owner, the task's owner, a seat's owner, the last person who steered the step |
| What you need  | One of five intents: FYI, review, approve, answer, take over                                                                                                                                       |
| Link           | The exact run, step, approval, question, document version or comment                                                                                                                               |
| Note, due time | Optional                                                                                                                                                                                           |

- A tag is a typed operation, never a pattern in text: `@Sam` in an agent's
  message or a pasted document does nothing.
- Recipients are resolved once, when the tag is made, and frozen on it.
- A group is answered by any one member, after which the others see "handled by
  Sam" (O57).
- A recipient that cannot be resolved falls back to the workflow's owner with a
  visible note (O62).

Where a tag appears:

| Place                                                                         | How                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A human step                                                                  | The approver or assignee is a tag: `audience: ["@design-reviewers"]` |
| A Notify step                                                                 | `uses: people.tag`, which may wait for the response or carry on      |
| A steer or comment on a live run or step, an artifact comment, a chat message | The same @ picker as chat; a chat mention is a tag with intent FYI   |
| An agent, during a run                                                        | `people.tag` through Bakery's own connection (section 18.1)          |

**Agents (O55).** Agent-first applies: an agent tags under the same grants as a
person, and the tag is labelled as the agent's action. By default it tags people
already involved (the starter, the owners above, an audience the workflow
names), limited to 3 tags per step and 10 per run (O63). Bringing in someone
new, or handing over a power the recipient does not already hold, is an
off-by-default power under O52.

### 19.2 What a tag grants (O56)

Observe on that run, plus the one power the intent needs, on the one thing the
tag is about.

| Intent    | The recipient may                                                      |
| --------- | ---------------------------------------------------------------------- |
| FYI       | Observe                                                                |
| Review    | Observe and comment                                                    |
| Approve   | Observe and make that one decision: approve, request changes or reject |
| Answer    | Observe and answer that one question                                   |
| Take over | Observe, steer that session and take over that one step (O20)          |

- **Bounded by the tagger.** Nobody hands over what they do not hold; bringing
  in someone without access needs sharing authority on the run. A tag-only
  recipient cannot share onward, and a tag cannot gain a power for oneself.
- **Narrow.** Nothing beyond that run and that power.
- **Stated before sending:** "Sam will be able to see this run and approve this
  step."
- **Expiry and withdrawal.** The power is used up by the response, or ends when
  the tag is withdrawn or expires after seven days (O63). Observe stays.
  Withdrawal is explicit; deleting the comment that carried a tag does not
  revoke it.
- **Recorded.** Making a tag and its response both go in the work item's
  decisions ledger.

### 19.3 Delivery and follow-through (O59, O60)

- One inbox item per recipient (chapter 24's notification); every channel
  delivers that item.
- Channels: the inbox always, Slack where the member has a linked identity, and
  email as the fallback when the item stays unseen. Approving from Slack is
  allowed under the linked identity (O21); email is a link to the signed-in
  page.
- A delivery carries the intent, who asked and the link, never document
  contents.
- One open tag per recipient, target and intent; tagging again nudges it.
- **Escalate once, then expire.** A tag may name one escalation: after a time
  with no response, tag someone else with the same request. If there is still no
  response by the expiry, a waiting step returns `expired`, which the workflow
  can branch on; unhandled, the run ends `needs_human`. Nothing is ever approved
  by silence.

### 19.4 Slices

| Slice | Delivers                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| TG1   | Chapter 24's inbox, bell and page, with targets widened to runs, steps, approvals, questions, document versions and comments |
| TG2   | The tag record, `people.tag`, scoped grants and withdrawal; tags as the audience of human steps, and in steers and comments  |
| TG3   | Agents tag people already involved, with limits and the label                                                                |
| TG4   | Groups; Slack and email delivery; one escalation; the `expired` result                                                       |

Later, not designed here: guests and other people outside the organization
(O58), group tags needing all or a number of members, push, custom intents,
longer escalation chains, reminders and per-person channel preferences, on-call
rotas, and recipients taken from a tracker or code owners.

## 20. Decisions O54 to O63

Approved by the owner on 15 November 2026.

- **O54:** one tag mechanism for approvers, Notify steps, comments, steers and
  agents.
- **O55:** agents tag people already involved by default, rate-limited and
  labelled; bringing in someone new or delegating a power is an O52 power.
- **O56:** a tag grants observe on the run plus the one power its intent needs,
  bounded by the tagger; the power expires, observe stays.
- **O57:** any one member answers a group tag.
- **O58:** no people outside the organization in the first version.
- **O59:** escalate once, then return `expired`; never approve by silence.
- **O60:** inbox always, Slack where linked, email as fallback; approving from
  Slack is allowed, email is link-only.
- **O61:** dropped (quiet hours and do-not-disturb).
- **O62:** an unresolvable recipient falls back to the workflow's owner, with a
  visible note.
- **O63:** agents 3 tags per step and 10 per run; one escalation step; tags
  expire after 7 days.
