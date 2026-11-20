/**
 * Seeds the identities the scene-state stills need.
 *
 *   deno run -A scripts/evidence/scene-states/seed.ts owner
 *   deno run -A scripts/evidence/scene-states/seed.ts outsider
 *
 * `owner` creates one admin with their own organization, so a real page loads
 * at all. `outsider` creates a second real person who belongs to no
 * organization, so an organization genuinely refuses them: the Access denied
 * page is the organization's answer, not a mock pretending to be one.
 *
 * Idempotent: each mode finds its principal after the first run.
 *
 * Environment: the stack's env file (DATABASE_URL, BETTER_AUTH_SECRET and the
 * rest of the server's auth environment). Source it first:
 * `set -a; . ./.env.<project>; set +a`.
 */
import {
  readDatabaseConfig,
  readEnvironmentSnapshot,
  readRuntimeConfig,
} from "@bakery/config";
import {
  authEnvironmentNames,
  readAuthTaskEnvironment,
} from "../../../apps/server/src/platform/auth-task-config.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { createSuperuser } from "../../../apps/server/src/modules/auth/index.ts";

const OWNER = {
  email: "evidence@example.test",
  password: "Evidence-Pass-1",
  display: "Sam Lee",
} as const;

const OUTSIDER = {
  email: "outsider@example.test",
  password: "Evidence-Pass-1",
  display: "Nadia Okafor",
} as const;

const mode = Deno.args[0] ?? "owner";
if (mode !== "owner" && mode !== "outsider") {
  throw new Error(`unknown seed mode ${mode}`);
}

const databaseConfig = readDatabaseConfig(
  readEnvironmentSnapshot(["DATABASE_URL"]),
  "owner",
);
const authConfig = readRuntimeConfig(
  readAuthTaskEnvironment(
    readEnvironmentSnapshot(authEnvironmentNames),
    databaseConfig,
  ),
  "server",
).auth!;

const pg = openPgDatabase(databaseConfig.url);

async function q<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pg.query<T>(sql, values);
  return result.rows;
}

try {
  const identity = mode === "owner" ? OWNER : OUTSIDER;
  const existing = await q<{ id: string }>(
    `select id from bakery.principals where display_name = $1 limit 1`,
    [identity.display],
  );
  if (mode === "owner") {
    if (existing.length === 0) {
      // The real sign-up path: creates the principal, its organization and the
      // admin membership a page needs to load.
      await createSuperuser({ pgDatabase: pg, config: authConfig }, {
        email: identity.email,
        displayName: identity.display,
        password: identity.password,
      });
    }
  } else {
    // A person with no organization at all. The sign-up path would give them
    // one, and the point of this identity is that there is nothing to reach.
    let userId = (
      await q<{ id: string }>(`select id from "user" where email = $1`, [
        identity.email,
      ])
    )[0]?.id;
    if (userId === undefined) {
      const user = await q<{ id: string }>(
        `insert into "user" (name, email, "emailVerified", "createdAt",
                             "updatedAt", "profile_version")
         values ($1, $2, true, now(), now(), 1)
         returning id`,
        [identity.display, identity.email],
      );
      userId = user[0]!.id;
    }
    if (existing.length === 0) {
      await q(
        `insert into bakery.principals (provider_user_id, display_name,
                                        principal_type)
         values ($1, $2, 'human')`,
        [userId, identity.display],
      );
    }
    // The credential row is what sign-in reads, so it is reconciled on every
    // run rather than assumed: a principal alone cannot sign in, and a 401
    // here would look like a refusal instead of a missing seed.
    const { hashPassword } = await import("better-auth/crypto");
    const hashed = await hashPassword(identity.password);
    const existingCredential = await q<{ id: string }>(
      `select id from account where "userId" = $1::uuid
        and "providerId" = 'credential'`,
      [userId],
    );
    if (existingCredential.length === 0) {
      await q(
        `insert into account (id, "accountId", "providerId", "userId",
                              password, "createdAt", "updatedAt")
         values (gen_random_uuid(), $1::text, 'credential', $1::uuid, $2,
                 now(), now())`,
        [userId, hashed],
      );
    } else {
      await q(
        `update account set password = $2, "updatedAt" = now() where id = $1`,
        [existingCredential[0]!.id, hashed],
      );
    }
  }
  console.log(`seed ${mode} done`);
} finally {
  await closePgDatabase(pg);
}
