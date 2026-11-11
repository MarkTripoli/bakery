# Bakery

<!-- impeccable:product-schema 1 -->

## Platform

web, with a desktop client consuming the same React UI

## Users

Mark manages multiple applications from desktop browsers and a phone. Additional users initially have Admin or Developer access.

## Product Purpose

An autonomous software factory: people plan, review, and provide guidance; agents coordinate, develop, test, independently review, repair, merge, deploy, and report results within the configured scope.

## Operating Context

Deno, TypeScript, Mastra, Inngest, Postgres; responsive React/shadcn UI; Turborepo. Pi/OpenRouter, Claude Code, and subscription-authenticated Codex execute on self-hosted Linux workers and a spare MacBook for iOS. The complete factory also runs on one local machine.

## Capabilities and Constraints

GitHub, chat, webhook and scheduled intake; public skill imports and external MCP/integration catalog; durable artifacts and repo learning in Postgres; no unconditional human approval step: a task's selected stage policy decides whether the plan stage waits for an exact-revision human approval (default automatic, opt-in `human_approval`); missing-information questions remain interactive. Target $200 monthly operating cost, existing fees shown separately. Only personal Cloudflare account me@marktripoli.com.

The chat is a direction and review surface for autonomous work. Freeform requests, natural-language workflow invocation, and explicitly selected saved workflows enter the same execution system. It has no local coding-assistant controls or Plan-mode toggle. Reference screenshots inform layout without requiring every pictured feature.

People can mention an organization teammate with `@` plus a first name or email. Sending the typed mention grants that person chat read/reply access and creates a notification under authorized sharing. A top-right bell and dedicated Notifications page collect mentions and task outcomes with exact deep links. The durable inbox and future push channel share one notification identity; see [Mentions and notifications](24-mentions-and-notifications.md).

Models and providers remain selectable in task, session, and workflow settings, outside the default chat composer. Configurable inexpensive presets handle routine automation; defaults do not lock the product to one harness or provider.

Bakery supplies locked, versioned workflows such as Research, Plan and Implement.
Any accessible workflow can become an editable organization-owned copy through
Create organization copy; supplied sources, published versions and existing forks
are never silently rewritten by an upstream update. Workflows remain skill-driven.

A task can span multiple repositories, with independent work in parallel and
explicit ordering where outputs depend on one another. A saved workflow is optional:
agents can discover/link authorized repositories and persist a coordinated work
plan directly from a request. Repository roles and mapped issue labels such as
`frontend` and `backend` help select targets; they do not grant access. Track one
parent outcome, per-repository work and shared acceptance/budget constraints.
The [workflow and coordination contract](06-workflows-delivery-and-acceptance.md#workflow-ownership-and-multi-repository-work)
and [ticket routing rules](10-tickets.md#repository-label-routing) define this behavior.

All human-facing application copy uses the shared internationalization platform. Web, desktop, notifications, provider chat interfaces, integrations and plugins support the same locale contract. English is the complete fallback; pseudo-locale and right-to-left fixtures are required before adding customer locales.

Requested platform roadmap: a thin desktop package (Tauri 2 is the research candidate), private UI customization and installable plugins authored through conversation, a versioned SDK, and a marketplace as a stretch goal. Support multiple organizations and multiple members from the initial release; Personal is only the default created at setup. Admin/Developer roles apply per organization, and user layouts and plugin preferences remain private. Public signup/subscription provisioning and commerce come later. [Desktop](08-desktop.md) and [Plugins](11-plugins.md) have separate dedicated areas; these capabilities are proposed, not implemented.

Build for personal use first. If Bakery becomes a paid product, **Lemon Squeezy is the preferred payment provider** because Mark already has it set up for his company. Pricing, plans, checkout and subscription lifecycle policies remain deferred; the current build has no payment dependency.

Bakery is open source (Apache-2.0) with a single edition: every feature, including SSO, SCIM, custom roles and audit export and retention, is always available. There are no licence keys, seat limits or paid-feature gates.

Integrations connect authorized external accounts to organization-scoped repositories/projects. GitHub is the first ticket provider; labels admit work through readiness, planning and delivery checks, with progress synchronized to the original issue. Linear and Jira follow the same execution contract through provider-specific adapters. Bakery tasks track execution without replacing the external tracker. [Integrations](09-integrations.md) and [Tickets](10-tickets.md) have separate dedicated areas for connection management and ticket operations.

Working chats retain visible links to open Jira issues, pull requests, or merge requests, with side chats inheriting their work context. The chat workspace exposes exact Git comparisons, navigable supporting evidence, sub-agent relationships, recorded call activity, and the current workflow or coordination-plan position. These are requested design and implementation contracts; historical conversations keep closed/merged references without inventing new work. See [Chat workspace](chat-composer/BEHAVIOR.md#linked-work-changes-and-execution-activity).

## Installation settings

Installation settings control registration and organization creation through persisted Postgres policy. Settings affect availability alongside permissions; they never grant access. Existing-user sign-in and local first-Admin setup remain available when registration is closed.

[Backend rails](04-backend-and-errors.md#installation-settings) owns server enforcement, bootstrap behavior, and implementation acceptance. It is also included in the generated technical HTML reader.

## Brand Commitments

Approved Bakery bread-bot on a conveyor logo and matching favicon in the repository assets/brand directory. Enterprise product interface referencing Linear, GitHub and Vercel, with Codex-like session management. Light and dark themes are equally supported, with system preference as the default and a persistent per-person override. The approved mascot remains a small identity asset; the prior warm workshop UI direction is rejected. Use Alidade's engineering and component-design conventions, Storybook and Paper.

## Evidence on Hand

Current source in Alidade and BB RPI. This directory contains proposed technical design, not a deployed product. Example task names/counts in mockups are illustrative.

## Product Principles

One server authority across clients. Durable work independent of an open browser. Quality proven against the delivered revision. Simple topology and explicit costs. Autonomy with observable progress and user steering.

## Accessibility & Inclusion

Mobile-first across the entire application, with complete desktop support. Every screen/state mock requires paired phone and desktop layouts with equal task capability and documented tablet transitions. This includes authentication, administration, integrations, tickets, collaboration, desktop-shell content and plugin surfaces. No desktop-only core actions. Semantic controls, 44px touch targets, keyboard/focus support, safe areas, software-keyboard handling, readable contrast, zoom/reflow, reduced motion, and explicit non-color status labels are required.


## Workflow and Skills design commitment

Workflow building follows the familiar n8n/Zapier editor conventions requested by Mark: compact nodes, named ports, curved connections, a contextual step picker, focused properties and an optional friendly AI panel inside Bakery’s existing design system. Library is the application area; its shared SectionNavigation exposes Workflows and Skills. Skills covers Global, Organization and My skills, with package authoring, immutable versions, test cases and evaluations. Bakery-provided workflows and skills stay locked; accessible sources can be copied into an editable permitted scope. See [the Skills and evaluations plan](23-skills-and-evaluations.md).
