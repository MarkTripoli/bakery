# Integration design handoff

Status: reviewable Paper designs, not a running integration UI. All accounts, events, URLs and connection state shown are fixtures. The current v2 route set uses the enterprise icon rail and supersedes the earlier integration navigation.

Mobile-first is a global product requirement. Each of the 11 current route families has a phone and desktop counterpart. New views cannot enter design handoff without both. Follow the [shared responsive contract](../enterprise-mocks/UI-CONTRACT.md): complete phone flows, equivalent actions on desktop, documented tablet transitions, safe areas, keyboard handling and 44px touch targets. Static paired exports do not prove runtime reflow.

Provider subpages keep Overview, Permissions, Connections and Docs navigation on phone. Provider-owned access links remain available wherever an account, installation or workspace can be changed. Mobile breadcrumbs name the immediate parent route; dirty forms still use the existing unsaved-change confirmation before navigation.

## Source and reuse

- [Current editable routes in Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/6-0): 11 paired desktop/phone route families for the catalog, provider subpages, setup, installed connections and recovery.
- [Responsive route gallery](../integration-mocks-v2/index.html): exact exports with route navigation, deep links and desktop/phone switching.
- [Earlier state library in Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/5-0): recovery, confirmation, webhook and delivery specimens retained as supporting states.
- [Primitive library in Paper](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/4-0): 32 named variants across four sheets.
- [Screen/component map](../integration-mocks-v2/paper-manifest.json): Paper references, dimensions and export names. Screen IDs are design references, not runtime IDs.
- [Exact Paper export](primitives.json): token values, computed styles and JSX for each primitive. Exported divs are visual source, not accessible production controls.

Paper MCP exposes editable nodes and cloning, not live component-instance propagation. These mocks clone canonical primitives and share token references. Regenerate affected clones when a master changes. In implementation, map masters to one shared React UI package and import it in both screens and Storybook; do not paste the export into each screen.

| Paper family | Shared React component / required behavior |
|---|---|
| Primary, secondary, destructive, ghost, focus, hover, pressed, loading, disabled | Button variants; native button semantics; loading prevents duplicate submission without losing focus |
| Touch and icon action | Button size and IconButton; 44px coarse-pointer target; accessible icon name |
| Field, focused, invalid, disabled, secret, textarea | Label + native control + description/error; 16px editable type; aria-describedby/invalid; secret reveal/copy only during authorized setup |
| Select and search | Shared Select/Combobox and SearchField; keyboard selection, empty results, loading, cursor continuation |
| Checked, unchecked, unavailable choice | Checkbox and ResourceChoice; full row is the hit area; unavailable reason is visible |
| Healthy, pending, revoked, disabled | StatusBadge; text conveys state independently of color |
| Neutral, warning, error notice | Notice; status/alert semantics appropriate to urgency; safe StandardError message only |
| Selected/default tab | Tabs; arrow-key navigation, aria-selected and panel relationship |
| Confirm dialog | AlertDialog on desktop, accessible sheet on phone; focus trap, labeled title, initial safe action, return focus |

The route work also defines shared product patterns for implementation and Storybook:

| Pattern | Contract |
|---|---|
| `ProviderHeader` | Provider identity, native/verified status, provider tabs and one installation action |
| `OAuthHandoff` | Bakery context, provider-owned consent boundary, return destination and one primary continuation |
| `ProviderAccessSummary` | Plain-language effective access first; technical provider scopes remain available as secondary detail |
| `ResourcePicker` | Server search, opaque cursor continuation, persistent cross-page selection and selected-only review |
| `CapabilityStatusList` | Read-only included/needs-approval states; editable controls appear only in a distinct change flow |
| `DeliveryRouteList` | Named routes, zero or more channel targets, visible mobile edit action and provider-scope note |
| `ConnectionHealth` | Lifecycle and health shown separately with time, safe problem code and next action |
| `ConnectionImpactReview` | Affected resources, workflow/queue effects, provider-side remainder and typed confirmation |

Control outline token: --color-control-border = #8A8A94 (3.42:1 against white); decorative separators keep --color-border.

Geist 13/14/16/20/24px; 4px spacing unit; neutral primary action; semantic statuses. Fields 44px; desktop buttons 36px, coarse-pointer targets 44px. Long values scroll inside controls, never widen the page. Apply the existing 743/744/1280 responsive boundaries. Full-page integration setup/detail routes provide room for resource and permission review; this supersedes the earlier generic side-pane suggestion. Incidental context may still use an inspector.

At 320–743px, use the mobile header and single content column; every core action remains visible, provider tabs scroll without truncating labels, resource selection exposes a selected-only review, and route editing uses 44px targets. At 744–1279px, retain the icon rail, stack secondary inspectors below the main section, keep setup content to a readable maximum width, and keep repository/route summaries in flow. At 1280px and wider, use the full rail and optional side inspector. No breakpoint may hide an action without exposing an equivalent menu item on that same screen.

## Flow contract

| Flow | Screens and boundaries |
|---|---|
| Discovery | `/integrations` is the shared catalog and installed-connection entry point. Each provider owns a subpage such as `/integrations/github` or `/integrations/slack`. |
| GitHub install | Organization → real provider consent → verified account → repository partition → Bakery actions → connected detail |
| GitHub access change | Current/requested/effective comparison → provider approval when needed → current resource/action review; other organizations do not gain Bakery grants |
| Update | Rename and save with version check; immutable account identity; dirty navigation uses confirmation |
| Disable/remove | Disable retains resource reservations. Removal previews affected resources, workflows, queued work and provider-side remainder before typed confirmation; shared installation and other organizations remain intact |
| Slack | Provider workspace consent → workspace-wide entry points and named channel delivery routes on one configuration page → bot scope review; separate authenticated OIDC linking for each human |
| Webhook inbound | Bound application + selected intake behavior → receiver and secret setup → connection detail; no auto-execution by installation |
| Webhook outbound | HTTPS destination + separate key → source/events/content/sender grant → disabled subscription → review and enable |
| Delivery | Activity → safe effect detail; uncertain writes reconcile, never blind retry |
| Recovery | The paired recovery specimen covers verifying, canceled, expired, wrong-account, partial, revoked, degraded, stale and resolved states with one safe next action |

GitHub fixture uses Metadata read + Issues write; checks and code permissions require a separate review. Show the plain-language effect before the technical scope names. Provider consent can be broader than Bakery grants; never present read-only Bakery capability status as checkboxes or imply that it reduces the provider's consent grant. Bakery exposes opaque cursor pagination even when a provider uses page numbers internally. Repository search is server-side, each response returns a bounded batch plus `nextCursor`, and selections persist across pages and searches. A selected-only review remains available; newly discovered repositories stay unselected. An unavailable repository never names its owning Bakery organization.

Slack is a workspace-wide Bakery interface. Its shared communication capabilities include app mentions, direct messages, commands/actions and Bakery-owned threads. Conversations and delivery routes are grouped sections on one configuration page, then reviewed together; each named route can target one or more channels for progress, failures or application events, and every route has a visible mobile edit action. Bot scope profile starts with the least access needed for enabled entry points and routes. The mobile setup includes a visible scope-review action. Channel discovery uses cursor-based `conversations.list`; posting is limited to channels where Bakery is invited. Broad public-channel posting through `chat:write.public` is an explicit scope upgrade. [Slack channel scope](https://docs.slack.dev/reference/scopes/channels.read/), [channel listing](https://docs.slack.dev/reference/methods/conversations.list/). Personal identity uses separate openid/profile consent. Successful installation does not link a person or confer membership.

Webhook secret setup is a proposed one-time delivery contract: authenticated Admin sees the newly generated value during setup only, with explicit reveal/copy. Do not write it to URL, local storage, analytics, logs, agents or audit payloads. Lost values require rotation. The masked screenshot is never evidence that a real key exists. Retain the defined overlap policy for rotation and separate inbound/outbound keys.

## States and acceptance

Create, update, enable and remove recheck membership, role, resource boundary, policy and version on the server. UI gating explains access; it does not authorize it. Developers share enabled actions but cannot manage the connection. Automations require their own grants.

Show connected only after verified usable identity is persisted. OAuth callback state binds user, organization and attempt; handle denied, expired, wrong-account and duplicate callbacks without advancing incorrectly. Preserve nonsecret draft selections for the attempt. Show the original request's status on duplicate submissions. The recovery route is an all-states reference matrix; a separate attention-queue filter contains only live unresolved connections. Cancellation/removal never promises that an already-submitted provider action was undone. Removal states that already-submitted actions may finish and that audit history and local records remain available.

Required Storybook matrix: primitives at default/hover/pressed/focus/loading/disabled/error; all current route families plus retained state specimens; empty/search-empty/loading, pending callback, canceled/expired callback, account/repository selection, healthy/partial/revoked/suspended/disabled, stale discovery, unavailable resource, quota countdown, uncertain effect and stale edit. Each list uses cursor continuation. Unavailable secrets and actions get explicit reasons.

Use shared fixture schemas and StandardError/Problem parsing. No raw provider exception, headers, body or token in UI/logs. Errors show an actionable safe message and correlation reference. Render server notices without injecting HTML. Authorization forms and destructive confirmations need keyboard, screen-reader, zoom/reflow and mobile checks in implementation.

Design review: compare future code against the matching Paper export at fixed viewport and fixture state. The agreed default visual similarity gate is 95%; runtime accessibility, behavior and integration acceptance are separate gates. The gallery verifies image/source linkage and responsive navigation, not production UI behavior. Mock controls in the images are not clickable. Provider-hosted consent pages are intentionally represented by Bakery's handoff and return states.
