import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import {
  createMemoryStorage,
  fakeDriverContext,
} from "../../packages/integration-sdk/testing.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  mountStorageConnection,
  type StorageConnectionDeps,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";

function parsed(text: string): { result?: { items?: { path: string }[] } } {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

Deno.test("an agent's /connections listing shows a mount once a live grant covers the folder", () =>
  withWorkerFixture(async (fixture) => {
    const connectionId = crypto.randomUUID();
    await seedRigIntegration(fixture.pgDatabase, {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      connectionId,
      resourceId: crypto.randomUUID(),
    });
    const storage = createMemoryStorage();
    const { ctx } = fakeDriverContext();
    const deps = {
      resolver: (connection: { id: string }) =>
        connection.id === connectionId
          ? { port: storage.port, ctx, adapterVersion: "memory@1" }
          : undefined,
    } as unknown as StorageConnectionDeps;
    const mount = await withPgTransaction(
      fixture.runtimePgDatabase,
      (tx) =>
        mountStorageConnection(tx, deps, {
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          connectionId,
        }),
    );
    const folder = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and system_key = 'connections'`,
      [fixture.organizationId],
    );
    const connectionsId = folder.rows[0].id;
    const worker = await registeredWorker(fixture, {
      name: "connections-listing",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as
      & Awaited<ReturnType<typeof claimAssignment>>
      & { sessionCredential?: string };
    const token = assignment.sessionCredential;
    assert(token);
    const listed = async () => {
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        {
          tool: "storageFolderEntries.list",
          arguments: { id: connectionsId },
        },
        { headers: { "x-session-credential": token } },
      );
      const text = await response.text();
      return {
        status: response.status,
        paths: (parsed(text).result?.items ?? []).map((item) => item.path),
      };
    };
    const before = await listed();
    assertEquals(before.paths.includes(mount.path), false);
    await fixture.pgDatabase.query(
      `insert into bakery.agent_file_grants
         (organization_id, workflow_id, folder_id, access, granted_by, expires_at)
       values ($1, $2, $3, 'read', $4, now() + interval '1 hour')`,
      [
        fixture.organizationId,
        job.workflowId,
        connectionsId,
        fixture.principalId,
      ],
    );
    const after = await listed();
    assertEquals([after.status, after.paths.includes(mount.path)], [200, true]);
  }));
