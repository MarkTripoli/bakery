import { assert, assertEquals } from "@std/assert";
import {
  type CoordinationFixture,
  openCoordinationFixture,
} from "../helpers/coordination-fixture.ts";
import { publishOutput } from "../helpers/coordination-lanes.ts";
import {
  projectArtifactEntry,
  type StorageQuery,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

// #444 AC4: a run input may name a storage path (`inputPaths`, a map from a
// declared uuid input to a path; the fixture workflow declares `taskId`). Admission resolves it to the
// entry's current version and the run keeps that pin, not the path. A later move
// or new version changes nothing about a running or replayed run, and a path in
// another organization is refused like a path that does not exist.

const db = (fx: CoordinationFixture): StorageQuery => ({
  query: async <Row>(sql: string, params: unknown[] = []) => ({
    rows: (await fx.owner.unsafe(sql, params as never[])) as unknown as Row[],
  }),
});

async function pathOf(
  fx: CoordinationFixture,
  organizationId: string,
  taskId: string,
  name: string,
): Promise<string> {
  const rows = await fx.owner`
    select application.slug, folder.name as folder
      from bakery.tasks task
      join bakery.applications application
        on application.organization_id = task.organization_id
       and application.id = task.application_id
      join bakery.storage_entries folder
        on folder.organization_id = task.organization_id
       and folder.system_key = 'task:' || task.id::text
     where task.organization_id = ${organizationId} and task.id = ${taskId}`;
  return `/projects/${rows[0].slug}/artifacts/${rows[0].folder}/${name}`;
}

const runWith = async (
  fx: CoordinationFixture,
  taskId: string,
  extra: { inputs?: unknown; inputPaths?: unknown },
  key?: string,
) => {
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  return await fx.sendTask(fx.developer, "POST", `/v1/tasks/${taskId}/runs`, {
    key,
    body: {
      workflowVersionId: fx.workflowVersionId,
      repositoryProfileId: pinned[0].id,
      executionMode: "repository",
      budgetLimitUsd: "0.005000",
      ...extra,
    },
  });
};

const runCount = async (fx: CoordinationFixture, taskId: string) =>
  Number(
    (await fx.owner`
    select count(*)::text as n from bakery.workflow_runs
     where organization_id = ${fx.organizationId} and task_id = ${taskId}`)[0]
      .n,
  );

Deno.test("AC4: a run pins the version a path resolved to, and a later move or new version changes nothing", async () => {
  const fx = await openCoordinationFixture();
  try {
    const taskId = await fx.insertTask("path pin", { repo: "api" });
    const made = await publishOutput(fx, taskId, "brief.md", "plan");
    const entryId = await projectArtifactEntry(db(fx), {
      organizationId: fx.organizationId,
      artifactId: made.artifactId,
    });
    assert(entryId);
    const path = await pathOf(fx, fx.organizationId, taskId, "brief.md");

    const key = `path-pin-${crypto.randomUUID()}`;
    const response = await runWith(
      fx,
      taskId,
      { inputPaths: { taskId: path } },
      key,
    );
    assertEquals(response.status, 201, await response.clone().text());
    const run = await response.json() as { id: string };

    // The input holds the version the path resolved to; the pin and the path
    // label are recorded; the path itself is nothing the run depends on.
    const frozen = async () => {
      const input = (await fx.owner`
        select snapshot->'inputs'->>'taskId' as value from bakery.workflow_runs
         where organization_id = ${fx.organizationId} and id = ${run.id}`)[0]
        .value;
      const label = await fx.owner`
        select input_name as "inputName", storage_path as "storagePath",
               entry_id as "entryId", artifact_id as "artifactId",
               artifact_version_id as "versionId", sha256
          from bakery.run_input_paths
         where organization_id = ${fx.organizationId} and run_id = ${run.id}`;
      return { input, label: label.map((row) => ({ ...row })) };
    };
    const pins = async () =>
      await fx.owner`
        select artifact_version_id as "versionId", sha256 from bakery.run_input_pins
         where organization_id = ${fx.organizationId} and run_id = ${run.id}`;
    const expected = {
      input: made.versionId,
      label: [{
        inputName: "taskId",
        storagePath: path,
        entryId,
        artifactId: made.artifactId,
        versionId: made.versionId,
        sha256: made.sha,
      }],
    };
    assertEquals(await frozen(), expected);
    assertEquals(
      (await pins()).map((row) => [row.versionId, row.sha256]),
      [[made.versionId, made.sha]],
    );

    // Move the entry and publish a newer version of the same artifact.
    const shared = (await fx.owner`
      select id from bakery.storage_entries
       where organization_id = ${fx.organizationId} and system_key = 'shared'`)[
      0
    ].id;
    await fx.owner`
      update bakery.storage_entries set parent_id = ${shared}, name = 'Moved.md',
             name_key = 'moved.md' where id = ${entryId}`;
    const newer = crypto.randomUUID();
    await fx.owner`
      insert into bakery.artifact_versions (
        id, organization_id, artifact_id, task_id, author_id, revision, content,
        sha256, size_bytes, media_type
      ) values (${newer}, ${fx.organizationId}, ${made.artifactId}, ${taskId},
        ${fx.admin.principalId}, 2, ${new Uint8Array([9, 9])}, ${
      "cd".repeat(32)
    }, 2,
        'application/json')`;
    await fx.owner`
      update bakery.artifacts set current_version_id = ${newer}, revision = 3
       where organization_id = ${fx.organizationId} and id = ${made.artifactId}`;

    // The run keeps what it pinned: same version, same digest, same label.
    assertEquals(await frozen(), expected);
    assertEquals(
      (await pins()).map((row) => [row.versionId, row.sha256]),
      [[made.versionId, made.sha]],
    );

    // A replay of the same request returns the same run, not a re-resolution.
    const replay = await runWith(
      fx,
      taskId,
      { inputPaths: { taskId: path } },
      key,
    );
    assert(replay.status < 300, await replay.clone().text());
    assertEquals((await replay.json() as { id: string }).id, run.id);
    assertEquals(await runCount(fx, taskId), 1);
    assertEquals(await frozen(), expected);

    // The old path no longer resolves, so a new run (on a fresh task) naming
    // it is refused by name and creates nothing.
    const other = await fx.insertTask("stale path", { repo: "api" });
    const stale = await runWith(fx, other, { inputPaths: { taskId: path } });
    assertEquals(stale.status, 422, await stale.clone().text());
    assert(
      (await stale.text()).includes("input_storage_path_unavailable"),
      "the moved path is unavailable",
    );
    assertEquals(await runCount(fx, other), 0);
    assertEquals(await runCount(fx, taskId), 1);
  } finally {
    await fx.close();
  }
});

Deno.test("AC4: a path in another organization is refused like a missing one, and nothing is created", async () => {
  const fx = await openCoordinationFixture();
  try {
    const taskId = await fx.insertTask("cross org", { repo: "api" });

    // A real file with a real path, in another organization.
    const other = fx.hostileOrganizationId;
    const application = crypto.randomUUID();
    const conversation = crypto.randomUUID();
    const foreignTask = crypto.randomUUID();
    await fx.owner`
      insert into bakery.applications (id, organization_id, slug, name, description)
      values (${application}, ${other}, 'foreign', 'foreign', '')`;
    await fx.owner`
      insert into bakery.conversations (id, organization_id, application_id, title, created_by, created_at, updated_at, version)
      values (${conversation}, ${other}, ${application}, 'foreign', ${fx.admin.principalId}, now(), now(), 1)`;
    await fx.owner`
      insert into bakery.tasks (id, organization_id, application_id, conversation_id, title, description, task_type, status, priority, created_by, created_at, updated_at, version)
      values (${foreignTask}, ${other}, ${application}, ${conversation}, 'foreign work', '', 'epic', 'draft', 50, ${fx.admin.principalId}, now(), now(), 1)`;
    const artifactId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await fx.owner`
      insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
      values (${artifactId}, ${other}, ${foreignTask}, 'plan', 'secret.md')`;
    await fx.owner`
      insert into bakery.artifact_versions (id, organization_id, artifact_id, task_id, author_id, revision, content, sha256, size_bytes, media_type)
      values (${versionId}, ${other}, ${artifactId}, ${foreignTask}, ${fx.admin.principalId}, 1, ${new Uint8Array(
      [1],
    )}, ${"ef".repeat(32)}, 1, 'text/plain')`;
    await fx.owner`
      update bakery.artifacts set current_version_id = ${versionId}
       where organization_id = ${other} and id = ${artifactId}`;
    assert(
      await projectArtifactEntry(db(fx), {
        organizationId: other,
        artifactId,
      }),
    );
    const foreignPath = await pathOf(fx, other, foreignTask, "secret.md");

    const refused = await runWith(fx, taskId, {
      inputPaths: { taskId: foreignPath },
    });
    const missing = await runWith(fx, taskId, {
      inputPaths: { taskId: "/projects/nowhere/artifacts/x/secret.md" },
    });
    assertEquals(refused.status, 422);
    assertEquals(missing.status, 422);
    // The two refusals read the same, so a caller learns nothing about the other
    // organization's tree.
    const reason = (text: string) =>
      /input_storage_path_[a-z_]+/.exec(text)?.[0];
    const refusedText = await refused.text();
    assertEquals(reason(refusedText), "input_storage_path_unavailable");
    assertEquals(
      reason(await missing.text()),
      "input_storage_path_unavailable",
    );
    assert(!refusedText.includes("foreign"), "nothing of the other tree leaks");
    assertEquals(await runCount(fx, taskId), 0);
    const pinned = await fx.owner`
      select count(*)::text as n from bakery.run_input_pins
       where artifact_version_id = ${versionId}`;
    assertEquals(pinned[0].n, "0");
    const labelled = await fx.owner`
      select count(*)::text as n from bakery.run_input_paths
       where artifact_version_id = ${versionId}`;
    assertEquals(labelled[0].n, "0");
  } finally {
    await fx.close();
  }
});

Deno.test("AC4: a malformed path input is refused by name", async () => {
  const fx = await openCoordinationFixture();
  try {
    const taskId = await fx.insertTask("bad path", { repo: "api" });
    for (
      const [extra, reason] of [
        [
          { inputPaths: { taskId: "projects/relative" } },
          "input_storage_path_invalid",
        ],
        [
          { inputPaths: { taskId: "/projects/../x" } },
          "input_storage_path_invalid",
        ],
        [{ inputPaths: { taskId: 5 } }, "input_storage_path_invalid"],
        [{ inputPaths: ["/shared"] }, "input_paths_not_object"],
        [
          {
            inputs: { taskId: crypto.randomUUID() },
            inputPaths: { taskId: "/shared" },
          },
          "input_storage_path_conflict",
        ],
      ] as const
    ) {
      const response = await runWith(fx, taskId, extra);
      assertEquals(response.status, 422);
      assert((await response.text()).includes(reason), reason);
    }
    assertEquals(await runCount(fx, taskId), 0);
  } finally {
    await fx.close();
  }
});

Deno.test("AC4: a path under a restricted folder is pinned only for a member with a grant inside it", async () => {
  const fx = await openCoordinationFixture();
  try {
    const taskId = await fx.insertTask("restricted pin", { repo: "api" });
    const made = await publishOutput(fx, taskId, "brief.md", "plan");
    const entryId = await projectArtifactEntry(db(fx), {
      organizationId: fx.organizationId,
      artifactId: made.artifactId,
    });
    assert(entryId);
    const path = await pathOf(fx, fx.organizationId, taskId, "brief.md");
    const folder = (await fx.owner`
      select parent_id as id from bakery.storage_entries
       where organization_id = ${fx.organizationId} and id = ${entryId}`)[0]
      .id as string;
    await fx.owner`
      update bakery.storage_entries set restricted = true
       where organization_id = ${fx.organizationId} and id = ${folder}`;

    const refused = await runWith(fx, taskId, { inputPaths: { taskId: path } });
    assertEquals(refused.status, 422);
    assert(
      (await refused.text()).includes("input_storage_path_unavailable"),
    );
    assertEquals(await runCount(fx, taskId), 0);

    await fx.owner`
      insert into bakery.storage_folder_grants
        (organization_id, folder_id, principal_id, level, granted_by)
      values (${fx.organizationId}, ${folder}, ${fx.developer.principalId},
              'view', ${fx.admin.principalId})`;
    const allowed = await runWith(fx, taskId, { inputPaths: { taskId: path } });
    assertEquals(allowed.status, 201, await allowed.clone().text());
    assertEquals(await runCount(fx, taskId), 1);
  } finally {
    await fx.close();
  }
});
