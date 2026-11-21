import { assert, assertEquals } from "@std/assert";
import { collectPluginBundle } from "../../apps/server/src/modules/catalog/retention/collect-bundle.ts";
import { blobObjectKey } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { blobKeyLock } from "../../apps/server/src/platform/blob-key-lock.ts";
import { recordBlob } from "../../apps/server/src/modules/knowledge/blobs.ts";
import { SkillFileStoreError } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { sweepCollectablePluginBundles } from "../../apps/server/src/modules/catalog/retention/sweep-bundles.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { postgresErrorCode } from "../../apps/server/src/platform/postgres-errors.ts";

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
    stat(_objectKey: string) {
      return Promise.resolve(missing ? null : { sizeBytes: 12 });
    },
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

/** A snapshot of `installId` taken as it left `fromVersionId` (#34). */
async function snapshot(
  fixture: Fixture,
  installId: string,
  fromVersionId: string,
): Promise<void> {
  await fixture.pgDatabase.query(
    `insert into bakery.plugin_install_snapshots
       (organization_id, plugin_install_id, from_plugin_version_id,
        from_state_schema_version, state_row_count)
     values ($1, $2, $3, 1, 0)`,
    [fixture.organizationId, installId, fromVersionId],
  );
}

Deno.test("a version only a snapshot names keeps its archive, because a rollback restores it", async () => {
  await withWorkerFixture(async (fixture) => {
    const left = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const current = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const installId = await install(fixture, current);
    await snapshot(fixture, installId, left.versionId);
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, left.versionId),
      false,
      "the install can still be moved back to the version it left",
    );
    assertEquals(store.deleted, []);

    // Once the install is finished nothing can move back, and the bytes go.
    await fixture.pgDatabase.query(
      `update bakery.plugin_installs set status = 'uninstalled'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, installId],
    );
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, left.versionId),
      true,
    );
    assertEquals(store.deleted, [left.objectRef]);
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
      stat: () => Promise.resolve({ sizeBytes: 12 }),
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

Deno.test("a bundle another live version still points at is kept, because two packages can share bytes", async () => {
  await withWorkerFixture(async (fixture) => {
    // The object key is the organization and the digest, and the digest is
    // unique only per package, so two packages publishing identical archives
    // share one object. Collecting for the withdrawn package would strip the
    // other's live installs of the bytes they point at.
    const withdrawn = await seedVersion(fixture, {
      listingStatus: "withdrawn",
    });
    const live = await seedVersion(fixture, { listingStatus: "listed" });
    // Same bytes, so the same key - which is what the digest-driven key means.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_object_ref = $2, bundle_digest = $3
        where organization_id = $1 and id = $4 returning id`,
      [
        fixture.organizationId,
        withdrawn.objectRef,
        "c".repeat(57),
        live.versionId,
      ],
    );
    await install(fixture, live);

    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, withdrawn.versionId),
      false,
      "the shared object still belongs to a live version",
    );
    assertEquals(store.deleted, []);
    // The object still has a live owner, and it is the package that is still
    // listed: the withdrawn version's own tombstone stays unwritten too.
    const found = await fixture.pgDatabase.query<
      { id: string; bundle_purged_at: Date | null }
    >(
      `select id, bundle_purged_at from bakery.plugin_versions
        where organization_id = $1 and bundle_object_ref = $2`,
      [fixture.organizationId, withdrawn.objectRef],
    );
    assertEquals(found.rows.length, 2, "both versions point at the same bytes");
    assertEquals(
      found.rows.filter((row) => row.bundle_purged_at === null).map((row) =>
        row.id
      ).sort(),
      [withdrawn.versionId, live.versionId].sort(),
      "neither version is marked collected",
    );
  });
});

Deno.test("the last version pointing at shared bytes releases them", async () => {
  await withWorkerFixture(async (fixture) => {
    // A reference count, not a blanket refusal: while one sharing version is
    // live the object stays, and once it is gone the other version frees it.
    const first = await seedVersion(fixture, { listingStatus: "listed" });
    const second = await seedVersion(fixture, { listingStatus: "withdrawn" });
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_object_ref = $2, bundle_digest = $3
        where organization_id = $1 and id = $4`,
      [
        fixture.organizationId,
        first.objectRef,
        "c".repeat(64),
        second.versionId,
      ],
    );
    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, second.versionId),
      false,
      "the listed package still points at the bytes",
    );
    assertEquals(store.deleted, []);

    // The listed package is withdrawn, which makes both versions collectable;
    // neither can go first while the other still counts as a live reference,
    // and the one the sweep reaches first decides. Whichever order, the object
    // is freed exactly once, by the last version still pointing at it.
    await fixture.pgDatabase.query(
      `update bakery.plugin_packages set listing_status = 'withdrawn'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, first.packageId],
    );
    // Retire the second version's claim first, by writing the tombstone it
    // would have written had it been allowed to collect.
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_purged_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, second.versionId],
    );
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, first.versionId),
      true,
      "with no live sharer left, the bytes are released",
    );
    assertEquals(store.deleted, [first.objectRef]);
  });
});

Deno.test("bytes an artifact blob shares are never a plugin bundle's to delete", async () => {
  await withWorkerFixture(async (fixture) => {
    // Artifact and upload bytes live at the same organization-and-digest key as
    // a plugin bundle, and nothing collects their blobs. A withdrawn version
    // whose archive hashes to a digest the blob registry knows must leave the
    // object alone, or collecting a plugin would delete an artifact's bytes.
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const digest = "d".repeat(64);
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_digest = $2
        where organization_id = $1 and id = $3`,
      [fixture.organizationId, digest, seeded.versionId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.blobs
         (organization_id, sha256, size_bytes, media_type, created_by_id)
       values ($1, $2, 12, 'text/plain', $3)`,
      [fixture.organizationId, digest, fixture.principalId],
    );

    const store = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      false,
      "the blob registry owns these bytes",
    );
    assertEquals(store.deleted, []);
    assertEquals((await tombstone(fixture, seeded.versionId)).purged, null);
  });
});

Deno.test("two collectable versions sharing bytes still release them", async () => {
  await withWorkerFixture(async (fixture) => {
    // A reference count that counted dead versions would leak: two withdrawn
    // versions of two packages on identical bytes would each refuse forever
    // because the other exists. Only a version that can still serve an install
    // keeps the bytes alive.
    const first = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const second = await seedVersion(fixture, { listingStatus: "withdrawn" });
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_object_ref = $2, bundle_digest = $3
        where organization_id = $1 and id = $4`,
      [
        fixture.organizationId,
        first.objectRef,
        "c".repeat(64),
        second.versionId,
      ],
    );

    // A store that forgets a key once it is deleted, the way the real one
    // answers false for an absent object rather than reporting it twice.
    const held = new Set<string>();
    const deleted: string[] = [];
    const store = {
      stat: (objectKey: string) =>
        Promise.resolve(held.has(objectKey) ? { sizeBytes: 12 } : null),
      delete(objectKey: string): Promise<boolean> {
        if (!held.has(objectKey)) return Promise.resolve(false);
        held.delete(objectKey);
        deleted.push(objectKey);
        return Promise.resolve(true);
      },
    };
    const first_ = await fixture.pgDatabase.query<
      { bundle_object_ref: string }
    >(
      `select bundle_object_ref from bakery.plugin_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, first.versionId],
    );
    held.add(first_.rows[0].bundle_object_ref);

    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, first.versionId),
      true,
      "a dead sharer does not hold the bytes",
    );
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, second.versionId),
      true,
      "the second version still finishes, against bytes that are already gone",
    );
    assertEquals(deleted, [first.objectRef], "the object is deleted once");
  });
});

Deno.test("an upload completing for identical bytes and a sweep contend for one lock", async () => {
  await withWorkerFixture(async (fixture) => {
    // The behavioural half of the lock: a completion for the same bytes and a
    // sweep of a withdrawn plugin share one advisory key, so one of them waits.
    // Without a shared key both would proceed and the sweep could delete bytes
    // an upload had just claimed.
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const digest = "e".repeat(64);
    await fixture.pgDatabase.query(
      `update bakery.plugin_versions set bundle_digest = $2
        where organization_id = $1 and id = $3`,
      [fixture.organizationId, digest, seeded.versionId],
    );
    const objectKey = blobObjectKey(fixture.organizationId, digest);

    // Hold the key, then try to record a blob for the same bytes with a short
    // lock timeout: it must refuse rather than queue forever.
    const blocked = await withPgTransaction(
      fixture.pgDatabase,
      async (holder) => {
        await holder.query(
          `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [blobKeyLock(fixture.organizationId, objectKey)],
        );
        return await withPgTransaction(fixture.pgDatabase, async (other) => {
          await other.query(`set local lock_timeout = '250ms'`);
          try {
            await recordBlob(other, {
              organizationId: fixture.organizationId,
              principalId: fixture.principalId,
              sha256: digest,
              sizeBytes: 12,
              mediaType: "text/plain",
            }, { stat: () => Promise.resolve({ sizeBytes: 12 }) });
            return "recorded";
          } catch (error) {
            return postgresErrorCode(error);
          }
        });
      },
    );
    assertEquals(blocked, "55P03", "the completion waits for the same key");

    // With the key free, the same completion succeeds.
    assertEquals(
      await withPgTransaction(
        fixture.pgDatabase,
        async (transaction) =>
          (await recordBlob(transaction, {
            organizationId: fixture.organizationId,
            principalId: fixture.principalId,
            sha256: digest,
            sizeBytes: 12,
            mediaType: "text/plain",
          }, { stat: () => Promise.resolve({ sizeBytes: 12 }) })).sha256,
      ),
      digest,
    );
  });
});

Deno.test("an object already gone is not deleted again, and still gets its tombstone", async () => {
  await withWorkerFixture(async (fixture) => {
    // The bytes can go between the decision and the delete: a previous attempt
    // deleted them and failed to write the tombstone. Re-statting under the lock
    // turns that into "nothing to delete", which is the truth, instead of a
    // second delete against a key nobody re-checked.
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    let deleteCalls = 0;
    const store = {
      stat: () => Promise.resolve(null),
      delete(_objectKey: string): Promise<boolean> {
        deleteCalls += 1;
        return Promise.resolve(false);
      },
    };
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      true,
      "the version is recorded as collected",
    );
    assertEquals(deleteCalls, 0, "an absent object is not deleted");
    assert(
      (await tombstone(fixture, seeded.versionId)).purged !== null,
      "the tombstone is written even though nothing was deleted",
    );

    // And when the object is there, the delete happens.
    const live = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const deleting = trackingStore();
    assertEquals(
      await collectPluginBundle(fixture.pgDatabase, deleting, live.versionId),
      true,
    );
    assertEquals(deleting.deleted, [live.objectRef]);
  });
});

Deno.test("bytes deleted between the upload and the record are a named refusal, not a row", async () => {
  await withWorkerFixture(async (fixture) => {
    // The upload writes the object, then records it. A bundle sweep of a
    // withdrawn plugin that shares the digest can delete the key in between -
    // the registry has no row yet, so nothing tells the sweep to spare it. The
    // record therefore looks under the lock it shares with the sweep, and
    // refuses by name rather than storing a row that claims bytes nothing holds.
    const missing = {
      stat: () => Promise.resolve(null),
    };
    const refused = await withPgTransaction(fixture.pgDatabase, async (tx) => {
      try {
        await recordBlob(tx, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          sha256: "f".repeat(64),
          sizeBytes: 12,
          mediaType: "text/plain",
        }, missing);
        return "recorded";
      } catch (error) {
        const standard = error as {
          code?: string;
          params?: { reason?: string };
        };
        return `${standard.code}:${standard.params?.reason}`;
      }
    });
    assertEquals(
      refused,
      "PRECONDITION_FAILED:blob_bytes_missing",
      "the refusal names what went wrong",
    );
    const blobs = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.blobs
        where organization_id = $1 and sha256 = $2`,
      [fixture.organizationId, "f".repeat(64)],
    );
    assertEquals(blobs.rows[0].count, "0", "nothing is recorded");
  });
});

Deno.test("the collector waits for the blob key's lock before it decides or deletes", async () => {
  await withWorkerFixture(async (fixture) => {
    // The other half of the shared lock. The completion test above holds the key
    // itself and proves recordBlob waits; this one proves the COLLECTOR waits. If
    // the collector took no lock, a completion could stat the object, then the
    // collector delete it, then the completion record a row naming nothing.
    const seeded = await seedVersion(fixture, { listingStatus: "withdrawn" });
    const store = trackingStore();
    const pending: Promise<boolean>[] = [];
    await withPgTransaction(fixture.pgDatabase, async (holder) => {
      await holder.query(
        `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [blobKeyLock(fixture.organizationId, seeded.objectRef)],
      );
      pending.push(
        collectPluginBundle(fixture.pgDatabase, store, seeded.versionId),
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      assertEquals(
        store.deleted,
        [],
        "the collector is waiting on the key, so nothing has been deleted yet",
      );
    });
    assertEquals(
      await pending[0],
      true,
      "once the key is free the collector finishes",
    );
    assertEquals(store.deleted, [seeded.objectRef]);
  });
});
