import { assertEquals, assertNotEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  PROVIDER_TABLES,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import {
  codeMigrationsDigest,
  resetToMigratedBaseline,
} from "../helpers/migrated-database.ts";

const config = readTestDatabaseConfig();
const resetOptions = {
  targetUrl: config.databaseUrl,
  ...readTestDatabaseResetOptions(),
};

async function withDatabase<T>(
  run: (
    owner: ReturnType<typeof openDatabase>,
    ownerPg: ReturnType<typeof openPgDatabase>,
  ) => Promise<T>,
): Promise<T> {
  const owner = openDatabase(config.databaseUrl);
  const ownerPg = openPgDatabase(config.databaseUrl);
  try {
    return await run(owner, ownerPg);
  } finally {
    await closePgDatabase(ownerPg);
    await closeDatabase(owner);
  }
}

/** Row counts of every table a reset owns, and the position of every sequence. */
async function stateOf(owner: ReturnType<typeof openDatabase>) {
  const provider = PROVIDER_TABLES.map((name) => `'${name}'`).join(", ");
  const counts = await owner.unsafe<{ name: string; rows: number }[]>(`
    select table_schema || '.' || table_name as name,
      (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %I.%I', table_schema, table_name),
        false, true, '')))[1]::text::int as rows
    from information_schema.tables
    where table_type = 'BASE TABLE' and (table_schema = 'bakery'
      or (table_schema = 'public' and table_name in (${provider})))
    order by 1`);
  const sequences = await owner.unsafe<{ name: string; last: string | null }[]>(
    `
    select schemaname || '.' || sequencename as name, last_value::text as last
    from pg_sequences where schemaname in ('bakery', 'public') order by 1`,
  );
  return {
    counts: Object.fromEntries(counts.map((row) => [row.name, row.rows])),
    sequences: Object.fromEntries(sequences.map((row) => [row.name, row.last])),
  };
}

Deno.test(
  "restoring the migrated baseline returns rows, seeds and sequences to the migrated state",
  async () => {
    await withDatabase(async (owner, ownerPg) => {
      // Start from a real rebuild: a database that already holds a baseline
      // (any earlier fixture in the lane) would make this first call a restore,
      // and the comparison below would then check a restore against itself.
      await resetTestDatabase(owner, resetOptions);
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "rebuilt",
      );
      const migrated = await stateOf(owner);
      assertEquals(
        Object.values(migrated.counts).some((rows) => rows > 0),
        true,
        "migrations seed at least one row, so a plain truncate would be wrong",
      );

      const now = new Date("2026-11-19T00:00:00.000Z");
      const userId = crypto.randomUUID();
      await owner`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${userId}, 'Restore Tester', ${`restore-${userId}@example.test`}, true, ${now}, ${now})`;
      await owner`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
        values (${crypto.randomUUID()}, ${userId}, 'Restore Tester', 'human')`;
      await owner`update bakery.installation_settings set version = version + 1 where id = true`;
      const [sequence] = await owner<{ name: string }[]>`
        select schemaname || '.' || sequencename as name from pg_sequences
        where schemaname = 'bakery' order by 1 limit 1`;
      if (sequence) {
        await owner.unsafe(`select nextval('${sequence.name}')`);
      }
      assertNotEquals(
        await stateOf(owner),
        migrated,
        "the test data must show",
      );

      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
      );
      assertEquals(await stateOf(owner), migrated);
    });
  },
);

Deno.test(
  "a changed migration ledger refuses the baseline and the database is rebuilt",
  async () => {
    await withDatabase(async (owner, ownerPg) => {
      await resetToMigratedBaseline(owner, ownerPg, resetOptions);
      await owner`insert into bakery.schema_migrations (version, checksum) values ('9999_not_a_real_migration', 'x')`;
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "rebuilt",
      );
      const stray =
        await owner`select 1 from bakery.schema_migrations where version = '9999_not_a_real_migration'`;
      assertEquals(stray.length, 0);
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
        "the rebuild captured a fresh baseline",
      );
    });
  },
);

Deno.test(
  "a table the baseline does not know refuses it and the database is rebuilt",
  async () => {
    await withDatabase(async (owner, ownerPg) => {
      await resetToMigratedBaseline(owner, ownerPg, resetOptions);
      await owner.unsafe(
        "create table bakery.baseline_extra_table (id int primary key)",
      );
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "rebuilt",
      );
      const [extra] = await owner<{ present: boolean }[]>`
        select to_regclass('bakery.baseline_extra_table') is not null as present`;
      assertEquals(extra?.present, false);
    });
  },
);

Deno.test(
  "a baseline captured for other migrations than the code carries is refused and rebuilt",
  async () => {
    const extra = [{
      owner: "bakery" as const,
      version: "9999_not_in_this_checkout",
      sql: "select 1",
      checksum: "not-a-real-checksum",
    }];
    const real = await codeMigrationsDigest();
    assertNotEquals(
      await codeMigrationsDigest(extra),
      real,
      "an extra migration changes the digest",
    );
    await withDatabase(async (owner, ownerPg) => {
      await resetToMigratedBaseline(owner, ownerPg, resetOptions);
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
        "the baseline matches the code it was captured for",
      );
      // The checkout now carries a migration the baseline was not captured with.
      assertEquals(
        await resetToMigratedBaseline(
          owner,
          ownerPg,
          resetOptions,
          await codeMigrationsDigest(extra),
        ),
        "rebuilt",
      );
      // And back: the baseline now belongs to the other code, so it rebuilds.
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "rebuilt",
      );
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
      );
    });
  },
);

Deno.test(
  "a baseline captured before the code digest existed is refused and rebuilt",
  async () => {
    await withDatabase(async (owner, ownerPg) => {
      await resetToMigratedBaseline(owner, ownerPg, resetOptions);
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
      );
      // The shape of a baseline from before the digest was recorded.
      await owner.unsafe(
        "alter table bakery_baseline.meta drop column code_digest",
      );
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "rebuilt",
      );
      assertEquals(
        await resetToMigratedBaseline(owner, ownerPg, resetOptions),
        "restored",
        "the rebuild captured a baseline with the digest",
      );
    });
  },
);

Deno.test("a full reset drops the baseline so it can never outlive a rebuild", async () => {
  await withDatabase(async (owner, ownerPg) => {
    await resetToMigratedBaseline(owner, ownerPg, resetOptions);
    await resetTestDatabase(owner, resetOptions);
    const [after] = await owner<{ present: boolean }[]>`
      select to_regclass('bakery_baseline.meta') is not null as present`;
    assertEquals(after?.present, false);
    assertEquals(
      await resetToMigratedBaseline(owner, ownerPg, resetOptions),
      "rebuilt",
    );
  });
});
