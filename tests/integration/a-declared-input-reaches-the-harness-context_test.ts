import { assert, assertEquals } from "@std/assert";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { prepareHarnessContext } from "../../apps/worker/src/harness-context.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { workerFixtureCapabilities } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";

const RUN_REPO = "00000000-0000-4000-8000-0000000000a1";

const withBrief = {
  id: "gate",
  needs: ["first"],
  uses: "quality.check",
  with: { repositoryId: "$input.repo", revision: "abc" },
  checks: ["fmt"],
  inputs: [{ name: "brief", from: "$input.brief" }],
};

const DECLARED = {
  repo: { type: "uuid", required: true },
  brief: { type: "uuid", required: true },
};

async function seedBrief(
  fixture: WorkerFixture,
  taskId: string,
  versionId: string,
  text: string,
) {
  const artifactId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Bytes(bytes);
  await fixture.pgDatabase.query(
    `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name)
     values ($1,$2,$3,'document',$4)`,
    [artifactId, fixture.organizationId, taskId, `Brief ${artifactId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.artifact_versions
       (id,organization_id,artifact_id,task_id,author_id,revision,content,
        sha256,size_bytes,media_type,retention_class)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'text/markdown','evidence')`,
    [
      versionId,
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      bytes,
      sha256,
      bytes.length,
    ],
  );
  return { sha256, sizeBytes: bytes.length };
}

Deno.test("a declared input slot reaches the harness context index", () =>
  withWorkerFixture(async (fixture) => {
    const versionId = crypto.randomUUID();
    const document = await compiled([noop("first"), withBrief], DECLARED);
    const seeded = await seedPlanRun(fixture, document, {
      inputs: { repo: RUN_REPO, brief: versionId },
    });
    const repo = (await fixture.pgDatabase.query<{ repositoryId: string }>(
      `select repository_id as "repositoryId" from bakery.workflow_runs where id = $1`,
      [seeded.job.runId],
    )).rows[0].repositoryId;
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{inputs,repo}', to_jsonb($2::text))
        where id = $1`,
      [seeded.job.runId, repo],
    );
    const brief = await seedBrief(
      fixture,
      seeded.job.taskId,
      versionId,
      "# The brief",
    );
    await setRow(fixture, seeded, seeded.firstKey, "completed", {});
    const key = await seeded.repository.findNext(
      seeded.job.runId,
      seeded.owner,
    );
    assert(key !== undefined);
    assertEquals(key.stepKey, "gate");
    assertEquals(
      (await seeded.repository.admit(key, seeded.owner)).terminal,
      false,
    );

    const pinRows = (await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_input_pins where run_id = $1`,
      [seeded.job.runId],
    )).rows[0].n;
    assertEquals(pinRows, "1");
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'completed'
        where run_step_id in (select id from bakery.run_steps
                               where run_id = $1 and step_key <> 'gate')`,
      [seeded.job.runId],
    );
    const worker = await registeredWorker(fixture, { name: "context-join" });
    const client = new WorkerApiClient({
      baseUrl: authTestOrigin,
      credential: worker.credential,
      fetcher: async (input, init) =>
        await fixture.app.fetch(new Request(input, init)),
    });
    const host = (await fixture.pgDatabase.query<{
      workerSessionId: string;
      workerSessionGeneration: string;
    }>(
      `select worker_session_id as "workerSessionId",
              worker_session_generation::text as "workerSessionGeneration"
         from bakery.worker_hosts
        where credential_hash = $1`,
      [await sha256Hex(worker.credential)],
    )).rows[0];
    const claim = await client.claim({
      claimKey: crypto.randomUUID(),
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
      workerSessionId: host.workerSessionId,
      workerSessionGeneration: host.workerSessionGeneration,
    });
    assertEquals(claim.value !== null, true);
    const assignment = claim.value as JobAssignment;

    const root = await Deno.makeTempDir();
    const context = await prepareHarnessContext({
      assignment,
      attemptRoot: root,
      goal: "Check the fmt requirement.",
      workDir: "/workspace",
      readAttemptContext: async (attemptId, proof) =>
        (await client.attemptContext(attemptId, proof)).value,
    });
    assert(context.ok, context.ok ? "" : context.detail);
    assertEquals(context.contextDir?.endsWith("/context"), true);
    const index = await Deno.readTextFile(`${context.contextDir}/CONTEXT.md`);
    assert(index.includes("`brief.md`"), index);
    assert(index.includes(brief.sha256), index);
    assert(index.includes(`${brief.sizeBytes} bytes`), index);
    assertEquals(
      await Deno.readTextFile(`${context.contextDir}/brief.md`),
      "# The brief",
    );
    assert(context.promptSection.includes("`brief.md`"), context.promptSection);
  }));
