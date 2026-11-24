import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
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
  MAX_EXPORT_ATTEMPTS,
  mountStorageConnection,
  prepareStorageExport,
  readConnectionRange,
  runConnectionSync,
  runDueConnectionSyncs,
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
import type { OrganizationBlobStore } from "../../apps/server/src/modules/catalog/storage-port.ts";
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
import {
  closeWorkerOrganization,
  createWorkerScope,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";

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

    assertEquals(await ingestedCount(r), 0);
    const copied = await r.db.query<{ n: number }>(
      `select count(*)::int as n from bakery.artifacts
        where organization_id = $1 and artifact_type = 'connection_file'`,
      [r.organizationId],
    );
    assertEquals(copied.rows[0].n, 0);
    const top = await r.db.query<{ system_key: string }>(
      `select top.system_key from bakery.storage_entries mount
         join bakery.storage_entries top
           on top.organization_id = mount.organization_id
          and top.id = mount.parent_id
        where mount.organization_id = $1 and mount.id = $2`,
      [r.organizationId, r.mount.entryId],
    );
    assertEquals(top.rows[0].system_key, "connections");

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

    const byPath = await withPgTransaction(
      r.db,
      (tx) =>
        pinStoragePath(storageQueryOf(tx), {
          organizationId: r.organizationId,
          path,
        }),
    );
    assertEquals(byPath?.versionId, versionId);

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
    assertEquals(r.storage.calls.write, 0);
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

async function call(
  fixture: WorkerFixture,
  method: string,
  path: string,
  options: { body?: unknown; organizationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": options.organizationId ??
          fixture.organizationId,
        Cookie: fixture.adminCookie,
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : JSON.parse(text) as Record<string, unknown>,
  };
}

const q = (path: string) => encodeURIComponent(path);

Deno.test("routes answer a typed error when no provider serves the connection", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const docs = r.mount.path + "/docs";
    const refusals = [
      await call(
        fixture,
        "GET",
        "/v1/storage/connection-paths?path=" + q(docs),
      ),
      await call(
        fixture,
        "GET",
        "/v1/storage/connection-paths/stat?path=" + q(docs + "/a.txt"),
      ),
      await call(
        fixture,
        "GET",
        "/v1/storage/connection-paths/content?path=" + q(docs + "/a.txt") +
          "&offset=0&length=5",
      ),
      await call(fixture, "POST", "/v1/storage/connection-syncs", {
        body: { path: docs, taskId: r.taskId },
      }),
      await call(fixture, "POST", "/v1/storage/connection-exports", {
        body: {
          path: docs + "/out.txt",
          artifactVersionId: crypto.randomUUID(),
        },
      }),
      await call(
        fixture,
        "POST",
        "/v1/storage/connections/" + r.connectionId + "/mount",
      ),
    ];
    for (const refusal of refusals) {
      assertEquals(refusal.status, 409, JSON.stringify(refusal.body));
      assert(
        JSON.stringify(refusal.body).includes("storage-provider-unavailable"),
        JSON.stringify(refusal.body),
      );
    }
    assertEquals(r.storage.calls.list + r.storage.calls.read, 0);
  }));

Deno.test("routes refuse another organization and list and pause syncs", () =>
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
    const other = await createWorkerScope(fixture, "storage-452", fixture);
    try {
      for (
        const path of [
          "/v1/storage/connection-paths?path=" + q(r.mount.path),
          "/v1/storage/connection-paths/stat?path=" + q(r.mount.path),
        ]
      ) {
        const refused = await call(fixture, "GET", path, {
          organizationId: other.organizationId,
        });
        assertEquals(refused.status, 404, JSON.stringify(refused.body));
      }
      const elsewhere = await call(
        fixture,
        "GET",
        "/v1/storage/connection-syncs",
        { organizationId: other.organizationId },
      );
      assertEquals(elsewhere.status, 200);
      assertEquals(elsewhere.body.items, []);
      const pauseElsewhere = await call(
        fixture,
        "POST",
        "/v1/storage/connection-syncs/" + syncId + "/pause",
        { organizationId: other.organizationId },
      );
      assertEquals(pauseElsewhere.status, 404);

      const listed = await call(fixture, "GET", "/v1/storage/connection-syncs");
      assertEquals(listed.status, 200, JSON.stringify(listed.body));
      const items = listed.body.items as Record<string, unknown>[];
      assertEquals(items.map((item) => [item.id, item.path, item.pausedAt]), [
        [syncId, r.mount.path + "/docs", null],
      ]);
      const paused = await call(
        fixture,
        "POST",
        "/v1/storage/connection-syncs/" + syncId + "/pause",
      );
      assertEquals(paused.status, 201, JSON.stringify(paused.body));
      assert(typeof paused.body.pausedAt === "string");
      const sweep = await runDueConnectionSyncs(r.db, r.deps);
      assertEquals(sweep, { ran: 0, failed: 0 });
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, other.organizationId);
    }
  }));

function memoryBlobs(): OrganizationBlobStore {
  const objects = new Map<string, Uint8Array>();
  const key = (organizationId: string, sha256: string) =>
    organizationId + "/" + sha256;
  return {
    putIfAbsent(organizationId, sha256, content) {
      objects.set(key(organizationId, sha256), content);
      return Promise.resolve();
    },
    read(organizationId, sha256) {
      const found = objects.get(key(organizationId, sha256));
      return found === undefined
        ? Promise.reject(new Error("missing object"))
        : Promise.resolve(found);
    },
    stat(organizationId, sha256) {
      const found = objects.get(key(organizationId, sha256));
      return Promise.resolve(
        found === undefined ? null : { sizeBytes: found.byteLength },
      );
    },
    recover() {
      return Promise.resolve();
    },
  };
}

async function exportOf(
  r: Rig,
  path: string,
  key: string,
  deps: StorageConnectionDeps = r.deps,
) {
  const source = await as(
    r,
    (context, tx) =>
      ingestConnectionInput(context, tx, reader, deps, {
        organizationId: r.organizationId,
        principalId: r.principalId,
        taskId: r.taskId,
        path: r.mount.path + path,
      }),
  );
  return await as(
    r,
    (context) =>
      prepareStorageExport(context, reader, r.deps, {
        path: r.mount.path + "/out/" + key + ".txt",
        artifactVersionId: source.versionId,
        idempotencyKey: key,
      }),
  );
}

async function clearEffects(
  fixture: WorkerFixture,
  r: Rig,
): Promise<void> {
  await fixture.pgDatabase.query(
    "delete from bakery.external_effects where organization_id = $1",
    [r.organizationId],
  );
}

Deno.test("an export refuses a version the caller may not read", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const other = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Someone else', 'service')`,
      [other],
    );
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
    const before = await fixture.pgDatabase.query<
      { policy: string; owner_id: string | null }
    >(
      `select policy, owner_id from bakery.storage_entries
        where organization_id = $1 and id = $2`,
      [r.organizationId, source.entryId],
    );
    const exportIt = (key: string) =>
      as(r, (context) =>
        prepareStorageExport(context, reader, r.deps, {
          path: r.mount.path + "/out/" + key + ".txt",
          artifactVersionId: source.versionId,
          idempotencyKey: key,
        }));
    try {
      assertEquals((await exportIt("mine")).status, "prepared");
      await fixture.pgDatabase.query(
        `update bakery.storage_entries set policy = 'personal', owner_id = $3
          where organization_id = $1 and id = $2`,
        [r.organizationId, source.entryId, other],
      );
      assertEquals(await code(exportIt("leak")), "RESOURCE_NOT_FOUND");
      const effects = await fixture.pgDatabase.query<
        { idempotency_key: string }
      >(
        `select idempotency_key from bakery.external_effects
          where organization_id = $1`,
        [r.organizationId],
      );
      assertEquals(effects.rows.map((row) => row.idempotency_key), ["mine"]);
      assertEquals(r.storage.calls.write, 0);
    } finally {
      await fixture.pgDatabase.query(
        `update bakery.storage_entries set policy = $3, owner_id = $4
          where organization_id = $1 and id = $2`,
        [
          r.organizationId,
          source.entryId,
          before.rows[0].policy,
          before.rows[0].owner_id,
        ],
      );
      await clearEffects(fixture, r);
      await fixture.pgDatabase.query(
        "delete from bakery.principals where id = $1",
        [other],
      );
    }
  }));

Deno.test("a blob-backed export settles, and one whose bytes are gone fails once", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    try {
      const blobDeps: StorageConnectionDeps = {
        ...r.deps,
        blobStore: memoryBlobs(),
      };
      const stored = await exportOf(r, "/docs/a.txt", "blob-1", blobDeps);
      const sent = await runStorageExport(r.db, blobDeps, {
        organizationId: r.organizationId,
        effectId: stored.effectId,
      });
      assertEquals(sent.outcome, "confirmed");
      assertEquals(
        decoder.decode(r.storage.bytesOf("/out/blob-1.txt")),
        "alpha",
      );

      const orphan = await exportOf(r, "/docs/b.txt", "blob-2", blobDeps);
      const lost = await runStorageExport(r.db, r.deps, {
        organizationId: r.organizationId,
        effectId: orphan.effectId,
      });
      assertEquals(lost.outcome, "failed");
      assertEquals(lost.effect.failureCode, "provider_not_sent");
      const again = await runStorageExport(r.db, r.deps, {
        organizationId: r.organizationId,
        effectId: orphan.effectId,
      });
      assertEquals([again.outcome, again.dispatched], ["failed", false]);
    } finally {
      await clearEffects(fixture, r);
    }
  }));

Deno.test("an export whose lease expired is claimed again, and its attempts are capped", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    try {
      const stale = await exportOf(r, "/docs/a.txt", "lease-1");
      await r.db.query(
        `update bakery.external_effects
            set status = 'submitted', dispatch_generation = 1,
                lease_expires_at = now() - interval '1 minute'
          where organization_id = $1 and id = $2`,
        [r.organizationId, stale.effectId],
      );
      const reclaimed = await runStorageExport(r.db, r.deps, {
        organizationId: r.organizationId,
        effectId: stale.effectId,
      });
      assertEquals([reclaimed.outcome, reclaimed.dispatched], [
        "confirmed",
        true,
      ]);
      assertEquals(reclaimed.effect.dispatchGeneration, 2);

      const failing: StorageConnectionDeps = {
        resolver: (connection) => {
          const bound = r.deps.resolver(connection);
          return bound === undefined ? undefined : {
            ...bound,
            port: {
              ...bound.port,
              write: () => Promise.reject(new Error("remote down")),
            },
          };
        },
      };
      const stuck = await exportOf(r, "/docs/b.txt", "retry-1");
      const outcomes: string[] = [];
      for (let attempt = 0; attempt <= MAX_EXPORT_ATTEMPTS; attempt++) {
        const ran = await runStorageExport(r.db, failing, {
          organizationId: r.organizationId,
          effectId: stuck.effectId,
        });
        outcomes.push(ran.outcome);
        await r.db.query(
          `update bakery.external_effects set next_retry_at = null
            where organization_id = $1 and id = $2`,
          [r.organizationId, stuck.effectId],
        );
      }
      assertEquals(outcomes, [
        ...Array(MAX_EXPORT_ATTEMPTS).fill("retry_scheduled"),
        "failed",
      ]);
      const last = await runStorageExport(r.db, failing, {
        organizationId: r.organizationId,
        effectId: stuck.effectId,
      });
      assertEquals(last.effect.failureCode, "retry_exhausted");
    } finally {
      await clearEffects(fixture, r);
    }
  }));

Deno.test("a sync longer than one run resumes where it stopped and only then moves the feed", () =>
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
    const position = async () =>
      (await r.db.query<{ change_position: string | null; walking: boolean }>(
        `select change_position, walk_folders is not null as walking
           from bakery.storage_connection_syncs
          where organization_id = $1 and id = $2`,
        [r.organizationId, syncId],
      )).rows[0];
    const run = () =>
      runConnectionSync(r.db, r.deps, {
        organizationId: r.organizationId,
        syncId,
        maxFiles: 1,
      });
    const counts: number[] = [];
    const midWalk: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      counts.push((await run()).ingested);
      if (i < 2) midWalk.push((await position()).change_position);
    }
    assertEquals(counts, [1, 1, 1]);
    assertEquals(midWalk, [null, null]);
    assertEquals(await ingestedCount(r), 3);
    assertEquals((await position()).walking, false);
    assert((await position()).change_position !== null);
    assertEquals((await run()).unchanged, true);
    r.storage.put("/docs/deep/d.txt", "delta");
    const walked: number[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await run();
      walked.push(result.ingested + result.replayed);
    }
    assertEquals(walked, [1, 1, 1, 1]);
    assertEquals(await ingestedCount(r), 4);
    assertEquals((await run()).unchanged, true);
  }));

Deno.test("a paused sync never runs until it is resumed", () =>
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
    const paused = await call(
      fixture,
      "POST",
      "/v1/storage/connection-syncs/" + syncId + "/pause",
    );
    assertEquals(paused.status, 201, JSON.stringify(paused.body));
    const skipped = await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    assertEquals(skipped.unchanged, true);
    assertEquals(await ingestedCount(r), 0);
    const resumed = await call(
      fixture,
      "POST",
      "/v1/storage/connection-syncs/" + syncId + "/resume",
    );
    assertEquals(resumed.status, 201, JSON.stringify(resumed.body));
    assertEquals(resumed.body.pausedAt, null);
    const ran = await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    assertEquals(ran.ingested, 3);
  }));

Deno.test("a failing sync is recorded and the sweep moves on", () =>
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
    const broken: StorageConnectionDeps = {
      resolver: (connection) => {
        const bound = r.deps.resolver(connection);
        return bound === undefined ? undefined : {
          ...bound,
          port: {
            ...bound.port,
            changes: () => Promise.reject(new Error("EACCES")),
          },
        };
      },
    };
    const sweep = await runDueConnectionSyncs(r.db, broken);
    assertEquals(sweep.failed >= 1, true);
    const row = await r.db.query<
      { last_failure: string | null; ran: boolean }
    >(
      `select last_failure, last_run_at is not null as ran
         from bakery.storage_connection_syncs
        where organization_id = $1 and id = $2`,
      [r.organizationId, syncId],
    );
    assertEquals(row.rows[0], { last_failure: "sync_failed", ran: true });
    const listed = await call(fixture, "GET", "/v1/storage/connection-syncs");
    const items = listed.body.items as Record<string, unknown>[];
    assertEquals(items.map((item) => item.lastFailure), ["sync_failed"]);
    await runConnectionSync(r.db, r.deps, {
      organizationId: r.organizationId,
      syncId,
    });
    const cleared = await r.db.query<{ last_failure: string | null }>(
      `select last_failure from bakery.storage_connection_syncs
        where organization_id = $1 and id = $2`,
      [r.organizationId, syncId],
    );
    assertEquals(cleared.rows[0].last_failure, null);
  }));

Deno.test("a connections path in any case goes through the guarded ingest", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    const asked: string[] = [];
    const spelled = "/Connections/" + r.mount.name + "/docs/a.txt";
    await withPgTransaction(r.db, (tx) =>
      resolveInputPaths(tx, {
        organizationId: r.organizationId,
        inputs: {},
        inputPaths: { brief: spelled },
        connections: (path: string) => {
          asked.push(path);
          return ingestConnectionInput(
            personContext(tx, r.organizationId, r.principalId),
            tx,
            reader,
            r.deps,
            {
              organizationId: r.organizationId,
              principalId: r.principalId,
              taskId: r.taskId,
              path,
            },
          );
        },
      }));
    assertEquals(asked, [spelled]);
    const refused = await assertRejects(() =>
      withPgTransaction(r.db, (tx) =>
        resolveInputPaths(tx, {
          organizationId: r.organizationId,
          inputs: {},
          inputPaths: { brief: r.mount.path + "/docs/a.txt" },
        }))
    );
    assert(refused instanceof StandardError);
    assertEquals(
      JSON.stringify(refused.params).includes("input_storage_path_unavailable"),
      true,
    );
  }));

Deno.test("two remote names that differ only in case both land in the tree", () =>
  withWorkerFixture(async (fixture) => {
    const r = await rig(fixture);
    r.storage.put("/cased/Report.txt", "upper");
    r.storage.put("/cased/report.txt", "lower");
    const pins = [];
    for (const path of ["/cased/Report.txt", "/cased/report.txt"]) {
      pins.push(
        await as(
          r,
          (context, tx) =>
            ingestConnectionInput(context, tx, reader, r.deps, {
              organizationId: r.organizationId,
              principalId: r.principalId,
              taskId: r.taskId,
              path: r.mount.path + path,
            }),
        ),
      );
    }
    assertNotEquals(pins[0].entryId, pins[1].entryId);
  }));
