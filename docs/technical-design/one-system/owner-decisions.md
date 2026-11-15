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

There are no pending decisions as of 14 November 2026.
