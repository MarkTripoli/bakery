# Workflow and Skills studio

[Open the current-shell Paper designs](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/12-0) · [Open the interactive prototype](http://127.0.0.1:8846/docs/technical-design/workflow-studio/index.html) · [Reference screenshots](references.html) · [Skills and evaluation technical plan](../23-skills-and-evaluations.md)

**Revised 8 September 2026.** The current Paper page contains six focused editable screens built inside Bakery's current app shell: the workflow listing, familiar node canvas, Build with Bakery panel, Skills listing, nested skill package editor and its phone layout. The prior [21-screen interaction study](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/10-0) remains available for Setup, JSON, execution, evaluation and edge-state detail.

The official Zapier Copilot screenshot was opened in the browser and inspected on 8 September; the gallery links it and the current primary guide. The six supplied reference screenshots are preserved unchanged in `references/` and linked in the gallery. They informed the node shapes, named ports, curved branches, dashed skill links and execution drawer. These are UI and interaction references, not evidence that Bakery's execution runtime exists.

## Try the prototype

The existing server at port 8846 serves this folder. If it is not running, start it from the repository root:

```sh
rtk proxy python3 -m http.server 8846 --bind 127.0.0.1 --directory .
```

- **Canvas:** drag a node; pan or zoom; open Add step and drag a skill onto the canvas. Select an output then an input, drag a port, or choose a compatible input in Setup. Arrow keys move a focused node; Enter opens Setup. The ordered phone view provides equivalent selection and input controls.
- **Navigation and recovery:** Skills and workflow views have shareable URL routes, including evaluation filters and selected cases. Phone panels contain keyboard focus and have explicit close actions. Narrow tablets use the outline beside chat. Invalid Setup values remain in place with inline guidance; Restore valid uses a real validated snapshot. Appearance supports System, Light and Dark.
- **AI:** Ask Bakery opens beside the canvas. Choose Ask before editing or Auto-build draft. Try “Research an issue, then make a plan,” “Add an independent review,” or select a step and request a 45-minute timeout. Review the concrete edit list and apply, or let auto-build make a reversible draft edit. Step removals still pause for review. Save a checkpoint through Conversation options, compare and restore it, then Undo. A stale proposal must refresh against the current revision. Conversations, unsent messages, pending proposals, checkpoints and up to 40 Undo records are stored per workflow on the same device. Refresh retains the proposal’s original step context; checkpoint comparison includes budgets, inputs and nested configuration.
- **JSON:** edit a name or timeout and see the canvas change; edit Setup and inspect the matching JSON. Invalid source is retained while the last valid canvas remains available. Restore valid, formatting, validated import and JSON download are available.
- **Workflows:** open the library, inspect locked Research/Plan/Implement sources, create an editable organization copy or an empty workflow. Each is stored separately; reopening an unfinished draft preserves the library and exact source buffer.
- **Skills:** filter Global, Organization or My skills. A skill is a package with a required `SKILL.md`, nested directories and multiple Markdown, JSON, YAML, text, JavaScript and Python files. Browse and edit every text file inline. Only declared `.js`/`.mjs` and `.py` files can be runnable; validation rejects every other executable type. Copying preserves the complete package, and a workflow keeps its pinned revision until you select an explicit update in Setup.
- **Evaluations:** inspect baseline/candidate scores, filter failures and open a case's input, expected behavior, actual output and explanation. Add a test case and save it into a new selectable organization dataset revision. New revisions start unscored; example results are never relabeled as actual runs.

Appearance offers System, Light and Dark using Bakery's tokens. Phones use a readable outline and focused full-width panels; text editing is 16px and primary touch controls are at least 44px. Undo remains available after AI changes.

## Boundaries

This is a dependency-free design prototype with local browser storage, sample runs and scripted AI proposals. No cloud agent, evaluator, worker, webhook, publication service or external connection is called. The Run evaluation interaction explicitly opens a fixed example fixture. Real permissions, concurrency, collaborative editing and durable storage belong to the technical plan.

The compact model illustrates a subset of the canonical typed JSON contract. It validates bounded JSON/duplicate keys, versions, IDs, compatible references/actions/skills, timeouts, skill package paths and runnable file types, plus some loop constraints. Semantically incomplete JSON remains in the source buffer instead of supporting every incomplete graph shape. Drag positions are presentation metadata. Multi-repository branches are illustrated, but all-candidate integration acceptance and scheduling require the production compiler/runtime.

Global/organization/user permissions are visual examples; server enforcement is required. Local workflow and skill copying preserve separate records and revisions, but full source lineage, import binding resolution, retirement policy and connection authorization remain production work. Evaluation dataset revisions are saved locally; scoring, suite configuration, usage and release gates are specified in chapter 23.

The [workflow plan](../06-workflows-delivery-and-acceptance.md) retains the complete contract for locked packages, copies, bounded control flow, multi-repository coordination, issue-label routing, import/export, connections and webhooks. [Chapter 23](../23-skills-and-evaluations.md) adds Skills management, exact evaluation manifests, registered code/model scoring, budgeted Inngest execution, comparison semantics, scoped operations and implementation acceptance. Structured schema/catalog reconciliation is still pending.

## Verification and design sources

```sh
rtk proxy node docs/technical-design/workflow-studio/verify.mjs
rtk proxy node --check docs/technical-design/workflow-studio/studio.mjs
```

The design-quality score covers the reviewed prototype; production runtime acceptance is excluded.

`index.html`, `studio.css`, `studio.mjs`, `samples.mjs` and `icons.mjs` are the current interactive design. `model.mjs` holds the bounded prototype validator; assistant.mjs describes semantic edits and the actual current graph. `studio-paper.mjs` generates the revised inline Paper source; `paper-revision-source.json` is its output and `paper-revision-manifest.json` records the actual editable artboards. `paper-tokens.css` is the existing Paper token export. `mobile-status-bar.html` is Paper's supplied status-bar markup. Exported preview images live in `previews/`.

Regenerate the revised source with:

```sh
rtk proxy node docs/technical-design/workflow-studio/studio-paper.mjs --write
```

This writes the source file only. Paper edits use its MCP tools and need screenshot review before updating the manifest. The legacy `boards.mjs`, `paper-source.json`, `paper-manifest.json` and original [35-frame Paper page](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/X-0) are retained as earlier studies, not the current authoring direction.
