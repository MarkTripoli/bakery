> Companion of [chapter 25, One engine](../25-one-engine.md). Where this document and [owner-decisions.md](owner-decisions.md) differ, the owner decisions win.

# Workflow editor: UX specification

Status: proposal for the product owner, 14 November 2026. Second pass the same day adds section 13 (agents, skills and reusable workflows). Simplification pass over `docs/technical-design/workflow-studio/` (revised 8 September 2026), read against `origin/main` at `a7a673649`.

Prototype: `prototype.html` in the design handoff (not copied into the repository), published at https://claude.ai/artifact/HzqreyRgx5pPcaZdprxfgn

The brief asks for the picture of a node-graph tool with the editing of a step-list tool. This spec resolves that as follows: **the workflow is drawn as a diagram, but it is edited as a list.** The diagram is always laid out by Bakery. Nobody draws a line, places a node or picks a port.

The reason this works for Bakery in particular: the definition model is not a free graph. It is a tree of ordered lists (`steps`, `then`, `else`, `lanes[].steps`, repeat `steps`) in `packages/contracts/src/workflow-compiler/schema.ts`. A free canvas lets people draw things the compiler will reject. A structured editor can only produce shapes the compiler accepts.

---

## 1. Principles and mental model

### Principles

1. **The diagram is the workflow, and Bakery draws it.** Top to bottom, auto-layout, no stored positions. Order on screen is execution order.
2. **You only ever say what comes next.** One gesture adds anything: the "+" on a connector. There is no wiring, because inputs are filled in from the steps above.
3. **A new step works with zero setup when it can.** Defaults come from the action registry and the steps above. Only fields that have no safe default are asked for. Everything else is behind Advanced or in the code view.
4. **Nothing happens by accident.** Editing changes a draft. Publishing makes a version. "Use this version" changes what new tasks get. AI suggestions change nothing until accepted. Each of those is a separate, named action.
5. **One tree, three views.** Diagram, outline and code are views of the same definition. The outline is not an accessibility fallback bolted on later: it is the same DOM tree with a different layout, and it is the phone layout.

### The mental model, in one paragraph

A workflow is a recipe. At the top is how it starts. Below that are steps that run in order, top to bottom. Sometimes the recipe asks a question and takes one of two paths. Sometimes it does a few things at the same time and waits for all of them. Sometimes it waits, for a set time or for a person. You build it by pressing "+" where the next thing should go and picking from a short list. You change a step by selecting it and editing a short form beside the diagram. Your edits are a draft. When the draft has no problems you publish it as a numbered version that never changes, and then choose to use that version for new tasks.

### The decisions behind that

| Question | Decision | Why |
| --- | --- | --- |
| Auto-layout or free positioning | Auto-layout only. No dragging nodes, no saved coordinates. | The model is a tree of ordered lists. Free positions add a second thing to keep in sync, a "private layout" store, and a mess to tidy. Removing them removes a whole class of state. |
| Direction | Top to bottom. | It is the same order as the phone outline, so one mental model serves both. Branch arms and parallel lanes sit side by side as columns, which reads correctly without labels on the lines. |
| How steps are added | "+" on every connector and at the end of every path and lane. Opens a searchable picker with three groups. | One gesture, works with keyboard and touch, cannot produce an unconnected node. |
| Connections | Never drawn by hand. The line shows order. Data is wired automatically and shown as "Works from" in the panel. | Port-wiring is where node tools get hard. The compiler already knows which earlier outputs fit which inputs. |
| Canvas technology | Plain DOM layout (nested flex), not a graph library. Pan by scrolling; zoom and Fit are view aids. | With no free positions and no hand-drawn edges there is nothing left for a graph library to do. DOM gives keyboard order, screen-reader structure, RTL and text expansion for free. This departs from doc 06, which names React Flow. |
| How much configuration shows | Name, the one to three fields that matter, where it gets its input, which agent. Time limit, spend limit and IDs are under Advanced. Retry, capabilities, effect keys and outputs are code-view only. | An engineering manager should not meet `retry.on` or `effectKey` to build a five-step flow. The registry already supplies safe values. |

---

## 2. The editing model

### How it starts (the trigger)

The first card is always "How it starts". It cannot be deleted or moved. Selecting it opens a panel with three choices:

- **By hand, from a task.** The default. Someone picks the workflow when starting a task.
- **When something happens in GitHub.** Event (an issue is labeled, an issue is opened, a pull request is opened), the label where relevant, and the repository.
- **On a schedule.** Repeats (every weekday, every day, every Monday), a time and a time zone, with the next five start times listed underneath and one sentence on what happens when the clocks change.

For the two automatic choices the panel also asks which project it runs in and the spend limit per run. Advanced holds two policies in plain words: "If Bakery was down at the start time" (run once when it is back, or skip it) and "If the last run is still going" (skip this start, or wait and then run once).

Start settings take effect only on "Use this version". Editing them starts nothing. See gap G2: these settings are an automation in the model, not part of the workflow.

### Adding and inserting steps

Every connector carries a "+". So does the end of every branch path, every lane and the workflow itself. The "+" is always visible, not shown on hover. It is 22px to look at and 44px to hit.

Pressing it opens the picker: a search field and three short groups (section 3). Choosing an item inserts it at that point, selects it and opens its panel. If the step needs nothing, the user is done. If it needs one thing, the cursor is one Tab away from it.

### Branching: "If / otherwise"

Inserting "If / otherwise" adds a question card with two paths under it, labelled **Yes** and **Otherwise**. Each path has its own "+". The paths join again underneath.

The question is built from three controls: what to check (a result of an earlier step, such as "Review: blocking findings"), a comparison (is, is not, is more than, is less than) and a value. If there is an obvious thing to check, it is prefilled: adding a branch after a Review defaults to "If the review found nothing blocking". The card title is written from the condition in plain words and can be renamed.

More than two paths: put another "If / otherwise" inside Otherwise. The model's branch is two-armed, and nesting keeps the picture honest.

### At the same time (parallel groups)

Inserting "At the same time" adds a group with two empty lanes side by side, each with a "+". "+ Lane" adds another, up to eight. The panel states the rule in two sentences: lanes start together, the workflow continues when every lane has finished, and if one fails the steps after the group do not run. Those two behaviours are fixed in the model (`join: all-required`, `failurePolicy: stop-dependent`), so they are stated, not offered as options. "Run at most N at a time" is under Advanced.

### Waits

"Wait" pauses for a number of seconds, minutes or hours, from one second to 24 hours. It is one card with two fields.

### Approvals

"Wait for approval" pauses until a person decides. Fields: who can approve (default: the workflow owner), and how long to wait, up to 7 days. Approve continues. Request changes sends the work, with the notes, back to the step just before the approval (a picker under Advanced comes later). Reject stops the run. In a live run the card reads "Waiting", the run banner offers "Approve the plan", and the step panel shows who was asked and when.

This is the largest gap between what the brief asks for and what the model has. See G1.

### Loops

The model has one loop, a bounded repeat with a typed value carried between rounds. That is too much to expose as a general tool. The editor offers one prepared loop, **Fix until it passes**: fix the findings, run checks, review again, at most N times (1 to 8), stopping as soon as the review finds nothing blocking and all required checks pass. The user edits N and the steps inside. **Owner decision:** every loop has an optional minimum and maximum iteration count in its panel. Minimum means "run at least N times even if the exit condition is already met"; the model has no `repeat.min` yet (gap G18). Maximum is `repeat.max`, bounded by the 1 to 8 cap; a loop that runs out of its allowed rounds below the maximum pauses for a person to allow more, never past the maximum (chapter 25, section 10). Other loops are written in the code view and shown on the diagram as a read-only loop box. See G8.

### Deleting, moving, undo

- **Delete**: in the panel footer, or Delete on a focused card. A plain step is removed at once with an "Undo" toast. A group asks one question first: delete everything inside, keep the steps and remove only the group, or cancel.
- **If other steps depended on it**, they show "Needs setup" straight away with a message that says what to add. The draft still saves.
- **Move**: Move up and Move down in the panel footer, and Alt+Up / Alt+Down on a focused card. "Move to…" opens a list of valid positions for moves across groups. Dragging a card onto a "+" is a later, pointer-only shortcut for the same operation. It is not needed and is not in the first slices.
- **Undo and redo**: every edit, including an accepted AI suggestion and an applied code edit, is one undo step. Toolbar buttons and Ctrl/Cmd+Z. Typing in one field is one step, not one per keystroke.

### What the canvas shows

**At rest**, each step is one card: an icon, its name, and one line saying what it does or its key setting ("Coding agent makes the change", "Engineering managers · up to 24 h"). A step with a problem has a red outline and "Needs setup" in place of that line. Groups show their rule as a short label ("At the same time", "Yes", "Otherwise"). There are no ports, no IDs, no skill satellites, no retry counts, no hint text about dragging.

**On selection**, the card gets the selection ring, the panel opens beside the diagram (full height on a phone), and the step this one works from gets a dashed outline. That one outline replaces every data wire a node tool would draw. With nothing selected, the panel is closed and the diagram has the full width.

---

## 3. The step catalog

Names users see, grouped the way the picker groups them, mapped to what the definition stores. Sources: `packages/contracts/src/workflow-action-registry.ts` and `workflow-compiler/schema.ts`.

### Agent work

| Users see | Says | Definition | Asked for by default |
| --- | --- | --- | --- |
| Research | Reads the task and the code, then writes up what it found. | `action` `rpi.research` | Nothing |
| Design | Turns the research into a design document. | `action` `rpi.design` | Nothing (works from Research) |
| Plan | Writes a step-by-step plan for the change. | `action` `rpi.plan` | Nothing (works from Research or Design) |
| Implement | A coding agent makes the change in the repository. | `action` `harness.implement` | Optional extra instructions |
| Fix problems | A coding agent fixes failed checks and review findings. | `action` `harness.repair` | Nothing |
| Review | A separate agent reviews the changes and lists what it found. | `action` `review.independent` | Nothing (works from Run checks) |
| Custom agent task | Give an agent your own instructions. | `action` `agent.freeform` | The instructions (required) |

### Checks and delivery

| Users see | Says | Definition | Asked for by default |
| --- | --- | --- | --- |
| Run checks | Runs the repository's lint, tests and build. | `action` `quality.check` | Which checks (default: all required) |
| Open a pull request | Opens a pull request with the changes. | `action` `tool.call` (**G4**) | Open as a draft, yes or no |
| Merge | Merges the changes when checks and review allow it. | `action` `delivery.merge` | Nothing |
| Prepare a release, Deploy, Check health | Later slice, same pattern. | `delivery.prepare`, `delivery.deploy`, `delivery.health` | Environment |
| Publish a document | Later slice. | `artifact.publish` | Which document |

### Flow

| Users see | Says | Definition |
| --- | --- | --- |
| If / otherwise | Take one of two paths, depending on an earlier result. | `branch` with `when`, `then`, `else` |
| At the same time | Run two or more sets of steps side by side. | `parallel` with `lanes`, `join: all-required`, `failurePolicy: stop-dependent` |
| Wait | Pause for a set time, up to 24 hours. | `wait` with `duration` |
| Wait for approval | Pause until a person approves. | **G1**. Nearest: `wait` with `event: approval.decided` |
| Fix until it passes | Fix, check and review again, a limited number of times. | `repeat` with `max`, `until`, a prepared seed and candidate |

### How it starts (not a step)

| Users see | Definition |
| --- | --- |
| By hand, from a task | No automation. `RunCreate.workflowId` from a task. |
| When something happens in GitHub | Automation version, `trigger: {type: event, provider: github, kind, action, filter}` |
| On a schedule | Automation version, `trigger: {type: schedule, cron, timezone}`, plus `misfirePolicy`, `overlapPolicy` |

### Not in the picker

- `sequence`: the editor never needs it. Every list is already a sequence.
- `workflow.noop`, `delivery.candidate_evidence`, `evaluation.sample`, `memory.promote`, `task.brief`: plumbing or specialist. They render correctly if present in a definition and can be added in the code view.
- `wait` on a named event: compiles, but a run is refused at admission ("an event wait has no producer yet", `workflow-adapter/plan-admission.ts`). Hidden until it runs.
- A step's own `if` ("skip unless"): the compiler rejects reads of a step that may be skipped, so it creates more errors than it removes. Code view only.

### Skills

The current design starts from a skill and resolves an action. This spec starts from the step type and puts the agent and its skills in the panel, because "Plan" is a word an engineering manager already has and a skill revision is not. Library items still belong in the picker: a fourth group, **From your library**, lists published workflows and skills. Section 13 covers agents, skills and workflows used inside workflows. Whether the picker leads with step types or skills is an owner decision (section 12).

---

## 4. Step configuration

### The panel

One panel, 344px beside the diagram at desktop widths, full height on a phone, closed when nothing is selected. Top to bottom:

1. **Name.** Free text. The stable ID is derived once and never changes on rename (see G3).
2. **One sentence** saying what this step type does.
3. **Works from.** Where the step gets its input, already chosen: "The plan from 'Write a plan'". It is a select only so it can be changed when more than one earlier step fits. If nothing fits, this is where the error appears, with what to add.
4. **The fields that matter for this step type.** Usually none or one. Derived from the action's input schema: required fields with no default are shown, optional fields a manager would plausibly use are shown, the rest are not.
5. **Agent.** "Default for this step (Coding agent)" with the option to pick another version. Maps to `agentVersionId`, falling back to the workflow's `agents` binding and then the repository profile.
6. **Advanced**, collapsed: time limit (default from the registry, 30 minutes if none), spend limit, and the read-only step ID and action name.

Footer: Move up, Move down, Delete.

### Defaults first

| Thing | Default | Source |
| --- | --- | --- |
| `needs` | The step before it in the same list | Editor writes it. Never shown. |
| `with` inputs | The nearest earlier output of the right type; `$input.taskId` and `$input.repositoryId` for task and repository; `$delivery.*` for revision, checks and findings | Compiler types (`passes/types.ts`, `default-catalog.ts`) |
| `timeout`, `retry` | Registry values | `WORKFLOW_ACTION_METADATA`, `limits.ts` |
| `effectKey` | Generated for merge, deploy and integration steps | Editor writes it. Shown read-only in code. |
| Branch and lane `outputs` | Written when a later step picks a value from inside a group | Editor writes it. Never shown. |
| `maxConcurrency` | Number of lanes | Advanced |
| Workflow `limits` | Organization defaults | Workflow settings, from the More menu |

### Inline validation

- The draft validates continuously against the server (`POST /v1/workflow-validations`, debounced). The draft saves whether or not it is valid; the model already allows that.
- Each finding has a JSON Pointer path and a stable code. The editor maps path to step to field, and code to a sentence that says what to do: `input_field_missing` on a Review's `evidence` becomes "A review needs check results. Add a Run checks step before it." The compiler's own messages ("The action input is missing a required field.") are never shown raw.
- Three places show it, in increasing detail: the card ("Needs setup"), a "2 problems" chip in the toolbar that lists them and jumps to each, and the message under the field itself.
- Errors clear as the user types. They never block typing, saving or leaving.
- Workflow-level findings (worst-case cost over the limit, too many steps) appear in the same list, addressed to the workflow: "This workflow could cost up to $14 a run, over its $12 limit."
- Publish is never disabled. Pressed with problems, it lists them with "Show me" beside each.

---

## 5. Draft, publish, use: the lifecycle

This follows the shipped Library pages and their wording (`apps/web/src/pages/WorkflowPage.tsx`, `BuiltInWorkflowPage.tsx`, `library/*`, `library.*` strings).

```
Built in  --Make a copy-->  Draft  --Publish-->  Version N  --Use this version-->  In use
                              ^                      |
                              +--Edit as a new draft-+
```

- **Draft.** There is one shared draft per workflow. It autosaves with the draft's version as the precondition. The header shows "Draft" and what is in use ("Version 3 is in use"). Nothing runs from a draft.
- **Validate.** Continuous, as above. The toolbar shows either "N problems" or "Ready to publish".
- **Publish.** Opens one dialog: what changed since the version in use, in plain words (New, Changed, Removed, by step name), that no problems were found, and one sentence: a version never changes after it is published, and publishing starts nothing. The server validates again at publish time under the publisher's permissions. If the draft changed since the check, the dialog says so and re-checks instead of failing.
- **Use this version.** A second, separate confirmation in the same dialog, and the same action that already exists on the workflow page. It says exactly what changes: new tasks get this version, running tasks keep theirs, and the start settings now start this version. "Not now" leaves the version published and unused.
- **Published versions are read-only.** Opening one shows the same diagram with no "+" and a banner. "Edit as a new draft" starts the next draft from it.
- **Built-in workflows** open in the same read-only view with "Built-in workflows cannot be changed. Make a copy to edit it." and one primary button, "Make a copy". The copy dialog is the shipped one: a name, and "The copy starts as a draft from version N. It is not used until you publish it."
- **Versions** live in the More menu: the list from the workflow page, with "Use this version" on each published row.
- **Permissions.** Reading is for Developers, changing is for Admins. A non-admin sees every step and panel read-only, with the shipped sentence "Only organization administrators can change workflows."

Publish and "Use this version" stay two steps because they are two operations with different consequences, and the second one can turn on a trigger. Collapsing them is an owner decision (section 12).

---

## 6. Running: the same diagram, with status

A **Runs** tab sits beside Editor. It lists recent runs of this workflow, including ones started by a schedule or an event, with how each started.

Selecting a run shows **the diagram of the version that run started with**, read-only. A line says so: "shown on version 3, the version this run started with". This is why the overlay can never mislead after the draft has moved on.

On each card:

| Status | Shown as |
| --- | --- |
| Done | Green "Done", with duration and cost in place of the description |
| Running | Blue "Running" with a spinner; two lanes of a group can show it at once |
| Waiting | Amber "Waiting", for an approval or a timed wait |
| Failed | Red "Failed"; later steps stay "Not started" |
| Skipped | Dashed and dimmed, for the path a branch did not take |
| Not started | Dashed and dimmed |

Status is always a word as well as a colour. A branch card says which path it took. A loop shows "Round 2 of 2" with a control to look at earlier rounds.

Selecting a step opens the panel in run mode: status, duration, cost, agent, attempts, a one-paragraph result, and "Open the full output", which goes to the existing task and run pages. The editor does not rebuild the log viewer.

A run that is waiting for a person shows a banner at the top of the diagram with the action on it ("Approve the plan"), for people allowed to take it.

Live updates use the existing run and step invalidations. Nothing in this view can change the workflow or the run's definition.

"Test workflow" from the current design is not here. See G7.

---

## 7. AI assist

**Where it lives.** One "Ask Bakery" button in the toolbar. It opens in the panel slot beside the diagram, so the diagram stays visible. On a phone it is a full-height sheet. A new, empty workflow also opens with one question, "What should this workflow do?", which is the fastest path for a first-time builder.

**How a proposal appears.** On the diagram itself, as a diff:

- New steps: dashed green outline, "New".
- Changed steps: amber, "Changed", with the before and after for each changed field listed in the conversation ("Time limit: 2 hours → 3 hours").
- Removed steps: dashed red, struck through, "Removed", still in place so the user can see what goes.
- A bar across the top of the diagram: "Bakery suggests 3 changes. Nothing changes until you accept." with **Accept** and **Reject**.

While a proposal is open, the diagram is read-only. That removes the stale-proposal case from the common path. If someone else changes the draft meanwhile, Accept is replaced by "Refresh suggestion".

**Rules.**

- One proposal is one coherent change, accepted or rejected whole. No per-step approvals.
- Accepting applies it to the draft through the same edit operations as a manual edit, as one undo step. It is validated like any edit. It cannot publish, cannot choose the version in use, cannot turn on a trigger and cannot start a run.
- A proposal is compiled before it is shown. If it has problems, the bar says so and names them; they are then ordinary draft problems that block publishing.
- On a built-in workflow, Ask Bakery offers "Make a copy" first.
- There is one mode. The current design's "Auto-build draft", which applies edits without review, is cut: it is a second behaviour to explain and it weakens the one promise that matters.

---

## 8. Outline and code view

### Outline

The outline is the same tree as an indented list: how it starts, then each step as a row, with groups as nested lists under headings ("At the same time", "Yes", "Otherwise"). Every row is a button. "+" sits between rows exactly as on the diagram. Selecting a row opens the same panel.

- At desktop widths it is a view toggle, Diagram or Outline, in the tab bar.
- Below 744px it is the only layout. A phone gets the outline, the full-height panel, and the picker as a bottom sheet. There is no separate phone design to maintain.
- For a screen reader both views expose the same structure, because they are the same elements: nested lists, each step a button with its name, description and state.
- Keyboard: Tab and the arrow keys move through steps in order, Enter opens a step, Alt+Up and Alt+Down move it, Delete removes it, every "+" is a button. No action needs a pointer.

Because diagram and outline are two CSS layouts of one tree, they cannot disagree, and the first acceptance criterion of #67 is true by construction for those two.

### Code view

"View as code" in the More menu opens the definition as JSON, with the start settings as a second block. It is deliberately one level down from the toolbar: most people never need it, and those who do know to look.

- It edits the same draft. Applying valid text is one undo step and the diagram redraws.
- Text that does not parse stays in the buffer with its errors, and the diagram keeps showing the last valid draft.
- Anything the diagram cannot edit (a hand-written loop, a step's `if`, custom retry) is shown read-only on the diagram with "Edited in code", never dropped.
- YAML import and export are a later addition to this view, not a third tab.

---

## 9. Keep, change, cut against the current workflow studio

### Keep

| From the current design | Why |
| --- | --- |
| Canvas, outline and JSON over one definition | #67 requires it, and it is right. |
| AI in a panel beside the canvas, with a concrete edit list and "Your workflow stays as it is until you apply" | The right contract. This spec adds the diff on the diagram. |
| Built-in workflows locked, editing through a copy | Matches the model and the shipped pages. |
| Undo after every change, including AI | Makes experimenting safe. |
| Phone layout as an ordered list with full-width panels | It becomes the outline, shared with desktop. |
| Invalid JSON kept in the buffer while the last valid canvas stays | Correct and required by doc 06. |
| Bakery tokens, System/Light/Dark, 44px targets, 16px phone inputs | Unchanged. |
| Parallel work drawn as side-by-side lanes that join | Reads well. Kept, rotated to columns. |

### Change

| Current | Proposed | Why |
| --- | --- | --- |
| Left-to-right canvas with free node positions, drag, pan and zoom as the main interaction | Top-to-bottom auto-layout; scrolling; zoom and Fit as aids | The definition is a tree of lists. Free positions add state and no meaning. |
| Named ports; connect by selecting an output then an input, dragging a port, or choosing an input in Setup | "+" to insert; inputs filled in automatically; "Works from" in the panel | Removes the hardest interaction and three ways of doing it. |
| "Add step" button opening a node library | "+" on every connector opening a three-group picker | The user says where first, so nothing is ever unconnected. |
| Skill and model shown as satellites on the canvas with dashed links | "Agent" row in the panel | Less on the canvas. The binding is a property of a step, not a neighbour. |
| Setup panel with inputs, skill, model, capabilities, retry, time and cost | Name, key fields, Works from, Agent; Advanced for time and spend | Defaults-first. The rest is in code. |
| JSON and Outline as peer buttons in the tab bar | Outline is a view toggle; code is in More | The common path should show the common things. |
| "When started · Manual trigger" node | "How it starts" card with by hand, GitHub event, schedule | The model has real triggers. The schedule preview is a #67 requirement. |
| Publish as one button | Publish, then "Use this version" | Two operations in the model and in the shipped pages. |
| "Create organization copy" | "Make a copy" | The shipped label. |
| AI "Ask before editing" and "Auto-build draft" | One mode: always a reviewable suggestion | One behaviour to learn; nothing applies unseen. |
| AI edit list only in the panel | Edit list plus New / Changed / Removed on the diagram | The user reviews the change where the change is. |

### Cut from the editor

| Cut | Where it goes | Why |
| --- | --- | --- |
| Skills listing and the skill package editor | Their own Library area | A different job. It doubles the surface of "the workflow editor". |
| Evaluations tab | With skills and agents | Same reason. |
| "Test workflow" and the example execution drawer | Runs tab shows real runs; see G7 | A draft cannot be run today. A fake run in an editor is worse than none. |
| Checkpoints, compare and restore inside the conversation | Undo and Versions | Two history systems for one draft. |
| Auto-build mode | Removed | Section 7. |
| Dragging a skill onto the canvas; drag-to-move hint text | "+" and the picker | Pointer-only, and redundant. |
| Per-step capabilities, retry policy, effect key editing | Code view | Registry-owned or generated. Nobody building a flow should need them. |
| Stored canvas layout | Removed | No positions to store. |
| YAML tab and import dialog | Later, inside the code view | Rare. JSON is the contract. |
| Webhook as a trigger type | Removed until it exists | The automation trigger is a schedule or a GitHub event. Nothing else is accepted. |
| Multi-repository lanes with a repository name under each lane | Hidden until the runtime admits them; see G6 | A run today refuses a group whose lanes name more than one repository. |

---

## 10. Gaps: what the UX needs that the model or runtime does not have

Ordered by how much they block the brief. Each has the smallest change that would close it.

**G1. There is no approval step.** Doc 06 says so directly: "No approval step is inserted into the YAML; stage policy lives on the task." Approvals exist as a task-level policy for the fixed presets (`approval_policy: {plan: human_approval}`), with their own operations and events. The nearest node is `wait` on the `approval.decided` event. It compiles, but a run is refused at admission because event waits have no producer, nothing requests the approval, and the wait carries no reference to which approval it means.
*Smallest change:* a registered action, for example `human.approval`, with input (what is being approved, who may approve) and output (`decision`: approved or rejected, and a note). The host completes it when `approvals.decide` is called. That gives the editor a typed result to branch on and reuses the approvals that exist. Until then "Wait for approval" must not ship in the picker.

**G2. How a workflow starts is not part of the workflow.** A trigger is an automation, a separate thing with its own versions, and each automation version pins one exact `workflowVersionId` plus an application, repository, budget and policies. So (a) editing a trigger is not in the workflow draft or its undo history, (b) publishing or using a new workflow version does not move the trigger to it, and (c) one workflow can have several automations.
*Smallest change:* let an automation version target a workflow (`workflowId`) and resolve the version in use when it fires, the way `RunCreate.workflowId` already does. The editor then reads and writes "the automation for this workflow" beside the draft, and "Use this version" needs no second write. Without that, "Use this version" must also create a new automation version, as two calls that can half-fail.

**G3. Step names have nowhere to live.** A node has an `id` (`[a-z][a-z0-9_]{1,63}`) and no label or description, and the schema is strict. Doc 06 treats labels as private presentation data keyed by node ID. With auto-layout there are no positions left to store, but names are not private: a teammate, the Runs tab and the publish diff all need them.
*Smallest change:* a `presentation` object stored with each draft and version, shared, outside the digest: `{labels: {nodeId: text}, notes: {nodeId: text}}`. Validation ignores it; copy and export carry it.

**G4. There is no "open a pull request" action.** The registry has merge, prepare, deploy and health, and the generic `tool.call` (`connectionId`, `tool`, `toolVersion`, `resourceId`, `arguments`). No pull-request action id was found in the contracts.
*Smallest change:* either a first-class `delivery.pull_request` action with a small typed input (draft, title source), or a catalogued integration action id the editor can present by name with a fixed argument form. The prototype assumes the second and invents the id; that id is not real.

**G5. Everything is capped at 24 hours.** A wait can be at most 24 hours, and so can the whole workflow (`wallClock`). A plan approval that sits over a weekend fails the run.
*Smallest change:* do not count time spent waiting on a person against `wallClock`, and give approval its own ceiling (for example 7 days).

**G6. "At the same time" is narrower at runtime than in the model.** Every lane must name a repository alias. A run is refused if the lanes of all groups name more than one alias. And two lanes that both change code in the same repository each produce their own revision, with nothing that combines them: the brief's own example, Implement beside Write tests, has this problem. Run checks after the group can only be pointed at one of the two.
*Smallest change:* default the lane alias to the run's repository so the editor never asks, and add a validation rule that at most one lane per repository or workspace may write to it, with a message that says so. This counts any step allowed to write to that repository or workspace, including custom agent tasks, not only Implement: the rule is decided by what the step may write, whatever its action type. The useful same-repository pattern today is one writing lane beside read-only lanes (research, a test plan, a review). Decide separately whether two writers should share a branch.

**G7. A draft cannot be test-run.** Runs start only from a published version or a preset. The current design's "Test workflow" shows an example execution, which the README already labels as a fixture.
*Smallest change:* none needed for the first releases: publish without "Use this version", then start one task on that version from the Runs tab ("Try version 4 on a task"). A true draft run is a larger runtime feature and should be scoped on its own.

**G8. Loops carry a typed accumulator.** `repeat` needs a seed value, a value carried to the next round, and an exit condition written against `$repeat.currentCandidate`. That cannot be made simple.
*Smallest change:* none required; the editor ships one prepared loop. A possible later simplification: let `until` read the last round's step outputs directly, so the carried value becomes optional.

**G9. Values inside a branch or lane are not readable after it** unless the group declares `outputs`. The editor can write those outputs itself when a later step picks such a value. This is editor work, not a model gap, but it is the subtlest part of auto-wiring and needs its own tests. There is also no n-way branch; nesting covers it.

**G10. The picker needs a catalogue the server does not yet serve.** Doc 06 lists `GET /v1/workflow-actions` as a required refinement. The editor also needs, per action, a plain name, a one-sentence description, an icon key, and which input fields are primary. Today only three actions have user-facing names in `packages/i18n`. *Smallest change:* add that metadata beside the registry and serve it from the catalogue endpoint.

**G11. Issue-label triggers overlap with ticket label routing.** An event trigger filters by equality on fields of the event's normalized projection. "An issue is labeled ready" needs a `label` field there for `issues.labeled`; that was not verified. Separately, doc 10 routes tickets by label to repositories. Two features that both start work from a label need one story. Owner decision.

**G12. Two catalogue facts shape the defaults and are worth confirming.** `rpi.plan` takes one input named `designArtifact`; the editor wires Research straight into it, which type-checks (both are artifact strings) but skips Design. And `review.independent` requires `evidence` from a checks step, so Review can never be used without Run checks before it. If both are intended, the editor's behaviour is right as specified.

---

## 11. Slicing: small UI slices against #67

Each slice is shippable alone and leaves the Library pages working. Server work is named where a slice depends on it.

| # | Slice | What ships | #67 item |
| --- | --- | --- | --- |
| 1 | **Read-only diagram** | The diagram and outline replace "Steps in version N" on the workflow and built-in pages. Any version. Phone layout, both themes, RTL, loading / empty / error / forbidden. No editing. | Canvas plus outline; states |
| 2 | **Edit a straight line** | Draft editing of action steps only: "+", picker, delete, move, undo and redo, autosave with the draft precondition, conflict and offline states. Needs G3 (names) and G10 (catalogue). | Create and edit; keyboard and phone; conflict, stale, offline |
| 3 | **Panel and problems** | Defaults-first forms from input schemas, "Works from" auto-wiring, problems chip, path-to-field mapping, plain messages per diagnostic code. | Typed validation; inspector |
| 4 | **Publish from the editor** | Publish dialog with the plain-language diff, re-validation, stale-check handling, "Use this version", read-only published view, "Edit as a new draft", Versions. | Explicit publication; no implicit execution |
| 5 | **Flow blocks** | If / otherwise, At the same time, Wait, Fix until it passes. Auto-written group outputs (G9). | Connect; bounded control flow |
| 6 | **Code view** | JSON view on the same draft, apply as one undo step, invalid buffer kept, "Edited in code" rendering. | JSON round-trip |
| 7 | **How it starts** | Trigger panel bound to automations: GitHub event, schedule with time zone and next-starts preview, missed-start and overlap policies. Firings in the Runs list. Better after G2. | Schedules and triggers; timezone and misfire previews; run linkage |
| 8 | **Run overlay** | Runs tab, statuses on the pinned version's diagram, step panel in run mode, live updates. | Run linkage |
| 9 | **Ask Bakery** | Conversation in the panel, proposal as a diff on the diagram, accept or reject as one validated undoable edit, refresh when stale, empty-state prompt. | Conversational proposals as reviewable edits |
| 10 | **Wait for approval** | The approval step and its run-time banner. Blocked on G1 and G5. | (Beyond #67 as written) |

Slices 1 to 4 are a complete, useful editor for sequential workflows. Each later slice adds one capability without changing the ones before it.

### How the design meets #67's acceptance criteria

| Requirement | How |
| --- | --- |
| Canvas, outline and JSON round-trip to the same versioned definition and plan | Diagram and outline are one tree with two layouts. Code view edits the same draft. There is no layout data to diverge. Names sit outside the digest (G3). |
| Keyboard and phone users can create, connect, edit and validate with no pointer-only action | Every action is a button. There is no drag and no hover-only control. "Connect" is automatic and changeable through a select. |
| AI proposals cannot bypass validation or authority, and never execute | A proposal becomes a draft edit through the same operations. Publish re-validates under the publisher's permissions. Accept cannot publish, activate or run. |
| Schedules and triggers with timezone and misfire previews | "How it starts": time zone, next five starts, clock-change rule, missed-start and overlap policies in plain words; firings in Runs. |
| Loading, empty, error, forbidden, conflict, stale, offline | All designed; all reachable from the prototype's State menu, the empty scenario and the AI flow. |
| System / Light / Dark | Bakery's two token maps. |
| 44px touch targets | "+" has a 44px hit area; rows, buttons and inputs are 44px at phone width. |
| RTL and 35% text expansion | Logical properties throughout; the flow is vertical, so it has no direction to mirror. Cards and buttons wrap; nothing is truncated or fixed-height. |
| Visual score against the approved reference | **Not met by definition.** The approved Paper reference is the left-to-right canvas. Adopting this spec needs a new approved reference first (section 12). |

---

## 12. Decisions for the product owner

1. **Top-to-bottom auto-layout replaces the approved left-to-right canvas.** This is the core of the proposal and it invalidates the current Paper reference that #67's visual score is measured against.
2. **Approval step semantics (G1).** Is "reject stops the run" enough for a first version, or must "request changes" send the work back? Who may approve by default? How long may it wait (G5)?
3. **Triggers in the editor (G2).** This spec shows one "How it starts" per workflow and treats it as part of the workflow. Automations are a separate item in the navigation today. Confirm that the editor should own the common case, and that a workflow with several automations shows "Starts 3 ways" and links out.
4. **Publish and "Use this version" as two steps.** Matches the shipped pages and keeps trigger activation explicit. The alternative is one "Publish and use" button for a workflow's first version.
5. **Two writers at the same time (G6).** The brief's example runs Implement and Write tests side by side. Decide whether to forbid two code-changing lanes in one repository, or define how their work is combined. **Decided by the owner:** blocked in v1. This counts any step allowed to write to that repository or workspace, including custom agent tasks, not only Implement: the rule is decided by what the step may write, whatever its action type.
6. **Drop "Test workflow" for now (G7)** in favour of trying a published, not-in-use version on one task.
7. **Step types first, skills second** in the picker (section 3).
8. **Only one prepared loop** in the editor; other loops in code (G8).
9. **Open a pull request (G4):** a first-class action or a named integration action.

---

## 13. Agents, skills and reusable workflows

Added in the second pass, in answer to: "What if I want to reuse specific agents, or use specific skills for the workflow? What if our skills are a workflow themselves?"

Checked against `origin/main`: doc 06 ("Skills and models are explicit step bindings", the grammar section, and the sentence "General map and arbitrary subworkflow recursion remain outside this contract"), doc 23, `AgentVersionCreateConfigSchema` in `packages/contracts/src/contracts.ts`, and `workflow-compiler/schema.ts`.

### The rule, in plain language

| It is a… | When it is… | Example | Lives in |
| --- | --- | --- | --- |
| **Skill** | Know-how one agent uses inside one step. Instructions, files and scripts, versioned. No steps of its own. | "API compatibility review": what to compare and how to report it | Library → Skills |
| **Agent** | Who does a step. A saved, versioned setup: model, harness, tools, budget, and the skills it always brings. | "Senior reviewer" | Library → Agents |
| **Workflow** | The process. Steps in order, paths, things at the same time, waits, people. | "Security review": scan, specialist review, sign-off | Library → Workflows |

One test settles most cases, and the editor says it where the choice is made:

> Does it need more than one agent, a person, things running at the same time, a wait, or retries you want to see? Then it is a workflow. Otherwise it is a skill.

So "our skills are a workflow themselves" has a direct answer: those are workflows, and you reuse them with a **Run a workflow** step. A skill stays small on purpose. It makes one agent better at one step; it cannot pause, branch or hand work to someone else.

### Picking a saved agent for a step

Every step that uses a model has an **Agent** field in its panel. It is a select:

- First option: the default, named. "Workflow default (Deep researcher)" if the workflow sets one, otherwise "Default for this step (Reviewer)", which comes from the repository profile.
- Then the saved agents from Library → Agents that can run this kind of step.

Under the select, one line says what was chosen: "Large model · Claude Code · pinned to version 6". Choosing an agent pins its current version for this step only. That is exactly the model's `agentVersionId` on the step, and the fallback order is the model's: step, then the workflow's `agents` map, then the repository profile.

If a newer version of the pinned agent exists, an amber row appears under the field: "Version 4 of Careful coder is available." with **Update**. Nothing updates on its own.

Steps that do not use a model (Run checks, Open a pull request, Wait) have no Agent field. The compiler rejects an agent on those (`step_agent_version_forbidden`), so the editor never offers one.

### Attaching skills to a step

Under Agent, a **Skills** list:

- Skills the chosen agent always brings are listed first, with "comes with Senior reviewer". They cannot be removed here, because they belong to the agent.
- Skills attached to this step follow, each with its pinned version and **Remove**.
- "Attach a skill…" lists published skills that fit this kind of step. A private skill can be attached too (owner decision, which reverses doc 23's earlier rule). Attaching one asks for confirmation: "Everyone who can see or run this workflow will be able to use this skill. Its files stay private, but a run may quote it." Confirming grants use of that skill version to everyone who can see or run the workflow. Other collaborators see the skill's name, owner and version, never its files. Copying the workflow to another organization leaves an unresolved slot that must be rebound before publishing.
- A skill with a newer published version shows "version 3 is available" and **Update**. Updating changes this step only and is one undo step.

A skill version never changes after it is published, and a step never moves to a new one by itself. That is doc 23's rule ("editing or publishing a skill never silently changes existing workflows or runs") made visible.

Attaching a skill to a step is a model gap today (G13): skills currently ride on an agent version, not on a step.

### Workflow-level default agents

**More → Default agents** opens one small form: a row for each kind of agent step this workflow uses (Research, Plan, Implement, Review…), each with the same agent select. This is the workflow's `agents` map and is supported today. A step that picks its own agent overrides it; a step that does not shows "Workflow default (…)".

This is the answer to "I want the whole workflow to use our reviewers": set it once here, not on every step.

### What the step card shows

Still one line. The rule: the card describes what the step does until you have made a choice worth seeing, then it shows that choice.

- Untouched: "Independent reviewer"
- Agent chosen, or skills attached: "Senior reviewer · 2 skills"

No skill names, no versions, no badges for updates on the card. The count includes skills the agent brings. Names, versions and updates are in the panel.

### The picker's "From your library" group

A fourth group in the "+" picker, under Flow:

- **Workflows.** "Security review · Workflow · version 4 · runs its 3 steps as one step". Choosing one inserts a Run a workflow step pinned to the latest published version.
- **Skills.** "API compatibility review · Skill · adds a Review step that uses it". Choosing one inserts the kind of step the skill is made for, with the skill attached. The user asked for the skill and gets a working step.
- **Agents are not in the picker.** An agent says who, not what, so choosing one cannot tell the editor which step to insert. Agents are chosen in the panel, where the step already exists.

Search covers all four groups. The group is hidden when the library is empty. The workflow being edited, and anything that already contains it, is not listed.

### The "Run a workflow" step

On the diagram it is one ordinary card: the child workflow's name, and "Workflow · version 3 · 3 steps". Under the card is a small tab, **Show 3 steps**.

- **Collapsed by default.** The parent stays readable. A reused workflow is one thing in the parent's story.
- **Expanded**, the child's steps appear in a dashed box under the card, read-only, with "Security review, version 3. Read-only here." There are no "+" buttons inside.
- **Open Security review** at the bottom of the box (and Open in the panel) goes to the child workflow's own editor. Edits happen there, to its draft, and reach this parent only through a new published version and an explicit update.

The panel has four things: which workflow, the pinned version, **Works from** (filled in from the steps above, like any step), and **Gives back** (the child's named results, which later steps and If / otherwise can use). Nothing else is configurable from the parent.

Limits, stated in the panel only when hit: a workflow cannot run itself, a called workflow can itself call one more level and no further, and the child's own start settings are ignored when it is called.

### How a run shows nested progress

In the Runs view the card behaves like any step, with two additions:

- While the child is running, the card line is progress: "1 of 3 steps done".
- Expanding it shows each child step with its own status (Done, Running, Waiting, Not started), using the same words and colours as the parent.

The step panel lists the child's steps and statuses and offers "Open the nested run". A child step that waits for a person raises the same banner on the parent run, so nobody has to find it.

### Versioning

- The parent pins an exact child version. Publishing a new version of the child changes nothing for any parent.
- When a newer child version exists, the card line reads "Workflow · version 3 · update available" and the panel shows what the new version says about itself ("Version 4 is available. It adds a licence check before the scan.") with **Update**.
- Update re-pins in the parent's draft, as one undo step, and re-validates: if the new version needs an input the parent does not supply, the step shows "Needs setup".
- Runs change only when the parent is published and that version is put in use.
- The publish dialog lists pinned things that have newer versions ("Security review has a newer version. This workflow stays on version 3."), as information, never as a blocker.

The same three rules hold for agents and skills: pinned, never automatic, one click to update.

Because a parent can only pin a version that is already published, and a published version never changes, a workflow can never end up calling itself through a chain. Recursion is impossible by construction, not by a check someone has to remember.

### When a skill outgrows a step

The moment someone wants a skill to "then wait for approval" or "and have a second agent check it", it has become a process. The editor offers the move instead of letting the skill grow:

- On a step with a skill attached, More in the panel has **Turn into a workflow**.
- It creates a new organization workflow draft containing that one step, with the same agent and skill, named after the skill.
- It offers to replace the step in the current workflow with a Run a workflow step, once the new workflow has a published version. Until then the original step stays as it is.
- Skill authoring shows the same test sentence, with "Make this a workflow" beside it.

Not in the prototype.

### Model gaps for this section

**G18. Loops have no minimum.** `repeat` has `max` (1 to 8) and `until`, and stops as soon as `until` holds.
*Smallest change:* an optional `repeat.min` (1 to `max`); `until` is not evaluated before round `min`. The worst case still comes from `max`.

**G13. Skills cannot be attached to a step.** An action node has `agentVersionId` and no skills field. Skills are bound on an agent version (`skillBindings`: name to immutable skill version). Doc 06 already says step skill bindings are intended and that "the catalog must gain those step fields before the UI claims to support them."
*Smallest change:* an optional `skills` list of skill version ids on action nodes that use a model, digest-affecting, checked by the existing skill binding validation (unavailable, not published, revoked), and added to the agent's own bindings at admission. *Possible today without a model change:* the editor creates a derived agent version (the chosen agent plus the extra skills). It works, but it fills Library → Agents with machine-made versions, so it is acceptable for a spike only.

**G14. A workflow cannot run another workflow.** Doc 06: "General map and arbitrary subworkflow recursion remain outside this contract." There is also no way for a workflow to declare what it gives back: a definition has `inputs` and no `outputs`.
*Smallest change:* (a) a `call` node, `{id, needs, call: {workflowVersionId, with}}`, where the target is a published version in the same organization; (b) workflow-level `outputs`, named typed values; (c) the compiler **inlines** the pinned child under the call node's id, so the child's steps become ordinary plan steps (`security_review.scan`). With inlining the interpreter, retries, budgets, waits and run status need no new machinery, the existing expansion limits (steps, attempts, cost, wall clock) apply to the whole, and nested progress falls out of ordinary step keys. Add a nesting limit of two levels. No recursion check is needed, for the reason given under Versioning.

**G15. The agent picker needs a library projection.** `AgentVersion` exists (config, digest), and Library → Agents is issue #66. The editor needs, for one kind of step: the agents that can run it, each with a name, its latest published version, a one-line model and harness summary, and the names and versions of the skills it brings. The validation report's `stepBindings` already says which agent a "default" step resolves to; the editor should show that name.

**G16. "Update available" needs one lookup.** For everything a draft pins (agent versions, skill versions, child workflow versions): the latest published version and whether it is still compatible. One read on the draft, not a call per reference. Doc 23's "Used by" is the same data read the other way.

**G17. Skills must say what kind of step they fit.** Doc 23 gives a skill a "compatible action". The picker and the Attach list depend on that being present and reliable for every published skill.

### Owner decisions for this section, with recommendations

| # | Decision | Recommendation |
| --- | --- | --- |
| 10 | May a step add skills on top of its agent's, or do skills only ever come with an agent? | Allow both. The agent carries defaults; a step may add. Ship "pick an agent" first, with the agent's skills shown read-only, and add step skills when G13 lands. |
| 11 | Build workflows-inside-workflows at all? | Yes, as a pinned published version that the compiler inlines, two levels deep at most. Schedule it after the first nine slices; it is the one real answer to "our skills are workflows". |
| 12 | Should anything ever update on its own (agent, skill, child workflow)? | No. Everything is pinned; newer versions prompt. This matches doc 23 and makes a published version mean one thing forever. |
| 13 | Agents in the "+" picker? | No. Panel only. An agent does not say what the step does. |
| 14 | Does a called workflow use its own agents, or the parent's? | Its own. It was published and tested that way. The parent cannot override them in the first version. |
| 15 | May a called workflow contain approvals and waits? | Yes. They are ordinary steps once inlined. Its start settings are ignored when called. |
| 16 | May the parent see inside the child? | Read-only, on demand, collapsed by default. Editing happens in the child. |
| 17 | Private skills in shared workflows | **Decided by the owner:** attachable. Attaching asks for confirmation and grants use to everyone who can see or run the workflow. This reverses doc 23's rule. |

### Slices this adds

| # | Slice | Depends on |
| --- | --- | --- |
| 11 | Agent field in the panel, Default agents form, agent "update available" | G15, G16. Model support exists. |
| 12 | Skills list in the panel (read-only for the agent's skills) | G15 |
| 13 | Attach, remove and update skills on a step; skills in the picker | G13, G17 |
| 14 | Run a workflow: card, expand, Open, panel, workflows in the picker | G14 |
| 15 | Nested run progress | Slice 8 and G14 |
| 16 | Turn a skill into a workflow | Slices 13 and 14 |

---

## 14. Owner decisions, prototype pass 5 (14 November 2026)

These win over anything above that differs.

1. **Request changes** on an approval sends the work back to the step just before the approval. A picker under Advanced, to choose another step, comes later.
2. **Default steering permissions:** developers on the task can message and pause; the task owner and Admins make decisions. A workflow may narrow these.
3. **Phone:** all six steer controls are shown on a phone.
4. **Agents acting on other agents' work** is off by default in new workflows, on in Bakery templates that need it, and always labelled "Agent's action".
5. **Team live view:** when a seat is running a workflow, that run opens nested in place, the same as a called workflow.
6. **"Describe it" runs** that were never saved stay findable from the conversation for as long as the run record exists.

## Appendix: what the prototype does and does not show

Shown and working: the sample workflow (issue labeled "ready", research, a custom step that needs setup, plan, approval, two lanes at the same time, checks, a reusable "Security review" workflow run as one step, review by a chosen agent with two skills, a branch on the review result); the Agent field with saved agents and "update available"; attaching, updating and removing skills; Default agents in the More menu; the "From your library" picker group; expanding the Run a workflow step, updating its pinned version, and its nested status in a live run; inserting any step with "+"; adding a branch, a group, a wait, an approval and the prepared loop; the panel with defaults, "Works from" and Advanced; problems on the card, in the toolbar and under the field, clearing as you type; delete with the group question, move, undo and redo; the publish dialog, blocked with problems and then the two-step publish and use; versions; make a copy from the locked built-in; the Runs tab with a live run that waits for approval, a completed run that took the other path and a failed run; Ask Bakery with three scripted suggestions shown as a diff; the empty workflow built from one sentence; diagram and outline; the phone frame; themes, right-to-left, and the loading, error, offline, conflict and view-only states.

Simplified: the AI is scripted. The code view is read-only and prints a readable authoring form, not the exact normalized document. Validation is a plain-language mirror of a handful of compiler rules, run locally. Move works within one list. The condition builder knows two facts (review findings, checks passed). The schedule preview lists calendar days and does no real time-zone arithmetic. Agents, skills and library workflows are sample data. "Open" on a called workflow and "Turn into a workflow" are not built. "Model notes" in the prototype bar turns on short annotations where a construct depends on a gap in section 10 or section 13.
