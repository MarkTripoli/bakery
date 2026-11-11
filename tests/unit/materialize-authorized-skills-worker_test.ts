import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { createExecutionRoutes } from "../../apps/server/src/modules/execution/routes.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
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
  SkillMaterializationRequest,
} from "../../apps/worker/src/types.ts";
import {
  createFakeSkillFixture,
  type FakeSkillFixture,
} from "../helpers/worker-skill-materialization.ts";

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

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right)
      ).map(([key, child]) => [key, canonical(child)]),
    );
  };
  return JSON.stringify(canonical(value));
}

Deno.test("WorkerApiClient sends exact attempt identity and bounds verified binary skill bytes", async () => {
  const content = new TextEncoder().encode("# worker skill\n");
  const fileDigest = await sha256(content);
  const file = {
    path: "SKILL.md",
    mediaType: "text/markdown",
    sizeBytes: content.byteLength,
    sha256: fileDigest,
    isExecutable: false,
  };
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: [file],
  };
  const digest = await sha256(
    new TextEncoder().encode(canonicalJson(manifest)),
  );
  const request = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    workerHostId: "20000000-0000-4000-8000-000000000002",
    attemptId: "30000000-0000-4000-8000-000000000003",
    workerSessionId: "40000000-0000-4000-8000-000000000004",
    workerSessionGeneration: "7",
    leaseToken: "lease-secret",
    fence: "9",
    versionId: "50000000-0000-8000-8000-000000000005",
    digest,
  };
  let fileBodyPulls = 0;
  const client = new WorkerApiClient({
    baseUrl: "https://worker.test",
    credential: "worker-credential",
    fetcher: (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("authorization"), "Bearer worker-credential");
      assertEquals(
        headers.get("X-Bakery-Attempt-Id"),
        request.attemptId,
      );
      assertEquals(headers.get("X-Bakery-Lease-Token"), request.leaseToken);
      assertEquals(headers.get("X-Bakery-Fence"), request.fence);
      assertEquals(headers.get("X-Worker-Session-Id"), request.workerSessionId);
      if (!url.includes("/files/")) {
        return Promise.resolve(Response.json({
          organizationId: request.organizationId,
          attemptId: request.attemptId,
          workerHostId: request.workerHostId,
          workerSessionId: request.workerSessionId,
          workerSessionGeneration: request.workerSessionGeneration,
          fence: request.fence,
          version: {
            id: request.versionId,
            skillId: "60000000-0000-4000-8000-000000000006",
            revision: 1,
            sourceRevision: "source-1",
            digest: request.digest,
            entryPath: "SKILL.md",
            manifest,
            status: "published",
            createdBy: "70000000-0000-4000-8000-000000000007",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
          files: [file],
        }, {
          headers: {
            "Cache-Control": "no-store",
            "X-Bakery-Worker-Protocol-Version": "2",
          },
        }));
      }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          fileBodyPulls += 1;
          controller.enqueue(content.subarray(0, 3));
          controller.enqueue(content.subarray(3));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": file.mediaType,
            "Content-Length": String(file.sizeBytes),
            "Content-Disposition": "attachment; filename*=UTF-8''SKILL.md",
            "ETag": `"${file.sha256}"`,
            "X-Content-Type-Options": "nosniff",
            "X-Bakery-Worker-Protocol-Version": "2",
            "X-Bakery-Organization-Id": request.organizationId,
            "X-Bakery-Attempt-Id": request.attemptId,
            "X-Bakery-Worker-Host-Id": request.workerHostId,
            "X-Bakery-Worker-Session-Id": request.workerSessionId,
            "X-Bakery-Worker-Session-Generation":
              request.workerSessionGeneration,
            "X-Bakery-Fence": request.fence,
            "X-Bakery-Skill-Version-Id": request.versionId,
            "X-Bakery-Skill-Version-Digest": request.digest,
            "X-Bakery-Skill-File-Path": encodeURIComponent(file.path),
            "X-Bakery-Skill-File-Sha256": file.sha256,
            "X-Bakery-Skill-File-Executable": String(file.isExecutable),
          },
        }),
      );
    },
  });
  const version = await client.getSkillVersion(request);
  assertEquals(version.value.organizationId, request.organizationId);
  const response = await client.getSkillFile({
    ...request,
    organizationId: version.value.organizationId,
    file: version.value.files[0],
  });
  assertEquals(response.value.content, content);
  assertEquals(response.value.sha256, fileDigest);
  assertEquals(fileBodyPulls, 1);
});

Deno.test("WorkerApiClient rejects untrusted identity and oversized streams before accepting bytes", async () => {
  const file = {
    path: "SKILL.md",
    mediaType: "text/markdown",
    sizeBytes: 1,
    sha256: await sha256(new Uint8Array([65])),
    isExecutable: false,
  };
  const base = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    workerHostId: "20000000-0000-4000-8000-000000000002",
    attemptId: "30000000-0000-4000-8000-000000000003",
    workerSessionId: "40000000-0000-4000-8000-000000000004",
    workerSessionGeneration: "1",
    leaseToken: "lease",
    fence: "1",
    versionId: "50000000-0000-8000-8000-000000000005",
    digest: "a".repeat(64),
    file,
  };
  let pulled = false;
  const response = (overrides: Record<string, string>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array([65, 66]));
          controller.close();
        },
      }),
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": file.mediaType,
          "Content-Length": "1",
          "Content-Disposition": "attachment; filename*=UTF-8''SKILL.md",
          "ETag": `"${file.sha256}"`,
          "X-Content-Type-Options": "nosniff",
          "X-Bakery-Worker-Protocol-Version": "2",
          "X-Bakery-Organization-Id": base.organizationId,
          "X-Bakery-Attempt-Id": base.attemptId,
          "X-Bakery-Worker-Host-Id": base.workerHostId,
          "X-Bakery-Worker-Session-Id": base.workerSessionId,
          "X-Bakery-Worker-Session-Generation": base.workerSessionGeneration,
          "X-Bakery-Fence": base.fence,
          "X-Bakery-Skill-Version-Id": base.versionId,
          "X-Bakery-Skill-Version-Digest": base.digest,
          "X-Bakery-Skill-File-Path": encodeURIComponent(file.path),
          "X-Bakery-Skill-File-Sha256": file.sha256,
          "X-Bakery-Skill-File-Executable": "false",
          ...overrides,
        },
      },
    );
  const identityOverrides: Record<string, string>[] = [
    {
      "X-Bakery-Organization-Id": "90000000-0000-4000-8000-000000000009",
    },
    {
      "X-Bakery-Worker-Host-Id": "90000000-0000-4000-8000-000000000009",
    },
  ];
  for (const override of identityOverrides) {
    const identityClient = new WorkerApiClient({
      baseUrl: "https://worker.test",
      credential: "credential",
      fetcher: () => Promise.resolve(response(override)),
    });
    const identityError = await assertRejects(
      () => identityClient.getSkillFile(base),
      WorkerRequestError,
      "WORKER_SKILL_FILE_IDENTITY_INVALID",
    );
    assertEquals(identityError.code, "WORKER_SKILL_FILE_IDENTITY_INVALID");
  }

  const overflowClient = new WorkerApiClient({
    baseUrl: "https://worker.test",
    credential: "credential",
    fetcher: () => Promise.resolve(response({})),
  });
  const overflowError = await assertRejects(
    () => overflowClient.getSkillFile(base),
    WorkerRequestError,
    "WORKER_SKILL_FILE_TOO_LARGE",
  );
  assertEquals(overflowError.code, "WORKER_SKILL_FILE_TOO_LARGE");
  assertEquals(pulled, true);
});

Deno.test("canonical skill routes pass headerless developer reads to the catalog handler", async () => {
  const app = new Hono();
  app.route(
    "/",
    createExecutionRoutes({
      database: null as unknown as PgDatabase,
      browserSession: async (_context, next) => await next(),
      publicBaseUrl: "https://worker.test",
      secret: "test-secret-value",
    }),
  );
  app.get(
    "/v1/skill-versions/:id",
    (context) => context.json({ source: "developer" }),
  );
  const response = await app.request(
    "/v1/skill-versions/50000000-0000-8000-8000-000000000005",
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { source: "developer" });

  const malformedWorker = await app.request(
    "/v1/skill-versions/50000000-0000-8000-8000-000000000005",
    { headers: { "X-Bakery-Worker-Protocol-Version": "2" } },
  );
  assertEquals(malformedWorker.status, 400);
  assertEquals(malformedWorker.headers.get("Cache-Control"), "no-store");
  assertEquals((await malformedWorker.json()).code, "MALFORMED_REQUEST");
});

function successorRequest(
  fixture: FakeSkillFixture,
  overrides: Partial<{
    workerSessionId: string;
    workerSessionGeneration: string;
    fence: string;
  }> = {},
): SkillMaterializationRequest {
  const workerSessionId = overrides.workerSessionId ??
    fixture.request.workerSessionId;
  const workerSessionGeneration = overrides.workerSessionGeneration ??
    fixture.request.workerSessionGeneration;
  const assignment = {
    ...fixture.request.assignment,
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    fence: overrides.fence ?? fixture.request.assignment.fence,
    workerSessionId,
    workerSessionGeneration,
  };
  return {
    assignment,
    workerSessionId,
    workerSessionGeneration,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function countNamed(root: string, name: string): Promise<number> {
  let count = 0;
  const visit = async (path: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) await visit(child);
      else if (
        entry.name === name ||
        (name === "*.json" && entry.name.endsWith(".json"))
      ) count += 1;
    }
  };
  await visit(root);
  return count;
}

async function committedTree(cache: SkillCache): Promise<string> {
  const commits = [...Deno.readDirSync(join(cache.rootPath, "commits"))];
  assertEquals(commits.length, 1);
  const record = JSON.parse(
    await Deno.readTextFile(join(cache.rootPath, "commits", commits[0].name)),
  ) as { stageId: string };
  return join(
    cache.rootPath,
    "objects",
    commits[0].name,
    record.stageId,
    "tree",
  );
}

Deno.test("SkillMaterializer cold and warm paths preserve authority order, zero warm file reads, and private inode copies", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-skill-cache-" });
  try {
    const fixture = await createFakeSkillFixture();
    const cache = new SkillCache(stateDir);
    const materializer = new SkillMaterializer(cache, fixture.client);
    const first = await materializer.prepare(
      fixture.request,
      new AbortController().signal,
    );
    assertEquals(fixture.events, [
      "manifest:1",
      "file:SKILL.md",
      "file:bin/run.sh",
      "manifest:2",
      "manifest:3",
    ]);
    assertEquals(first.roots.length, 1);
    const tree = await committedTree(cache);
    const cacheEntry = join(tree, "SKILL.md");
    const cacheExecutable = join(tree, "bin", "run.sh");
    const firstEntry = join(first.roots[0].rootPath, "SKILL.md");
    const firstExecutable = join(first.roots[0].rootPath, "bin", "run.sh");
    assertEquals((await Deno.lstat(cacheEntry)).mode! & 0o777, 0o400);
    assertEquals((await Deno.lstat(cacheExecutable)).mode! & 0o777, 0o500);
    assertEquals((await Deno.lstat(firstEntry)).mode! & 0o777, 0o600);
    assertEquals((await Deno.lstat(firstExecutable)).mode! & 0o777, 0o700);

    const second = await materializer.prepare(
      successorRequest(fixture),
      new AbortController().signal,
    );
    assertEquals(fixture.counts.files(), 2);
    assertEquals(fixture.events.slice(-2), ["manifest:4", "manifest:5"]);
    const secondEntry = join(second.roots[0].rootPath, "SKILL.md");
    const cacheStat = await Deno.lstat(cacheEntry);
    const firstStat = await Deno.lstat(firstEntry);
    const secondStat = await Deno.lstat(secondEntry);
    assertEquals(cacheStat.nlink, 1);
    assertEquals(firstStat.nlink, 1);
    assertEquals(secondStat.nlink, 1);
    assertEquals(
      new Set([
        `${cacheStat.dev}:${cacheStat.ino}`,
        `${firstStat.dev}:${firstStat.ino}`,
        `${secondStat.dev}:${secondStat.ino}`,
      ]).size,
      3,
    );

    await Deno.writeTextFile(firstEntry, "attempt-one-mutation\n");
    assertEquals(
      await Deno.readTextFile(cacheEntry),
      "# exact worker skill\n",
    );
    assertEquals(
      await Deno.readTextFile(secondEntry),
      "# exact worker skill\n",
    );
    const firstRoot = first.roots[0].rootPath;
    const secondRoot = second.roots[0].rootPath;
    await first.release();
    await first.release();
    await second.release();
    assertEquals(await exists(dirname(firstRoot)), false);
    assertEquals(await exists(dirname(secondRoot)), false);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("SkillMaterializer cancels mid-copy and denies lost final authority without leaking pins or attempt roots", async () => {
  const canceledState = await Deno.makeTempDir({
    prefix: "bakery-skill-cancel-",
  });
  const revokedState = await Deno.makeTempDir({
    prefix: "bakery-skill-revoked-",
  });
  try {
    const canceledFixture = await createFakeSkillFixture();
    const controller = new AbortController();
    const canceledCache = new SkillCache(canceledState, {
      hooks: { beforeCopyFile: () => controller.abort() },
    });
    const canceled = new SkillMaterializer(
      canceledCache,
      canceledFixture.client,
    );
    await assertRejects(
      () => canceled.prepare(canceledFixture.request, controller.signal),
      DOMException,
      "Operation aborted",
    );
    assertEquals(canceledFixture.counts.manifests(), 2);
    assertEquals(canceledFixture.counts.files(), 2);
    assertEquals(
      await countNamed(join(canceledCache.rootPath, "pins"), "*.json"),
      0,
    );
    assertEquals(
      await countNamed(
        join(canceledCache.rootPath, "attempts"),
        "owner.json",
      ),
      0,
    );

    const revokedFixture = await createFakeSkillFixture({
      beforeManifest: (call) => {
        if (call === 3) throw new Error("AUTHORITY_REVOKED_AFTER_COPY");
      },
    });
    const revokedCache = new SkillCache(revokedState);
    const revoked = new SkillMaterializer(revokedCache, revokedFixture.client);
    await assertRejects(
      () =>
        revoked.prepare(
          revokedFixture.request,
          new AbortController().signal,
        ),
      Error,
      "AUTHORITY_REVOKED_AFTER_COPY",
    );
    assertEquals(revokedFixture.events, [
      "manifest:1",
      "file:SKILL.md",
      "file:bin/run.sh",
      "manifest:2",
      "manifest:3",
    ]);
    assertEquals(
      [...Deno.readDirSync(join(revokedCache.rootPath, "commits"))].length,
      1,
    );
    assertEquals(
      await countNamed(join(revokedCache.rootPath, "pins"), "*.json"),
      0,
    );
    assertEquals(
      await countNamed(join(revokedCache.rootPath, "attempts"), "owner.json"),
      0,
    );
  } finally {
    await Deno.remove(canceledState, { recursive: true });
    await Deno.remove(revokedState, { recursive: true });
  }
});

for (
  const corruption of [
    "bytes",
    "extra-inventory",
    "symlink",
    "hardlink",
    "mode",
  ] as const
) {
  Deno.test(`warm cache rejects ${corruption} corruption before any object-file read`, async () => {
    const stateDir = await Deno.makeTempDir({
      prefix: `bakery-skill-${corruption}-`,
    });
    try {
      const fixture = await createFakeSkillFixture();
      const cache = new SkillCache(stateDir);
      const materializer = new SkillMaterializer(cache, fixture.client);
      const first = await materializer.prepare(
        fixture.request,
        new AbortController().signal,
      );
      await first.release();
      const tree = await committedTree(cache);
      const entry = join(tree, "SKILL.md");
      let expectedCode = "SKILL_CACHE_CONTENT_INVALID";
      if (corruption === "bytes") {
        const corrupted = await Deno.readFile(entry);
        corrupted[0] ^= 0xff;
        await Deno.chmod(entry, 0o600);
        await Deno.writeFile(entry, corrupted);
        await Deno.chmod(entry, 0o400);
      } else if (corruption === "extra-inventory") {
        await Deno.writeTextFile(join(tree, "extra.txt"), "extra");
        expectedCode = "SKILL_CACHE_INVENTORY_INVALID";
      } else if (corruption === "symlink") {
        const target = join(stateDir, "symlink-target");
        await Deno.writeTextFile(target, "target");
        await Deno.remove(entry);
        await Deno.symlink(target, entry);
        expectedCode = "SKILL_CACHE_SYMLINK";
      } else if (corruption === "hardlink") {
        await Deno.link(entry, join(stateDir, "outside-hardlink"));
        expectedCode = "SKILL_CACHE_FILE_UNSAFE";
      } else {
        await Deno.chmod(entry, 0o500);
        expectedCode = "SKILL_CACHE_FILE_UNSAFE";
      }
      const error = await assertRejects(
        () =>
          materializer.prepare(
            successorRequest(fixture),
            new AbortController().signal,
          ),
        SkillCacheError,
      );
      assertEquals(error.code, expectedCode);
      assertEquals(fixture.counts.files(), 2);
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  });
}

Deno.test("recovery removes only exact stale owners and preserves active or unknown foreign supervisor state", async () => {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-skill-recover-" });
  try {
    const fixture = await createFakeSkillFixture();
    const cache = new SkillCache(stateDir);
    const materializer = new SkillMaterializer(cache, fixture.client);
    const stale = await materializer.prepare(
      fixture.request,
      new AbortController().signal,
    );
    const foreignRequest = successorRequest(fixture, {
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "2",
      fence: "2",
    });
    const foreign = await materializer.prepare(
      foreignRequest,
      new AbortController().signal,
    );
    await materializer.recover(
      () => Promise.resolve("active"),
      new AbortController().signal,
    );
    await materializer.recover(
      () => Promise.reject(new Error("RECONCILIATION_UNAVAILABLE")),
      new AbortController().signal,
    );
    assertEquals(await exists(dirname(stale.roots[0].rootPath)), true);
    assertEquals(await exists(dirname(foreign.roots[0].rootPath)), true);

    await materializer.recover(
      (owner) =>
        Promise.resolve(
          owner.workerSessionId === stale.owner.workerSessionId &&
            owner.attemptId === stale.owner.attemptId &&
            owner.fence === stale.owner.fence
            ? "stale"
            : "active",
        ),
      new AbortController().signal,
    );
    assertEquals(await exists(dirname(stale.roots[0].rootPath)), false);
    assertEquals(await exists(dirname(foreign.roots[0].rootPath)), true);
    await foreign.release();
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("cancellation boundaries forbid commit publication and durable pin creation", async () => {
  const beforeCommitState = await Deno.makeTempDir({
    prefix: "bakery-skill-before-commit-",
  });
  const beforePinState = await Deno.makeTempDir({
    prefix: "bakery-skill-before-pin-",
  });
  try {
    const beforeCommitController = new AbortController();
    const beforeCommitFixture = await createFakeSkillFixture({
      beforeManifest: (call) => {
        if (call === 2) beforeCommitController.abort();
      },
    });
    const beforeCommitCache = new SkillCache(beforeCommitState);
    await assertRejects(
      () =>
        new SkillMaterializer(beforeCommitCache, beforeCommitFixture.client)
          .prepare(beforeCommitFixture.request, beforeCommitController.signal),
      DOMException,
      "Operation aborted",
    );
    assertEquals(
      [...Deno.readDirSync(join(beforeCommitCache.rootPath, "commits"))]
        .length,
      0,
    );
    assertEquals(
      await countNamed(
        join(beforeCommitCache.rootPath, "objects"),
        "owner.json",
      ),
      0,
    );

    const beforePinController = new AbortController();
    let lockAcquisitions = 0;
    const beforePinFixture = await createFakeSkillFixture();
    const beforePinCache = new SkillCache(beforePinState, {
      hooks: {
        afterLock: () => {
          lockAcquisitions += 1;
          if (lockAcquisitions === 2) beforePinController.abort();
        },
      },
    });
    await assertRejects(
      () =>
        new SkillMaterializer(beforePinCache, beforePinFixture.client).prepare(
          beforePinFixture.request,
          beforePinController.signal,
        ),
      DOMException,
      "Operation aborted",
    );
    assertEquals(
      [...Deno.readDirSync(join(beforePinCache.rootPath, "commits"))].length,
      1,
    );
    assertEquals(
      await countNamed(join(beforePinCache.rootPath, "pins"), "*.json"),
      0,
    );
    assertEquals(
      await countNamed(join(beforePinCache.rootPath, "attempts"), "owner.json"),
      0,
    );
  } finally {
    await Deno.remove(beforeCommitState, { recursive: true });
    await Deno.remove(beforePinState, { recursive: true });
  }
});
