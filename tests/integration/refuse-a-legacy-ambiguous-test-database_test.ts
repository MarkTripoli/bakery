import { assert, assertRejects } from "@std/assert";
import {
  closeDatabase,
  openDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  assertDatabaseIsNotLegacyAmbiguous,
  openAuthFixture,
} from "../helpers/auth.ts";

// The fixture refuses a database the server would treat as ambiguous. The
// server's own condition is `bootstrap_principal_id is null` and more than one
// `public."user"` row (apps/server/src/modules/auth/adapters/postgres.ts:137),
// which on a long-lived stack fails every auth boot with one opaque code: a
// fresh volume clears it, so the code under test was never wrong.
//
// Each case seeds its state inside a transaction that is rolled back, so the
// test proves the precondition on the condition it names without leaving the
// shared database in the state it refuses.
const databaseConfig = readTestDatabaseConfig();

let migrated: PgDatabase | undefined;

async function migratedDatabase(): Promise<PgDatabase> {
  if (migrated) return migrated;
  const database = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(database, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(database);
  }
  // openAuthFixture runs the migrations and, on a freshly reset database,
  // passes its own precondition: no users, so nothing is ambiguous.
  const fixture = await openAuthFixture({ databaseConfig });
  migrated = fixture.pgDatabase;
  return migrated;
}

async function withSeededState(
  seed: (pg: PgDatabase) => Promise<void>,
  run: (pg: PgDatabase) => Promise<void>,
): Promise<void> {
  const pg = await migratedDatabase();
  await pg.query("begin");
  try {
    await seed(pg);
    await run(pg);
  } finally {
    await pg.query("rollback");
  }
}

async function setLegacyMarker(pg: PgDatabase): Promise<void> {
  await pg.query(
    `update bakery.installation_settings set bootstrap_principal_id = null
     where id = true`,
  );
}

async function insertUser(pg: PgDatabase, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await pg.query(
    `insert into public."user" (id, name, email, "emailVerified")
     values ($1, $2, $3, false)`,
    [id, name, `${name}-${id}@example.test`],
  );
  return id;
}

Deno.test("the auth fixture refuses a legacy-ambiguous database and names the users", async () => {
  const ids: string[] = [];
  await withSeededState(async (pg) => {
    await setLegacyMarker(pg);
    // Truncate cascades to dependents and, inside this transaction, is undone
    // on rollback so the shared database keeps whatever it had.
    await pg.query(`truncate table public."user" cascade`);
    ids.push(await insertUser(pg, "legacy-a"));
    ids.push(await insertUser(pg, "legacy-b"));
  }, async (pg) => {
    const error = await assertRejects(
      () => assertDatabaseIsNotLegacyAmbiguous(pg),
      Error,
    );
    // The count alone would still cost a psql trip to learn which rows must
    // go, so the message carries both the count and the ids.
    assert(
      error.message.includes("legacy-bootstrap state with 2 users"),
      error.message,
    );
    for (const id of ids) assert(error.message.includes(id), error.message);
  });
});

Deno.test("a single user in legacy-bootstrap state is not ambiguous", async () => {
  await withSeededState(async (pg) => {
    await setLegacyMarker(pg);
    await pg.query(`truncate table public."user" cascade`);
    await insertUser(pg, "solo");
  }, async (pg) => {
    // Exactly one user: the server resolves it as the bootstrap identity, so
    // the precondition must stay silent. This is the calibration guard - a
    // check that threw on any legacy-null marker would pass the refusal test
    // and break every single-user stack.
    await assertDatabaseIsNotLegacyAmbiguous(pg);
  });
});

Deno.test("several users with a bootstrap identity set are not ambiguous", async () => {
  await withSeededState(async (pg) => {
    // No truncate here: the earlier cases roll back, so this starts from the
    // freshly migrated database with no users. Truncating would cascade
    // through principals to installation_settings and delete the marker row
    // this case needs to update.
    const first = await insertUser(pg, "first");
    await insertUser(pg, "second");
    // bootstrap_principal_id has a foreign key to installation_administrators,
    // so the marker must name a real administrator rather than a bare uuid.
    const principal = await pg.query<{ id: string }>(
      `insert into bakery.principals (provider_user_id, display_name, principal_type)
       values ($1, $2, 'human') returning id`,
      [first, "first"],
    );
    const principalId = principal.rows[0].id;
    await pg.query(
      `insert into bakery.installation_administrators
         (principal_id, granted_by_principal_id)
       values ($1, $1)`,
      [principalId],
    );
    await pg.query(
      `update bakery.installation_settings set bootstrap_principal_id = $1
       where id = true`,
      [principalId],
    );
  }, async (pg) => {
    // With a principal set the server never runs the ambiguous branch, so the
    // precondition must not fire even when several users exist.
    await assertDatabaseIsNotLegacyAmbiguous(pg);
  });
});

// The three cases above prove the helper on the condition it names. This one
// proves the fixture actually calls it: without this, deleting the call from
// `openAuthFixture` leaves every other test green, because they call the
// helper directly. A red-proof that cannot fail when the seam is unwired is
// pointed at the wrong thing.
Deno.test("openAuthFixture refuses a legacy-ambiguous database at the entry point", async () => {
  const pg = await migratedDatabase();
  const seeded: string[] = [];
  const prior = await pg.query<{ principalId: string | null }>(
    `select bootstrap_principal_id as "principalId"
     from bakery.installation_settings where id = true`,
  );
  const priorPrincipalId = prior.rows[0]?.principalId ?? null;
  try {
    // No truncate: it cascades through principals to installation_settings and
    // removes the marker row. Add users until the table holds two, which is
    // the condition the server treats as ambiguous.
    const existing = await pg.query<{ id: string }>(
      `select id from public."user" order by id`,
    );
    for (let index = existing.rows.length; index < 2; index++) {
      seeded.push(await insertUser(pg, `entry-${index}`));
    }
    await pg.query(
      `update bakery.installation_settings set bootstrap_principal_id = null
       where id = true`,
    );
    const error = await assertRejects(
      () => openAuthFixture({ databaseConfig }),
      Error,
    );
    assert(
      error.message.includes("legacy-bootstrap state with 2 users"),
      error.message,
    );
    for (const id of seeded) assert(error.message.includes(id), error.message);
  } finally {
    if (seeded.length > 0) {
      await pg.query(
        `delete from public."user" where id = any($1::uuid[])`,
        [seeded],
      );
    }
    await pg.query(
      `update bakery.installation_settings set bootstrap_principal_id = $1
       where id = true`,
      [priorPrincipalId],
    );
  }
});
