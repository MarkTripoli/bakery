# Internationalization

**Platform contract.** Bakery treats translation as a shared platform capability used by web, desktop, provider adapters, notifications, emails, plugins, and future chat clients. Each surface resolves the same message key and parameters through `@bakery/i18n`; feature modules do not keep private translation systems.

## What is translated

Translate navigation, buttons, form labels, validation, empty/loading states, permission explanations, workflow and run status, StandardError presentation, notifications, email, Slack/Discord/Teams projections, integration metadata, and plugin UI metadata. Dates, times, numbers, currencies, lists, plurals, and relative time use the JavaScript `Intl` APIs with the resolved locale and timezone.

User-authored messages, code, logs, repository content, artifacts, ticket bodies, and model output keep their source language unless a user explicitly invokes a translation action. Provider-owned names and content remain provider data. This prevents Bakery from silently changing evidence or shared work.

## Shared package and catalogs

```text
packages/i18n/
├── src/{locale.ts,catalog.ts,format.ts,keys.ts}
└── locales/{en,es,fr,...}.json
```

`@bakery/i18n` owns locale parsing, fallback, message formatting, catalog loading, direction, and the generated `MessageKey` union. English is the complete source locale. Other catalogs may be partial and fall back key-by-key to English. Missing keys emit bounded telemetry with the key, requested locale, catalog version, and surface; production UI never exposes an unresolved key.

Keys are stable, namespaced identifiers such as `core.actions.save`, `tickets.status.ready`, `integrations.github.permissions.issuesWrite`, and `problems.stateConflict.detail`. Messages use ICU-style named arguments and plural/select rules. Never assemble sentences from translated fragments or pass unvalidated arbitrary values as message keys.

Built-in catalogs ship with the application release. They are immutable, content-hashed assets cached by locale, namespace, and release. Do not store the source catalog in Postgres. Persist only a person's optional preferred locale and an organization's default locale. A later organization-override feature can add versioned override records when a real requirement exists.

Plugin and integration packages may include catalog files in their immutable bundle. Their manifest declares supported locales and one namespace such as `plugin.<publisher>.<package>` or `integration.<provider>`. Installation validates that every key stays inside that namespace, arguments match the source catalog, files are bounded, and fallback English exists. A package cannot replace core Bakery keys.

## Locale resolution

Resolve locale per request or recipient in this order:

1. Explicit locale selected for the current person or notification recipient.
2. Person preference.
3. Bakery organization default.
4. Valid `Accept-Language` or browser preference.
5. `en`.

Normalize and match BCP 47 language tags against installed catalogs. Locale and timezone are separate. One Slack connection can therefore send different human-facing replies to different people while using an organization default for shared channel updates. WebSocket events and durable domain records carry stable codes, keys, arguments, timestamps, and source data rather than pre-rendered prose; each client formats them for its current locale. Server-originated email and chat delivery resolves the recipient locale at dispatch time.

## Persistence and settings

Add `principals.preferred_locale` and `auth_organization.default_locale` as nullable BCP 47 tags with no default; a null organization default falls back to the Bakery default (`en`) at resolution time. A person chooses System default or an installed locale in account preferences. An Admin chooses the organization default in organization settings. Both writes use the existing authenticated settings operations, validation, audit, and optimistic concurrency rails rather than a separate translation service.

The application bootstrap returns the effective locale, direction, timezone, and catalog version. Built-in catalogs are code-split release assets; authenticated plugin/integration bundle reads serve their validated namespace catalogs. Locale lists are bounded configuration, so they do not introduce a page-number API.

## Transport and error behavior

`StandardError({slug,status,params?,cause?})` keeps a stable slug and safe parameters. The presentation adapter maps that slug to `problems.<slug>.title` and `problems.<slug>.detail`. HTTP Problem Details may honor `Accept-Language` and return `Content-Language` plus `Vary: Accept-Language`; clients continue to branch on `type` or `code`, never localized text. MCP protocol and OAuth errors retain their required protocol framing. Valid MCP tool failures may localize their safe text while preserving the same structured Problem code.

API DTOs do not duplicate every label as translated prose. A representation supplies stable enum/status values; the client maps them to catalog keys. When the server must render an outbound message, it uses the same `@bakery/i18n` catalog and records `locale` and `catalogVersion` with the external effect so reconciliation can explain what was sent.

Catalog text renders as text by default. Rich messages permit only an explicit component/tag allowlist; translation content cannot inject HTML, URLs, commands, tool calls, or authorization decisions.

## Responsive and bidirectional behavior

The document root sets both `lang` and `dir`. UI CSS uses logical properties and layout primitives that work in left-to-right and right-to-left locales. Icons whose meaning depends on direction mirror; logos, media controls, code, identifiers, and provider marks do not. Components must tolerate at least 35% text expansion without truncating essential actions.

## Acceptance rails

- Build fails when the English source catalog has duplicate keys, invalid ICU arguments, or a code reference to an unknown key.
- Catalog validation rejects argument drift, namespace escape, unsafe rich-text tags, invalid BCP 47 tags, and missing English fallback.
- Storybook and responsive browser rails run with English, a long pseudo-locale, and one RTL locale at 320/390/744/1280/1440 widths.
- Tests cover plural/select formatting, locale fallback, number/date/timezone formatting, `lang`/`dir`, translated Problem Details headers, and recipient-specific outbound messages.
- Accessibility names, validation relationships, focus order, and live-region meaning remain correct after translation.
- Metrics report missing/fallback keys and locale distribution without recording message arguments that may contain sensitive data.

The first implementation can ship English plus pseudo-locale and RTL test catalogs. Add human-reviewed customer locales as content is translated; the platform boundary does not require a translation-management product or machine translation service.
