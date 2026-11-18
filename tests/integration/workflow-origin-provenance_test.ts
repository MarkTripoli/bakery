import { assert, assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../packages/persistence/src/postgres.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { ensurePresetWorkflowVersion } from "../../apps/server/src/modules/work/workflow-presets.ts";

/**
 * Installing a catalog workflow records where it came from, once.
 *
 * The three things this proves are the three AC1 claims that a read-shape test
 * cannot: the install writes the catalog key and version, a second install of
 * the same preset does not rewrite them, and two organizations installing the
 * same catalog item get independent rows that agree about the origin.
 *
 * The immutability claim is proved by the second install rather than by trying
 * to update the columns: there is no update path for them, and the insert that
 * could set them is `on conflict do nothing`. A test that wrote an UPDATE would
 * be testing a statement production never issues.
 */
const { databaseUrl } = readTestDatabaseConfig(Deno.env.toObject());

type Seeded = { organizationId: string; principalId: string };

async function seedOrganization(
  db: ReturnType<typeof openPgDatabase>,
  label: string,
): Promise<Seeded> {
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.query(
    `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ($1,$2,$3,true,$4,$4)`,
    [userId, label, `${label}-${userId}@example.test`, now],
  );
  await db.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,$2,$3,'human')`,
    [principalId, userId, label],
  );
  await db.query(
    `insert into bakery.organizations (id,name,slug,created_at,updated_at)
     values ($1,$2,$3,now(),now())`,
    [organizationId, label, organizationId],
  );
  await db.query(
    `insert into bakery.organization_memberships
       (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at)
     values ($1,$2,$3,'developer','active',$4,$4,$4)`,
    [crypto.randomUUID(), organizationId, principalId, now],
  );
  return { organizationId, principalId };
}

async function originOf(
  db: ReturnType<typeof openPgDatabase>,
  organizationId: string,
  slug: string,
) {
  const result = await db.query<
    {
      origin_kind: string;
      origin_catalog_key: string | null;
      origin_catalog_version: number | null;
    }
  >(
    `select origin_kind, origin_catalog_key, origin_catalog_version
       from bakery.workflow_definitions
      where organization_id = $1 and slug = $2`,
    [organizationId, slug],
  );
  return result.rows;
}

Deno.test("installing a catalog workflow records its origin once", async () => {
  const db = openPgDatabase(databaseUrl, 2);
  try {
    const { organizationId, principalId } = await seedOrganization(
      db,
      "origin-install",
    );

    await withPgTransaction(db, (transaction) =>
      ensurePresetWorkflowVersion(
        transaction,
        organizationId,
        principalId,
        FIXED_CODING_PRESET,
      ));

    const afterFirst = await originOf(
      db,
      organizationId,
      FIXED_CODING_PRESET.slug,
    );
    assertEquals(afterFirst.length, 1);
    assertEquals(afterFirst[0]!.origin_kind, "catalog");
    assertEquals(afterFirst[0]!.origin_catalog_key, FIXED_CODING_PRESET.id);
    assertEquals(
      afterFirst[0]!.origin_catalog_version,
      FIXED_CODING_PRESET.revision,
    );

    // A second install is the idempotency claim: one row, same origin.
    await withPgTransaction(db, (transaction) =>
      ensurePresetWorkflowVersion(
        transaction,
        organizationId,
        principalId,
        FIXED_CODING_PRESET,
      ));

    const afterSecond = await originOf(
      db,
      organizationId,
      FIXED_CODING_PRESET.slug,
    );
    assertEquals(afterSecond.length, 1);
    assertEquals(afterSecond[0], afterFirst[0]);
  } finally {
    await closePgDatabase(db);
  }
});

Deno.test("two organizations installing one catalog item get independent rows", async () => {
  const db = openPgDatabase(databaseUrl, 2);
  try {
    const first = await seedOrganization(db, "origin-tenant-a");
    const second = await seedOrganization(db, "origin-tenant-b");

    for (const seeded of [first, second]) {
      await withPgTransaction(db, (transaction) =>
        ensurePresetWorkflowVersion(
          transaction,
          seeded.organizationId,
          seeded.principalId,
          FIXED_CODING_PRESET,
        ));
    }

    const a = await originOf(
      db,
      first.organizationId,
      FIXED_CODING_PRESET.slug,
    );
    const b = await originOf(
      db,
      second.organizationId,
      FIXED_CODING_PRESET.slug,
    );
    assertEquals(a.length, 1);
    assertEquals(b.length, 1);
    // Both are catalog installs, not merely equal to each other: without this
    // the case would pass on two authored rows that agree about nothing.
    assertEquals(a[0]!.origin_kind, "catalog");
    assertEquals(b[0]!.origin_kind, "catalog");
    // Same catalog item, so the same origin...
    assertEquals(a[0]!.origin_catalog_key, b[0]!.origin_catalog_key);
    assertEquals(a[0]!.origin_catalog_version, b[0]!.origin_catalog_version);
    // ...but separate rows, because the definition is tenant-owned.
    const ids = await db.query<{ id: string }>(
      `select id from bakery.workflow_definitions
        where organization_id in ($1, $2) and slug = $3`,
      [first.organizationId, second.organizationId, FIXED_CODING_PRESET.slug],
    );
    assertEquals(ids.rows.length, 2);
    assert(ids.rows[0]!.id !== ids.rows[1]!.id);
  } finally {
    await closePgDatabase(db);
  }
});
