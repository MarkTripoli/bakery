> Decision record for [chapter 25, One engine](../25-one-engine.md). It wins over every companion document in this folder where they differ.

# Owner decisions: Bakery's one-system design (14 November 2026)

This file records what the product owner decided in conversation with their orchestrator. It takes precedence wherever the design documents in this folder say otherwise. Every decision is now made; nothing is pending.

## Philosophy

- Bakery is a platform. It provides durable infrastructure, primitives and building blocks, and people build their own factory from them. We cannot build every workflow for everyone, so extensibility has to be highly accessible: describe it in words, use the visual editor, copy a template, or write code with the SDK.
- There is one system, not several. New ways of working become plug-ins or new combinations of existing pieces, never an architecture rewrite.
- Dogfooding rule: everything Bakery ships, including Deliver and an OpenRig-style team template, is built only from the same public primitives customers get. There are no private engine paths.

## Engine (one-system.md)

- **O1:** one engine. The compiled interpreter is the only thing that decides what runs next, and the flat preset executor is retired. Approved.
- **O2:** coordination plans become the engine's "split" primitive. Approved.
- **O6/O7:** customer extensions are data only for now. Sandboxed customer code comes once isolation is proven. Approved.
- **O8:** a workflow's starts (triggers) live with the workflow and are switched on by "Use this version". Readiness can come from a label or a workflow status. Approved.
- **O22:** remote VMs get the execution-environment seam now (E8), with no provider built in v1. Approved.

## Steering (these replace O18–O21 where they differ)

- **Agents steer and spawn.** Agents can steer other agents and spawn other agents or sub-work when they are authorized. The engine checks permission, budget, count and depth before it acts, and records every steer and spawn exactly like a person's. This overrides O19 ("agents only message and interrupt").
- **Agents and decisions.** Agents may make decisions (approve, raise a limit, redirect, take over) only where a workflow explicitly grants it. Otherwise decisions are human-only. The owner accepted this as presented.
- **Reviewer messaging (O18).** Messaging a reviewer is off by default. If a workflow turns it on, the review is labelled "steered" and does not count where an independent review is required. To overrule a reviewer, the owner records an "accept, with reason" decision openly. A reviewer can still be paused or cancelled, and its questions answered.
- **Take over in v1 (O20).** The person becomes the step's completer: they provide the step's result themselves, or restart the step with a fresh agent and a note. Attaching live to the agent's session or terminal comes later, with workspaces and remote VMs.
- **Slack (O21).** Slack posts at milestones: started, waiting on you (with Approve and Reject buttons), stuck, failed, done (with a PR link). Each post links to the live view. Replying in the thread steers the agent, and the reply is recorded under the person's linked identity. The raw stream is not posted to Slack.
- **Live watch.** You can watch any running work live in the browser or elsewhere. Click a running node to see its agent output streaming, like Claude Code, and steer it from there. This works everywhere: workflow steps, team seats, plain tasks and the coordinator.

## Workflow editor (workflow-editor/UX-SPEC.md)

- The editor is as simple to edit as HubSpot and shows an n8n-style visual diagram.
- A step may add skills on top of the ones its agent already has. Yes.
- Sub-workflows ("Run a workflow"): build them, after the core editor slices. Yes.
- A called workflow uses its own agents. Yes.
- A called workflow may contain approvals and waits. Yes.
- Private skills CAN be attached to shared workflows. Attaching one asks for confirmation and grants use to everyone who can see or run the workflow. This reverses chapter 23's rule.

## Integrations (integrations-architecture-review.md, PR #379)

- Issue handling is provider-neutral. Providers come in this order: GitHub, then Linear, then GitLab, with Jira after that. Users set up integrations in the UI.
- Self-hosted providers (GitLab self-managed, GitHub Enterprise Server, Jira Data Center) are in scope, but not for v1.
- API tokens are allowed, as well as OAuth and app installs.
- Readiness comes from a label AND a workflow status, defined as a generic rule each provider declares.
- When work depends on another ticket in a tracker without code, the blocker being Done is enough to start.
- Each integration is a self-contained module in `packages/integration-<slug>/`, with UI, backend and manifest together. Boundaries are enforced mechanically (import rules, no provider names in core code, conformance suite, registry checks). Providers are pure adapters, and core owns the neutral tables (O13, approved).

## Future (after v1/V2, design the seams only)

- Kanban-style building, where moving cards between statuses in Jira or Linear drives what Bakery works on (after V2).
- Remote ephemeral VMs for running work (E2B, Daytona, Modal, Fly Machines and similar), as execution-environment providers.

## Remaining recommendations: all approved ("go with your recs")

**Workflow editor**
1. The layout runs top to bottom. It replaces the approved left-to-right Paper reference, so a new approved visual reference is needed for #67's visual check.
2. Approvals offer Approve, Request changes (sent back with notes) and Reject. The workflow owner is the default approver. A wait can last up to 7 days (raising the 24-hour cap).
3. The editor shows and edits the workflow's starts as a list at the top.
4. "Publish and use" is the primary button, with "Publish only" as a secondary option.
5. Two code-changing parallel lanes on one repository are blocked in v1, with a clear message.
6. The step picker shows step types first. Skills and saved workflows appear under "From your library".
7. **Loops:** one ready-made loop, "Fix until it passes". Other loops are written in the code view. **Owner addition:** every loop has optional **minimum and maximum iteration counts**, set in the loop's panel. Minimum means "run at least N times even if the exit condition is already met". The engine's `repeat` has only `max` (1..8) today, so a `min` is a model gap. Reconcile the maximum with the 1..8 cap and with the deliver doc's D9 (a loop that runs out of rounds pauses for a person to allow more).
8. "Test workflow" is dropped. To try a workflow, publish it without "Use" and run it on one task.

**Engine (one-system.md)**
- **O3:** "what runs next" is not pluggable. Customers express strategy through decision/route steps, which the engine validates.
- **O4:** a team is seats plus a route node in the same definition format, with fresh sessions and no `mode` key.
- **O5:** no warm rework in the first version.
- **O9:** a board starts one run per column visit. Documents and decisions belong to the work item.
- **O10:** `call` has one contract with two bindings: inline first, child run later.
- **O12:** vocabulary. "Plan" means only the document. "Split" and "lanes" replace "coordination plan".
- **O13:** providers are pure adapters. Core owns all the neutral tables, and provider packages contain no SQL.
- **O14:** evaluations run on the kernel with an offline environment.
- **O15:** one linear candidate per repository per run tree. Named candidates come later.
- **O16:** the delivery module (checks, reviews, merges) is native and sits beside the kernel, not inside it.

**Prototype pass 5 (approved as recommended)**
1. Request changes on an approval sends the work back to the step just before the approval. A picker under Advanced comes later.
2. Default steering permissions: developers on the task can message and pause; the task owner and admins make decisions. A workflow may narrow these.
3. On a phone, all six steer controls are shown.
4. Agents acting on other agents' work is off by default in new workflows, on in Bakery templates that need it, and always labelled "Agent's action".
5. Team live view: when a seat is running a workflow, that run opens nested in place, the same as a called workflow.
6. "Describe it" runs that were never saved stay findable from the conversation for as long as the run record exists.
- Design note: the "no two code-changing parallel steps on one repository" rule counts ANY step allowed to write to that repository or workspace, including custom agent tasks.
- Framing: Bakery is not code-only. The kernel is domain-neutral. Software delivery is one template pack beside it. MCP servers, skills and integrations are all building blocks inside workflows (architect addendum pending).

**Non-code factories and MCP (one-system.md §10): O23–O33 all approved as recommended.**
- O23: the kernel is domain-neutral, and software delivery is a pack.
- O24: an MCP server is a Connection kind under E4.
- O25: agents reach MCP only through Bakery's broker.
- O26: an Admin classifies each tool's side effects.
- O27: personal MCP connections on shared workflows need an explicit use grant, are labelled, and are never used by unattended starts.
- O28: large media goes in Bakery's object store as artifact versions. This is amended by the storage decision below.
- O29: binary documents are validated by sandboxed platform probes.
- O30: the review loop is split out of the delivery pack.
- O31: MCP tools come first.
- O32: add "Connection", "revision" and "scope profile" to the vocabulary.
- O33: the first non-code proof is a text-only content factory, then video.

**Storage (owner callout on O28):** Bakery's storage must look and navigate like a file system, even though it is not literally one. It is a virtual, hierarchical file tree over the object store, with folders, paths and browsing. Its top-level areas have sensible defaults; for example, artifacts are stored in a specific area. Users, agents, the API/CLI and the UI all navigate the same tree. Immutable artifact versions and pinned refs stay underneath, and paths are the human-friendly way in. The design is pending from the architect.

**Storage (one-system.md §11): O34–O43 approved as recommended, with one change.**
- **O39 changed: agents browse by default.** Agents can browse and read the file tree within their grants (not only their step's mounts). Every read is recorded.
- **Agents can upload and write files.** They do this through the Bakery Files connection, the CLI or API, and step outputs. Writes are versioned, recorded and kept within grants and quotas.

**Principle: EVERYTHING in Bakery is agent-first.** Anything a person can do, an agent can do through the same operations (API, CLI or MCP), under the same grants, budgets and audit. The architect is adding a parity audit.

**Agent-first parity (one-system.md §0.5, §11.6, §12): O44–O53 all approved as recommended.**
- O44: default read scope is the project tree, /shared, /library and bound connections. Personal folders (including the starter's own) need that member's grant.
- O45: default write scope is outputs, workspace, the step's own run folder, attachments, and the project's assets and workspaces. /shared needs a grant.
- O46: a browsing read returns the version current at step admission. The latest is available on request. Both are recorded.
- O47: reviewers never see side-writes of the work under review, and write only their declared outputs.
- O48: internal writes go to a write set with undo. The effect ledger is only for writes that leave Bakery.
- O49: each step may write up to 2 GiB and 2,000 files by default.
- O50: an agent acts with the run's principal or the seat's own identity, always labelled as an agent's action.
- O51: parity has exactly four exceptions: secrets and consent, who holds authority, irreversible destruction (an agent prepares, a person confirms), and nothing for oneself.
- O52: these powers are off by default and can be granted per workflow or seat: decisions, publishing, "Use this version", switching on a start, widening one's own file scope, and steering other agents.
- O53: sealed steps are available to any definition and are the default for evaluation runs.

**Tagging people (one-system.md §13), 15 November 2026: "No quiet hours. Don't over-engineer."**
- **Dropped:** O61, quiet hours and do-not-disturb.
- **Approved as recommended:** O54 (one tag mechanism), O55 (agents tag people already involved by default; bringing in someone new or delegating a power is an O52 power), O56 (a tag grants observe plus the one power its intent needs, which expires; observe stays), O59 (escalate, then expire; never approve by silence), O60 (inbox always, Slack where linked, email fallback), O62 (an unresolvable recipient falls back to the workflow owner).
- **Approved in simplified form:** O57 (any one group member answers), O58 (no outside people in v1), O63 (simple fixed limits; one escalation step).
- **Later, not designed now:** push notifications, custom intent forms, "all" or "N of M" group answers, multi-level escalation, and guests.

There are no pending owner decisions as of 15 November 2026.
