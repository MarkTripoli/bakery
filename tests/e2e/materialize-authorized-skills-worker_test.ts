import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";
import {
  SkillCache,
  SkillCacheError,
} from "../../apps/worker/src/skill-cache.ts";
import { SkillMaterializer } from "../../apps/worker/src/skill-materializer.ts";
import type {
  JobAssignment,
  SkillMaterializationRequest,
} from "../../apps/worker/src/types.ts";
import { bindLoopbackPortWithRetry } from "../fixtures/loopback-port-allocation.ts";
import {
  closeWorkerFixture,
  openWorkerFixture,
  registeredWorker,
  seedFundedModelJob,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import { type PostgresStack, upPostgresStack } from "./helpers/stack.ts";

const encoder = new TextEncoder();

async function currentUid(): Promise<number> {
  const output = await new Deno.Command("id", {
    args: ["-u"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const uid = Number.parseInt(new TextDecoder().decode(output.stdout), 10);
  if (!output.success || !Number.isInteger(uid) || uid < 0) {
    throw new Error("ISSUE279_UID_UNAVAILABLE");
  }
  return uid;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function committedTree(stateDir: string): Promise<string> {
  const root = join(stateDir, "skill-materialization-v1");
  const commits = [...Deno.readDirSync(join(root, "commits"))];
  assertEquals(commits.length, 1);
  const record = JSON.parse(
    await Deno.readTextFile(join(root, "commits", commits[0].name)),
  ) as { keyHash: string; stageId: string };
  return join(root, "objects", record.keyHash, record.stageId, "tree");
}

Deno.test("real network worker client enforces cold, warm, post-copy, corruption, and isolation barriers", async () => {
  const databaseEnvironmentNames = [
    "DATABASE_URL",
    "BAKERY_APP_DATABASE_URL",
    "BAKERY_ADMIN_DATABASE_URL",
  ] as const;
  const environment = Deno.env.toObject();
  const previousDatabaseEnvironment = Object.fromEntries(
    databaseEnvironmentNames.map((name) => [name, environment[name]]),
  ) as Record<(typeof databaseEnvironmentNames)[number], string | undefined>;
  let stack: PostgresStack | undefined;
  let skillRoot: string | undefined;
  let stateDir: string | undefined;
  let fixture: Awaited<ReturnType<typeof openWorkerFixture>> | undefined;
  let server: Deno.HttpServer | undefined;
  let testFailed = false;
  let testError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    stack = await upPostgresStack("materialize-authorized-skills-worker");
    Deno.env.set("DATABASE_URL", stack.ownerDatabaseUrl);
    Deno.env.set("BAKERY_APP_DATABASE_URL", stack.appDatabaseUrl);
    Deno.env.delete("BAKERY_ADMIN_DATABASE_URL");
    skillRoot = await Deno.makeTempDir({ prefix: "bakery-279-e2e-store-" });
    stateDir = await Deno.makeTempDir({ prefix: "bakery-279-e2e-cache-" });
    console.log(
      `owned fixture project=${stack.project} skillRoot=${skillRoot} stateDir=${stateDir}`,
    );
    const uid = await currentUid();
    const realStore = new SkillFileStore(skillRoot, uid);
    let objectReads = 0;
    const openedFixture = await openWorkerFixture({
      skillFileStore: {
        recover: realStore.recover.bind(realStore),
        putIfAbsent: realStore.putIfAbsent.bind(realStore),
        read: async (key: string, expectedDigest: string, size: number) => {
          objectReads += 1;
          return await realStore.read(key, expectedDigest, size);
        },
      },
    });
    fixture = openedFixture;
    let serverUrl = "";
    let manifestReads = 0;
    let fileReads = 0;
    let revokeDuringCopy = false;
    let sourceId = "";
    const port = await bindLoopbackPortWithRetry({
      allocated: new Set<number>(),
      bind: async (candidate) => {
        const listening = Promise.withResolvers<void>();
        server = Deno.serve({
          hostname: "127.0.0.1",
          port: candidate,
          onListen() {
            listening.resolve();
          },
        }, async (request) => {
          const incoming = new URL(request.url);
          if (/^\/v1\/skill-versions\/[^/]+$/.test(incoming.pathname)) {
            manifestReads += 1;
          }
          if (incoming.pathname.includes("/files/")) fileReads += 1;
          const target = new URL(
            `${incoming.pathname}${incoming.search}`,
            openedFixture.config.publicBaseUrl,
          );
          return await openedFixture.app.fetch(new Request(target, request));
        });
        await listening.promise;
        serverUrl = `http://127.0.0.1:${candidate}`;
      },
      cleanupOwnedAttempt: async () => {
        await server?.shutdown().catch(() => undefined);
        server = undefined;
      },
    });
    assertEquals(serverUrl, `http://127.0.0.1:${port}`);

    const markdown = encoder.encode("# issue 279 exact skill\n");
    const executable = encoder.encode("#!/bin/sh\nprintf ready\\n\n");
    const markdownDigest = await digest(markdown);
    const executableDigest = await digest(executable);
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
        path: "bin/run.sh",
        mediaType: "text/x-shellscript",
        sizeBytes: executable.byteLength,
        sha256: executableDigest,
        isExecutable: true,
      }],
    };
    const versionDigest = await sha256Hex(canonicalJson(manifest));
    const adminPost = (path: string, body: unknown) =>
      fetch(`${serverUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: openedFixture.adminCookie,
          origin: openedFixture.config.publicBaseUrl,
          "Bakery-Organization-Id": openedFixture.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
    const create = await adminPost("/v1/skills", {
      slug: "issue279-e2e-materialization",
      name: "Issue 279 e2e materialization",
    });
    assertEquals(create.status, 201, await create.clone().text());
    const skill = await create.json() as { id: string; sourceId: string };
    sourceId = skill.sourceId;
    const publish = await adminPost(`/v1/skills/${skill.id}/versions`, {
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
        path: "bin/run.sh",
        mediaType: "text/x-shellscript",
        isExecutable: true,
        contentBase64: btoa(String.fromCharCode(...executable)),
      }],
    });
    assertEquals(publish.status, 201, await publish.clone().text());
    const version = await publish.json() as { id: string; digest: string };
    objectReads = 0;

    const worker = await registeredWorker(openedFixture, {
      name: "issue279-e2e-materializer",
    });
    await seedFundedModelJob(
      openedFixture.pgDatabase,
      openedFixture.organizationId,
      openedFixture.principalId,
      { skillRefs: [{ versionId: version.id, digest: versionDigest }] },
    );
    const assignment = await claimAssignment(openedFixture, worker);
    const request: SkillMaterializationRequest = {
      assignment: assignment as unknown as JobAssignment,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
    };
    const client = new WorkerApiClient({
      baseUrl: serverUrl,
      credential: worker.credential,
      requestTimeoutMs: 5_000,
    });
    const cache = new SkillCache(stateDir, {
      uid,
      hooks: {
        beforeCopyFile: async () => {
          if (!revokeDuringCopy) return;
          revokeDuringCopy = false;
          await openedFixture.pgDatabase.query(
            "update bakery.skill_sources set enabled = false where id = $1",
            [sourceId],
          );
        },
      },
    });
    const materializer = new SkillMaterializer(cache, client);

    const cold = await materializer.prepare(
      request,
      new AbortController().signal,
    );
    assertEquals(objectReads, 2);
    assertEquals(fileReads, 2);
    assertEquals(manifestReads, 3);
    const firstEntry = join(cold.roots[0].rootPath, "SKILL.md");
    await Deno.writeTextFile(firstEntry, "attempt-only mutation\n");
    await cold.release();

    const warm = await materializer.prepare(
      request,
      new AbortController().signal,
    );
    assertEquals(objectReads, 2);
    assertEquals(fileReads, 2);
    assertEquals(manifestReads, 5);
    assertEquals(
      await Deno.readTextFile(join(warm.roots[0].rootPath, "SKILL.md")),
      "# issue 279 exact skill\n",
    );
    await warm.release();

    revokeDuringCopy = true;
    let executorInvocations = 0;
    const denial = await assertRejects(
      async () => {
        const prepared = await materializer.prepare(
          request,
          new AbortController().signal,
        );
        executorInvocations += 1;
        await prepared.release();
      },
      WorkerRequestError,
      "AUTH_FORBIDDEN",
    );
    assertEquals(denial.code, "AUTH_FORBIDDEN");
    assertEquals(executorInvocations, 0);
    assertEquals(objectReads, 2);
    assertEquals(fileReads, 2);
    assertEquals(manifestReads, 7);
    await openedFixture.pgDatabase.query(
      "update bakery.skill_sources set enabled = true where id = $1",
      [sourceId],
    );

    const tree = await committedTree(stateDir);
    const cacheEntry = join(tree, "SKILL.md");
    assertEquals(await Deno.readFile(cacheEntry), markdown);
    await Deno.chmod(cacheEntry, 0o600);
    const corrupted = await Deno.readFile(cacheEntry);
    corrupted[0] ^= 0xff;
    await Deno.writeFile(cacheEntry, corrupted);
    await Deno.chmod(cacheEntry, 0o400);
    const corruption = await assertRejects(
      () =>
        materializer.prepare(
          request,
          new AbortController().signal,
        ),
      SkillCacheError,
    );
    assertEquals(corruption.code, "SKILL_CACHE_CONTENT_INVALID");
    assertEquals(objectReads, 2);
    assertEquals(fileReads, 2);
    assertEquals(manifestReads, 8);
    assert(
      [...Deno.readDirSync(join(cache.rootPath, "commits"))].length === 1,
    );
  } catch (error) {
    testFailed = true;
    testError = error;
  } finally {
    const cleanup = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (server) await cleanup(() => server!.shutdown());
    if (fixture) await cleanup(() => closeWorkerFixture(fixture!));
    if (stateDir) {
      await cleanup(() => Deno.remove(stateDir!, { recursive: true }));
    }
    if (skillRoot) {
      await cleanup(() => Deno.remove(skillRoot!, { recursive: true }));
    }
    for (const name of databaseEnvironmentNames) {
      await cleanup(() => {
        const previous = previousDatabaseEnvironment[name];
        if (previous === undefined) Deno.env.delete(name);
        else Deno.env.set(name, previous);
        return Promise.resolve();
      });
    }
    if (stack) await cleanup(() => stack!.down());
    if (stack && cleanupErrors.length === 0) {
      console.log(`owned fixture cleanup complete project=${stack.project}`);
    }
  }
  if (testFailed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [testError, ...cleanupErrors],
        "MATERIALIZATION_E2E_TEST_AND_CLEANUP_FAILED",
      );
    }
    throw testError;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "MATERIALIZATION_E2E_CLEANUP_FAILED",
    );
  }
});
