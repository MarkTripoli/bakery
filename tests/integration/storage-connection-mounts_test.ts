/**
 * #452: the storage family in the tree (chapter 25 section 17.4, O38). A
 * storage connection mounts under /connections and is read through its port
 * with nothing copied; a run that uses an outside file ingests it into an
 * artifact version (once per mount, path and remote revision) and pins it;
 * one-way sync is a workflow over the same ingest; writing out is a keyed
 * external effect. Another organization cannot see or read the mount.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createMemoryStorage,
  fakeDriverContext,
  type MemoryStorage,
} from "../../packages/integration-sdk/testing.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  createConnectionSync,
  ingestConnectionInput,
  listConnectionFolder,
  mountStorageConnection,
  prepareStorageExport,
  readConnectionRange,
  runConnectionSync,
  runStorageExport,
  statConnectionPath,
  STORAGE_EXPORT_OPERATION,
  type StorageConnectionDeps,
  type StorageMount,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";
import {
  pinStoragePath,
  storageQueryOf,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";
import {
  recordInputPaths,
  resolveInputPaths,
} from "../../apps/server/src/modules/work/run-input-pins.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import {
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

const reader = { isAdmin: false } as const;
const decoder = new TextDecoder();

/** A person's request context over one transaction, as the routes build it. */
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

type Rig = {
  db: PgDatabase;
  organizationId: string;
  principalId: string;
  connectionId: string;
  storage: MemoryStorage;
  deps: StorageConnectionDeps;
  mount: StorageMount;
  taskId: string;
  runId: string;
};

/**
 * Seeds an enabled connection, binds it to an in-memory storage provider and
 * mounts it. The run gives a real work item and run for ingest and pins.
 */
async function rig(fixture: WorkerFixture): Promise<Rig> {
  const db = fixture.runtimePgDatabase;
  const connectionId = crypto.randomUUID();
  await seedRigIntegration(fixture.pgDatabase, {
    organizationId: fixture.organizationId,
    principalId: fixture.principalId,
    connectionId,
    resourceId: crypto.randomUUID(),
  });
  await seedProviderPricingSnapshot(fixture.pgDatabase);
  const run = await seedAdmissibleRun(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    { stepKey: "storage-" + crypto.randomUUID() },
  );
  const storage = createMemoryStorage();
  storage.put("/docs/a.txt", "alpha");
  storage.put("/docs/b.txt", "bravo");
  storage.put("/docs/deep/c.txt", "charlie");
  const { ctx } = fakeDriverContext();
  const deps: StorageConnectionDeps = {
    resolver: (connection) =>
      connection.id === connectionId
        ? { port: storage.port, ctx, adapterVersion: "memory@1" }
        : undefined,
  };
  const mount = await withPgTransaction(
    db,
    (tx) =>
      mountStorageConnection(tx, deps, {
        organizationId: fixture.organizationId,
        principalId: fixture.principalId,
        connectionId,
      }),
  );
  return {
    db,
    organizationId: fixture.organizationId,
    principalId: fixture.principalId,
    connectionId,
    storage,
    deps,
    mount,
    taskId: run.taskId,
    runId: run.runId,
  };
}

function as<T>(
  r: Rig,
  work: (context: ActionContext, tx: PgTransactionClient) => Promise<T>,
  organizationId = r.organizationId,
): Promise<T> {
  return withPgTransaction(
    r.db,
    (tx) => work(personContext(tx, organizationId, r.principalId), tx),
  );
}

async function ingestedCount(r: Rig): Promise<number> {
  const rows = await r.db.query<{ n: number }>(
    `select count(*)::int as n from bakery.storage_connection_ingests
      where organization_id = $1`,
    [r.organizationId],
  );
  return rows.rows[0].n;
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise);
  assert(error instanceof StandardError, String(error));
  return error.code;
}

Deno.test("a mounted connection is read through its port and nothing is copied", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    assertEquals(r.mount.path.startsWith("/connections/"), true);
    // Mounting twice is the same mount.
    const again = await withPgTransaction(
      r.db,
      (tx) =>
        mountStorageConnection(tx, r.deps, {
          organizationId: r.organizationId,
          principalId: r.principalId,
          connectionId: r.connectionId,
        }),
    );
    assertEquals(again, r.mount);

    const root = await as(
      r,
      (context) =>
        listConnectionFolder(context, reader, r.deps, { path: r.mount.path }),
    );
    assertEquals(root.items.map((item) => [item.treePath, item.kind]), [
      [r.mount.path + "/docs", "folder"],
    ]);
    const first = await as(
      r,
      (context) =>
        listConnectionFolder(context, reader, r.deps, {
          path: r.mount.path + "/docs",
          limit: 2,
        }),
    );
    assertEquals(first.items.map((item) => item.name), ["a.txt", "b.txt"]);
    assert(first.nextCursor !== null);
    const rest = await as(
      r,
      (context) =>
        listConnectionFolder(context, reader, r.deps, {
          path: r.mount.path + "/docs",
          limit: 2,
          cursor: first.nextCursor!,
        }),
    );
    assertEquals(rest.items.map((item) => item.name), ["deep"]);
    assertEquals(rest.nextCursor, null);

    const stat = await as(
      r,
      (context) =>
        statConnectionPath(context, reader, r.deps, {
          path: r.mount.path + "/docs/a.txt",
        }),
    );
    assertEquals([stat.kind, stat.sizeBytes], ["file", 5]);
    const range = await as(
      r,
      (context) =>
        readConnectionRange(context, reader, r.deps, {
          path: r.mount.path + "/docs/b.txt",
          offset: 1,
          length: 3,
        }),
    );
    assertEquals(decoder.decode(range.bytes), "rav");

    // Reading through copied nothing: no ingest, no artifact, no file entry.
    assertEquals(await ingestedCount(r), 0);
    const copied = await r.db.query<{ n: number }>(
      `select count(*)::int as n from bakery.artifacts
        where organization_id = $1 and artifact_type = 'connection_file'`,
      [r.organizationId],
    );
    assertEquals(copied.rows[0].n, 0);
    // The mount folder sits under /connections, which the roots now show.
    const top = await r.db.query<{ system_key: string }>(
      `select top.system_key from bakery.storage_entries mount
         join bakery.storage_entries top
           on top.organization_id = mount.organization_id
          and top.id = mount.parent_id
        where mount.organization_id = $1 and mount.id = $2`,
      [r.organizationId, r.mount.entryId],
    );
    assertEquals(top.rows[0].system_key, "connections");

    // A missing path is 404; a disabled connection is refused.
    assertEquals(
      await code(
        as(r, (context) =>
          statConnectionPath(context, reader, r.deps, {
            path: r.mount.path + "/docs/nope.txt",
          })),
      ),
      "RESOURCE_NOT_FOUND",
    );
    await fixture.pgDatabase.query(
      "update bakery.integration_connections set status = 'disabled' where id = $1",
      [r.connectionId],
    );
    assertEquals(
      await code(
        as(r, (context) =>
          listConnectionFolder(context, reader, r.deps, {
            path: r.mount.path,
          })),
      ),
      "STATE_CONFLICT",
    );
  }));

Deno.test("a run that uses an outside file ingests it once per revision and pins the version", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const path = r.mount.path + "/docs/a.txt";
    const readsBefore = r.storage.calls.read;
    const pinned = await as(r, async (context, tx) => {
      const resolved = await resolveInputPaths(tx, {
        organizationId: r.organizationId,
        inputs: {},
        inputPaths: { brief: path },
        connections: (inputPath) =>
          ingestConnectionInput(context, tx, reader, r.deps, {
            organizationId: r.organizationId,
            principalId: r.principalId,
            taskId: r.taskId,
            path: inputPath,
          }),
      });
      await recordInputPaths(tx, {
        organizationId: r.organizationId,
        runId: r.runId,
        resolved: resolved.resolved,
      });
      return resolved;
    });
    assertEquals(r.storage.calls.read, readsBefore + 1);
    const versionId = (pinned.inputs as { brief: string }).brief;
    const pin = await r.db.query<{ sha256: string; content: Uint8Array }>(
      `select pin.sha256, version.content
         from bakery.run_input_pins pin
         join bakery.artifact_versions version
           on version.organization_id = pin.organization_id
          and version.id = pin.artifact_version_id
        where pin.organization_id = $1 and pin.run_id = $2
          and pin.artifact_version_id = $3`,
      [r.organizationId, r.runId, versionId],
    );
    assertEquals(pin.rows.length, 1);
    assertEquals(decoder.decode(pin.rows[0].content), "alpha");

    // The same revision again: the same version, no second read or row.
    const replay = await as(
      r,
      (context, tx) =>
        ingestConnectionInput(context, tx, reader, r.deps, {
          organizationId: r.organizationId,
          principalId: r.principalId,
          taskId: r.taskId,
          path,
        }),
    );
    assertEquals(replay.versionId, versionId);
    assertEquals(r.storage.calls.read, readsBefore + 1);
    assertEquals(await ingestedCount(r), 1);

    // The file appears at its path in the tree and pins like any other file.
    const byPath = await withPgTransaction(
      r.db,
      (tx) =>
        pinStoragePath(storageQueryOf(tx), {
          organizationId: r.organizationId,
          path,
        }),
    );
    assertEquals(byPath?.versionId, versionId);

    // A new remote revision is a new version of the same artifact.
    r.storage.put("/docs/a.txt", "alpha two");
    const next = await as(
      r,
      (context, tx) =>
        ingestConnectionInput(context, tx, reader, r.deps, {
          organizationId: r.organizationId,
          principalId: r.principalId,
          taskId: r.taskId,
          path,
        }),
    );
    assert(next.versionId !== versionId);
    assertEquals(next.artifactId, replay.artifactId);
    assertEquals(await ingestedCount(r), 2);
  }));

Deno.test("another organization cannot see or read a connection's mount", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const otherOrganizationId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations
         (id, name, slug, metadata, created_at, updated_at, version)
       values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
      [otherOrganizationId, "other-" + otherOrganizationId.slice(0, 8)],
    );
    try {
      for (
        const attempt of [
          (context: ActionContext) =>
            listConnectionFolder(context, reader, r.deps, {
              path: r.mount.path,
            }),
          (context: ActionContext) =>
            statConnectionPath(context, reader, r.deps, {
              path: r.mount.path + "/docs/a.txt",
            }),
          (context: ActionContext) =>
            readConnectionRange(context, reader, r.deps, {
              path: r.mount.path + "/docs/a.txt",
              offset: 0,
              length: 5,
            }),
        ]
      ) {
        assertEquals(
          await code(
            as<unknown>(r, (context) => attempt(context), otherOrganizationId),
          ),
          "RESOURCE_NOT_FOUND",
        );
      }
      assertEquals(
        await code(
          as(
            r,
            (context, tx) =>
              ingestConnectionInput(context, tx, reader, r.deps, {
                organizationId: otherOrganizationId,
                principalId: r.principalId,
                taskId: r.taskId,
                path: r.mount.path + "/docs/a.txt",
              }),
            otherOrganizationId,
          ),
        ),
        "RESOURCE_NOT_FOUND",
      );
      // Mounting another organization's connection is 404 too.
      assertEquals(
        await code(
          withPgTransaction(r.db, (tx) =>
            mountStorageConnection(tx, r.deps, {
              organizationId: otherOrganizationId,
              principalId: r.principalId,
              connectionId: r.connectionId,
            })),
        ),
        "RESOURCE_NOT_FOUND",
      );
      assertEquals(r.storage.calls.read, 0);
      assertEquals(r.storage.calls.list, 0);
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [otherOrganizationId],
      );
    }
  }));

Deno.test("one-way sync ingests a remote folder into a work item and resumes from the change feed", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const { syncId } = await as(
      r,
      (context) =>
        createConnectionSync(context, reader, r.deps, {
          path: r.mount.path + "/docs",
          taskId: r.taskId,
        }),
    );
    const first = await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    assertEquals(first, {
      unchanged: false,
      ingested: 3,
      replayed: 0,
      skipped: 0,
    });
    const quiet = await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    assertEquals(quiet.unchanged, true);
    assertEquals(quiet.ingested + quiet.replayed, 0);

    r.storage.put("/docs/new.txt", "november");
    r.storage.put("/outside.txt", "not synced");
    const third = await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    assertEquals(third, {
      unchanged: false,
      ingested: 1,
      replayed: 3,
      skipped: 0,
    });
    const synced = await r.db.query<{ remote_path: string }>(
      `select remote_path from bakery.storage_connection_ingests
        where organization_id = $1 order by remote_path`,
      [r.organizationId],
    );
    assertEquals(synced.rows.map((row) => row.remote_path), [
      "/docs/a.txt",
      "/docs/b.txt",
      "/docs/deep/c.txt",
      "/docs/new.txt",
    ]);
    // One way: nothing was ever written to the provider.
    assertEquals(r.storage.calls.write, 0);
    // A file is not a folder to sync.
    assertEquals(
      await code(
        as(r, (context) =>
          createConnectionSync(context, reader, r.deps, {
            path: r.mount.path + "/docs/a.txt",
            taskId: r.taskId,
          })),
      ),
      "UNPROCESSABLE",
    );
  }));

Deno.test("writing out is a keyed external effect that lands once", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    try {
      await exportScenario(r);
    } finally {
      // The ledger keeps an effect's argument version (NO ACTION), so the
      // effects go before the organization's versions do.
      await fixture.pgDatabase.query(
        "delete from bakery.external_effects where organization_id = $1",
        [r.organizationId],
      );
    }
  }));

async function exportScenario(r: Rig): Promise<void> {
  {
    const source = await as(
      r,
      (context, tx) =>
        ingestConnectionInput(context, tx, reader, r.deps, {
          organizationId: r.organizationId,
          principalId: r.principalId,
          taskId: r.taskId,
          path: r.mount.path + "/docs/a.txt",
        }),
    );
    const other = await as(
      r,
      (context, tx) =>
        ingestConnectionInput(context, tx, reader, r.deps, {
          organizationId: r.organizationId,
          principalId: r.principalId,
          taskId: r.taskId,
          path: r.mount.path + "/docs/b.txt",
        }),
    );
    const target = r.mount.path + "/out/report.txt";
    const prepare = (versionId: string, key: string) =>
      as(r, (context) =>
        prepareStorageExport(context, reader, r.deps, {
          path: target,
          artifactVersionId: versionId,
          idempotencyKey: key,
        }));
    const first = await prepare(source.versionId, "export-1");
    assertEquals([first.status, first.replayed], ["prepared", false]);
    // Preparing writes nothing out.
    assertEquals(r.storage.calls.write, 0);
    const replay = await prepare(source.versionId, "export-1");
    assertEquals(replay, { ...first, replayed: true });
    assertEquals(
      await code(prepare(other.versionId, "export-1")),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    const ran = await runStorageExport(r.db, r.deps, {
      organizationId: r.organizationId,
      effectId: first.effectId,
    });
    assertEquals([ran.outcome, ran.dispatched], ["confirmed", true]);
    assertEquals(decoder.decode(r.storage.bytesOf("/out/report.txt")), "alpha");
    assert(ran.effect.remoteId !== null);
    const again = await runStorageExport(r.db, r.deps, {
      organizationId: r.organizationId,
      effectId: first.effectId,
    });
    assertEquals([again.outcome, again.dispatched], ["confirmed", false]);
    assertEquals(r.storage.calls.write, 1);

    const rows = await r.db.query<
      { operation: string; idempotency_key: string; status: string }
    >(
      `select operation, idempotency_key, status from bakery.external_effects
        where organization_id = $1 and integration_connection_id = $2`,
      [r.organizationId, r.connectionId],
    );
    assertEquals(rows.rows.map((row) => ({ ...row })), [{
      operation: STORAGE_EXPORT_OPERATION,
      idempotency_key: "export-1",
      status: "confirmed",
    }]);

    // A second export of a different file under If-Match null onto the now
    // existing path is refused by the provider and the effect fails.
    const clash = await prepare(other.versionId, "export-2");
    const refused = await runStorageExport(r.db, r.deps, {
      organizationId: r.organizationId,
      effectId: clash.effectId,
    });
    assertEquals(refused.outcome, "failed");
    assertEquals(refused.effect.failureCode, "provider_rejected");
    assertEquals(decoder.decode(r.storage.bytesOf("/out/report.txt")), "alpha");
  }
}
