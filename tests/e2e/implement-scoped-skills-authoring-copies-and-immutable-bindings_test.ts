/**
 * #42 [B13.04] e2e on an owned Postgres stack: a workflow version and a job
 * pinned to skill version v1 keep resolving v1's digest through the real
 * worker API after the skill's draft is edited and v2 is published. Moving to
 * v2 is explicit (chapter 23: "Publish a version, then explicitly link or
 * upgrade a workflow step. Existing references retain the old version."): a new
 * workflow version that names v2, which leaves the old one on v1.
 */
import { assert, assertEquals } from "@std/assert";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  adminRequest,
  closeWorkerFixture,
  openWorkerFixture,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import { type PostgresStack, upPostgresStack } from "./helpers/stack.ts";

const encoder = new TextEncoder();
const b64 = (text: string) =>
  btoa(String.fromCharCode(...encoder.encode(text)));

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function upload(text: string) {
  const bytes = encoder.encode(text);
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
      isExecutable: false,
    }],
  };
  return {
    revision: 1,
    digest: await sha256(encoder.encode(canonicalJson(manifest))),
    entryPath: "SKILL.md",
    manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      isExecutable: false,
      contentBase64: b64(text),
    }],
  };
}

async function ok<T>(response: Response, status: number): Promise<T> {
  assertEquals(response.status, status, await response.clone().text());
  return await response.json() as T;
}

const ifMatch = (version: number) => ({ "If-Match": `"${version}"` });

async function publishWorkflowVersion(
  fixture: WorkerFixture,
  workflowId: string,
  skillVersionId: string,
  label: string,
): Promise<string> {
  const path = `/v1/workflows/${workflowId}/versions`;
  const draft = await ok<{ id: string; version: number }>(
    await adminRequest(fixture, path, {
      definition: {
        kind: "fixed",
        steps: [{
          id: "first",
          uses: "workflow.noop",
          action: "agent.run",
          skills: [skillVersionId],
        }],
      },
    }, { idempotencyKey: `draft-${label}` }),
    201,
  );
  const published = await ok<{ id: string }>(
    await adminRequest(fixture, `${path}/${draft.id}/publish`, {}, {
      idempotencyKey: `publish-${label}`,
      headers: ifMatch(draft.version),
    }),
    200,
  );
  return published.id;
}

async function pinnedSkills(
  fixture: WorkerFixture,
  versionId: string,
): Promise<unknown> {
  const result = await fixture.pgDatabase.query<{ skills: unknown }>(
    `select normalized_spec #> '{steps,0,skills}' as skills
       from bakery.workflow_versions where id = $1`,
    [versionId],
  );
  return result.rows[0]?.skills;
}

Deno.test("a workflow version and a job pinned to v1 keep v1 after v2 is published; only a new workflow version moves to v2", async () => {
  const names = [
    "DATABASE_URL",
    "BAKERY_APP_DATABASE_URL",
    "BAKERY_ADMIN_DATABASE_URL",
  ] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, Deno.env.get(name)]),
  );
  let stack: PostgresStack | undefined;
  let fixture: WorkerFixture | undefined;
  let root: string | undefined;
  let failed = false;
  try {
    stack = await upPostgresStack("scoped-skills-immutable-bindings");
    Deno.env.set("DATABASE_URL", stack.ownerDatabaseUrl);
    Deno.env.set("BAKERY_APP_DATABASE_URL", stack.appDatabaseUrl);
    Deno.env.delete("BAKERY_ADMIN_DATABASE_URL");
    root = await Deno.makeTempDir({ prefix: "bakery-42-e2e-store-" });
    const uid = Number.parseInt(
      new TextDecoder().decode(
        (await new Deno.Command("id", { args: ["-u"], stdout: "piped" })
          .output())
          .stdout,
      ),
      10,
    );
    const store = new SkillFileStore(root, uid);
    fixture = await openWorkerFixture({
      skillFileStore: {
        recover: store.recover.bind(store),
        putIfAbsent: store.putIfAbsent.bind(store),
        read: store.read.bind(store),
        stat: store.stat.bind(store),
      },
    });

    // v1, published from an upload.
    const skill = await ok<{ id: string }>(
      await adminRequest(fixture, "/v1/skills", {
        slug: "pinned-research",
        name: "Pinned research",
      }, { idempotencyKey: "e2e-skill" }),
      201,
    );
    const v1 = await ok<{ id: string; digest: string }>(
      await adminRequest(
        fixture,
        `/v1/skills/${skill.id}/versions`,
        await upload("# Pinned research\n\nVersion one.\n"),
        { idempotencyKey: "e2e-v1" },
      ),
      201,
    );

    // A workflow version bound to v1, and a job pinned to v1.
    const workflow = await ok<{ id: string }>(
      await adminRequest(fixture, "/v1/workflows", {
        slug: "pinned-flow",
        name: "Pinned flow",
        description: "Uses the pinned skill.",
      }, { idempotencyKey: "e2e-workflow" }),
      201,
    );
    const first = await publishWorkflowVersion(
      fixture,
      workflow.id,
      v1.id,
      "v1",
    );
    assertEquals(await pinnedSkills(fixture, first), [v1.id]);
    const worker = await registeredWorker(fixture, { name: "issue42-pinned" });
    const seeded = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { skillRefs: [{ versionId: v1.id, digest: v1.digest }] },
    );

    // The draft is edited and published as v2.
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const draft = await ok<{ version: number }>(
      await adminRequest(fixture, draftPath, undefined, {
        idempotencyKey: "e2e-open",
      }),
      200,
    );
    const saved = await ok<{ version: number }>(
      await adminRequest(fixture, `${draftPath}/files`, {
        path: "SKILL.md",
        mediaType: "text/markdown",
        contentBase64: b64("# Pinned research\n\nVersion two.\n"),
      }, { idempotencyKey: "e2e-save", headers: ifMatch(draft.version) }),
      200,
    );
    const v2 = await ok<{ id: string; digest: string; revision: number }>(
      await adminRequest(fixture, `${draftPath}/publish`, undefined, {
        idempotencyKey: "e2e-publish",
        headers: ifMatch(saved.version),
      }),
      201,
    );
    assertEquals(v2.revision, 2);
    assert(v2.digest !== v1.digest);

    // The workflow version still names v1, and v1 is exactly as published.
    assertEquals(await pinnedSkills(fixture, first), [v1.id]);
    const stored = await fixture.pgDatabase.query<{ digest: string }>(
      "select digest from bakery.skill_versions where id = $1",
      [v1.id],
    );
    assertEquals(stored.rows[0].digest, v1.digest);

    // The job pinned to v1 reads v1's digest and bytes through the worker API.
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, seeded.jobId);
    assertEquals(assignment.skillRefs, [{
      versionId: v1.id,
      digest: v1.digest,
    }]);
    const client = new WorkerApiClient({
      baseUrl: authTestOrigin,
      credential: worker.credential,
      fetcher: async (input, init) =>
        await fixture!.app.fetch(new Request(input, init)),
    });
    const read = await client.getSkillVersion({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      workerHostId: worker.registration.workerHostId,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
      versionId: v1.id,
      digest: v1.digest,
    });
    assertEquals(read.value.version.id, v1.id);
    assertEquals(read.value.version.digest, v1.digest);

    // The explicit upgrade: a new workflow version names v2; the old keeps v1.
    const second = await publishWorkflowVersion(
      fixture,
      workflow.id,
      v2.id,
      "v2",
    );
    assertEquals(await pinnedSkills(fixture, second), [v2.id]);
    assertEquals(await pinnedSkills(fixture, first), [v1.id]);
    const usage = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}/used-by`, {
        headers: {
          cookie: fixture.adminCookie,
          "Bakery-Organization-Id": fixture.organizationId,
        },
      }),
    );
    const page = await ok<
      {
        items: {
          kind: string;
          versionId: string;
          skillVersionIds: string[];
        }[];
      }
    >(usage, 200);
    assertEquals(
      // The seeded job's agent version binds v1 too; the workflow rows are these.
      page.items.filter((row) => row.kind === "workflow")
        .map((row) => [row.versionId, row.skillVersionIds]),
      [[second, [v2.id]], [first, [v1.id]]],
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fixture) await closeWorkerFixture(fixture, { failed });
    if (root) await Deno.remove(root, { recursive: true });
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    if (stack) await stack.down();
  }
});
