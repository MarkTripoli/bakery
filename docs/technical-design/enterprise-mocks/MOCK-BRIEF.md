# Bakery enterprise mock round

Status: enterprise references confirmed; all three composition studies generated, imported into Paper and presented for user review. No frontend application is being implemented in this round.

## Confirmed direction

Linear, GitHub and Vercel for enterprise craft; Codex for sessions. Geist / Geist Mono verified available in Paper. Keep the approved mascot as a small app icon. Replace warm cream/cocoa/gold, oversized headings and sparse pseudo-dashboard rows. Light work surfaces support long daytime desktop sessions and mobile checks; dark theme remains a later state, not a competing world.

## Three compositions

1. Work queue: compact task list with scoped filters and a selected task inspector. Fast triage across repositories.
2. Session workspace: persistent session sidebar, shared conversation, versioned plan and threaded comments. Fast collaborative steering and review.
3. Application overview: applications and their current work in an aligned operational table, with selected app delivery detail. Fast cross-application oversight.

All studies share the same world, typography, neutral palette and component character. These test composition and task priority, not three different brands. Generated comps are a visual probe, not a pixel-accurate specification or an implemented product. All example names, statuses and usage are synthetic.

## Proposed mock palette and scale

White work surface; neutral #F7F7F8 navigation; #18181B foreground; #60616B supporting text; #E4E4E7 separators; #3158D4 selected/focus state. Primary action near-black. Semantic status is labeled, with restrained green, amber and red. Geist regular/medium/semibold, 13/14/16/20/24px; Geist Mono only for IDs, SHA, logs and measured values. Four-pixel spacing unit; 36px desktop controls with 44px coarse-pointer targets; 4–6px control corners. Candidate values, not a released token system.

## After composition review

Create editable Paper desktop and phone flows, then extract validated primitives, semantic tokens, component anatomy and states into Storybook-ready definitions. Cover work intake, sessions, plans/comments, previews/review, applications, workers, skills/MCP/integrations, workflow editing and administration. For each: loading, empty, failure, permission, offline, long content, keyboard/focus and concurrent-user states. Rebuild the technical reading map in the same visual grammar after the product mocks establish it. Keep all technical content.

## Reference evidence

- https://linear.app/docs/projects
- https://github.com/features/code-review
- https://vercel.com/docs/projects
- Codex session-management reference supplied by the user.

## Approved composition

The user selected A · Work queue via the review page. Retain compact queue-first navigation and its inspector, with shared sessions and application operations as companion views. Do not copy inconsistent synthetic counters, people-as-agent avatars, generated logo variations or raster text. All controls and text become editable native elements.

## Review delivery

- Review page: http://127.0.0.1:51333/ (local, current session)
- Paper: https://app.paper.design/file/01M1X504XVC45FC0VDK857A37D/2-0
- Paper boards are raster composition studies; editable components are the next stage.
- Screenshot review: all three imports are populated and fit their frames; the proposed hierarchy, neutral contrast and aligned rows read clearly at desktop scale. Image lettering and synthetic status counts must not become authoritative specifications.
- Mobile layouts, keyboard behavior, real interactions and design tokens have not been implemented or validated by these still images.
- Recommendation: use the shared session as the central working surface, with queue triage and application oversight as companion views. User selected A · Work queue via review 947b2a38; proceed with editable designs in this direction.

## Editable v1 delivery

Twelve native Paper frames now cover desktop queue/session/application operations, phone queue/task answer/session/plan review/applications, foundations, recovery/multiplayer states, and model selection/default presets. Text and controls are native Paper elements. The 44 exported v1 tokens and source frames are recorded in tokens.json and paper-manifest.json.

User correction incorporated: Agent is the conversation identity; harness, provider and model are distinct. Task/session selectors, compatible connected catalogs and configurable inexpensive automation presets are specified. Example model names are synthetic fixtures, not fixed application defaults or promised catalog availability.

The reader loads bundled Geist/Geist Mono fonts without a font CDN. Product interactions, complete screen implementation, Storybook and measured 95% runtime visual parity remain unimplemented.

## Mobile-first coverage requirement

Every current or future screen/state mock needs both a phone and desktop counterpart with the same fixture, actions, authority and recovery paths. Fifteen current core specimens now cover seven paired screen families plus one foundation reference sheet. The integration catalog adds 20 paired views. Component/reference sheets and archived composition studies are not evidence of app-screen coverage. Missing either counterpart blocks design handoff. Start new screens at 390px, prove the 320px minimum, then expand to tablet and desktop. See DESIGN.md and the frontend UI contracts for the release gates.
