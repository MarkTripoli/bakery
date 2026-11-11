# E05 artifacts mock brief

Repo-authored JSX; no Paper application export. Source authority: E05 design D6,
14-artifacts.md viewer contract, enterprise UI-CONTRACT.md, and ../DESIGN.md.
Production task AppLayout supplies the 208px desktop rail, 64px desktop header
and 57px phone header.
Geist/Geist Mono and palette, type, spacing, radii follow ../DESIGN.md. Desktop
is 1440px; phone is 390px. Artboard heights fit all content; body owns scroll.
Feature controls remain at least 44px high; shell and dialog controls follow
production pointer-specific sizes. Desktop discussion sits beside preview; phone
comments states show a full-width sheet below preview, preserving revision
context.

## States and frames

Main screens include light/dark. Every listed state includes desktop/phone.
Frame identifiers, dimensions and source hashes live in source-manifest.json.
Static controls show intended affordances, not implemented application actions.
Private preview and agent review execution remain outside this slice.

| Surface  | State            | Desktop frame                                  | Phone frame                                  | Theme |
| -------- | ---------------- | ---------------------------------------------- | -------------------------------------------- | ----- |
| task-run | default          | E05-task-run--default--light--desktop          | E05-task-run--default--light--phone          | light |
| task-run | default          | E05-task-run--default--dark--desktop           | E05-task-run--default--dark--phone           | dark  |
| task-run | truncated        | E05-task-run--truncated--light--desktop        | E05-task-run--truncated--light--phone        | light |
| task-run | reconnecting     | E05-task-run--reconnecting--light--desktop     | E05-task-run--reconnecting--light--phone     | light |
| task-run | reset            | E05-task-run--reset--light--desktop            | E05-task-run--reset--light--phone            | light |
| task-run | exit             | E05-task-run--exit--light--desktop             | E05-task-run--exit--light--phone             | light |
| task-run | interrupted      | E05-task-run--interrupted--light--desktop      | E05-task-run--interrupted--light--phone      | light |
| task-run | quota            | E05-task-run--quota--light--desktop            | E05-task-run--quota--light--phone            | light |
| task-run | usage-unknown    | E05-task-run--usage-unknown--light--desktop    | E05-task-run--usage-unknown--light--phone    | light |
| task-run | timeout          | E05-task-run--timeout--light--desktop          | E05-task-run--timeout--light--phone          | light |
| task-run | lost-lease       | E05-task-run--lost-lease--light--desktop       | E05-task-run--lost-lease--light--phone       | light |
| artifact | default          | E05-artifact--default--light--desktop          | E05-artifact--default--light--phone          | light |
| artifact | default          | E05-artifact--default--dark--desktop           | E05-artifact--default--dark--phone           | dark  |
| artifact | text             | E05-artifact--text--light--desktop             | E05-artifact--text--light--phone             | light |
| artifact | image            | E05-artifact--image--light--desktop            | E05-artifact--image--light--phone            | light |
| artifact | patch            | E05-artifact--patch--light--desktop            | E05-artifact--patch--light--phone            | light |
| artifact | log              | E05-artifact--log--light--desktop              | E05-artifact--log--light--phone              | light |
| artifact | comments         | E05-artifact--comments--light--desktop         | E05-artifact--comments--light--phone         | light |
| artifact | outdated         | E05-artifact--outdated--light--desktop         | E05-artifact--outdated--light--phone         | light |
| artifact | deleted          | E05-artifact--deleted--light--desktop          | E05-artifact--deleted--light--phone          | light |
| artifact | reply            | E05-artifact--reply--light--desktop            | E05-artifact--reply--light--phone            | light |
| artifact | send-to-agent    | E05-artifact--send-to-agent--light--desktop    | E05-artifact--send-to-agent--light--phone    | light |
| artifact | pinned           | E05-artifact--pinned--light--desktop           | E05-artifact--pinned--light--phone           | light |
| artifact | expired          | E05-artifact--expired--light--desktop          | E05-artifact--expired--light--phone          | light |
| artifact | capacity-paused  | E05-artifact--capacity-paused--light--desktop  | E05-artifact--capacity-paused--light--phone  | light |
| artifact | forbidden        | E05-artifact--forbidden--light--desktop        | E05-artifact--forbidden--light--phone        | light |
| artifact | missing-version  | E05-artifact--missing-version--light--desktop  | E05-artifact--missing-version--light--phone  | light |
| artifact | loading          | E05-artifact--loading--light--desktop          | E05-artifact--loading--light--phone          | light |
| artifact | empty            | E05-artifact--empty--light--desktop            | E05-artifact--empty--light--phone            | light |
| artifact | unsupported      | E05-artifact--unsupported--light--desktop      | E05-artifact--unsupported--light--phone      | light |
| artifact | stale            | E05-artifact--stale--light--desktop            | E05-artifact--stale--light--phone            | light |
| artifact | reconnecting     | E05-artifact--reconnecting--light--desktop     | E05-artifact--reconnecting--light--phone     | light |
| artifact | digest-failure   | E05-artifact--digest-failure--light--desktop   | E05-artifact--digest-failure--light--phone   | light |
| artifact | publish-conflict | E05-artifact--publish-conflict--light--desktop | E05-artifact--publish-conflict--light--phone | light |
| artifact | failed-mutation  | E05-artifact--failed-mutation--light--desktop  | E05-artifact--failed-mutation--light--phone  | light |

## Reproduction and handoff

`node packages/ui/scripts/paper-jsx-to-html.mjs --site artifacts` generates
site/. `node packages/ui/scripts/render-artifacts-references.mjs --write` alone
writes reference PNGs and artifacts-baselines.json. Commit them together with
site/. `--check` verifies source hashes, generated HTML, source digest, frame
inventory, and fresh full-artboard render scores at the existing 0.95 floor. No
masks or comparison regions. Repo-authored frames have no fabricated Paper PNG
exports or computed-style export records.

Planned ledger IDs `e05-task-run` and `e05-artifact-page` reserve scored cases
without replacing shipped route debt. Phases 6/7 implement fixture candidates
`/__fixtures__/artifacts/{task-run|artifact}/{state}` and promote cases onto
`task-detail` / `artifact-retrieval`, removing these planned entries. Dark
states other than default have no separate frame in this phase.

## Production shell correction (paper2)

Shell authority: `apps/web/src/shell/AppLayout.tsx`,
`packages/ui/src/navigation.css`, and `docs/technical-design/DESIGN.md`.
The existing scored `/tasks` queue uses the same shell components: enterprise
`queue.default.light.desktop` / `queue.default.light.phone`, Paper frames 5J-0 /
E8-0. Settings adds section navigation and is not the task-shell authority.

Browser measurements on authenticated `/tasks/:taskId` and
`/tasks/:taskId/artifacts/:artifactId` confirm these mock values:

| Metric | Production | Authored mock |
| --- | --- | --- |
| Desktop rail width | 208px | 208px |
| Desktop header height | 64px including border | 64px including border |
| Artifact desktop header/content inset | 40px; x248 | 40px; x248 |
| Task desktop header/main width | 735px | 735px |
| Task main padding | 0px desktop/phone | 0px desktop/phone |
| Task title x | 232px desktop / 20px phone | 232px / 20px |
| Task desktop inspector | x943; 497px including border | x943; 497px |
| Task artifact pane width | 496px desktop / 350px phone | 496px / 350px |
| Task pane header / body inset | 64px / 24px | 64px / 24px |
| Rail padding / row gap | 16px 12px / 4px | 16px 12px / 4px |
| Rail navigation row / icon | 36px / 18px | 36px / 18px |
| Phone header | 57px | 57px |
| Phone menu / title x | 16px / 72px | 16px / 72px |
| Artifact phone content inset | 16px | 16px |
| Send-to-agent dialog width | 560px desktop / 358px phone | 560px / 358px |
| Dialog padding / radius | 24px / 8px | 24px / 8px |
| Close control | 28px fine pointer / 44px coarse | 28px / 44px |

Desktop breadcrumb is `Workspace`. Phone TopBar renders `Bakery`, with no
breadcrumb. The previous second phone header was invented; it is removed.
Sidebar uses the production logo asset, Work, Applications, Sessions, Workers,
Library, Automations and Settings. Authenticated measurement identity is
Organization / Fixture Admin. Work is selected as on `/tasks/:taskId`.

Task frames follow `TaskSessionView` and `TaskDetail`: zero main padding, a
24px desktop / 20px phone title inset, and transcript padding of 28px 32px 4px
(desktop) or 28px 20px 4px (phone). The 496px wide desktop inspector has a 1px
left border, sticks to the viewport top and scrolls within its column. On phone,
the same artifact pane follows the feature content inside the transcript at x20.
The production `SessionPane` composition supplies its 64px header, version
selector, summary, immutable descriptor, bounded text preview and ruled Open
footer. Representative data is synthetic. Both themes use the existing tokens.
The pane retains production `min-height: 100%`; on phone its footer follows that
layout's natural overflow rather than clipping it or inventing bottom padding.

E05 title and feature subtrees remain unchanged inside those shell wrappers.
Artifact-page frames retain their existing padded shell and dialog treatment.

Height rule: minimum 960px, otherwise the ceiling of natural document height at
1440px desktop or 390px phone width, after fonts load. No fixed content clipping,
extra bottom compensation, or content-dependent comparison region. Default task
frames measure 1304px desktop and 3214px phone. The same measured height is
recorded in both source manifests. Modal layers are fixed to
the viewport and do not add document height. Their centered geometry, 36%
foreground backdrop, raised surface, shadow and initially focused close control
follow the production Dialog. Frames remain static authored JSX.

Feature subtrees are retained; task shell wrapping and the existing artifact
inspector composition change. Modal placement remains unchanged in round two.
Site HTML and reference PNGs are generated by the existing Paper generator and
renderer. K-0 inputs, thresholds and regions stay unchanged.

## Phone capture follow-up (F2)

The runtime screenshot is in `capture-stories.mjs`, a K-0 digest input. The
lead's conditional authorization forbids editing pinned machinery, so F2 is
skipped. No shared renderer or capture file changes. Phone browser measurements
use viewport screenshots with coarse-pointer assertions before and after.
Reference self-scores do not claim that runtime full-page pointer drift is fixed.
