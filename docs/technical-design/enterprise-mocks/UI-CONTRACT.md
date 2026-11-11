# Bakery enterprise UI contract

**Status:** proposed design contract for editable mocks and later Storybook
extraction. It describes screen behavior and component anatomy; it is not a
running implementation, API contract, or visual pixel specification. All
content in mocks is synthetic.

## Direction and rails

Composition A, the **work queue**, anchors the product: compact triage rows,
scoped filters, and a selected-task inspector. It is the selected review
composition (review key `947b2a38`). The session workspace is the primary
follow-through surface; application oversight is its companion view.
The visual references are Linear (work density), GitHub (revision and review
evidence), Vercel (application and environment clarity), and Codex (persistent
sessions and steering). Use the references as interaction cues, never as
copied branding. The approved bread-bot is a small app mark only.

Bakery adapts Alidade's engineering rails to a native React web client:
React + Vite, TanStack Router and Query, shadcn/Radix primitives, strict
TypeScript, semantic components, co-located stories, Storybook, and responsive
rails. Alidade's implementation is Expo React Native; Bakery does not treat
that runtime or its components as dependencies. The server remains the
authority; REST performs writes, the authenticated resumable event stream only
delivers notifications, and query/mutation state is owned by TanStack Query.
The UI must show `loading`, `empty`, `ready`, `stale`, `reconnecting`, `error`,
and `forbidden` paths, with labeled status text and accessible focus behavior.

### v1 design tokens

These are the v1 design tokens captured by the reviewed Paper composition and
matched by `DESIGN.md`; the runtime token implementation remains unimplemented:

| Role | v1 value |
| --- | --- |
| work surface | `#FFFFFF` |
| navigation/subtle surface | `#F7F7F8` |
| primary text | `#18181B` |
| supporting text | `#60616B` |
| separator | `#E4E4E7` |
| selection/focus | `#3158D4` |
| type | Geist; Geist Mono for IDs, SHAs, logs, and measured values |

Use a four-pixel spacing unit, 13/14/16/20/24px type steps, compact controls
at 36px on fine pointers, 44px targets on coarse pointers, and 4–6px control
corners. Semantic green, amber, and red always include readable labels and
icons. No gradients, bread-gold surfaces, decorative glow, or stacked floating
cards. These values are design references; runtime token generation and
consumption remain unimplemented.

### Responsive transform

**Global handoff gate:** every screen/state has paired phone and desktop Paper mocks. Author the phone flow first; preserve its actions when expanding to desktop. Match fixture, revision and authorization state across the pair. Tablet behavior is specified between them; add a tablet frame when the composition introduces a distinct interaction. Reference sheets do not satisfy this screen gate.

| Profile | Structure | Required transform |
| --- | --- | --- |
| sheet, ≤743px | one column, compact header and navigation drawer | queue filters become a sheet; selecting work opens a focused task route; primary action stays reachable after content |
| pane, 744–1279px | collapsed navigation, two prioritized columns | keep queue plus inspector when space permits; move secondary detail below the work surface |
| rail, ≥1280px | labeled rail, work canvas, inspector | persistent inspector and compact rows; no horizontal squeeze |

Pointer capability is independent of width. Reading content caps at 720px;
long logs and artifact previews scroll or paginate intentionally. Deep links,
keyboard navigation, zoom/reflow, reduced motion, and 44px coarse-pointer
targets apply at every profile.

Use mobile base CSS, progressive min-width/container queries, safe-area padding and dynamic viewport height. Test 320/360/390/430px phones, both sides of 744/1280px transitions, 834/1024px tablets, 1440/1920px desktops, plus landscape and software keyboard. Do not hide core functionality on mobile. Tables become labeled rows or bounded scroll regions; side inspectors become routes or accessible sheets; comments, approvals and forms remain fully usable. Authentication, integrations, organization settings, Tickets, desktop-shell content and plugin-hosted UI follow this same contract.

Runtime acceptance additionally requires WebKit/iOS Safari, Chromium/Android Chrome and desktop browser checks; touch and keyboard; 200% text enlargement and reflow at 320 CSS pixels; long/pseudo-localized copy; empty, loading, error, offline and concurrent-edit states. Real-device keyboard and safe-area checks remain required before release. A responsive gallery around static images proves neither intermediate product reflow nor those device interactions.

## Provider, harness, and model selection

Bakery is provider/model agnostic. A **harness** is the execution boundary
(Pi, Claude Code, or Codex; Mastra may appear where the backend configuration
allows it), a **provider connection** is the authenticated account or adapter,
and a **model** is one concrete model exposed by that connection. They are
distinct concepts and records. The model picker may combine provider and model selection, while the harness remains a separate control. A harness does not imply that every model can
run in it, and a provider connection does not imply access to every model.

Every task, session, and workflow step lets the user choose a concrete model
when the compatible catalog is known. Light-touch full automation may use a
configured inexpensive preset so the user need not choose on every run. The
UI always shows both the inherited default and the resolved actual selection,
along with the cost source (`subscription`, `api`, `compute`, or `storage`)
when recorded. It must not invent a price; unknown cost is labeled unknown.

Proposed resolution precedence, from most specific to least specific, is:

```text
explicit step invocation override → explicit task/session override →
workflow-step or automation preset → repository default → workspace default →
installation default
```

An automation preset is therefore a configured policy selected by the
workflow/automation, not a workspace default silently overriding it. The
installation fallback is only present if administration exposes that setting;
otherwise resolution stops at the workspace default.

Resolution is constrained by the selected harness, connected credential,
provider model catalog, capability grants, region or context limits, and any
budget policy. An unavailable or incompatible selection is an explicit
validation/problem state with a compatible alternative only when the catalog
provides one. Retry preserves the active attempt's resolved selection; a
changed model takes effect on the next invocation/attempt and never rewrites
history for an invocation already started.

The UI presents a compact `ModelResolution` trace: inherited source, each
override that was considered, resolved harness/provider/model, compatibility
constraints, and cost measurement/source. Automation presets expose their
model and harness policy as editable configuration, with an inexpensive
default preset clearly labeled as a default rather than a hidden forced
choice.

The current transport evidence supports `AgentConfig.harness` and
`usage_records.provider/model/billingType`, plus bounded billing configuration,
but does not establish a connected-provider model-catalog DTO or fields for
workspace/repository/task/step override precedence and resolved invocation
metadata. Those require a future catalog/resolution contract and safe
projections (or an explicit extension to existing config schemas) before
implementation; mocks may show the proposed fields but must label them
`proposed`. Any installation default must also be added to the settings and
resolution contract rather than assumed.

## Screen contract

Each screen exposes one primary operation, its current data state, and the
scope or revision being acted on. Actions are disabled or hidden by permission
but are always rechecked by the API.

| Page | Primary action | Data and state surface | Mobile transform |
| --- | --- | --- | --- |
| **Work** `/` | create task or open selected work | queue rows show title, application/repository, status, owner, updated time, revision, and resolved model; filters and cursor continuation; inspector shows next action, run state, plan, checks, artifacts, preview, and model resolution | bottom nav; filter sheet; dedicated task detail route with tabs; actions remain reachable |
| **Intake** `/inbox` | triage, accept, or create from webhook/chat/schedule | source, received time, normalized request, missing information, dedupe state, validation errors, retry; explicit `needs input` | one intake item per screen with sticky accept/request-info action; raw payload behind disclosure |
| **Sessions** `/tasks/:taskId` | send steering message or run control | persistent session sidebar, shared conversation, queued/active turns, plan version, event cursor, run timeline, reconnect marker; private draft and author attribution; each invocation exposes harness/provider/model and inherited/resolved policy | sidebar becomes drawer; conversation first; plan/timeline/model tabs; composer fixed within safe area |
| **Artifacts/comments** `/tasks/:taskId/artifacts/:artifactId` | open revision, comment, resolve/reopen | artifact version and SHA, bounded preview/download, check results, anchored threads, replies, stale revision notice | preview first; comments sheet with original-revision link; compose and resolve remain 44px reachable |
| **Applications** `/applications` | inspect application or add one (Admin) | aligned application table: repository/profile, environment, active work, latest deploy/check, health and last update; selected delivery detail | table becomes stacked rows; detail is a sheet; filters and add action in top sheet |
| **Workers** `/workers` | inspect health or register/disable host (Admin) | host capability, lease, capacity, heartbeat, current job, version, degraded/offline reason; never show credentials | host cards with health and current job; capability/detail sheet; destructive controls behind confirmation |
| **Workflow editor** `/workflows` | edit and validate a versioned workflow | version list, YAML/editor surface, validation problems, diff, run preview, active-run pinned version, save/publish state and ETag conflict | versions and editor are tabs; problems open from a bottom panel; publish action remains sticky |
| **Skills + MCP + integrations** `/skills`, `/integrations` | inspect revision or connect/import provider | skills show source, digest, manifest, files, install/import state; MCP shows tool discovery and scopes; integrations show provider connection, health, scopes, credential version, rotation state, and compatible model catalog; secrets are never rendered | segmented tabs; catalog rows become cards; install/connect/rotate/model catalog uses full-height sheet |
| **Automations** `/automations` | create, pause, or run an automation | schedule/trigger, target scope, last/next run, status, notification policy, failure and retry history; paused and permission states explicit | list plus detail sheet; create form is a step-light sheet with review before submit |
| **Usage/evals** `/usage`, `/evals` | inspect cost or run an evaluation | exact decimal budget values, reserved/settled/available, unknown measurements, run/application scope; eval suite, revision, pass/fail findings, baseline and artifact links | summary strip becomes horizontal scroll; tables stack; filters in sheet; values remain text, not color-only charts |
| **Settings/auth** `/settings`, `/login` | sign in or update profile/session controls | Better Auth session, role, profile, notification/session settings supported by contract, local endpoint; loading, expired, forbidden, and restored deep link | single-column form; full-width controls; destructive/session actions separated and labeled |

Work, Sessions, and Artifacts preserve visible links between task, run,
revision, checks, comments, and preview. A disconnected event stream retains
the last durable state and says `reconnecting`; it never claims live state.
Cursor pagination uses an accessible Load more or continuation control, never
numbered pages.

## Shared component families

The supported surface is semantic `@bakery/ui` composition over shadcn/Radix;
feature screens do not invent raw colors, one-off spacing, or absolute
overlays.

- **Shell/navigation:** `AppShell`, `ResponsiveNav`, `PageHeader`,
  `Breadcrumbs`, `ScopeSwitcher`, `CommandMenu`, `MobileNav`.
- **Layout/surfaces:** `Stack`, `Inline`, `Panel`, `Card`, `Section`,
  `Inspector`, `Tabs`, `Sheet`, `Dialog`, `Popover`, `Separator`.
- **Controls:** `Button`, `IconButton`, `TextField`, `Textarea`, `Select`,
  `Combobox`, `Date/TimeField`, `FilterBar`, `SegmentedControl`, `Menu`.
- **Work/session:** `TaskRow`, `TaskQueue`, `TaskComposer`, `SessionSidebar`,
  `MessageList`, `ReplyComposer`, `RunTimeline`, `PlanVersion`, `RunControl`,
  `HarnessSelector`, `ProviderSelector`, `ModelSelector`, `ModelResolution`.
- **Evidence:** `RevisionBadge`, `CheckSummary`, `ArtifactPreview`,
  `ArtifactVersionList`, `CommentThread`, `CommentAnchor`, `DiffView`,
  `LogViewer`.
- **Operations:** `ApplicationRow`, `WorkerRow`, `WorkflowVersionList`,
  `YamlEditor`, `SkillRevisionRow`, `ProviderConnectionRow`, `AutomationRow`,
  `UsageSummary`, `EvalFindingList`.
- **State/feedback:** `StatusLabel`, `StatusDot`, `DataText`, `Skeleton`,
  `EmptyState`, `InlineNotice`, `AlertBanner`, `ProblemNotice`, `ErrorState`,
  `Toast`, `RetryAction`, `LoadMore`, `UnsavedChangesNotice`.

Every stateful component supports keyboard/focus, disabled and permission
variants, long labels, loading, empty, failure, and coarse-pointer anatomy.
State colors are paired with text and semantic status attributes.

## Storybook specimen contract

Stories are co-located with components and grouped by family. The catalog must
include desktop rail, pane, sheet, fine/coarse pointer, 1.3 text scale,
reduced-motion, keyboard focus, and long-content specimens. Required stories:

1. **Shell and primitives:** navigation, queue row, inspector, panel, tabs,
   controls, menus, sheets/dialogs, typography, token roles.
2. **Work/session:** empty queue, filtered queue, selected task, active run,
   needs-input, failed run, reconnecting session, concurrent messages, private
   draft, plan version conflict.
3. **Evidence and operations:** artifact preview with long log, anchored
   comment/reply, stale revision, application and worker tables, workflow
   validation/diff, skill/MCP/integration permission and health states,
   connected-provider model catalog, incompatible model/harness, inherited
   versus resolved model, automation preset, retry-next-invocation behavior,
   automation failure, usage unknown measurement, eval findings.
4. **Rails:** every page at all three responsive profiles, with focus order,
   overflow/truncation markers, target-size checks, and synthetic-data labels.

Paper frames validate composition and interaction intent. Storybook validates
the extracted component contract. Neither is evidence that the web client,
server routes, live events, auth, or worker behavior is implemented.

## State and data rules

Use synthetic IDs, names, SHAs, timestamps, usage, comments, and statuses in
all mock frames. Never imply production telemetry or customer data. Map
transport faults to safe UI states: 401 restores `/login` and the deep link;
403 explains the required role without retry looping; 409 offers refetch or
reconcile; 422 focuses the first invalid field; 429/503 show retry timing;
worker/provider absence explains queued behavior. Unknown, stale, offline,
and reconnecting states remain visibly distinct from healthy live state.

## Implementation boundary

This file is a design-system and screen-state contract for the reviewed Paper
composition and eventual `@bakery/ui` stories. It does not change the runtime,
Alidade, API catalogs, data model, Paper file, or token source. Runtime
implementation begins only after the reviewed tokens, anatomy, and states are
extracted into the proposed React/Vite system.
