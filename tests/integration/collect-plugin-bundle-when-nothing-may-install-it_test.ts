import { assert, assertEquals } from "@std/assert";
import { collectPluginBundle } from "../../apps/server/src/modules/catalog/retention/collect-bundle.ts";
import { SkillFileStoreError } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { sweepCollectablePluginBundles } from "../../apps/server/src/modules/catalog/retention/sweep-bundles.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

/**
 * Bundle retention for private plugin versions (#15, B14.01, AC3).
 *
 * The rule is one sentence - a version's archive is removed when nothing may
 * install it again - and these cases make each half of it visible: an install
 * keeps the bytes, a withdrawn package with no install releases them, a draft
 * releases them, and the tombstone is written whether or not the object was
 * still there. Rows are inserted directly because the question is what
 * collection decides, not how a route published a version.
 */

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

/** A store that records deletions, and can pretend an object has gone. */
function trackingStore(missing = false) {
  const deleted: string[] = [];
  return {
    deleted,
    delete(objectKey: string): Promise<boolean> {
      if (missing) return Promise.resolve(false);
      deleted.push(objectKey);
      return Promise.resolve(true);
    },
  };
}

async function seedVersion(
  fixture: Fixture,
  options: Readonly<{
    listingStatus?: "listed" | "unlisted" | "withdrawn";
    published?: boolean;
  }> = {},
): Promise<{ packageId: string; versionId: string; objectRef: string }> {
  const packageId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const objectRef = `${fixture.organizationId}/${crypto.randomUUID()}-${
    "a".repeat(64)
  }`;
  await fixture.pgDatabase.query(
    `insert into bakery.plugin_packages
       (id, organization_id, name, display_name, license, provenance,
        visibility, listing_status)
     values ($1, $2, $3, $3, 'MIT', '{"source":"test"}'::jsonb, 'private', $4)`,
    [
      packageId,
      fixture.organizationId,
      `pkg-${packageId}`,
      options.listingStatus ?? "unlisted",
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.plugin_versions
       (id, organization_id, plugin_package_id, version_name, sdk_range,
        manifest, bundle_object_ref, bundle_digest, source_evidence,
        build_evidence, published_at)
     values ($1, $2, $3, '1.0.0', '^1.0.0', '{}'::jsonb, $4, $5,
             '{"source":"test"}'::jsonb, '{"build":"test"}'::jsonb, $6)`,
    [
      versionId,
      fixture.organizationId,
      packageId,
      objectRef,
      "b".repeat(64),
      options.published === false ? null : new Date(),
    ],
  );
  return { packageId, versionId, objectRef };
}

async function install(
  fixture: Fixture,
  seeded: { packageId: string; versionId: string },
  status = "enabled",
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.plugin_installs
       (id, organization_id, plugin_package_id, plugin_version_id, scope,
        owner_principal_id, status, activated_at)
     values ($1, $2, $3, $4, 'personal', $5, $6, now())`,
    [
      id,
      fixture.organizationId,
      seeded.packageId,
      seeded.versionId,
      fixture.principalId,
      status,
    ],
  );
  return id;
}

async function tombstone(
  fixture: Fixture,
  versionId: string,
): Promise<{ purged: Date | null; policy: string | null }> {
  const result = await fixture.pgDatabase.query<{
    bundle_purged_at: Date | null;
    purge_policy: string | null;
  }>(
    `select bundle_purged_at, purge_policy from bakery.plugin_versions
      where id = $1`,
    [versionId],
  );
  return {
    purged: result.rows[0]?.bundle_purged_at ?? null,
    policy: result.rows[0]?.purge_policy ?? null,
  };
}

Deno.test("a version an install still names keeps its archive", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    await install(fixture, seeded);
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      false,
      "an installed version is not collectable even when its package is withdrawn",
    );
    assertEquals(store.deleted, []);
    assertEquals((await tombstone(fixture, seeded.versionId)).purged, null);
  });
});

Deno.test("a disabled install still pins the archive, because it may be re-enabled", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    await install(fixture, seeded, "disabled");
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      false,
      "re-enabling must not find the archive gone",
    );
    assertEquals(store.deleted, []);
  });
});

Deno.test("a withdrawn package with no install releases its archive", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      true,
    );
    assertEquals(store.deleted, [seeded.objectRef]);
    const after = await tombstone(fixture, seeded.versionId);
    assert(after.purged !== null, "the tombstone records the collection");
    assertEquals(after.policy, "retention-v1");
  });
});

Deno.test("an unpublished version is collectable without the package being withdrawn", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { published: false });
    assertEquals(
      await collectPluginBundle(
        fixture.pgDatabase,
        trackingStore(),
        seeded.versionId,
      ),
      true,
      "a draft was never installable, so nothing can still want it",
    );
  });
});

Deno.test("a published version of a listed package is not collected", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "listed" });
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      false,
      "install can still reach a published version",
    );
    assertEquals(store.deleted, []);
  });
});

Deno.test("collecting twice is idempotent and records the tombstone once", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      true,
    );
    // The second run answers false without touching the store: the tombstone
    // is what says the work is done, so a crash after the delete and before
    // the update is repaired by the retry rather than by collecting twice.
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      false,
    );
    assertEquals(store.deleted, [seeded.objectRef]);
  });
});

Deno.test("an archive already gone from the store still gets its tombstone", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    // The object was removed by a previous attempt that then failed to write
    // the tombstone. Returning false for an absent key is what lets the retry
    // finish instead of looping forever on a missing object, and the retry
    // still reports the version as collected: the row now reads as collected,
    // and a sweep that said "kept" would under-report what it just finished.
    assertEquals(
      await collectPluginBundle(
        fixture.pgDatabase,
        trackingStore(true),
        seeded.versionId,
      ),
      true,
    );
    assert(
      (await tombstone(fixture, seeded.versionId)).purged !== null,
      "the retry records the tombstone even though nothing was deleted",
    );
  });
});

Deno.test("collecting an uninstalled version leaves the install-free rows untouched", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const installId = await install(fixture, seeded, "uninstalled");
    const store = trackingStore();
    // An uninstalled row keeps the history of the install without keeping the
    // bytes: it exists so a person who uninstalls and reinstalls keeps both.
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      true,
    );
    const rows = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*) as count from bakery.plugin_installs where id = $1`,
      [installId],
    );
    assertEquals(
      rows.rows[0].count,
      "1",
      "the install row survives collection",
    );
  });
});

Deno.test("a store failure leaves no tombstone, so the bytes are never claimed gone", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const failing = {
      delete(): Promise<boolean> {
        return Promise.reject(
          new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE"),
        );
      },
    };
    let threw = false;
    try {
      await collectPluginBundle(fixture.pgDatabase, failing, seeded.versionId);
    } catch (error) {
      threw = error instanceof SkillFileStoreError;
    }
    assert(threw, "the store's failure reaches the caller");
    assertEquals(
      (await tombstone(fixture, seeded.versionId)).purged,
      null,
      "a version is never marked collected while its bytes may still exist",
    );
  });
});

Deno.test("a sweep tick collects a withdrawn uninstalled bundle and leaves an installed one", async () => {
  await withWorkerFixture(async (fixture) => {
    const collectable = await seedVersion(fixture, {
      listingStatus: "withdrawn",
    });
    await install(fixture, collectable, "uninstalled");
    const pinned = await seedVersion(fixture, { listingStatus: "withdrawn" });
    await install(fixture, pinned, "enabled");
    const store = trackingStore();
    const sweep = await sweepCollectablePluginBundles(
      fixture.pgDatabase,
      store,
      { limit: 50 },
    );
    // Same sweep as artifact collection, on purpose: the collector existed and
    // nothing called it, which is why this tick is part of the proof.
    assertEquals(
      sweep.scanned,
      1,
      "only the collectable version is a candidate",
    );
    assertEquals(sweep.collected, 1);
    assertEquals(store.deleted, [collectable.objectRef]);
    assert(
      (await tombstone(fixture, collectable.versionId)).purged !== null,
      "the withdrawn, uninstalled version is collected",
    );
    assertEquals(
      (await tombstone(fixture, pinned.versionId)).purged,
      null,
      "the installed version keeps its archive",
    );
  });
});

Deno.test("a sweep tick keeps a candidate that becomes installed after the scan", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    // The install arrives AFTER the sweep's own scan has returned its candidates
    // and BEFORE the collector runs, so the only thing that can keep the bytes is
    // the collector deciding again under the row lock.
    let installed = false;
    const racing = new Proxy(fixture.pgDatabase, {
      get(target, property) {
        if (property === "query") {
          return async (...args: unknown[]) => {
            const result =
              await (target.query as (...a: unknown[]) => Promise<unknown>)(
                ...args,
              );
            if (
              !installed &&
              String(args[0]).includes("order by version.created_at")
            ) {
              installed = true;
              await install(fixture, seeded);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = trackingStore();
    const sweep = await sweepCollectablePluginBundles(racing, store);
    assertEquals(
      installed,
      true,
      "the install was made between the scan and the collect",
    );
    assertEquals(
      sweep.scanned,
      1,
      "the sweep selected the version before the install",
    );
    assertEquals(sweep.collected, 0);
    assertEquals(store.deleted, []);
    assertEquals((await tombstone(fixture, seeded.versionId)).purged, null);
  });
});
