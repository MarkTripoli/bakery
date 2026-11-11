import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import type { WorkerSkillFileRequest } from "../../apps/worker/src/types.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  adminRequest,
  closeWorkerFixture,
  closeWorkerScope,
  createWorkerScope,
  openWorkerFixture,
  problemCode,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";

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

function workerClient(fixture: WorkerFixture, credential: string) {
  return new WorkerApiClient({
    baseUrl: authTestOrigin,
    credential,
    fetcher: async (input, init) =>
      await fixture.app.fetch(new Request(input, init)),
  });
}

Deno.test("persisted exact pins authorize staged manifest and file reads through the real worker API", async () => {
  const root = await Deno.makeTempDir({
    prefix: "bakery-279-authorized-reads-",
  });
  const realStore = new SkillFileStore(root);
  const fixtureRef: { current?: WorkerFixture } = {};
  let storeReads = 0;
  const openTransactions: number[] = [];
  let afterRead: (() => Promise<void>) | undefined;
  const store = {
    recover: realStore.recover.bind(realStore),
    putIfAbsent: realStore.putIfAbsent.bind(realStore),
    async read(key: string, digest: string, size: number) {
      storeReads += 1;
      if (!fixtureRef.current) throw new Error("WORKER_FIXTURE_MISSING");
      const transactionCount = await fixtureRef.current.pgDatabase.query<{
        count: number;
      }>(
        `select count(*)::int as count
           from pg_stat_activity
          where datname = current_database()
            and usename = 'bakery_app'
            and state like '%transaction%'`,
      );
      openTransactions.push(transactionCount.rows[0].count);
      const bytes = await realStore.read(key, digest, size);
      await afterRead?.();
      return bytes;
    },
  };
  const fixture = await openWorkerFixture({
    skillFileRoot: root,
    skillFileStore: store,
  });
  fixtureRef.current = fixture;
  let foreignScope: Awaited<ReturnType<typeof createWorkerScope>> | undefined;
  try {
    const markdown = new TextEncoder().encode("# Authorized skill\n");
    const script = new TextEncoder().encode("#!/bin/sh\nprintf ready\\n\n");
    const markdownDigest = await sha256(markdown);
    const scriptDigest = await sha256(script);
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: markdown.byteLength,
        sha256: markdownDigest,
        isExecutable: false,
      }, {
        path: "scripts/ready.sh",
        mediaType: "text/x-shellscript",
        sizeBytes: script.byteLength,
        sha256: scriptDigest,
        isExecutable: true,
      }],
    };
    const versionDigest = await sha256Hex(canonicalJson(manifest));
    const createSkill = await adminRequest(
      fixture,
      "/v1/skills",
      { slug: "authorized-worker-read", name: "Authorized worker read" },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(createSkill.status, 201, await createSkill.clone().text());
    const skill = await createSkill.json() as { id: string; sourceId: string };
    const publish = await adminRequest(
      fixture,
      `/v1/skills/${skill.id}/versions`,
      {
        revision: 1,
        digest: versionDigest,
        entryPath: "SKILL.md",
        manifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(String.fromCharCode(...markdown)),
        }, {
          path: "scripts/ready.sh",
          mediaType: "text/x-shellscript",
          isExecutable: true,
          contentBase64: btoa(String.fromCharCode(...script)),
        }],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(publish.status, 201, await publish.clone().text());
    const version = await publish.json() as { id: string; digest: string };
    assertEquals(version.digest, versionDigest);

    const replacementMarkdown = new TextEncoder().encode(
      "# Replacement skill\n",
    );
    const replacementMarkdownDigest = await sha256(replacementMarkdown);
    const replacementManifest = {
      ...manifest,
      files: [{
        ...manifest.files[0],
        sizeBytes: replacementMarkdown.byteLength,
        sha256: replacementMarkdownDigest,
      }, manifest.files[1]],
    };
    const replacementDigest = await sha256Hex(
      canonicalJson(replacementManifest),
    );
    const replacementPublish = await adminRequest(
      fixture,
      `/v1/skills/${skill.id}/versions`,
      {
        revision: 2,
        digest: replacementDigest,
        entryPath: "SKILL.md",
        manifest: replacementManifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(
            String.fromCharCode(...replacementMarkdown),
          ),
        }, {
          path: "scripts/ready.sh",
          mediaType: "text/x-shellscript",
          isExecutable: true,
          contentBase64: btoa(String.fromCharCode(...script)),
        }],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(
      replacementPublish.status,
      201,
      await replacementPublish.clone().text(),
    );
    const replacement = await replacementPublish.json() as {
      id: string;
      digest: string;
    };
    assertEquals(replacement.digest, replacementDigest);
    assertEquals(replacement.id === version.id, false);
    const active = await fixture.pgDatabase.query<{ activeVersionId: string }>(
      `select active_version_id as "activeVersionId"
         from bakery.skills
        where id = $1`,
      [skill.id],
    );
    assertEquals(active.rows[0]?.activeVersionId, replacement.id);
    storeReads = 0;
    openTransactions.length = 0;

    const worker = await registeredWorker(fixture, {
      name: "issue279-authorized-reader",
    });
    // Admission creates the agent version, skill binding, and paired holds
    // before the worker claims this real model assignment.
    const seeded = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { skillRefs: [{ versionId: version.id, digest: versionDigest }] },
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, seeded.jobId);
    assertEquals(assignment.skillRefs, [{
      versionId: version.id,
      digest: versionDigest,
    }]);
    const authority = {
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      workerHostId: worker.registration.workerHostId,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
      versionId: version.id,
      digest: versionDigest,
    };
    const client = workerClient(fixture, worker.credential);
    const manifestResponse = await client.getSkillVersion(authority);
    assertEquals(manifestResponse.value.organizationId, fixture.organizationId);
    assertEquals(manifestResponse.value.version.id, version.id);
    assertEquals(manifestResponse.value.version.digest, versionDigest);
    assertEquals(manifestResponse.value.files, manifest.files);
    assertEquals(storeReads, 0);

    const scriptFile = manifestResponse.value.files[1];
    const fileRequest: WorkerSkillFileRequest = {
      ...authority,
      organizationId: manifestResponse.value.organizationId,
      file: scriptFile,
    };
    const fileResponse = await client.getSkillFile(fileRequest);
    assertEquals(fileResponse.value.content, script);
    assertEquals(fileResponse.value.mediaType, "text/x-shellscript");
    assertEquals(fileResponse.value.isExecutable, true);
    assertEquals(fileResponse.value.path, "scripts/ready.sh");
    assertEquals(storeReads, 1);
    assertEquals(openTransactions, [0]);

    const expectPreStoreDenial = async (
      mutate: () => Promise<void>,
      restore: () => Promise<void>,
      code: string,
    ) => {
      await mutate();
      const before = storeReads;
      const error = await assertRejects(
        () => client.getSkillFile(fileRequest),
        WorkerRequestError,
        code,
      );
      assertEquals(error.code, code);
      assertEquals(storeReads, before);
      await restore();
    };

    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set skill_refs = '[]'::jsonb where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set skill_refs = $2::jsonb where id = $1`,
          [
            seeded.jobId,
            JSON.stringify([{ versionId: version.id, digest: versionDigest }]),
          ],
        ).then(() => undefined),
      "AUTH_FORBIDDEN",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skill_sources set enabled = false where id = $1`,
          [skill.sourceId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skill_sources set enabled = true where id = $1`,
          [skill.sourceId],
        ).then(() => undefined),
      "AUTH_FORBIDDEN",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skills set enabled = false where id = $1`,
          [skill.id],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skills set enabled = true where id = $1`,
          [skill.id],
        ).then(() => undefined),
      "AUTH_FORBIDDEN",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skill_versions set status = 'retired' where id = $1`,
          [version.id],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.skill_versions set status = 'published' where id = $1`,
          [version.id],
        ).then(() => undefined),
      "AUTH_FORBIDDEN",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set cancel_requested_at = clock_timestamp() where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set cancel_requested_at = null where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      "CANCEL_REQUESTED",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set status = 'queued' where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set status = 'leased' where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      "CANCEL_REQUESTED",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.job_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
          [assignment.attemptId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.job_attempts set lease_expires_at = clock_timestamp() + interval '60 seconds' where id = $1`,
          [assignment.attemptId],
        ).then(() => undefined),
      "LEASE_EXPIRED",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set current_fence = current_fence + 1 where id = $1`,
          [seeded.jobId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.jobs set current_fence = $2 where id = $1`,
          [seeded.jobId, assignment.fence],
        ).then(() => undefined),
      "LEASE_FENCED",
    );
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.job_attempts set fence = fence + 1 where id = $1`,
          [assignment.attemptId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.job_attempts set fence = $2 where id = $1`,
          [assignment.attemptId, assignment.fence],
        ).then(() => undefined),
      "LEASE_FENCED",
    );
    const replacementSessionId = crypto.randomUUID();
    await expectPreStoreDenial(
      () =>
        fixture!.pgDatabase.query(
          `update bakery.worker_hosts set worker_session_id = $2 where id = $1`,
          [worker.registration.workerHostId, replacementSessionId],
        ).then(() => undefined),
      () =>
        fixture!.pgDatabase.query(
          `update bakery.worker_hosts set worker_session_id = $2 where id = $1`,
          [
            worker.registration.workerHostId,
            worker.registration.workerSessionId,
          ],
        ).then(() => undefined),
      "LEASE_FENCED",
    );

    foreignScope = await createWorkerScope(
      fixture,
      "issue279-foreign-reader",
      fixture,
    );
    const foreignWorker = await registeredWorker(fixture, {
      name: "issue279-foreign-reader",
      scope: foreignScope,
    });
    const foreignClient = workerClient(fixture, foreignWorker.credential);
    const foreignBefore = storeReads;
    const foreignError = await assertRejects(
      () =>
        foreignClient.getSkillFile({
          ...fileRequest,
          workerHostId: foreignWorker.registration.workerHostId,
          workerSessionId: foreignWorker.registration.workerSessionId,
          workerSessionGeneration: String(
            foreignWorker.registration.workerSessionGeneration,
          ),
        }),
      WorkerRequestError,
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(foreignError.code, "RESOURCE_NOT_FOUND");
    assertEquals(storeReads, foreignBefore);

    afterRead = async () => {
      await fixture!.pgDatabase.query(
        `update bakery.skill_sources set enabled = false where id = $1`,
        [skill.sourceId],
      );
      afterRead = undefined;
    };
    const readsBeforeRevocation = storeReads;
    const midRead = await assertRejects(
      () => client.getSkillFile(fileRequest),
      WorkerRequestError,
      "AUTH_FORBIDDEN",
    );
    assertEquals(midRead.code, "AUTH_FORBIDDEN");
    assertEquals(storeReads, readsBeforeRevocation + 1);
    await fixture.pgDatabase.query(
      `update bakery.skill_sources set enabled = true where id = $1`,
      [skill.sourceId],
    );

    const leaked = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/skill-versions/${version.id}/files/scripts/ready.sh`,
        {
          headers: {
            Authorization: `Bearer ${worker.credential}`,
            "X-Bakery-Worker-Protocol-Version": "2",
            "X-Bakery-Attempt-Id": assignment.attemptId,
            "X-Bakery-Lease-Token": assignment.leaseToken,
            "X-Bakery-Fence": String(BigInt(assignment.fence) + 1n),
            "X-Worker-Session-Id": worker.registration.workerSessionId,
            "X-Worker-Session-Generation": String(
              worker.registration.workerSessionGeneration,
            ),
          },
        },
      ),
    );
    assertEquals(leaked.status, 409);
    assertEquals(leaked.headers.get("cache-control"), "no-store");
    assertEquals(await problemCode(leaked.clone()), "LEASE_FENCED");
    const faultText = await leaked.text();
    assertEquals(faultText.includes(root), false);
    assertEquals(faultText.includes("organizations/"), false);
    assertEquals(faultText.includes("local-bundle://"), false);
    assertStringIncludes(faultText, "LEASE_FENCED");

    const credentialHash = await sha256Hex(worker.credential);
    const host = await fixture.pgDatabase.query<{ organizationId: string }>(
      `select organization_id as "organizationId" from bakery.worker_hosts where credential_hash = $1`,
      [credentialHash],
    );
    assertExists(host.rows[0]);
    assertEquals(host.rows[0].organizationId, fixture.organizationId);
  } finally {
    if (foreignScope) {
      await closeWorkerScope(fixture, foreignScope).catch(() => undefined);
    }
    await closeWorkerFixture(fixture);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
