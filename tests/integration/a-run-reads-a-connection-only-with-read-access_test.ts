import { assert, assertEquals, assertRejects } from "@std/assert";
import { mkdir, writeFile } from "node:fs/promises";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
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
  type StorageConnectionDeps,
} from "../../apps/server/src/modules/knowledge/storage-connections.ts";
import { createRunCommand } from "../../apps/server/src/modules/work/run-command.ts";
import {
  internalContext,
  liveActor,
} from "../../apps/server/src/modules/workflows/automations/start.ts";

const WITHOUT_READ = ["task:read", "task:write", "run:read", "run:write"];
const WITH_READ = [...WITHOUT_READ, "integrationConnection:read"];

async function holdOnly(
  fx: CoordinationFixture,
  permissions: readonly string[],
): Promise<void> {
  const key = "runs-" + crypto.randomUUID().slice(0, 8);
  const role = await fx.ownerPg.query<{ id: string }>(
    `insert into bakery.organization_roles
       (organization_id, key, name, permissions, created_by_principal_id)
     values ($1, $2, $2, $3, $4) returning id`,
    [fx.organizationId, key, permissions, fx.admin.principalId],
  );
  await fx.ownerPg.query(
    `update bakery.organization_memberships
        set role = 'guest', custom_role_id = $3
      where organization_id = $1 and principal_id = $2`,
    [fx.organizationId, fx.viewer.principalId, role.rows[0].id],
  );
}

type Disk = Readonly<{
  root: string;
  connectionId: string;
  deps: StorageConnectionDeps;
  filePath: string;
}>;

async function connectionOnDisk(fx: CoordinationFixture): Promise<Disk> {
  const root = await Deno.makeTempDir({ prefix: "bakery-run-read-scope-" });
  const connectionId = crypto.randomUUID();
  await seedRigIntegration(fx.ownerPg, {
    organizationId: fx.organizationId,
    principalId: fx.admin.principalId,
    connectionId,
    resourceId: crypto.randomUUID(),
  });
  await fx.owner`
    update bakery.integration_connections
       set provider = ${LOCAL_DISK_PROVIDER},
           label = ${"disk-" + connectionId.slice(0, 8)}
     where id = ${connectionId}`;
  const folder = `${root}/${fx.organizationId}/${connectionId}`;
  await mkdir(folder, { recursive: true });
  await writeFile(folder + "/brief.md", "the brief");
  const deps = defaultStorageConnections({ storageLocalRoot: root });
  const mount = await withPgTransaction(
    fx.ownerPg,
    (tx) =>
      mountStorageConnection(tx, deps, {
        organizationId: fx.organizationId,
        principalId: fx.admin.principalId,
        connectionId,
      }),
  );
  return { root, connectionId, deps, filePath: mount.path + "/brief.md" };
}

function boundSpec(connectionId: string) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "bound-connection-scope",
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

async function startAs(
  fx: CoordinationFixture,
  permissions: readonly string[],
  taskId: string,
  body: Record<string, unknown>,
  deps: StorageConnectionDeps,
) {
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  const input = contractSchemas.RunCreate.parse({
    repositoryProfileId: pinned[0].id,
    executionMode: "repository",
    budgetLimitUsd: "0.005000",
    ...body,
  });
  await holdOnly(fx, permissions);
  return await withPgTransaction(fx.appPg, async (tx) => {
    const actor = await liveActor(
      tx,
      fx.organizationId,
      fx.viewer.principalId,
    );
    assert(actor !== null);
    return await createRunCommand(
      internalContext(
        tx,
        actor,
        { requestId: crypto.randomUUID(), traceId: crypto.randomUUID() },
        { id: taskId },
        {
          operation: "runs.create",
          idempotencyKey: crypto.randomUUID(),
          target: `/v1/tasks/${taskId}/runs`,
        },
      ),
      input,
      { storageConnections: deps },
    );
  });
}

async function refusalCode(work: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(work);
  assert(error instanceof StandardError, String(error));
  return error.code;
}

async function runsOf(fx: CoordinationFixture, taskId: string) {
  const rows = await fx.owner`
    select count(*)::int as n from bakery.workflow_runs
     where organization_id = ${fx.organizationId} and task_id = ${taskId}`;
  return rows[0].n as number;
}

Deno.test("a member who cannot read connections cannot bind one to a run", async () => {
  const fx = await openCoordinationFixture();
  const disk = await connectionOnDisk(fx);
  try {
    const { workflowVersionId } = await fx.publishWorkflowVersion(
      boundSpec(disk.connectionId),
    );
    const taskId = await fx.insertTask("bound scope", { repo: "api" });
    const body = { workflowVersionId, inputs: { taskId } };
    assertEquals(
      await refusalCode(() =>
        startAs(fx, WITHOUT_READ, taskId, body, disk.deps)
      ),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(await runsOf(fx, taskId), 0);
    await startAs(fx, WITH_READ, taskId, body, disk.deps);
    assertEquals(await runsOf(fx, taskId), 1);
  } finally {
    await Deno.remove(disk.root, { recursive: true });
    await fx.close();
  }
});

Deno.test("a member who cannot read connections cannot name a connection file as a run input", async () => {
  const fx = await openCoordinationFixture();
  const disk = await connectionOnDisk(fx);
  try {
    const taskId = await fx.insertTask("input scope", { repo: "api" });
    const body = {
      workflowVersionId: fx.workflowVersionId,
      inputPaths: { taskId: disk.filePath },
    };
    assertEquals(
      await refusalCode(() =>
        startAs(fx, WITHOUT_READ, taskId, body, disk.deps)
      ),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(await runsOf(fx, taskId), 0);
    await startAs(fx, WITH_READ, taskId, body, disk.deps);
    assertEquals(await runsOf(fx, taskId), 1);
  } finally {
    await Deno.remove(disk.root, { recursive: true });
    await fx.close();
  }
});
