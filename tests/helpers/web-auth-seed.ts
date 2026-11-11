import {
  readDatabaseConfig,
  readRuntimeConfig,
} from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { normalizeEmail } from "../../apps/server/src/modules/auth/domain/registration.ts";

/**
 * Seeds the single bootstrap admin `apps/web/tests/auth-journey.spec.ts`
 * signs in as. `pnpm createsuperuser` (`apps/server/src/tasks.ts:125-130`)
 * refuses a non-TTY stdin, so Playwright's `beforeAll` shells this script out
 * instead — same `createSuperuser` application code, argv instead of a
 * terminal prompt. Config is read exactly like `apps/server/src/tasks.ts`'s
 * own `createsuperuser` task (`readRuntimeConfig` for `BETTER_AUTH_SECRET`/
 * `BAKERY_PUBLIC_BASE_URL`, `readDatabaseConfig(env, "owner")` for the
 * migration-owner `DATABASE_URL` `createSuperuser` writes through).
 *
 * Usage: `web-auth-seed.ts <email>` (password read from
 * `WEB_AUTH_SEED_PASSWORD`, never argv, so it never appears in a process
 * listing or in `execFileSync`'s own "Command failed: …" message) or
 * `web-auth-seed.ts --reset-two-factor <email>` (no password needed), or
 * `web-auth-seed.ts --purge-user <email>` (no password needed — removes that
 * one user and every organization only that user was left in, so a journey
 * can remove a guest it invited), or
 * `web-auth-seed.ts --disable-principal <email>` (no password needed —
 * directly disables `bakery.principals` the way a real deactivation would,
 * the only real way `GET /v1/me` ever answers `AUTH_FORBIDDEN`
 * — see `apps/server/src/modules/auth/middleware.ts`'s
 * `resolvePrincipal`/`IdentityResolutionError` mapping).
 *
 * Idempotent: a second run with the same email/password against a database
 * that already has this exact admin resolves `already-complete` and also
 * clears any two-factor state left by an interrupted `auth-journey.spec.ts`
 * run, so the shared admin is always challenge-free at the start of a seed.
 *
 * `createSuperuser`'s single-bootstrap-admin invariant
 * (`apps/server/src/modules/auth/domain/bootstrap.ts`) throws
 * `AUTH_BOOTSTRAP_CONFLICT` both for "more than one user exists" *and* for
 * "the one user that exists has a different email/password" — those are not
 * the same problem. This script only self-heals the first (a leftover
 * invited/self-signed-up account from a prior `auth-journey.spec.ts` run):
 * it purges every `public."user"` other than the seed target — the same
 * tables `tests/helpers/auth.ts`'s `cleanupAuthFixture` clears, but never an
 * organization the seed admin itself belongs to — only when more than one
 * user exists *and* the seed target is one of them. Any other conflict
 * (password mismatch, or a different admin entirely — e.g. a developer's own
 * `pnpm createsuperuser` account, or `tests/browser/server.ts`'s browser
 * admin) exits non-zero with no writes at all.
 */

function usageError(message: string): never {
  console.error(`web-auth-seed: ${message}`);
  Deno.exit(2);
}

const flagArg = Deno.args[0] === "--reset-two-factor" ||
    Deno.args[0] === "--disable-principal" ||
    Deno.args[0] === "--purge-user"
  ? Deno.args[0]
  : null;
const purgeMode = flagArg === "--purge-user";
const resetMode = flagArg === "--reset-two-factor";
const disableMode = flagArg === "--disable-principal";
const rawEmail = flagArg ? Deno.args[1] : Deno.args[0];
if (!rawEmail) usageError("missing required <email> argument");
const email = normalizeEmail(rawEmail);

const env = Deno.env.toObject();
const databaseConfig = readDatabaseConfig(env, "owner");
const pgDatabase = openPgDatabase(databaseConfig.url);

async function resetTwoFactor(
  pg: PgDatabase,
  targetEmail: string,
): Promise<void> {
  const user = await pg.query<{ id: string }>(
    'select id from public."user" where email = $1',
    [targetEmail],
  );
  const userId = user.rows[0]?.id;
  if (!userId) return;
  await pg.query('delete from public."twoFactor" where "userId" = $1', [
    userId,
  ]);
  await pg.query(
    'update public."user" set "twoFactorEnabled" = false where id = $1',
    [userId],
  );
}

if (resetMode) {
  try {
    await resetTwoFactor(pgDatabase, email);
    console.log(JSON.stringify({ email, status: "two-factor-reset" }));
  } finally {
    await closePgDatabase(pgDatabase);
  }
  Deno.exit(0);
}

async function disablePrincipal(
  pg: PgDatabase,
  targetEmail: string,
): Promise<void> {
  const result = await pg.query<{ id: string }>(
    `update bakery.principals
     set disabled_at = current_timestamp
     where provider_user_id = (
       select id from public."user" where email = $1
     )
     returning id`,
    [targetEmail],
  );
  if (result.rows.length === 0) {
    throw new Error(`web-auth-seed: no principal found for ${targetEmail}`);
  }
}

if (disableMode) {
  try {
    await disablePrincipal(pgDatabase, email);
    console.log(JSON.stringify({ email, status: "principal-disabled" }));
  } finally {
    await closePgDatabase(pgDatabase);
  }
  Deno.exit(0);
}

if (purgeMode) {
  try {
    const target = await pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    await purgeUsers(pgDatabase, target.rows.map(({ id }) => id));
    console.log(JSON.stringify({
      email,
      status: target.rows.length === 0 ? "user-absent" : "user-purged",
    }));
  } finally {
    await closePgDatabase(pgDatabase);
  }
  Deno.exit(0);
}

const password = Deno.env.get("WEB_AUTH_SEED_PASSWORD");
if (!password) usageError("missing required WEB_AUTH_SEED_PASSWORD env var");

const runtime = readRuntimeConfig(env, "server");
const configProblems = [...runtime.missingConfig, ...runtime.invalidConfig];
if (!runtime.auth || configProblems.length > 0) {
  console.error(
    `web-auth-seed: AUTH_CONFIGURATION_INVALID:${configProblems.join(",")}`,
  );
  Deno.exit(78);
}
const authConfig = runtime.auth;

/**
 * Removes every `public."user"` other than `keepEmail` and everything they
 * own — but never an organization `keepEmail` itself belongs to: an org is
 * only dropped when *none* of its surviving (non-purged) members remain.
 */
async function purgeOtherUsers(
  pg: PgDatabase,
  keepEmail: string,
): Promise<void> {
  const others = await pg.query<{ id: string }>(
    'select id from public."user" where email <> $1',
    [keepEmail],
  );
  await purgeUsers(pg, others.rows.map(({ id }) => id));
}

/** Purges exactly these `public."user"` ids with the same ownership rules. */
async function purgeUsers(pg: PgDatabase, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pg.query(
    `delete from bakery.installation_administrators
     where principal_id = any(
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )
        or granted_by_principal_id = any(
          select id from bakery.principals where provider_user_id = any($1::uuid[])
        )`,
    [userIds],
  );
  await pg.query(
    `delete from bakery.permission_grants
     where principal_id = any(
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )
        or granted_by_principal_id = any(
          select id from bakery.principals where provider_user_id = any($1::uuid[])
        )`,
    [userIds],
  );
  await pg.query(
    `delete from bakery.organizations as organization
     where exists (
       select 1
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       where membership.organization_id = organization.id
         and principal.provider_user_id = any($1::uuid[])
     )
     and not exists (
       select 1
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       where membership.organization_id = organization.id
         and (
           principal.provider_user_id is null
           or principal.provider_user_id <> all($1::uuid[])
         )
     )`,
    [userIds],
  );
  await pg.query(
    `delete from public.organization as organization
     where exists (
       select 1 from public.member as member
       where member."organizationId" = organization.id
         and member."userId" = any($1::uuid[])
     )
     and not exists (
       select 1 from public.member as member
       where member."organizationId" = organization.id
         and member."userId" <> all($1::uuid[])
     )`,
    [userIds],
  );
  // A purged principal that is (or was) a member of an org a *surviving*
  // user also belongs to (e.g. an accepted invitation into the keep
  // email's own organization) leaves its `organization_memberships` row
  // behind: the org itself is deliberately kept above, and that row's
  // `principal_id` FK is `on delete restrict`, so it must be cleared
  // explicitly before `bakery.principals` below. A fully-purged org's own
  // memberships are already gone by then via that FK's `on delete cascade`
  // on `organization_id`, so this never contends with the delete above.
  await pg.query(
    `delete from bakery.organization_memberships
     where principal_id = any(
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pg.query(
    `delete from bakery.idempotency_records
     where principal_id = any(
       select id from bakery.principals where provider_user_id = any($1::uuid[])
     )`,
    [userIds],
  );
  await pg.query(
    `delete from bakery.principals where provider_user_id = any($1::uuid[])`,
    [userIds],
  );
  await pg.query(
    'delete from public."user" where id = any($1::uuid[])',
    [userIds],
  );
}

try {
  let result;
  try {
    result = await createSuperuser(
      { pgDatabase, config: authConfig },
      { email, displayName: "Browser Admin", password },
    );
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "AUTH_BOOTSTRAP_CONFLICT"
    ) throw error;
    const counts = await pgDatabase.query<{ count: string }>(
      'select count(*)::text as count from public."user"',
    );
    const totalUsers = Number(counts.rows[0]?.count ?? "0");
    const targetExists = await pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    if (totalUsers <= 1 || targetExists.rows.length === 0) {
      console.error(
        "web-auth-seed: AUTH_BOOTSTRAP_CONFLICT: an admin already exists " +
          "with a different email or password than requested; no writes " +
          "performed",
      );
      Deno.exit(1);
    }
    await purgeOtherUsers(pgDatabase, email);
    try {
      result = await createSuperuser(
        { pgDatabase, config: authConfig },
        { email, displayName: "Browser Admin", password },
      );
    } catch (retryError) {
      if (
        !(retryError instanceof Error) ||
        retryError.message !== "AUTH_BOOTSTRAP_CONFLICT"
      ) throw retryError;
      console.error(
        "web-auth-seed: AUTH_BOOTSTRAP_CONFLICT: purging leftover accounts " +
          "did not resolve the conflict — the existing admin has different " +
          "credentials than requested",
      );
      Deno.exit(1);
    }
  }

  if (result.status === "already-complete") {
    await resetTwoFactor(pgDatabase, email);
  }

  const membership = await pgDatabase.query<{ organizationId: string }>(
    `select membership.organization_id as "organizationId"
     from bakery.organization_memberships as membership
     join bakery.principals as principal
       on principal.id = membership.principal_id
     join public."user" as provider_user
       on provider_user.id = principal.provider_user_id
     where provider_user.email = $1`,
    [email],
  );
  const organizationId = membership.rows[0]?.organizationId;
  if (!organizationId) throw new Error("WEB_AUTH_SEED_ORGANIZATION_REQUIRED");

  // The password is never echoed back — the caller already holds it (it is
  // the one that put it in `WEB_AUTH_SEED_PASSWORD`).
  console.log(JSON.stringify({ email, organizationId, status: result.status }));
} finally {
  await closePgDatabase(pgDatabase);
}
