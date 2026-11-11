import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { AttemptRow } from "../../packages/persistence/src/types.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../packages/persistence/src/postgres.ts";
import { validateWorkerReferences } from "../../packages/persistence/src/event-journal.ts";
import {
  WORKER_EVENT_PAYLOAD_SCHEMAS,
} from "../../apps/server/src/modules/execution/shared.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { MAX_ARTIFACT_BYTES } from "../../packages/contracts/src/contracts.ts";
import {
  createArtifactReadHandlers,
} from "../../apps/server/src/modules/knowledge/reads.ts";
import { createArtifactResourceRoutes } from "../../apps/server/src/modules/knowledge/resource-routes.ts";
import {
  assertParentVersion,
} from "../../apps/server/src/modules/knowledge/authority.ts";
import {
  isArtifactMediaType,
  readArtifactUpload,
  validateArtifactUpload,
} from "../../apps/server/src/modules/knowledge/bytes.ts";

async function rejectsCode(action: () => Promise<unknown>, code: string) {
  try {
    await action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    assertEquals((error as { code?: string }).code, code);
  }
}

function rejectsParentCode(
  current: string | null,
  supplied: string | null | undefined,
  code: string,
): void {
  try {
    assertParentVersion(current, supplied);
    throw new Error(`expected ${code}`);
  } catch (error) {
    assertEquals((error as { code?: string }).code, code);
  }
}

Deno.test("worker artifact events require complete immutable references", () => {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const sha256 = "a".repeat(64);
  assertThrows(() =>
    WORKER_EVENT_PAYLOAD_SCHEMAS["job.artifact"].parse({
      artifactVersionId: versionId,
      sha256,
    })
  );
  assertThrows(() =>
    WORKER_EVENT_PAYLOAD_SCHEMAS["job.artifact"].parse({
      artifact: { artifactId, versionId },
    })
  );
});

Deno.test("worker artifact journal binds digest to artifact and version", async () => {
  const organizationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const runStepId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const sha256 = "b".repeat(64);
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const transaction = {
    query: (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("from bakery.jobs job")) {
        return {
          rows: [{
            runId: crypto.randomUUID(),
            runStepId,
            taskId,
            jobInput: {},
          }],
        };
      }
      if (text.includes("to_regclass")) {
        return { rows: [{ exists: true }] };
      }
      if (text.includes("select version.id")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PgTransactionClient;
  const attempt: AttemptRow = {
    id: crypto.randomUUID(),
    organizationId,
    jobId: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    workerSessionId: null,
    workerSessionGeneration: "1",
    fence: "1",
    leaseTokenHash: "token-hash",
    leaseExpiresAt: new Date(),
    leaseExpired: false,
    jobCurrentFence: "1",
    status: "running",
    lastEventSeq: "0",
  };
  const legacyError = await assertRejects(() =>
    validateWorkerReferences(
      transaction,
      attempt,
      "job.artifact",
      { artifactVersionId: versionId, sha256 },
    )
  );
  if (
    !legacyError ||
    typeof legacyError !== "object" ||
    !("code" in legacyError)
  ) {
    throw new Error("expected RESOURCE_NOT_FOUND");
  }
  assertEquals(legacyError.code, "RESOURCE_NOT_FOUND");
  assertEquals(queries, []);
  const error = await assertRejects(() =>
    validateWorkerReferences(
      transaction,
      attempt,
      "job.artifact",
      { artifact: { artifactId, versionId, sha256 } },
    )
  );
  if (!error || typeof error !== "object" || !("code" in error)) {
    throw new Error("expected RESOURCE_NOT_FOUND");
  }
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("artifact publication requires a concrete parent CAS proof", () => {
  assertParentVersion(null, undefined);
  rejectsParentCode("version-1", null, "PRECONDITION_REQUIRED");
  rejectsParentCode("version-1", 'W/"version-1"', "PRECONDITION_FAILED");
  rejectsParentCode(null, 'W/"version-1"', "PRECONDITION_FAILED");
  rejectsParentCode("version-1", '"version-0"', "PRECONDITION_FAILED");
  rejectsParentCode(null, "version-1", "PRECONDITION_FAILED");
  rejectsParentCode(null, "*", "PRECONDITION_FAILED");
  rejectsParentCode("version-1", "*", "PRECONDITION_FAILED");
  assertParentVersion("version-1", '"version-1"');
});

Deno.test("artifact publication rejects malformed If-Match values", () => {
  for (
    const supplied of [
      "version-1",
      '"version-1","version-2"',
      '"version-1',
      'abc"def',
    ]
  ) {
    rejectsParentCode(null, supplied, "PRECONDITION_FAILED");
    rejectsParentCode("version-1", supplied, "PRECONDITION_FAILED");
  }
});

Deno.test("multipart intake preserves an explicitly present If-Match", async () => {
  const request = (ifMatch?: string): Request => {
    const headers = new Headers({ "idempotency-key": crypto.randomUUID() });
    if (ifMatch !== undefined) headers.set("if-match", ifMatch);
    const form = new FormData();
    form.set("leaseToken", "token");
    form.set("fence", "1");
    form.set("artifactType", "patch");
    form.set("name", "if-match-boundary");
    form.set("contentType", "application/octet-stream");
    form.set("metadata", "{}");
    form.set("content", new File(["content"], "content.bin"));
    return new Request("http://localhost", {
      method: "POST",
      headers,
      body: form,
    });
  };

  assertEquals((await readArtifactUpload(request())).parentVersionId, null);
  assertEquals((await readArtifactUpload(request(""))).parentVersionId, "");
  assertEquals(
    (await readArtifactUpload(request("   "))).parentVersionId,
    "",
  );
});

Deno.test("artifact media validation rejects unsafe content types", () => {
  const safe = 'text/plain; charset="utf-8"';
  assertEquals(isArtifactMediaType(safe), true);
  assertEquals(
    isArtifactMediaType("application/vnd.bakery+json;version=1"),
    true,
  );
  assertEquals(isArtifactMediaType("text/plain, application/json"), false);
  assertEquals(isArtifactMediaType("text/plain;"), false);
  assertEquals(isArtifactMediaType("text/plain\n"), false);
  const base = {
    idempotencyKey: crypto.randomUUID(),
    leaseToken: "token",
    fence: "1",
    artifactType: "patch",
    name: "safe-media",
    contentType: safe,
    content: new TextEncoder().encode("safe"),
    metadata: {},
  };
  validateArtifactUpload(base);
  for (
    const unsafe of [
      'text/plain; charset="Ā"',
      "text/plain\r\nx-injected: yes",
      'text/plain; charset="\u000b"',
    ]
  ) {
    assertEquals(isArtifactMediaType(unsafe), false);
    assertThrows(() =>
      validateArtifactUpload({ ...base, contentType: unsafe })
    );
  }
});

Deno.test("artifact persistence validation enforces name length", async () => {
  const invalidName = {
    idempotencyKey: crypto.randomUUID(),
    leaseToken: "token",
    fence: "1",
    artifactType: "patch",
    name: "x".repeat(201),
    contentType: "application/octet-stream",
    content: new Uint8Array([1]),
    metadata: {},
  };
  await rejectsCode(
    async () => await Promise.resolve(validateArtifactUpload(invalidName)),
    "UNPROCESSABLE",
  );
});

Deno.test("artifact publication rejects NUL text and JSONB values", async () => {
  const base = {
    idempotencyKey: crypto.randomUUID(),
    leaseToken: "token",
    fence: "1",
    artifactType: "patch",
    name: "jsonb-boundary",
    contentType: "application/octet-stream",
    content: new Uint8Array([1]),
  };

  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        validateArtifactUpload({ ...base, name: "\0", metadata: {} })
      ),
    "UNPROCESSABLE",
  );
  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        validateArtifactUpload({ ...base, stepKey: "\0", metadata: {} })
      ),
    "UNPROCESSABLE",
  );
  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        validateArtifactUpload({ ...base, metadata: { nested: "\0" } })
      ),
    "UNPROCESSABLE",
  );
  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        validateArtifactUpload({ ...base, metadata: { ["\0"]: 1 } })
      ),
    "UNPROCESSABLE",
  );
  validateArtifactUpload({ ...base, metadata: { k: "\\u0000" } });
});

Deno.test(
  "artifact metadata rejects unpaired surrogates but accepts pairs and escapes",
  async () => {
    const base = {
      idempotencyKey: crypto.randomUUID(),
      leaseToken: "token",
      fence: "1",
      artifactType: "patch",
      name: "surrogate-boundary",
      contentType: "application/octet-stream",
      content: new Uint8Array([1]),
    };
    for (
      const source of [
        String.raw`{"\ud83d\ude00":"\ud83d\ude00"}`,
        String.raw`{"\\ud800":"\\ud800"}`,
      ]
    ) {
      validateArtifactUpload({
        ...base,
        metadata: JSON.parse(source),
      });
    }
    for (
      const source of [
        String.raw`{"\ud800":"ok"}`,
        String.raw`{"ok":"\ud800"}`,
        String.raw`{"\udc00":"ok"}`,
        String.raw`{"ok":"\udc00"}`,
      ]
    ) {
      await rejectsCode(
        () =>
          Promise.resolve().then(() =>
            validateArtifactUpload({
              ...base,
              metadata: JSON.parse(source),
            })
          ),
        "UNPROCESSABLE",
      );
    }
  },
);

Deno.test("artifact metadata enforces the published nesting boundary", async () => {
  const base = {
    idempotencyKey: crypto.randomUUID(),
    leaseToken: "token",
    fence: "1",
    artifactType: "patch",
    name: "metadata-depth-boundary",
    contentType: "application/octet-stream",
    content: new Uint8Array([1]),
  };
  let accepted: unknown = 0;
  for (let depth = 0; depth < 64; depth++) {
    accepted = { nested: accepted };
  }
  validateArtifactUpload({ ...base, metadata: accepted });

  let rejected: unknown = 0;
  for (let depth = 0; depth < 65; depth++) {
    rejected = { nested: rejected };
  }
  await rejectsCode(
    () =>
      Promise.resolve().then(() =>
        validateArtifactUpload({ ...base, metadata: rejected })
      ),
    "UNPROCESSABLE",
  );
});

Deno.test("artifact intake rejects overflow before persistence", async () => {
  const form = new FormData();
  form.set("leaseToken", "token");
  form.set("fence", "1");
  form.set("artifactType", "patch");
  form.set("name", "overflow");
  form.set("contentType", "application/octet-stream");
  form.set("metadata", "{}");
  form.set(
    "content",
    new File([new Uint8Array(MAX_ARTIFACT_BYTES + 1)], "overflow.bin"),
  );
  const request = new Request("http://localhost", {
    method: "POST",
    body: form,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  await rejectsCode(() => readArtifactUpload(request), "BODY_TOO_LARGE");
});

Deno.test("artifact intake rejects non-multipart cross-scope-shaped requests", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    body: JSON.stringify({ organizationId: "other-org", content: "secret" }),
    headers: { "content-type": "application/json" },
  });
  await rejectsCode(
    () => readArtifactUpload(request),
    "UNSUPPORTED_MEDIA_TYPE",
  );
});

Deno.test(
  "artifact content route rejects multi-range before returning bytes",
  async () => {
    let queryCount = 0;
    const context = {
      request: new Request("http://localhost", {
        headers: { range: "bytes=0-1,3-4" },
      }),
      params: { id: crypto.randomUUID() },
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      signal: new AbortController().signal,
      authority: {
        organizationId: crypto.randomUUID(),
        subject: { principalId: crypto.randomUUID() },
      },
      transaction: {
        query: () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [{
                id: context.params.id,
                media_type: "application/octet-stream",
                size_bytes: 4,
                sha256: "a".repeat(64),
              }],
            };
          }
          throw new Error("content query should not run");
        },
      },
    } as unknown as ActionContext;
    await assertRejects(
      () => createArtifactReadHandlers("secret").readArtifactContent(context),
    );
    assertEquals(queryCount, 1);

    const app = createArtifactResourceRoutes({
      database: {} as PgDatabase,
      browserSession: async (_context, next) => await next(),
      publicBaseUrl: "http://localhost",
      secret: "secret",
    });
    const response = await app.fetch(
      new Request(
        `http://localhost/v1/artifact-versions/${crypto.randomUUID()}/content`,
        { headers: { range: "bytes=0-1,3-4" } },
      ),
    );
    assertEquals(response.status, 400);
    assertEquals(
      response.headers.get("content-type")?.startsWith(
        "application/problem+json",
      ),
      true,
    );
    const body = await response.json();
    if (
      body === null || typeof body !== "object" || Array.isArray(body) ||
      !("code" in body)
    ) {
      throw new Error("standard problem response missing code");
    }
    assertEquals(body.code, "MALFORMED_REQUEST");
  },
);

Deno.test("artifact reads do not return bytes for an unauthorized version", async () => {
  let queryCount = 0;
  const context = {
    request: new Request("http://localhost"),
    params: { id: crypto.randomUUID() },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    authority: {
      organizationId: crypto.randomUUID(),
      subject: { principalId: crypto.randomUUID() },
    },
    transaction: {
      query: () => {
        queryCount += 1;
        return { rows: [] };
      },
    },
  } as unknown as ActionContext;
  await rejectsCode(
    () => createArtifactReadHandlers("secret").readArtifactContent(context),
    "RESOURCE_NOT_FOUND",
  );
  assertEquals(queryCount, 1);
});
