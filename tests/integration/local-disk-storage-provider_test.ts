/**
 * #452: the local-disk storage provider through the real storage connection
 * path. A connection whose provider is local-disk, deployed from an operator
 * root, is mounted, listed, stat'd, range-read, ingested, synced and exported
 * against a temporary folder, with no in-memory stand-in.
 */

import { assert, assertEquals } from "@std/assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { LOCAL_DISK_PROVIDER } from "../../apps/server/src/modules/knowledge/local-disk-storage.ts";
import {
  createConnectionSync,
  defaultStorageConnections,
  ingestConnectionInput,
  listConnectionFolder,
  mountStorageConnection,
  prepareStorageExport,
  readConnectionRange,
  runConnectionSync,
  runStorageExport,
  statConnectionPath,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import {
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

const reader = { isAdmin: false } as const;
const decoder = new TextDecoder();

function personContext(
  tx: PgTransactionClient,
  organizationId: string,
  principalId: string,
): ActionContext {
  const context = {
    request: new Request("http://bakery.test/"),
    params: {},
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    authority: { organizationId, subject: { principalId } },
    transaction: tx,
  };
  return context as unknown as ActionContext;
}

Deno.test("a local-disk connection mounts, reads, ingests, syncs and exports on disk", () =>
  withWorkerFixture(async (fixture) => {
    const root = await Deno.makeTempDir({ prefix: "bakery-local-disk-it-" });
    const db = fixture.runtimePgDatabase;
    const { organizationId, principalId } = fixture;
    const connectionId = crypto.randomUUID();
    try {
      await seedRigIntegration(fixture.pgDatabase, {
        organizationId,
        principalId,
        connectionId,
        resourceId: crypto.randomUUID(),
      });
      await fixture.pgDatabase.query(
        "update bakery.integration_connections set provider = $2 where id = $1",
        [connectionId, LOCAL_DISK_PROVIDER],
      );
      await seedProviderPricingSnapshot(fixture.pgDatabase);
      const run = await seedAdmissibleRun(
        fixture.pgDatabase,
        organizationId,
        principalId,
        { stepKey: "local-disk-" + crypto.randomUUID() },
      );
      const folder = `${root}/${organizationId}/${connectionId}`;
      await mkdir(folder + "/docs/deep", { recursive: true });
      await writeFile(folder + "/docs/a.txt", "alpha");
      await writeFile(folder + "/docs/b.txt", "bravo");
      await writeFile(folder + "/docs/deep/c.txt", "charlie");

      // The deployed providers, configured as the server configures them.
      const deps = defaultStorageConnections({ storageLocalRoot: root });
      const as = <T>(
        work: (context: ActionContext, tx: PgTransactionClient) => Promise<T>,
      ) =>
        withPgTransaction(
          db,
          (tx) => work(personContext(tx, organizationId, principalId), tx),
        );
      const mount = await withPgTransaction(
        db,
        (tx) =>
          mountStorageConnection(tx, deps, {
            organizationId,
            principalId,
            connectionId,
          }),
      );

      const listed = await as((context) =>
        listConnectionFolder(context, reader, deps, {
          path: mount.path + "/docs",
        })
      );
      assertEquals(
        listed.items.map((item) => [item.name, item.kind]),
        [["a.txt", "file"], ["b.txt", "file"], ["deep", "folder"]],
      );
      const stat = await as((context) =>
        statConnectionPath(context, reader, deps, {
          path: mount.path + "/docs/a.txt",
        })
      );
      assertEquals([stat.kind, stat.sizeBytes], ["file", 5]);
      const range = await as((context) =>
        readConnectionRange(context, reader, deps, {
          path: mount.path + "/docs/b.txt",
          offset: 1,
          length: 3,
        })
      );
      assertEquals(decoder.decode(range.bytes), "rav");

      const ingest = () =>
        as((context, tx) =>
          ingestConnectionInput(context, tx, reader, deps, {
            organizationId,
            principalId,
            taskId: run.taskId,
            path: mount.path + "/docs/a.txt",
          })
        );
      const first = await ingest();
      const again = await ingest();
      assertEquals(again.versionId, first.versionId);

      const { syncId } = await as((context) =>
        createConnectionSync(context, reader, deps, {
          path: mount.path + "/docs",
          taskId: run.taskId,
        })
      );
      const synced = await runConnectionSync(db, deps, {
        organizationId,
        syncId,
      });
      assertEquals(synced, {
        unchanged: false,
        ingested: 2,
        replayed: 1,
        skipped: 0,
      });
      const quiet = await runConnectionSync(db, deps, {
        organizationId,
        syncId,
      });
      assertEquals(quiet.unchanged, true);
      await writeFile(folder + "/docs/new.txt", "november");
      const later = await runConnectionSync(db, deps, {
        organizationId,
        syncId,
      });
      assertEquals([later.unchanged, later.ingested], [false, 1]);

      const prepared = await as((context) =>
        prepareStorageExport(context, reader, deps, {
          path: mount.path + "/out/report.txt",
          artifactVersionId: first.versionId,
          idempotencyKey: "local-export-1",
        })
      );
      const ran = await runStorageExport(db, deps, {
        organizationId,
        effectId: prepared.effectId,
      });
      assertEquals([ran.outcome, ran.dispatched], ["confirmed", true]);
      assert(ran.effect.remoteId !== null);
      assertEquals(await readFile(folder + "/out/report.txt", "utf8"), "alpha");
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.external_effects where organization_id = $1",
        [organizationId],
      );
      await Deno.remove(root, { recursive: true });
    }
  }));
