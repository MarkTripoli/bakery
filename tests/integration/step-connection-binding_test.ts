import { assert, assertEquals, assertRejects } from "@std/assert";
import { mkdir, writeFile } from "node:fs/promises";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  seedEligibleJob,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import { stepFilesForAttempt } from "../../apps/server/src/modules/execution/step-files.ts";
import { LOCAL_DISK_PROVIDER } from "../../apps/server/src/modules/knowledge/local-disk-storage.ts";
import {
  assertConnectionsBindable,
  defaultStorageConnections,
  mountStorageConnection,
  type StorageMount,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

async function localConnection(
  admin: PgDatabase,
  runtime: PgDatabase,
  root: string,
  organizationId: string,
  principalId: string,
  file: string,
): Promise<StorageMount> {
  const connectionId = crypto.randomUUID();
  await seedRigIntegration(admin, {
    organizationId,
    principalId,
    connectionId,
    resourceId: crypto.randomUUID(),
  });
  await admin.query(
    "update bakery.integration_connections set provider = $2, label = $3" +
      " where id = $1",
    [connectionId, LOCAL_DISK_PROVIDER, "disk-" + connectionId.slice(0, 8)],
  );
  const folder = root + "/" + organizationId + "/" + connectionId;
  await mkdir(folder, { recursive: true });
  await writeFile(folder + "/" + file, "bytes of " + file);
  return await withPgTransaction(
    runtime,
    (tx) =>
      mountStorageConnection(
        tx,
        defaultStorageConnections({ storageLocalRoot: root }),
        { organizationId, principalId, connectionId },
      ),
  );
}

async function pinPlanStep(
  fixture: Fixture,
  job: Awaited<ReturnType<typeof seedEligibleJob>>,
  files: Json,
): Promise<void> {
  const compiled = await compileWorkflowDocument({
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "agent-452-bound-connection",
    description: "One step that binds one storage connection.",
    inputs: {},
    steps: [{ id: "worker", uses: "workflow.noop", files }],
  }, { catalog: defaultWorkflowCompilerCatalog() });
  assert(compiled.ok, JSON.stringify(compiled));
  await fixture.pgDatabase.query(
    "update bakery.workflow_runs set snapshot = snapshot ||" +
      " jsonb_build_object('runtime', $3::jsonb)" +
      " where organization_id = $1 and id = $2",
    [
      fixture.organizationId,
      job.runId,
      JSON.stringify({ pin: {}, document: compiled.document }),
    ],
  );
  await fixture.pgDatabase.query(
    "update bakery.run_steps as step set dispatch = jsonb_build_object(" +
      "'action', job.action, 'input', step.input," +
      " 'requires', '[]'::jsonb," +
      " 'retry', jsonb_build_object('maxAttempts', job.max_attempts))" +
      " from bakery.jobs as job" +
      " where job.organization_id = step.organization_id" +
      " and job.run_step_id = step.id" +
      " and job.organization_id = $1 and job.id = $2",
    [fixture.organizationId, job.jobId],
  );
}

async function boundSession(fixture: Fixture, connectionId: string) {
  const worker = await registeredWorker(fixture, {
    name: "agent-452-bound",
    slots: 1,
  });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  await pinPlanStep(fixture, job, {
    read: ["connections"],
    connections: [connectionId],
  });
  const assignment = await claimAssignment(fixture, worker) as
    & Awaited<ReturnType<typeof claimAssignment>>
    & { sessionCredential?: string };
  const token = assignment.sessionCredential;
  assert(token, "the claim mints a session credential");
  return {
    attemptId: assignment.attemptId,
    call: async (tool: string, args: Json) => {
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool, arguments: args },
        { headers: { "x-session-credential": token } },
      );
      return {
        status: response.status,
        body: JSON.parse(await response.text()) as Json,
      };
    },
  };
}

function personContext(
  tx: unknown,
  organizationId: string,
  principalId: string,
): ActionContext {
  return {
    request: new Request("http://bakery.test/"),
    params: {},
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    authority: { organizationId, subject: { principalId } },
    transaction: tx,
  } as unknown as ActionContext;
}

const root = await Deno.makeTempDir({ prefix: "bakery-bound-connections-" });

Deno.test("a bound connection is read through the session; an unbound one is refused", () =>
  withWorkerFixture(async (fixture) => {
    const bound = await localConnection(
      fixture.pgDatabase,
      fixture.runtimePgDatabase,
      root,
      fixture.organizationId,
      fixture.principalId,
      "bound.txt",
    );
    const unbound = await localConnection(
      fixture.pgDatabase,
      fixture.runtimePgDatabase,
      root,
      fixture.organizationId,
      fixture.principalId,
      "unbound.txt",
    );
    const agent = await boundSession(fixture, bound.connectionId);
    const files = await withPgTransaction(
      fixture.pgDatabase,
      (tx) => stepFilesForAttempt(tx, fixture.organizationId, agent.attemptId),
    );
    assertEquals(files.connections, [bound.connectionId]);
    assertEquals([...files.read], ["connections"]);

    const listed = await agent.call("storageConnectionPaths.list", {
      path: bound.path,
    });
    assertEquals(listed.status, 200, JSON.stringify(listed.body));
    const items = (listed.body.result as { items: { name: string }[] })
      .items;
    assertEquals(items.map((item) => item.name), ["bound.txt"]);
    const stat = await agent.call("storageConnectionPaths.stat", {
      path: bound.path + "/bound.txt",
    });
    assertEquals(stat.status, 200, JSON.stringify(stat.body));

    for (
      const [tool, path] of [
        ["storageConnectionPaths.list", unbound.path],
        ["storageConnectionPaths.stat", unbound.path + "/unbound.txt"],
      ]
    ) {
      const refused = await agent.call(tool, { path });
      assertEquals(refused.status, 403, JSON.stringify(refused.body));
      assertEquals(refused.body.reason, "agent_file_connection_not_bound");
    }
  }, { env: { BAKERY_STORAGE_LOCAL_ROOT: root } }));

Deno.test("a binding to another organization's connection is refused at admission", () =>
  withWorkerFixture(async (fixture) => {
    const own = await localConnection(
      fixture.pgDatabase,
      fixture.runtimePgDatabase,
      root,
      fixture.organizationId,
      fixture.principalId,
      "own.txt",
    );
    const otherOrganizationId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      "insert into bakery.organizations" +
        " (id, name, slug, metadata, created_at, updated_at, version)" +
        " values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)",
      [otherOrganizationId, "other-" + otherOrganizationId.slice(0, 8)],
    );
    try {
      const foreign = await localConnection(
        fixture.pgDatabase,
        fixture.runtimePgDatabase,
        root,
        otherOrganizationId,
        fixture.principalId,
        "foreign.txt",
      );
      const check = (connectionIds: string[]) =>
        withPgTransaction(
          fixture.runtimePgDatabase,
          (tx) =>
            assertConnectionsBindable(
              personContext(tx, fixture.organizationId, fixture.principalId),
              tx,
              { isAdmin: false },
              {
                organizationId: fixture.organizationId,
                principalId: fixture.principalId,
                connectionIds,
              },
            ),
        );
      await check([own.connectionId]);
      for (const ids of [[foreign.connectionId], [crypto.randomUUID()]]) {
        const error = await assertRejects(() => check(ids));
        assert(error instanceof StandardError, String(error));
        assertEquals(error.code, "UNPROCESSABLE");
        assertEquals(
          (error.params as { issues: { code: string }[] }).issues[0].code,
          "storage_connection_not_bindable",
        );
      }
      await fixture.pgDatabase.query(
        "update bakery.integration_connections set status = 'disabled'" +
          " where id = $1",
        [own.connectionId],
      );
      const disabled = await assertRejects(() => check([own.connectionId]));
      assert(disabled instanceof StandardError);
      assertEquals(disabled.code, "STATE_CONFLICT");
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [otherOrganizationId],
      );
    }
  }));

Deno.test("cleanup: the temporary storage root is removed", async () => {
  await Deno.remove(root, { recursive: true });
});
