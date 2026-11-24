import { assert, assertEquals } from "@std/assert";
import { readInngestRuntimeConfig } from "@bakery/config";
import type { Inngest } from "inngest";
import type { OrganizationBlobStore } from "../../apps/server/src/modules/catalog/storage-port.ts";
import {
  createDefaultInngestFunctions,
  type IntegrationsBackgroundDependencies,
} from "../../apps/server/src/modules/execution/inngest-http.ts";
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

type Registered = {
  config: { id?: string };
  handler: (input: {
    step: { run: <T>(name: string, work: () => Promise<T>) => Promise<T> };
  }) => Promise<unknown>;
};

const inngestConfig = readInngestRuntimeConfig({
  BAKERY_ENV: "test",
  INNGEST_URL: "http://127.0.0.1:8288",
  INNGEST_SIGNING_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  INNGEST_EVENT_KEY: "issue-452-event-key",
});

function exportSweep(
  database: Parameters<typeof createDefaultInngestFunctions>[0]["database"],
  storage: {
    storageLocalRoot: string;
    storageBlobStore?: OrganizationBlobStore;
  },
): Registered {
  const registered: Registered[] = [];
  const client = {
    createFunction(
      config: Registered["config"],
      handler: Registered["handler"],
    ) {
      const value = { config, handler };
      registered.push(value);
      return value;
    },
  } as unknown as Inngest;
  createDefaultInngestFunctions({
    config: inngestConfig,
    database,
    client,
    integrations: {} as IntegrationsBackgroundDependencies,
    ...storage,
  });
  const sweep = registered.find((fn) =>
    fn.config.id === "bakery-knowledge-storage-connection-exports"
  );
  assert(sweep, "the export sweep is registered");
  return sweep;
}

Deno.test("the background export sweep carries the blob store to a blob-backed export", () =>
  withWorkerFixture(async (fixture) => {
    const root = await Deno.makeTempDir({ prefix: "bakery-local-disk-blob-" });
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
        { stepKey: "local-disk-blob-" + crypto.randomUUID() },
      );
      const folder = `${root}/${organizationId}/${connectionId}`;
      await mkdir(folder + "/docs", { recursive: true });
      await writeFile(folder + "/docs/a.txt", "alpha");
      const blobs = memoryBlobs();
      const deps = defaultStorageConnections({
        storageLocalRoot: root,
        blobStore: blobs,
      });
      assertEquals(deps.blobStore, blobs);
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
      const source = await as((context, tx) =>
        ingestConnectionInput(context, tx, reader, deps, {
          organizationId,
          principalId,
          taskId: run.taskId,
          path: mount.path + "/docs/a.txt",
        })
      );
      const inline = await fixture.pgDatabase.query<{ inline: boolean }>(
        `select content is not null as inline from bakery.artifact_versions
          where organization_id = $1 and id = $2`,
        [organizationId, source.versionId],
      );
      assertEquals(inline.rows[0].inline, false);
      const exportTo = (name: string) =>
        as((context) =>
          prepareStorageExport(context, reader, deps, {
            path: mount.path + "/out/" + name,
            artifactVersionId: source.versionId,
            idempotencyKey: "blob-sweep-" + name,
          })
        );
      const step = {
        run: <T>(_name: string, work: () => Promise<T>) => work(),
      };

      await exportTo("without.txt");
      await exportSweep(db, { storageLocalRoot: root }).handler({ step });
      const withoutStore = await fixture.pgDatabase.query<
        { status: string; failure_code: string | null }
      >(
        `select status, failure_code from bakery.external_effects
          where organization_id = $1 and idempotency_key = 'blob-sweep-without.txt'`,
        [organizationId],
      );
      assertEquals(
        withoutStore.rows.map((row) => [row.status, row.failure_code]),
        [
          ["failed", "provider_not_sent"],
        ],
      );

      await exportTo("with.txt");
      await exportSweep(db, { storageLocalRoot: root, storageBlobStore: blobs })
        .handler({ step });
      assertEquals(await readFile(folder + "/out/with.txt", "utf8"), "alpha");
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.external_effects where organization_id = $1",
        [organizationId],
      );
      await Deno.remove(root, { recursive: true });
    }
  }));
