import { assertEquals } from "@std/assert";
import {
  type CoordinationFixture,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { LOCAL_DISK_PROVIDER } from "../../apps/server/src/modules/knowledge/local-disk-storage.ts";
import {
  defaultStorageConnections,
  mountStorageConnection,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";

const deps = defaultStorageConnections({
  storageLocalRoot: "/nonexistent/bakery-452-admission",
});

async function connection(
  fx: CoordinationFixture,
  organizationId: string,
  mount: boolean,
): Promise<string> {
  const connectionId = crypto.randomUUID();
  await seedRigIntegration(fx.ownerPg, {
    organizationId,
    principalId: fx.admin.principalId,
    connectionId,
    resourceId: crypto.randomUUID(),
  });
  await fx.owner`
    update bakery.integration_connections
       set provider = ${LOCAL_DISK_PROVIDER},
           label = ${"disk-" + connectionId.slice(0, 8)}
     where id = ${connectionId}`;
  if (mount) {
    await withPgTransaction(
      fx.ownerPg,
      (tx) =>
        mountStorageConnection(tx, deps, {
          organizationId,
          principalId: fx.admin.principalId,
          connectionId,
        }),
    );
  }
  return connectionId;
}

function boundSpec(connectionId: string) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "bound-connection",
    inputs: { taskId: { type: "uuid", required: true } },
    steps: [{
      id: "flow",
      steps: [{
        id: "review",
        uses: "workflow.noop",
        with: {},
        files: { read: ["connections"], connections: [connectionId] },
      }],
    }],
  };
}

async function start(fx: CoordinationFixture, connectionId: string) {
  const { workflowVersionId } = await fx.publishWorkflowVersion(
    boundSpec(connectionId),
  );
  const taskId = await fx.insertTask("bound connection", { repo: "api" });
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  const response = await fx.sendTask(
    fx.developer,
    "POST",
    `/v1/tasks/${taskId}/runs`,
    {
      body: {
        workflowVersionId,
        repositoryProfileId: pinned[0].id,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { taskId },
      },
    },
  );
  const runs = await fx.owner`
    select count(*)::int as n from bakery.workflow_runs
     where organization_id = ${fx.organizationId} and task_id = ${taskId}`;
  return {
    status: response.status,
    body: JSON.parse(await response.text()) as {
      code?: string;
      reason?: string;
      issues?: { code?: string }[];
    },
    runs: runs[0].n as number,
  };
}

Deno.test("a run binding an unusable connection is refused with no run; a usable one starts", async () => {
  const fx = await openCoordinationFixture();
  try {
    const unmounted = await connection(fx, fx.organizationId, false);
    const disabled = await connection(fx, fx.organizationId, true);
    await fx.owner`
      update bakery.integration_connections set status = 'disabled'
       where id = ${disabled}`;
    const foreign = await connection(fx, fx.hostileOrganizationId, true);
    const usable = await connection(fx, fx.organizationId, true);

    for (const id of [unmounted, foreign, crypto.randomUUID()]) {
      const refused = await start(fx, id);
      assertEquals(refused.status, 422, JSON.stringify(refused.body));
      assertEquals(
        refused.body.issues?.[0]?.code,
        "storage_connection_not_bindable",
      );
      assertEquals(refused.runs, 0);
    }
    const off = await start(fx, disabled);
    assertEquals(off.status, 409, JSON.stringify(off.body));
    assertEquals(off.body.reason, "connection_unavailable");
    assertEquals(off.runs, 0);

    const started = await start(fx, usable);
    assertEquals(started.status, 201, JSON.stringify(started.body));
    assertEquals(started.runs, 1);
  } finally {
    await fx.close();
  }
});
