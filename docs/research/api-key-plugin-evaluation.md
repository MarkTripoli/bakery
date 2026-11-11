# `@better-auth/api-key` feasibility + plan

Plugin source read from
`npm pack @better-auth/api-key@1.7.3` (dist/index.mjs line refs below).

## Verdict

**Full replacement of custom storage + verification by the plugin: NOT feasible
without losing named security properties.** Mechanics are fine; semantics are not.

Mechanics OK (not blockers):
- Version: 1.7.3 peers `better-auth ^1.7.3`, `better-call 1.4.0`, `@better-auth/core ^1.7.3`,
  `@better-auth/utils 0.4.2`. `pnpm-lock.yaml` already resolves `better-call@1.4.0(zod@4.5.4)`
  and `@better-auth/utils@0.4.2`. Exact pin, no range. No peer conflict.
- Deno: scratch `deno run` of `apiKey({references:"organization"})` under
  `npm:better-auth@1.7.3` loads, exposes createApiKey/verifyApiKey/getApiKey/updateApiKey/
  deleteApiKey/listApiKeys/deleteAllExpiredApiKeys. Needs `deno.json` import map entry like
  `@better-auth/scim`.
- Digest compat: plugin stores base64url(SHA-256(key)) (`defaultKeyHasher`, ~2310); we store
  hex SHA-256. Same digest, re-encodable by a TS data migration, no secrets needed.
- Key format: `customKeyGenerator` can keep `bky_` + 43 base64url.
- Plugin routes can be closed via `deniedProviderPaths` (transport/http/routes.ts) /
  `disabledPaths` (better-auth/dist/api/index.mjs:164-166).

## Blocking gaps (code evidence)

| # | Property | Plugin behavior | Evidence |
|---|----------|-----------------|----------|
| 1 | Create org-bound key | `references:"organization"` create calls `checkOrgApiKeyPermission`: needs the better-auth `organization` plugin (`getOrgOptions`) else 500 `ORGANIZATION_PLUGIN_REQUIRED`; then a BA `member` row for the user; then BA AC `apiKey:[create]` via `hasPermission`. Bakery runtime plugin list (adapters/better-auth.ts:~118-140) has no `organization()` (only migration generators do, migrations.ts:109,153); membership + RBAC live in `bakery.*` (provider `member` data migrated away in bakery/0005). No bypass: the org branch always runs the check (index.mjs ~523-545, 736-748). Adding organization() + syncing member/AC = second authority, violates "TS-owned rules / single boundary". | index.mjs:523-545, 736-748 |
| 2 | Anti-escalation vs grantor, live permissions | Plugin has no concept of acting principal, grantor, or Bakery permissions. `permissions` is a static JSON snapshot checked by `role(...).authorize` (1666). Our live resolution (`resolveOrganizationActor`, `effectivePermissions`, `ownedServiceAccount`) must stay in TS either way. | index.mjs:1666; access-postgres.ts:511 (createAccessToken; helpers imported at :53) |
| 3 | Principal binding / created_by | Row only has `referenceId` (org id), `metadata` (off by default, JSON string), `permissions`. Principal id + createdBy + scopes would live in metadata JSON: no FK, not indexable, `assertAccessTokenLive` join on `principals` (authority-postgres.ts:439-458) becomes JSON extraction; principal delete no longer cascades. | index.mjs:812-832; apikey schema 2100-2300 |
| 4 | Bearer branch in session middleware | Plugin's own session hook hard-rejects `references != "user"` (`INVALID_REFERENCE_ID_FROM_API_KEY`) and loads a `user` by referenceId; service accounts have no user. So bearer branch must call server-only `auth.api.verifyApiKey` ourselves (works for any references). Doable, but means plugin verify only, not the hook. | index.mjs:2416-2424 |
| 5 | Expiry required | `createApiKey` accepts `expiresIn` null/absent -> `expiresAt: null` (index.mjs:820); `updateApiKey` can set `expiresIn: null` -> no expiry (1503-1510); verify skips expiry check when `expiresAt` null (1634). Only enforceable by a TS wrapper that is the sole caller (routes denied). Plugin offers no "required" option (only min/max/default). | index.mjs:820, 1503-1510, 1634 |
| 6 | Revocation + audit trail | Expired keys are hard-deleted on verify and by `deleteAllExpiredApiKeys` on every create/list/get/verify (10s throttle) (1640-1660, 2060-2075). Revoke = `deleteApiKey` hard delete or `enabled=false`. Current contract/UI expose `revokedAt`, `version` (optimistic `VERSION_CONFLICT`), expired tokens still listed with their state (contract `AccessToken`, access-postgres.ts:484-600). Plugin row has no `revokedAt`/`version`. Expired tokens vanishing from the list changes API behavior and loses evidence. | index.mjs:1640-1660, 2060-2075 |
| 7 | Last-used tracking | Set only as side effect of rate-limit consumption: with limiter off `evaluateRateLimit` returns `skip` + `lastRequest: now` (1586-1593) and `consumeRateLimit` writes it **every request**, plus an unconditional `updatedAt` update in `claimUsageInDatabase` (1717-1730). Current code throttles to 1 write/min (postgres.ts:402-409). Defaults if left alone: rate limit ON, 10 req/day per key (2335-2337) -> must be disabled (`rateLimit.enabled:false`). Two writes per request on hot path. | index.mjs:1586-1593, 1717-1730, 2335-2337 |
| 8 | Atomicity (state + audit in one tx) | Plugin writes via `ctx.context.adapter` (own pool connection), not Bakery `PgTransactionClient`. Mint + anti-escalation + audit event cannot commit atomically, violating "Atomically commit state, replay response, audit, outbox". Workaround = raw SQL INSERT into `"apikey"` in our tx (then plugin only provides schema + verify: cosmetic). | engineering-rules.md; access-postgres.ts:511 |
| 9 | Org isolation / cleanup | `referenceId` is plain text in `public."apikey"`, no FK to `bakery.organizations` -> org deletion leaves keys (needs TS cleanup). Isolation then rests on our `token.organizationId !== organizationId` check (authority-postgres.ts:~520), same as today. | index.mjs schema |
| 10 | Public surface | Create/update/delete/list/get mounted under `/api/auth/api-key/*` for any signed-in user (user-ref path trivially works: self-service keys bypass Bakery rules). Must deny all paths. | index.mjs:2430-2540 |

Still fine with plugin: digest-only storage, no RLS (plugin uses ordinary columns), Postgres
structure-only (table via provider migration, no CHECK), INSUFFICIENT_SCOPE vs 403 (stays
in `scopeDenied()`, authority-postgres.ts:369-386, independent of storage).

## Recommendation

Do NOT swap storage. Gaps 1, 2, 3, 5, 6, 8 each need Bakery to re-implement or fork the
plugin's job, ending with the plugin as a schema + hash helper only. Cost: lose revokedAt/
version/expired-listing/atomic audit/1-min throttle, add organization() plugin or raw SQL
bypass, add data migration, add table to reset list. Benefit: satisfies checklist wording.

Recommendation: keep tokens in Bakery-owned digest-only `bakery.access_tokens`;
`@better-auth/api-key@1.7.3` was evaluated and rejected.

## Fallback plan if the plugin is required (hybrid H, accepts gaps 6/7 partly)

Plugin = verification + schema + hashing; Bakery = all creation/revocation logic via adapter
(precedent: learnings/oauth-provider-dependency-pin.xml, rows written through
`auth.$context.adapter`).

Phase 1 dependency + config (verify: install + load)
- Add `@better-auth/api-key` `1.7.3` exact to root `package.json`, `apps/server/package.json`,
  `deno.json` imports; `pnpm install`; `pnpm-workspace.yaml` override if transitive drift
  (learning oauth-provider-dependency-pin).
- Check: `pnpm --dir apps/server why @better-auth/api-key`; `pnpm typecheck`.

Phase 2 provider migration (verify: migrate + checksum tests)
- Add `apps/server/src/modules/auth/migrations/provider/0013_api_key.sql` generated like
  0009 via a pinned `compileApiKeyMigration` in `migrations.ts` (plugin set
  `[organization(), apiKey({references:"organization", ...})]`); table `apikey`, no CHECK/RLS.
- Add `apikey` to drop list in `apps/server/src/platform/migrate.ts` and ledger lists in
  `tests/integration/implement-checksum-migrations-and-isolated-database-fixtures_test.ts`,
  `tests/unit/implement-local-skill-catalog-publication_test.ts` (learning
  test-reset-lists-provider-tables). Bakery side: new `bakery/0xxx_access_token_bindings.sql`
  (token id, org FK cascade, principal FK, created_by FK, scopes, revoked_at, version) so gaps
  3/6 stay relational.
- Check: `pnpm test:integration -- tests/integration/implement-checksum-migrations-and-isolated-database-fixtures_test.ts`; `pnpm test:rails`.

Phase 3 provider wiring (verify: provider lane)
- `adapters/better-auth.ts`: `apiKey({configId:"default", references:"organization",
  rateLimit:{enabled:false}, enableMetadata:false, disableKeyHashing:false,
  customKeyGenerator -> bky_+43 b64url, keyExpiration:{maxExpiresIn:365,minExpiresIn:0}})`,
  with `disabledPaths`/`deniedProviderPaths` for every `/api-key/*`.
- Check: `pnpm test:provider`.

Phase 4 create/revoke on plugin rows (verify: security tests)
- `access-postgres.ts`: keep anti-escalation; INSERT plugin row + binding row in the same tx
  by SQL (no organization plugin); enforce expiry in TS; revoke = binding.revoked_at +
  `enabled=false`.
- `application/access-tokens.ts`: digest becomes base64url; drop `sha256Hex` use.

Phase 5 verify path (verify: security tests)
- `middleware.ts`: bearer branch calls `auth.api.verifyApiKey({body:{key}})`, joins binding +
  principal; `authority-postgres.ts assertAccessTokenLive` reads binding + `apikey.enabled/
  expiresAt`; `adapters/postgres.ts findLiveAccessToken` replaced.
- Check: `pnpm test:security -- tests/security/scoped-access-tokens_test.ts`.

Phase 6 data migration (verify: integration) TS script (not SQL): hex digest -> base64url
`apikey` + binding rows, idempotent, bounded; evidence of before/after counts.

Phase 7 gates: `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, `pnpm contracts:check` (no contract
change expected; run `pnpm contracts:generate` only if schemas/catalog touched),
`pnpm test:security`, `pnpm test:integration`, `pnpm test:rails`. Add learning to
`learnings/index.xml`.

Residual risks in H: expired rows still hard-deleted (list loses them unless binding row
keeps state); 2 writes/request; mint/verify not in one tx for the plugin row unless raw SQL
(then plugin schema drift risk on upgrades); organization() plugin needed only for migration
generation.

Note: `docs/research/entitlements-scopes/` and plan P3 are not in this repo checkout
(only `docs/technical-design/entitlements-mocks/`); no learnings entry mentions api-key.
