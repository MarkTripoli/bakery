# Shared UI catalog

`components.json` is the authored design inventory for the first React baseline:
56 shared components and templates, and three sample page compositions.
Storybook in `packages/ui` binds each of the 59 semantic IDs to one real
rendered specimen.

Run `pnpm --dir packages/ui build-storybook` and `pnpm ui:stories:check` to
build and verify exact catalog/story/public-export parity. Run
`pnpm --dir packages/ui exec playwright test` for browser behavior and
accessibility checks. See [the web host guide](../../../apps/web/README.md) for
local commands.

The catalog preserves its original design requirements and Paper source
references. `specified` describes those requirements, not a claim that every
variant, translation, assistive technology, or product route is implemented. The
older `baselineIds` fields identify design-export records from PR #172; they do
not approve the new runtime images. Runtime images show the working first
version and can be regenerated as screens and components improve.

The current Paper source for generated foundation tokens is pinned in
`tokens.json`: Bakery file `01M1X504XVC45FC0VDK857A37D`, token content hash
`49fea8f7`, accessed 2026-09-09. Exact comparison frames and their image digests
are recorded in `paper-baselines.json`; historical baseline records are not
inputs to token generation.

Approved component specimen provenance is recorded separately in
`paper-specimens.json`. Every record requires its Paper file/page/frame
identity; newly approved records may additionally record an export content
hash/token, approval link, and source representation. Candidate PNGs are
never source inputs.

Run `pnpm ui:tokens:generate` to regenerate the typed token export and CSS. Run
`pnpm ui:tokens:check` to validate source metadata and fail on generated drift
without changing files.

Public React exports have one catalog owner and one Atomic Design level.
Foundations provide tokens, fonts, theming, focus and responsive behavior.
Atoms, molecules, organisms and templates compose downward; product pages own
their data fetching, routing and mutations. Consumers import semantic names from
`@bakery/ui`, not the package's internal directories.

## Runtime and Paper evidence

`runtime-cases.json` is the named browser matrix. It maps every catalog required
case to a stable Storybook story ID and records the supported viewport, pointer,
theme, stored preference, locale, direction, timezone, reduced-motion, zoom and
interaction contexts. `pnpm ui:stories:check` validates the mapping and rejects
missing coverage, unknown stories, duplicate case IDs and incomplete context
coverage.

Build Storybook first, then run
`pnpm --dir packages/ui capture:stories -- --all`. The capture writes candidate
images and a complete provenance manifest under
`artifacts/ui-baseline/runtime/`. `--changed` stays narrow only for a lone
`*.stories.tsx` file with one catalog owner. Changes under the whole
`ui-baselines/` directory, Storybook configuration, UI scripts, package or
Playwright configuration, non-story shared UI source, the story verifier, the UI
architecture harness, web fixtures, the lockfile, Turbo configuration, or the UI
workflow expand to the full matrix. Every selected run also includes cases
linked to Paper baselines.

A runtime case with `paperBaselineId` may narrow the semantic assertions for
that Paper-linked specimen with `semanticCoverage`. When present, both
`variants` and `states` must be non-empty arrays and each value must be a
member of the catalog required case's canonical variants or states.
`semanticCoverage` is rejected on cases without `paperBaselineId`; it cannot
weaken ordinary runtime coverage or use values outside the canonical case.

The runtime manifest uses schema version 2. Its `coverage` object reports the
expected catalog size, selected cases, observed records, passed cases, failed
cases, blocked cases, and every missing selected case ID. Each case records a
structured expected and observed description. Runtime assertion failures retain
their machine-readable reason and a `failed-<case-id>.png` evidence path, and
capture continues so the manifest enumerates every selected failure before the
command exits nonzero. A failed, blocked, or missing case is never affirmative
evidence.

Run `pnpm --dir packages/ui compare:paper -- --cycle 1` to compare fully
declared Paper inputs against two independent kinds of reference. `specimen`
cases compare a rendered Storybook contract against a pinned reference image,
exactly as before: every declared input — viewport, dpr, theme, pointer, locale,
direction, fonts, token and fixture revisions, browser, OS — must match the
candidate exactly. `design` cases compare a real app-route screenshot (captured
by `capture:stories` against a running web server, not Storybook) against a
deterministic render of the committed design source; only viewport, dpr, theme,
pointer, locale, direction, fonts, browser and OS are compared, since a route
candidate carries no story or component identity to check. Compatibility
mismatches, missing baselines, changed image digests, missing required captures
and scores below `0.95` block the command; a design case's dimension mismatch is
scored `0` instead of blocked, because a wrong-sized page is exactly the parity
defect the gate exists to catch. Reports and diagnostic images remain in
`artifacts/ui-baseline/paper/`; the command has no baseline-update mode. The
schema-version-2 comparison report carries the same coverage counts, lists
missing baseline IDs, and gives every image result an expected description, an
observed description, and the compared input paths and digests. Failed or
blocked runtime capture records cannot be comparison candidates. Design
artboards deliberately outside coverage are listed in `excluded`, with a
required reason, and are echoed into the report as accepted `excluded` results
instead of silently vanishing from coverage.

The comparison scores with content registration, not a full-frame mean channel
delta: it identifies the baseline's dominant colour as background, and within
the union of both images' non-background pixels splits pixels into two disjoint
classes. `ink` pixels — glyphs, icons, edges, anywhere either image is locally
non-flat — are scored only where at least one image is 48+ levels from the
background (core ink, not anti-aliasing fringe), with +/-1px registration
tolerance and a perceptual YIQ delta at pixelmatch threshold 0.2. Two Linux
Chromium builds rasterise the same glyph with anti-aliasing that differs by up
to ~50 grey levels; at that setting identical text scores 0.998 across machines
while a moved, missing or recoloured glyph still counts fully. `surface` pixels
— flat panel or background colour on both sides — are compared at the exact same
position with no tolerance at all, because a flat region is a design token and a
wrong token is a real defect even though it looks subtle. The reported `score`
is the minimum of the ink and surface scores, so a wrong layout cannot pass by
hiding structural differences behind a large shared background, and a
flat-colour substitution cannot pass by hiding behind generous edge-matching
slack. The report prints `ink=` and `surface=` alongside `score=` for every
image result.

The reference images for `design` cases live under `paper/design/` and are
renders of
`docs/technical-design/auth-mocks/{index.html,auth.css,auth.js,
logo.png}` — the
same HTML/CSS/JS the Paper page (file `01M1X504XVC45FC0VDK857A37D`, page `V-0`)
was exported from — at the exact viewport, theme and device
`paper-manifest.json` records for that screen and state. They are not exports of
the Paper file and not compositions approximating it:
`pnpm --dir packages/ui render:paper -- --write` (or `render:paper:v0` for the
unpinned V-0 cases alone) renders every declared case in
headless Chromium on `linux-x64` with the pinned Geist fonts,
`reduced-motion: reduce`, and the `reference.hidden`/ `reference.overrides` CSS
the manifest declares (hiding prototype-only marks, overriding tokens), then
writes the PNG, its `imageSha256` and its measured `image` dimensions back into
`paper-baselines.json`. `--check` pins the committed PNG by `imageSha256`, then
re-renders every design case and fails unless the fresh render scores at least
0.95 against it (the same content-registration scorer and threshold as the gate:
a fresh render on another machine differs from the committed pixels by glyph
rasterisation alone - the CI runner scores 0.984-0.995 against
workstation-rendered references - while a 6px shift of one heading scores 0.93).
A committed reference is therefore an honest output of the pinned source: an
edit without a new digest fails the pin, an edit with one fails the re-render by
more than the gate itself tolerates. `compare:paper` re-verifies this on every
run - it recomputes `source.digest` from the exact bytes of `source.inputs` and
re-renders every design reference before comparing any candidate, so a stale or
edited reference blocks the whole run as a `manifest` result rather than
silently scoring against a lie. One economy: given `BAKERY_CAPTURE_BASE_SHA` (a
pull request's base), the re-render is skipped when the diff against that base
touches none of the reference inputs - `source.inputs`, the manifest, the
reference PNGs, `render-paper-references.mjs`, `image-score.mjs` - because the
base's own run re-rendered exactly these references; every main push (no base)
re-renders, and a reference can only reach main through a pull request that
changed one of those paths. The report records which it did
(`Design
references:` line; `designReferences.provedAt` in `comparison.json`).

`reference.capabilities: "core"` renders every artboard through the design
source's own `?caps=core` switch: the design as a core installation ships it —
password sign-in, invitations, organizations, authenticator two-factor with
backup codes and browser sessions — with the blocks that need an external
identity provider, outbound email or an OAuth client registry omitted (GitHub
sign-in, password reset, passkeys, email/password change, the email-verification
badge, connected clients), exactly the rule Paper's own `login/github-disabled`
artboard applies to GitHub, and without the preview-only review aids (the
sample-invitation notice, the loading-state banner, the settings shell's preview
caption, the demo-QR and sample-code disclaimers, the sessions' "synthetic
device" suffix; the copied-codes status drops its "Sample" qualifier). The Paper
artboards remain the design of record; the `core` render is a documented
derivation of them, reproducible from the same committed source, and the
gallery's "Core installation capabilities" toggle shows it. Omitting a block may
release height, so a case whose screen the derivation edits
(`reference.derived`) may record an `image` shorter than its Paper `artboard`
but never taller or wider (`verify-ui-stories.ts`); every other case's image
must equal its artboard.

A design case may declare a `comparisonRegion` with `candidateOrigin: "main"`.
The reference's rectangle is then compared against the same-sized rectangle
whose origin is the app's `<main>` content box, as `capture-stories.mjs`
recorded it for that candidate (`contentBox`), and the two frames may differ in
overall size. The settings artboards use this: their surrounding shell (a 208px
illustrative rail and a breadcrumb top bar) stands in for the real application
shell, so only the content box below the top bar is the design being compared.
On desktop that box is declared as the design's `.settings-main` below the 64px
top bar, 1007px wide — the app's main column between its rail and its 225px
settings navigation; the design's content column (840px max) lies inside it and
the design surface further right is not compared. On phone the region is
measured from the design's `.settings-content` at render time
(`comparisonRegion.measure`) and re-verified by `--check`. The app's `<main>`
must equal the region in size, so extra or missing rows fail the case the same
way a whole-frame dimension mismatch does.

Only the FS03 product screens are cases: sign-in (`login`, `expired`),
`invite-login`, `join`, `register`, `invite`, `organizations`, `setup`,
`signout`, `totp-challenge`, `backup-challenge`, `security`, `sessions`,
`revoke`, `two-factor`, `totp-setup`, `backup-codes`, `totp-disable`. The
`excluded` list records the states of those screens that are deliberately not
compared. The remaining artboards on the page (email verification, password
reset, GitHub sign-in and linking, passkeys, password/email change, OAuth
consent and clients, the desktop return, re-authentication, the transactional
emails and the primitives sheet) describe capabilities the product does not have
and have no route to compare against; they are outside this gate, not excluded
states of it.

The reference images for `specimen` cases are still renders of the pinned
Storybook specimens, not exports of a Paper design frame: they record the
geometry and colour a reviewed commit produced, and the frame, page and source
fields say which Paper design the specimen answers to. Confirming that a
specimen still matches the design is a human review step; the comparison only
proves the rendered result has not drifted from the committed reference.

For a `specimen` case, `comparisonRegion.measure` is a non-empty CSS selector
evaluated on the candidate after runtime assertions and before the screenshot.
The visible, non-zero union of matching elements is recorded as
`componentExtent`; no match is a blocked capture, and a missing extent is
blocked before pixel scoring. `getBoundingClientRect()` reports CSS pixels, so
capture multiplies the measured `x`, `y`, `width`, and `height` by the case
`dpr` and rounds to image pixels before comparing them with the declared
`comparisonRegion`. A specimen with `dpr: 2` therefore declares image-pixel
geometry twice its CSS-pixel geometry. `measure` must be a non-empty string;
design cases retain their existing measured-region semantics.

Text rasterization differs per operating system by more than the `0.95`
threshold allows, so every case declares the `os` that produced its reference
image and the comparison blocks a run on any other platform instead of reporting
a misleading score. Specimen reference images come from the `ui-capture`
artifact of the UI workflow, which is why they declare `linux-x64`; to refresh
one after a reviewed component change, download `ui-capture-<sha>` from that
workflow run, copy the case image over the file in `paper/`, and update
`imageSha256`. Design reference images are refreshed whenever the auth-mocks source or
`paper-manifest.json` changes: `pnpm --dir packages/ui render:paper:v0`
(`render-v0-references.mjs`) re-renders only the unpinned V-0 cases and restamps
`source`; `render:paper -- --add <screen> <state>` adds new ones. K-0 cases are
pinned and never refilled; `--write` refuses them. Either kind of refresh is a reviewed commit, and
the image diff is the evidence.

Each source identity licenses exactly one such refresh on a branch. The
comparison takes its predecessor
from the first branch commit carrying the current manifest's exact
`source.revision` and `source.digest` pair, provided both fields differ from the
merge base. A revision-only or digest-only change is not a refresh: it remains
compared with the merge-base manifest and cannot self-license its metadata edits.
A source identity has one immutable boundary on a branch: its first qualifying
commit; later metadata edits under that identity block with `metadata changed
without refreshed immutable Paper source identity`. A new source identity is
required only when the pinned Paper source itself is re-exported.

The comparison also reports how much provenance it could check. When the merge
base carries no `paper-baselines.json`, the manifest result is `introduced`
rather than verified: nothing committed before the branch exists to compare
against, so the pinned source identity and reference images carry only the
approval of the people who review this branch. Once a manifest is on the merge
base, case metadata is compared against the merge base or against the first
branch commit carrying the current manifest's exact `source.revision` and
`source.digest` pair, provided both fields differ from the merge base; anything
that differs from that predecessor blocks the run. A source identity has one
immutable boundary per branch, so a single refresh under that identity does not
license further edits, and a new source identity is needed only when the pinned
Paper source is re-exported.

## Component metadata

Each `components.json` entry carries machine-checked guidance beyond its proof
obligations. The whole file is validated by `packages/ui/catalog/schema.ts`
(Zod, strict, every field described); `pnpm --dir packages/ui check:exports`
and `pnpm ui:stories:check` both parse it through the schema, and
`pnpm ui:architecture:test` runs `tests/rails/ui-catalog.node.mjs`.

| Field                     | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `paper`                   | Paper specimen frames `{ fileId, pageId, frameId, name, variant? }`; empty only with `paperAbsentReason` naming what was searched. Matched mechanically from artboard names on pages 14-0, 15-0, 16-0 (catalog id in the name) and from `paper-baselines.json` frame ids. |
| `usage.alternatives`      | `{ when, use }` pairs: a situation where another catalog component (`use`, must exist) fits better.              |
| `usage.replacesElements`  | Raw intrinsic tags that app code should not write because this component renders them (`ui.button` replaces `button`). Only where the mapping is real. |
| `usage.allowedLevels`     | Consumer levels (`atom` to `app`) that may import it; derived from the atomic-direction rule, never below the component's own level. |
| `a11y`                    | `{ role?, accessibleName, keyboard[], targetSize?, notes? }` read from the component source in `packages/ui/src`. |
| `tokens`                  | CSS custom properties the component's CSS rules use, derived from the class names in its source and the matching rules in `packages/ui/src/**/*.css`. |
| `requiredCaseCoverage`    | `partitioned` when each `requiredCases` item proves only its own `variants`/`states` subset (worker-readiness templates). Optional.                |
| `requiredCases[].wholeArtboardCapture` | `{ contractVersion, targetSelector, qualificationSelector }` registering a K-0 paired whole-artboard capture. Optional.            |
| `compositions` (top level)| `{ id, description, appliesTo, requires[{ anyOf }], forbids, paper[] }`: which components a screen pattern must (and must not) combine. `appliesTo` holds catalog ids or app module globs. Seeded with `work-queue` and `auth-entry`. |

Read the catalog through `packages/ui/catalog/index.ts`: `loadCatalog()`,
`findComponents(need)` (by raw `element`, `query`, `level`, `consumerLevel`,
`role`), `getComponent(id)`, `getComposition(id)`. The functions are pure; the
composition rules are enforced by the architecture checker, not by the schema.

When adding or changing an entry, fill every field above: cross-references
(`alternatives.use`, composition ids, rule and evidence ids) must resolve, and
frame ids must be unique inside an entry.

## Composition rules and the bakery-ui MCP

`scripts/check-ui-architecture.mjs` reads `components.json` and enforces it on
apps/web; nothing is hard-coded, so editing the catalog changes the rules.

| Rule                              | Fires when                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ui/raw-element-in-app`           | An intrinsic JSX element listed in any entry's `usage.replacesElements` appears in `apps/web/src`. The message lists every catalog component replacing that tag. `*.test.*`, `*.spec.*`, `*.stories.*`, `__tests__` and `__mocks__` are exempt; fixture routes under `apps/web/src/fixtures` are production-rendered and checked. |
| `ui/composition-missing-required` | A module a composition applies to renders none of one `requires[].anyOf` group. One diagnostic per module names every missing group. |
| `ui/composition-forbidden`        | A module a composition applies to renders a `forbids` component. Reported at the use.                                  |

Compositions target the module that owns the pattern (the screen that renders the heading and button), not wrapper pages that only delegate to it.

A module is "applied" when it matches an `appliesTo` glob (`*` stays in a path
segment, `**` crosses; globs with no file are fine) or, for a catalog id such as
`template.authEntry`, renders that component. "Renders" means a JSX tag that
resolves, through the public `@bakery/ui` exports, to the component the id names;
other uses (passing a component as a value) are not seen. `usage.allowedLevels`
is not enforced separately: every entry already allows `app`, and the
atomic-direction rule covers imports inside `packages/ui`.

Findings that predate a rule live in `guardrail-baseline.json`, keyed by rule,
module and subject (element tag or composition id) with a count. A module may
not exceed its count, a count above what remains fails as stale (lower it), and
`pnpm ui:architecture:check` fails when a count grows or a record appears
compared with the merge base. Fix the code, then lower the count; never raise it.
Weakening a catalog rule against the merge base (dropping a `replacesElements`
tag, a composition, a `requires` group, a `forbids` id or an `appliesTo` entry)
needs a `coverage-removals.json` record of kind `catalog-rule`, identity
`replaces:<entry>:<tag>`, `composition:<id>`, `requires:<id>:<sorted anyOf joined by |>`,
`forbids:<id>:<entry>` or `applies:<id>:<pattern>`; narrowing a group or adding rules needs none.
`guardrail-baseline.json` is a verify-run gate path.

`checkFile(path, { root })` and `describeFile` are exported from the checker and
run the same whole-workspace analysis as `checkUiArchitecture`, filtered to one
module (the merge-base contraction check is not part of a single-file answer).
A path the analyzer never parsed (directory, non-source file, outside the
analyzed packages) throws `NotAnalyzedModuleError`; `ui_check_file` returns it as
an `isError` "not an analyzed UI module", never `clean: true`.

`scripts/ui-catalog-mcp.mjs` is a dependency-free stdio MCP server (JSON-RPC 2.0,
protocol 2025-06-18, one message per line) registered as `bakery-ui` in
`.mcp.json`, `.cursor/mcp.json` and `opencode.json`. Tools are read-only and
their input schemas come from Zod via `z.toJSONSchema`:

| Tool                 | Answers                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `ui_find_component`  | Ranked entries for `need`, `element`, `level` or `role` (uses `findComponents`).                  |
| `ui_component`       | Full entry by `id`: usage, alternatives, a11y, tokens, story title, Paper frames with page URLs.  |
| `ui_composition`     | Compositions by `id`, those applied to a `file`, or all.                                          |
| `ui_route_reference` | Ledger entry for a route `path`, its manifest cases and reference PNG paths.                      |
| `ui_check_file`      | `checkFile` diagnostics for a repo-relative `path`; the same function CI runs.                    |

Paper page URLs use the documented `https://app.paper.design/file/<fileId>/<pageId>`
form; frame ids are returned beside them because no node deep link is documented.
Paths are confined to the repository (traversal and symlink escapes are tool
errors). `tests/rails/ui-catalog-mcp.node.mjs` spawns the server and asserts
`ui_check_file` equals `checkFile`, so the MCP cannot drift from CI.

## Route references

`route-references.json` is the ledger that ties each production route in
`routeCoverage` (`apps/web/src/router.tsx`) to the approved Paper frames and
golden cases that judge it. The schema is `packages/ui/catalog/route-references.ts`
(Zod, every field described). `pnpm ui:architecture:check` validates it; no
production route can ship without an entry.

One entry per route: `routeId`, `path`, `status`, `frames`, and as the status
requires `rationale`, `manifest`, `cases`, `absentVariants`.

| Status      | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `baselined` | Every frame has a listed case in the named manifest (`auth` is `paper-baselines.json`, `enterprise` is `enterprise-baselines.json`, `settings` is `settings-baselines.json`, `entitlements` is `entitlements-baselines.json`) with the same `frameId` and a `candidate.route` that matches a fixture route. |
| `planned`   | Route is not in `routeCoverage` yet. References exist; manifest cases are not required to exist here. Illegal once the route ships.       |
| `no-mock`   | Paper has no frame. `rationale` names what was searched. No frames, cases or manifest.                                                    |
| `debt`      | Paper has a frame, no golden yet. Contraction-only: debt may shrink, never grow.                                                          |

Diagnostics (kind `route-reference`):

| Code                                  | Fails when                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ui/route-reference-missing`          | a production route has no ledger entry                                                       |
| `ui/route-reference-unbaselined`      | a `baselined` frame lacks a matching manifest case, or the case lacks a fixture `candidate.route` |
| `ui/route-reference-planned-present`  | a `planned` entry names a route now in `routeCoverage`                                       |
| `ui/route-reference-stale`            | a non-`planned` entry names a route absent from `routeCoverage`, or its path differs         |
| `ui/route-reference-invalid`          | the ledger is not valid JSON or fails the Zod schema (a `planned` entry on the auth or settings manifest fails it; only enterprise and entitlements may be `planned`), a `planned` case is absent from its manifest, or two entries claim one case |
| `ui/route-reference-debt-grew`        | a route is `debt` now and was not `debt` at the merge base (contraction failure)             |

Debt growth compares the ledger with the merge-base ledger. The branch that
introduces the ledger has no base ledger and is not measured against itself.
Deleting an entry (kind `route-reference`) needs a `coverage-removals.json`
record like any other coverage contraction.

Adding a production route: add its `routeCoverage` entry, then a ledger entry.
With a Paper frame, make a fixture route and baseline case, then `baselined`.
Without one, `no-mock` with the artboards searched. A frame with no golden yet
is `debt` only when the owner accepts the debt.

## Device chrome on phone references

The enterprise phone frames (E8-0 queue, P6-0 session) include an iOS status bar
(time, signal, battery) that Paper's device frame draws and a web app never
renders. A case can exclude that band with an optional `deviceChrome` field in
`enterprise-baselines.json`, defined by `packages/ui/catalog/design-cases.ts`
(`EnterpriseDesignCaseSchema`, every field described):

```json
"deviceChrome": {
  "top": 62,
  "reason": "iOS status bar (time, signal, battery) drawn by Paper's device frame; a web app never renders device chrome",
  "source": { "frameId": "E8-0" }
}
```

Semantics:

- The reference PNG (W x H) is compared over rows `[top, H)`.
- The candidate is captured at a W x (H - top) viewport: a web app renders no
  device chrome, so the viewport is the reference minus the chrome rows.
  `capture-enterprise.mjs` hands the shared capture a derived copy of the case
  with that viewport (`captureViewport` in `paper-manifests.mjs`);
  `capture-stories.mjs` is pinned and untouched. The capture records that
  viewport, and `compare:paper` requires it.
- The whole candidate is compared with the reference rows `[top, H)`
  (`baselineCrop` `{x: 0, y: top, width: W, height: H - top}`, `candidateCrop`
  `{x: 0, y: 0, width: W, height: H - top}`). A candidate of any other size is a
  size failure that names the expected `W x (H - top)`, never a crop or pad.
- `image-score.mjs` and the 0.95 threshold are unchanged. `compare-paper.mjs`
  passes `deviceChrome` to `comparePixels`, which uses the existing
  `baselineCrop`/`candidateCrop` parameters of `comparePngs`; only the
  site-rendered manifests (`--manifest enterprise|settings`) do so.

`top` is derived, not authored. The renderer measures the status bar (the first
child of the frame root: 21px padding + 22px line + 19px padding = 62) in the
rendered enterprise site, `render:paper:enterprise -- --write` re-records it, and
`--check` fails when the recorded `top` differs from the measured height. The
schema also rejects a missing or blank `reason`, a non-positive, fractional or
`>= H` `top`, a `deviceChrome` on a desktop case, and a `source.frameId` that is
not the case's `frameId`. Desktop cases never carry it. Auth and K-0 cases never
get it: `compare:paper` refuses `deviceChrome` in any manifest that is not
site-rendered (`deviceChromeIssues`). Settings is site-rendered, so the check
allows it there; the renderer measurement above is enterprise-only today.

Enterprise rendering and capture live in unpinned modules because the K-0 source
profile pins `render-paper-references.mjs` and `capture-stories.mjs`:
`pnpm --dir packages/ui render:paper:enterprise -- --check|--write|--add` and
`pnpm --dir packages/ui capture:enterprise -- --all|--changed --web-base-url ...`.
Both run Chromium under `packages/ui/scripts/fontconfig/fonts.conf`.

## First introduction of an additional Paper profile

The legacy whole-manifest rule above remains for manifests without profiles.
For an additional profile, the comparator resolves the trusted Git merge base
and complete branch history itself. Caller-supplied absence cannot license a
profile. Missing, shallow, unreadable, malformed or ambiguous history blocks.

The earliest declaration **or case reference** binds the profile, regardless of
revision or digest. Its full original identity is `(Paper file ID, page ID,
export-manifest SHA256)`, read from that historical commit. The current candidate
is the first snapshot only when no committed appearance exists. Original
PNG/React-CSS bytes, frame IDs, dimensions, fonts, render bindings and composite
source digest must agree. These are integrity checks, not authentication of
human design approval; branch reviewers remain responsible for that judgment.

That first snapshot freezes the profile declaration and complete case inventory.
Later addition, removal, metadata change, reassignment, export-identity change
(including A→B→A), or disappearance/reappearance blocks. Revision or implementation
digest churn cannot renew the allowance. Existing-profile refresh is outside
this narrow introduction path.

One profile owns each `(file ID, page ID)` throughout the checked history. An
alias cannot obtain a second allowance with either the same or a changed export
SHA. Duplicate owners in the first snapshot block. This is a rule for this
additive path, not a retroactive universal rule for legacy Paper records. V0
objects, root settings/identity and reference bytes stay frozen, with one
exception: once per branch, V0 may change from the first commit whose V0
identity is a genuine refresh. The provenance walk recomputes the V0
`source.digest` from that snapshot's own `source.inputs` bytes (SHA-256 over
`<path>\0<sha256(bytes)>\n` per input, the V0 renderer's function, no browser
launch options). The recomputed digest must equal the declared digest and
differ from the merge base, and `source.revision` must read
`paper:<sha8>; mock:<digest8>; rendered:<date>` with `paper:` the first eight
hex of `sha256(source.manifestPath bytes)` and `mock:` the recomputed digest
prefix. Unverifiable, self-declared, revision-only or digest-only identities
block with a V0 message. Every later snapshot, including merges of main, must
carry the refreshed V0 bytes exactly; a second refresh or an A→B→A return
blocks. Profile objects and pinned profile inputs stay frozen. A global V0
refresh still cannot bypass a profile failure. Tests live in
`packages/ui/tests/paper-source-profiles.node.mjs`, which runs in
`pnpm ui:architecture:test`.

An unchanged V0 remains `passed`; a new K0 remains `introduced` throughout its
introducing branch, even after its first commit. Only a later trusted merge base
containing that profile permits `passed`. Any profile failure blocks the aggregate.
`introduced` proves neither visual parity nor human approval. Source validation,
original-image checks, reference re-rendering, compatibility, complete coverage
and the **0.95** threshold still apply. Prefix-filtered development comparisons
check full provenance too, but remain partial, not delivery evidence. Old capture
identity must be revalidated after tooling changes; never rewrite stamps to make
old screenshots appear current.

## Settings (O-0) manifest

The `settings` manifest follows the enterprise precedent (E-0): references are
renders of Paper JSX, not Paper's own PNGs. `docs/technical-design/settings-mocks/`
holds the read-only Paper desktop MCP exports of page O-0 (`get_jsx`, computed
styles, tokens, in `source/`, described and sha256-pinned by
`source-manifest.json`) and the generated static `site/`
(`paper-jsx-to-html.mjs --site settings`). Fonts are the pinned Geist files of
`enterprise-mocks/fonts`, rendered under the same hermetic fontconfig.

`pnpm --dir packages/ui render:paper:settings -- --check` gates, with no
`settings-baselines.json` needed: (1) every saved byte matches
`source-manifest.json`, (2) `site/` equals the generator output, and (3) each
frame's fresh render scores at least 0.95 (the enterprise
`REFERENCE_RENDER_FLOOR`, same comparison) against its committed reference
render under `ui-baselines/paper/settings/`, which `--write` produced once.
Case-level checks join when `settings-baselines.json` appears with the first
settings cases. The render's score against Paper's own PNG export (the
2026-09-08 exports, sha256-matched to `settings-mocks/paper-manifest.json`) is
recorded per frame as `paperExportScore` and shown as side-by-side composites
in `artifacts/ui-baseline/settings-provenance/`; it is a diagnostic, not a
gate, because layout matches and only Paper's glyph rasterization differs.
`planned` and `debt` ledger statuses stay enterprise-only, except that the
entitlements manifest may also hold `planned` entries (E16 routes ship across
phases). Its 84 reference renders live under `ui-baselines/paper/entitlements/`;
`entitlements-baselines.json` holds one case per frame, each owned by one
`planned` entry in the ledger until its route ships.

## Worker dark (derived) manifest

Paper K-0 has no dark Machines detail phone frame. The `worker-dark` manifest
scores that design against a reference **derived** from approved K-0 sources;
no Paper export is claimed (`fileId` `bakery-repo-worker-dark`, page
`worker-dark-derived`, frame `derived-90D-0-dark`).

Derivation (`packages/ui/scripts/derive-worker-dark-source.mjs`): the approved
light/dark list pairs 8SE-0/AD7-0 (phone) and 8SD-0/A8Y-0 (desktop) are aligned
token by token (`var(--…)` references and hex colours, in source order). Both
pairs have equal token counts and every light token maps to exactly one dark
token; the run fails otherwise, or when the light detail phone export 90D-0
uses a colour token the map does not cover. Fonts, radii, text sizes and
transparent are theme-invariant. The map is substituted into the bytes of
90D-0; the output carries a header naming every input with its SHA-256 and the
map. With the map applied, each light list export equals its dark export except
for the frame URL comment and two status-bar battery glyph attributes, which is
the evidence that the pairs differ by colour token only.

`docs/technical-design/worker-dark-mocks/` holds the generated derived source,
`paper-manifest.json` (renderer inputs), `source-manifest.json` (provenance:
inputs, map, method), a byte copy of K-0 `theme-values.json` and a static
`site/` whose fragment is the pinned K-0 JSX renderer's output
(`workerReadinessMarkup`, imported, never edited) with fonts served from
`enterprise-mocks/fonts` (byte-identical to the K-0 fonts).
`pnpm --dir packages/ui render:paper:worker-dark -- --write` regenerates all of
it plus `worker-dark-baselines.json` and `paper/worker-dark/*.png`; `--check`
re-derives every byte and re-renders the reference against the committed PNG
at the 0.95 floor.

The candidate is the story the K-0 light phone case scores,
`bakery-templates-workerreadonlydetail--contract` with `state: ready`, in dark
at the same 390x1483 viewport, coarse pointer and reduced-motion setting. A
site-rendered design case may name such a story candidate
(`candidate.storyId`, `args`, `reducedMotion`, `wholeArtboard`;
`StoryCandidateSchema` in `packages/ui/catalog/design-cases.ts`).
`pnpm --dir packages/ui capture:worker-dark -- --all` (`capture-site-stories.mjs`)
serves the built Storybook, runs the registered runtime case's assertions
(`wr.detail.ready.phone-dark-coarse`: axe, containment, target size) before and
after, checks the whole-artboard observation with the pinned K-0 helpers
(qualification visible and above the artwork, natural 390x1483 size), records
the complete UI as a native viewport bundle, then screenshots only the
artboard element at the viewport origin. The K-0 Paper-export raster offset is
not applied: the reference is a Chromium render, not Paper's PNG. No device
chrome is excluded, as for the light K-0 case. `compare:paper -- --manifest
worker-dark` admits story candidates only in site-rendered manifests and scores
the artboard image with the unchanged scorer and 0.95 threshold. The
`machine-detail` ledger route stays `no-mock`: the production route is not
scored against this synthetic artwork.

## Coverage contractions

`pnpm ui:architecture:check` compares catalog IDs, catalog required-case pairs,
runtime case/context edges, runtime context IDs, viewport profiles,
visual-baseline IDs, section-route identities, route reference ledger entries,
and workspace UI-consumer package identities against the exact merge base. The base reference resolves from an
explicit `--base` argument, then the pull request base ref, then `origin/main`,
and the merge base is computed with Git. The check fails closed when a required
base cannot be resolved.

Every base identity missing from the candidate fails the check unless the branch
adds `docs/technical-design/ui-baselines/coverage-removals.json` authorizing the
removal:

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "baseSha": "<exact merge-base SHA>",
      "kind": "required-case",
      "identity": "ui.button:legacy-state",
      "rationale": "The state is represented by the replacement contract.",
      "replacement": "ui.button:contract"
    }
  ]
}
```

Each record names the exact merge-base SHA, a `kind` (`catalog-id`,
`required-case`, `runtime-case-context-edge`, `runtime-context`,
`viewport-profile`, `visual-baseline`, `section-route`, `ui-consumer`,
`app-route`, `route-state`, or `route-reference`), one exact identity, a nonblank rationale, and
exactly one of `replacement` or `retired: true`. Wildcard identities, duplicate
records, stale base SHAs, records for identities still present in the candidate,
and records for identities absent from the merge base are rejected. The file is
optional and must not be created empty: when it is absent, no contractions are
authorized.
