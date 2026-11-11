---
name: Bakery
description: A quiet production floor for observable, agent-operated software delivery
colors:
  light-canvas: "#F5F6F8"
  light-surface: "#FFFFFF"
  light-surface-subtle: "#EEF0F4"
  light-surface-raised: "#FFFFFF"
  light-foreground: "#141A24"
  light-foreground-secondary: "#5D6675"
  light-foreground-tertiary: "#6B7686"
  light-foreground-disabled: "#9AA3B1"
  light-border: "#E3E6EB"
  light-border-strong: "#CBD0D8"
  light-control-border: "#8A939F"
  light-selection: "#0B63C6"
  light-selection-hover: "#0A56AD"
  light-selection-surface: "#ECF1F8"
  light-primary: "#141A24"
  light-primary-hover: "#262E3B"
  light-primary-foreground: "#FFFFFF"
  light-destructive: "#BE3341"
  light-destructive-hover: "#A72C3A"
  light-destructive-foreground: "#FFFFFF"
  dark-canvas: "#0B0E14"
  dark-surface: "#12161E"
  dark-surface-subtle: "#191E28"
  dark-surface-raised: "#212733"
  dark-foreground: "#F2F4F8"
  dark-foreground-secondary: "#A3ACBA"
  dark-foreground-tertiary: "#7D879A"
  dark-foreground-disabled: "#566173"
  dark-border: "#2D3542"
  dark-border-strong: "#3D4655"
  dark-control-border: "#59657A"
  dark-selection: "#4A93E6"
  dark-selection-hover: "#6EAAF0"
  dark-selection-surface: "#152338"
  dark-primary: "#F2F4F8"
  dark-primary-hover: "#DCE0E7"
  dark-primary-foreground: "#0B0E14"
  dark-destructive: "#C7394C"
  dark-destructive-foreground: "#FFFFFF"
  light-success: "#17784B"
  light-success-surface: "#E8F5EE"
  light-warning: "#8F5A0B"
  light-warning-surface: "#FBF3E4"
  light-critical: "#BE3341"
  light-critical-surface: "#FCEEEF"
  dark-success: "#45B37C"
  dark-success-surface: "#0F261C"
  dark-warning: "#E0A83F"
  dark-warning-surface: "#2A2010"
  dark-critical: "#EE6A79"
  dark-critical-surface: "#331820"
typography:
  display:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "36px"
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.02em"
  h2:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  heading:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
    letterSpacing: "0"
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0"
  body-large:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
    letterSpacing: "0"
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0"
  caption:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0"
rounded:
  control: "4px"
  surface: "6px"
  overlay: "8px"
  sheet: "12px"
  round: "999px"
spacing:
  "0": "0px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
components:
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-primary-dark:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-secondary-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  button-secondary-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
    height: "36px"
  field-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "40px"
  field-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "40px"
  nav-selected-light:
    backgroundColor: "{colors.light-selection-surface}"
    textColor: "{colors.light-selection}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "36px"
  nav-selected-dark:
    backgroundColor: "{colors.dark-selection-surface}"
    textColor: "{colors.dark-selection}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "36px"
---

# Design System: Bakery

## Overview

**Creative North Star: "The Quiet Production Floor"**

The [Paper file](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D) is the source of truth for token values and component geometry. This document mirrors it; when they disagree, update this document.

Bakery is an enterprise operating surface for directing and observing software work. It borrows the calm density of Linear, the revision and evidence discipline of GitHub, the environment clarity of Vercel, and the persistent-session ergonomics of Codex. The system should feel deliberate, familiar, and fast under sustained daily use. The approved bread-bot and conveyor identity provides one warm human signal at brand scale; it does not turn operational UI into a themed workshop.

Light and dark are authored peers. A phone in daylight and a desktop used late at night must expose the same hierarchy, state, and task capability. Theme changes color and elevation values only; component geometry, typography, density, information architecture, status meaning, and interaction remain stable.

**Key Characteristics:**
- Neutral operational surfaces with one restrained cobalt interaction color.
- Hairline structure, compact rows, and direct information instead of stacked decorative cards.
- Geist for human interface language; Geist Mono only for machine values.
- Every state is named in text and supported by color, iconography, or shape.
- Sheet, pane, and rail compositions share one component and content grammar.
- Product areas with sibling pages share persistent secondary navigation; the current section stays visible through detail and edit flows.
- Model, harness, provider, person, and agent identities remain visually distinct.

## Colors

The palette is cool fog white and ink in light mode, wet-ink black and cool instrument gray in dark mode. Neutrals share one hue family (about 218°) with no violet cast. Cobalt identifies selection, focus, links, and user-controlled action; it is never a button fill. Semantic green, amber, and red remain scarce, sit in the same desaturated register, and never substitute for labels.

### Theme mapping

| Semantic role | Light | Dark | Use |
|---|---|---|---|
| Canvas | `#F5F6F8` | `#0B0E14` | App background and navigation field |
| Surface | `#FFFFFF` | `#12161E` | Main work area, fields, panels |
| Subtle surface | `#EEF0F4` | `#191E28` | Hover, grouped rows, secondary regions |
| Raised surface | `#FFFFFF` | `#212733` | Menus, popovers, dialogs |
| Primary foreground | `#141A24` | `#F2F4F8` | Titles, body, controls |
| Secondary foreground | `#5D6675` | `#A3ACBA` | Supporting copy and metadata |
| Border | `#E3E6EB` | `#2D3542` | Dividers and resting boundaries |
| Control border | `#8A939F` | `#59657A` | Inputs and selectable controls (3:1 against surface) |
| Selection | `#0B63C6` | `#4A93E6` | Links, focus, active navigation, checkbox and radio fill |
| Selected surface | `#ECF1F8` | `#152338` | Persistent selected state |
| Primary action | `#141A24` / white | `#F2F4F8` / `#0B0E14` | One current primary action; same ink as foreground |
| Destructive action | `#BE3341` / white | `#C7394C` / white | Separate dark fill so white labels stay at 5:1 |

### Semantic state

| State | Light foreground / surface | Dark foreground / surface |
|---|---|---|
| Healthy / successful | `#17784B` / `#E8F5EE` | `#45B37C` / `#0F261C` |
| Pending / degraded | `#8F5A0B` / `#FBF3E4` | `#E0A83F` / `#2A2010` |
| Failed / destructive | `#BE3341` / `#FCEEEF` | `#EE6A79` / `#331820` |
| Unknown / unavailable | tertiary foreground / subtle surface | tertiary foreground / subtle surface |

**The Two Themes Rule.** Light and dark are explicit token maps. Never generate dark mode with `filter`, opacity inversion, or an algorithmic color flip.

**The One Cobalt Rule.** Cobalt is the only non-semantic interaction accent. It marks selection, focus, links, and user-controlled progress; provider brands remain inside provider identity marks.

**The State Speaks Twice Rule.** State color always appears with readable status text and, where useful, an icon or shape.

**The Bread Gold Boundary.** Warm mascot colors belong to the logo, favicon, onboarding delight, and empty-state illustration. They are not application surfaces, metrics, selection, or warnings.

Theme preference defaults to the operating system and can be set to System, Light, or Dark per person. Store the override; apply it before first paint; set `color-scheme`, browser chrome, syntax theme, charts, and native desktop title bar together. Embedded previews keep their own isolated theme.

## Typography

**Display Font:** Geist, system-ui fallback.
**Body Font:** Geist, system-ui fallback.
**Data Font:** Geist Mono, ui-monospace fallback.

**Character:** Geist keeps dense operational text plain and precise. Weight and scale create hierarchy. Geist Mono is evidence, not decoration.

### Hierarchy
- **Display** (600, 28/36, -0.02em): rare empty states, onboarding, and major overview moments.
- **H1** (600, 24/32, -0.02em): route title.
- **H2** (600, 20/28, -0.015em): major section.
- **Heading** (600, 16/24): panel, list group, or dialog title.
- **Body Large** (400, 16/24): reading and explanatory copy, 65–75ch maximum.
- **Body / UI** (400 or 500, 14/20): rows, controls, navigation, descriptions.
- **Label** (500, 13/20): field labels, compact headings, button labels.
- **Caption** (400, 12/18): timestamps and secondary metadata; never essential instructions alone.
- **Data** (400, 13/20): IDs, hashes, code-adjacent values, measurements, resolved model data.

Editable form text is at least 16px on phone. Use tabular numerals for counts, time, cost, and telemetry. Uppercase is limited to protocol identifiers or source data that is already uppercase.

**The Interface First Rule.** Human language stays in Geist. A technical product does not earn monospace navigation, buttons, labels, or prose.

**The Translation Expansion Rule.** Controls and layouts tolerate at least 35% text expansion. Never solve translated copy with smaller type.

## Layout

Bakery uses two independent axes: width-derived target and pointer capability. `sheet` covers 320–743px, `pane` covers 744–1279px, and `rail` begins at 1280px. Pointer determines hit area: 44px minimum for coarse input and 28px minimum for fine input. Width never implies pointer type.

Sheet uses one focused column, full-page subroutes, bottom sheets for protected focus, safe-area padding, and reachable actions above the software keyboard. Pane uses a compact 56px rail and introduces a second pane only when each region retains its minimum useful width. Rail uses the approved 208px navigation, flexible work surface, and optional 320px inspector.

### Section navigation

**The Persistent Section Navigation Rule.** Product areas with several sibling pages use the same secondary menu pattern, beginning with Settings and Organization. The primary rail selects the product area; the secondary menu lists its sections. Keep labels, order, spacing, and selected treatment consistent throughout the area. Detail, invite, and edit flows keep their parent section selected. Content tabs switch views within a section and never duplicate its section menu.

At rail widths, use the shared 224px secondary rail (`--container-section-sidebar`) below the 64px top bar, between global navigation and content. Reuse the Settings pattern: text-first links, 16px inline / 32px block rail padding, 12px inline row padding, 4px item gaps, 36px minimum rows for fine pointers, and the theme's selection foreground and surface with medium-weight selected text. Labels wrap and rows grow. At pane and sheet widths, expose the same destinations through a compact section selector or full-page section index with a clear parent return link; coarse targets remain at least 44px. Preserve hierarchy in both themes, label the navigation region, use real route links with `aria-current="page"`, support keyboard access and focus return, and reflow at 320px and 200% zoom. See [Paper's core navigation principle](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/B-0).

One route list supplies every target's labels, order, selected parent and capability filtering. Deep links and browser history retain the section; loading and errors retain the shell. Route changes preserve or explicitly resolve dirty drafts, focus the new heading, and return focus to the trigger when a temporary menu closes. Future concepts stay out of current navigation until available. Apply this standard to all new and revised multi-section surfaces, including desktop and plugins.

The single account area is named **Settings**; do not duplicate it as User settings or Personal settings. Its [canonical Paper page](https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/O-0) and [handoff](settings-mocks/SETTINGS.md) own account controls and read-only effective access. Organization members and shared organization administration have their own area.

Spacing uses 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64px. Components use container `gap`; feature code does not invent margins. Rows are 36px compact, 44px standard, and 56px comfortable. Page gutters are 16px sheet, 24px pane, and 40px rail. Reading measure stops at 720px.

Information lives directly on surfaces. Use aligned rows, section rules, split panes, and contextual inspectors. A card earns its border only when it represents one bounded object or interaction. Lists use fixed icon, content, status, and action lanes. Tables provide a list transformation on sheet rather than horizontal page overflow.

Every screen supports empty, loading, error, permission, offline, long-content, 200% zoom, keyboard, touch, reduced-motion, pseudo-locale, and RTL states. No desktop-only core action and no hover-only disclosure.

## Elevation & Depth

Depth is tonal and structural. Canvas, surface, subtle, and raised roles change by theme while keeping the same relationship. One-pixel boundaries do most separation. Resting cards and rows do not float.

### Shadow vocabulary
- **Raised light:** `0 1px 2px rgba(20,26,36,0.08)` for menus and compact popovers.
- **Overlay light:** `0 8px 24px rgba(20,26,36,0.12)` for dialogs and sheets.
- **Raised dark:** `0 1px 2px rgba(0,0,0,0.45)` for menus and compact popovers.
- **Overlay dark:** `0 12px 32px rgba(0,0,0,0.56)` for dialogs and sheets.

**The Hairline First Rule.** If tone and a one-pixel boundary establish ownership, do not add a shadow.

**The Overlay Meaning Rule.** Shadow communicates that an element interrupts or floats above the work. It never acts as glow, decoration, or selected state.

Motion is machined and brief: 120ms for hover/press, 180ms for menus and local disclosure, 240ms for sheets and route-preserving transitions. Default easing is `cubic-bezier(0.16,1,0.3,1)`. Reduced motion removes travel and preserves immediate state feedback.

The approved machine onboarding interaction adds shared semantic roles: `--duration-feedback: 160ms` for copied feedback, `--duration-status: 220ms` for confirmed state, `--distance-status-enter: 4px` for its short entrance, and `--duration-listening-cycle: 1200ms` for an opacity-only listening signal. These extend the existing scale; features must consume the generated roles rather than repeat literals. Register them in the shared token export and Paper component documentation during implementation; static Paper state frames are not executable animation tokens. Stop continuous motion while hidden/disconnected. Reduced motion uses instant state swaps and a static signal. See [Machines](21-machines.md#design-system-mapping-and-acceptance) for focus and live-announcement behavior.

## Shapes

Geometry is compact and machined. Controls use 4px corners, bounded surfaces 6px, overlays 8px, and mobile sheets 12px. Full pills are limited to short status badges, filters, and presence indicators. Borders are 1px; focus is a 2px cobalt ring with 2px offset.

Icons use a consistent 1.5–1.75px outline at 16, 18, or 20px. Icon slots have fixed width in repeated rows. Directional icons mirror in RTL; logos, code, media controls, and provider marks do not. The bread-bot stays recognizable at 16–32px and never replaces a semantic status icon.

Press states change tone without scaling the control. Selected rows use the selected surface and explicit text/icon state; a decorative colored side rail is optional only when it carries persistent selection in a dense list.

## Components

`@bakery/ui` owns raw visual values and exposes semantic components. First-party screens, desktop, and hosted plugin surfaces use the same contracts. shadcn/Radix primitives remain implementation details.

### Foundations
- **Text, Heading, Label, DataText:** bind type role, tone, truncation policy, and semantic element.
- **Stack, Inline, Divider, Spacer:** own layout rhythm; features do not add arbitrary margins.
- **Icon and LogoMark:** fixed sizes, accessible naming, RTL behavior, and decorative handling.
- **ThemeProvider:** resolves System/Light/Dark before paint and supplies theme, locale, direction, density, and pointer profile.

### Actions
- **Button:** primary, secondary, quiet, and destructive; sizes 36/44px; states default, hover, pressed, focus, loading, disabled. Loading retains label width and blocks duplicate submission.
- **IconButton:** same action states with an accessible name; compact visual size may sit inside a 44px coarse target.
- **Link:** cobalt text with visible focus; external destinations disclose departure; never style a mutation as a link.
- **Menu / Command:** grouped actions with keyboard navigation, destructive separation, shortcut metadata, and no hidden authorization.

### Forms and selection
- **Field:** persistent label, native input/textarea/select where adequate, description or error relationship, 40px desktop and 44px coarse height, 16px editable phone type.
- **SearchField / Combobox:** loading, empty, cursor continuation, selected tokens, keyboard navigation, and clear control.
- **Checkbox / Radio / Switch:** selection, single choice, and immediate boolean respectively; full row may be the target; unavailable state names why.
- **ResourcePicker:** server search, opaque cursor continuation, persistent selection across pages/searches, selected-only review, and explicit unavailable resources.

### Navigation
- **ApplicationRail:** 208px labelled rail, 56px compact pane rail, mobile drawer; icon and label lanes remain fixed.
- **SectionNavigation:** shared text-first 224px secondary rail at rail widths and section index/menu at pane/sheet widths; one route list preserves section order, parent selection, permissions and keyboard/focus behavior across targets. Follow [Section navigation](#section-navigation).
- **Breadcrumbs:** route ownership and return path; collapse middle segments on sheet.
- **NotificationBell:** one global 44px target at the header's top-right, outside contextual panel actions; unread count with a named textual equivalent. Desktop opens recent items and View all; phone opens Notifications. The inbox uses aligned rows and local All/Unread/Mentions filters. See [mention and inbox behavior](24-mentions-and-notifications.md).
- **Tabs / SegmentedControl:** tabs change views or subroutes within the selected section; segmented controls change one local view. Keyboard and selected state are explicit; neither duplicates SectionNavigation.
- **CursorControls:** Load more or next/previous continuation using opaque cursors; never expose page numbers.

### Data and work
- **ObjectRow:** fixed icon, title/description, status, metadata, and action lanes; compact/standard/comfortable density.
- **DataTable:** sortable labelled columns, empty/loading/error rows, keyboard-safe actions, and sheet list transformation.
- **StatusBadge / StatusLabel:** healthy, queued, active, needs input, degraded, failed, disconnected, disabled; text always present.
- **CodeBlock / LogViewer:** Geist Mono, copy affordance, bounded scrolling, syntax theme paired to app theme, source and timestamps preserved.
- **Avatar / Identity:** visually separates person, agent, harness, provider, and machine principals; initials are fallback, not authority.

### Feedback and overlays
- **InlineNotice:** condition of adjacent content; neutral, information, warning, or error.
- **AlertBanner:** persistent page condition with recovery action.
- **Toast:** result of a recent operator action; one concise message and optional undo.
- **Skeleton / EmptyState / ErrorState:** preserves layout, names missing content, or explains recovery without fabricated data.
- **Tooltip / Popover:** supplementary context and compact interaction; never contains a core action unavailable elsewhere.
- **Dialog / AlertDialog / Sheet:** confirmation and protected focus. Destructive flows name impact, keep the safe action first, require typed confirmation only for high-impact irreversible actions, and return focus.

### Collaboration and automation
- **ConversationMessage:** person/agent identity, timestamp, delivery state, edited state, attachments, actions, and source interface.
- **QuestionCard:** open/answered/expired states with one durable answer and competing-answer conflict behavior.
- **ArtifactComment:** author, immutable anchor, version context, replies, resolution, and outdated placement.
- **RunTimeline:** durable steps, active work, waits, attempts, evidence, failures, and bounded repair loops.
- **RunIdentity:** trusted execution fields with explicit unknown values; producer identity never comes from output text.
- **RunOutputPanel:** bounded inert text through LogViewer, saved sequence, reconnect, truncation, interruption and expired-history recovery. Uses surface, border, type-time, space-4/6 and control-radius tokens from this system; phone cards use space-4 padding.
- **RevisionSummary:** immutable candidate revisions and verified patch summaries; process exit never implies review or merge.
- **RunOutputView:** slot-based run composition matching the [E05 Paper frames](artifacts-mocks/MOCK-BRIEF.md), including phone layout and both themes. Fixture parity does not certify production task-route parity. Existing task controls and RunTimeline remain authoritative.

- **ModelResolution:** configured default, eligible override, resolved provider/model/harness, cost route, and unsupported reason without making one provider the product identity.

All components use translated message keys rather than embedded English. Plugin catalogs remain inside their namespace and cannot override core copy. Components use logical CSS properties, set `lang`/`dir`, and preserve accessible names after translation.

## Do's and Don'ts

### Do:
- **Do** use the same semantic component, geometry, and state language in both themes.
- **Do** apply System, Light, or Dark before first paint and persist the person's override.
- **Do** keep sessions, tasks, revisions, evidence, and external ticket state visibly connected.
- **Do** show provider, model, harness, person, and agent as separate metadata.
- **Do** put status in text and accessible semantics as well as color.
- **Do** build phone task completion first, then expand to pane and rail.
- **Do** use realistic synthetic fixtures in mocks and label them as synthetic.
- **Do** test every component in light, dark, keyboard, coarse pointer, pseudo-locale, RTL, loading, error, and disabled states.

### Don't:
- **Don't** create a light-only component and call automatic inversion dark mode.
- **Don't** use warm bread colors as dashboard surfaces, warnings, selection, or charts.
- **Don't** use gradients, glow, glass, neon, purple AI styling, or decorative metric cards.
- **Don't** use monospace for ordinary navigation, buttons, prose, or labels.
- **Don't** nest cards to manufacture hierarchy; use spacing, rules, and surfaces.
- **Don't** make provider or model branding dominate Bakery's interface.
- **Don't** hard-code English, concatenate translated fragments, or shrink type to fit translations.
- **Don't** add raw colors, arbitrary radii, margins, or one-off type sizes in feature code.
- **Don't** hide core actions behind hover, desktop width, or an unlabeled icon.

## Artifact review

The artifact route preserves immutable version identity in `version` and original
thread identity in `comment`. `ArtifactLayout` composes `VersionPicker`, a verified
`ArtifactViewer`, provenance, and `CommentRail`. Phone discussion opens inline after selecting comments; explicit thread requests
use `SendToAgentDialog` with a required request field. Artifact pinning
protects the parent artifact and all versions, never only the selected revision.

The artifacts mock site supplies the visual reference: 32px desktop/16px phone
content inset, 24px column gap, and the existing inspector-width token for the
comment rail. Existing surface, border, typography, spacing, and focus tokens
remain authoritative. Components use logical properties for RTL and permit
expanded pseudo-locale copy. They add no motion or palette tokens.

Artifact controls use the 14/20 medium control role and 44px minimum height.
The native version selector has an outline-action boundary and a foreground
chevron; keyboard selection and the 16px phone field role remain native.
Artifact captions use the 12/20 metadata role. The artifact-kind eyebrow uses
that role at semibold weight with `tracking.eyebrow` (0.06em), matching the
artifacts reference. Page titles retain the shared page-heading tracking.

Preview renders only digest-verified bytes. Markdown uses an element allowlist;
active or unknown media stays download-only. `ArtifactTombstone` retains context
when bytes expire. `CapacityBanner` distinguishes warning and paused writes;
production capacity requires the storage contract. Conflicts preserve drafts and
require refreshed versions before mutation. Sheets/dialogs retain keyboard focus
and return it to their trigger on dismissal.

Denied artifact reads use the unavailable `ArtifactLayout` region with a neutral
`ErrorState`, an access label, and a recovery action. They never mount the
artifact viewer or comment controls. The region uses existing surface, spacing,
and typography roles.

Artifact notices use body typography for supporting copy; the pinned artifact
notice uses metadata typography. Patch previews
preserve literal text and diff markers without adding bytes or syntax colors.
Raster mock images use a native-resolution render of their authored artwork,
then scale through the same image containment geometry as verified PNG previews.
