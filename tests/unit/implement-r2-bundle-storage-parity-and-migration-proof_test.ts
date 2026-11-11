import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { skillObjectKey } from "../../apps/server/src/modules/catalog/identity.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import {
  resolveR2Connection,
  SKILL_STORAGE_CONFIG_INVALID,
} from "../../apps/server/src/modules/catalog/skill-storage-config.ts";
import {
  DatabaseSkillObjectStore,
  mapProbeError,
  SkillStorageVerificationOutcome,
} from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { legacyStorageEnvironment } from "../helpers/legacy-storage-environment.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import {
  assertSkillObjectKey,
  SkillFileStoreError,
} from "../../apps/server/src/modules/catalog/storage-port.ts";
import {
  mapSkillS3Error,
  S3SkillObjectStore,
} from "../../apps/server/src/modules/catalog/s3-store.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { skillObjectStoreContract } from "../helpers/skill-object-store-contract.ts";

const stored = {
  accountId: "a".repeat(32),
  bucket: "test-bucket",
  endpointOverride: null,
};
const production = { allowLoopbackEndpoint: false };
const testEnvironment = { allowLoopbackEndpoint: true };

Deno.test("DB-sourced R2 settings pin the account endpoint and confine overrides to test", () => {
  assertEquals(
    resolveR2Connection(stored, production).endpoint,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  );
  // The pinned endpoint may be restated; anything else is refused.
  assertEquals(
    resolveR2Connection({
      ...stored,
      endpointOverride: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    }, production).bucket,
    "test-bucket",
  );
  for (
    const extra of [
      { accountId: "secret" },
      { accountId: "A".repeat(32) },
      { accountId: "a".repeat(31) + "/" },
      { accountId: `${"a".repeat(32)}.evil.example/x` },
      { bucket: "UPPER" },
      { bucket: "a" },
      { bucket: "../escape" },
      { endpointOverride: "http://127.0.0.1:9090" },
      { endpointOverride: "https://evil.example" },
      {
        endpointOverride: `https://${"b".repeat(32)}.r2.cloudflarestorage.com`,
      },
      { endpointOverride: "not a url" },
    ]
  ) {
    assertThrows(
      () => resolveR2Connection({ ...stored, ...extra }, production),
      Error,
      SKILL_STORAGE_CONFIG_INVALID,
    );
  }
  assertEquals(
    resolveR2Connection({
      ...stored,
      endpointOverride: "http://127.0.0.1:9090",
    }, testEnvironment).endpoint,
    "http://127.0.0.1:9090",
  );
  for (
    const endpointOverride of [
      "https://evil.example",
      "http://evil.example:9090",
      "http://user:pass@127.0.0.1:9090",
      "http://127.0.0.1:9090/path",
      "http://127.0.0.1:9090/?q=1",
      "http://169.254.169.254",
    ]
  ) {
    assertThrows(
      () =>
        resolveR2Connection({ ...stored, endpointOverride }, testEnvironment),
      Error,
      SKILL_STORAGE_CONFIG_INVALID,
    );
  }
});

Deno.test("runtime config no longer reads R2 or storage selection variables", () => {
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    ...legacyStorageEnvironment("/nonexistent"),
  }, "worker");
  assertEquals(JSON.stringify(config).includes("r2Storage"), false);
  assertEquals(JSON.stringify(config).includes("test-bucket"), false);
});

Deno.test("probe failures map to fixed outcome codes without provider text", () => {
  const s3 = (name: string, status: number) =>
    new S3ServiceException({
      name,
      $fault: "client",
      $metadata: { httpStatusCode: status },
      message: "credential-canary AKIA endpoint.example",
    });
  const outcomes = {
    credentials_rejected: [
      s3("InvalidAccessKeyId", 403),
      s3("SignatureDoesNotMatch", 403),
      s3("Unauthorized", 401),
    ],
    access_denied: [s3("AccessDenied", 403)],
    bucket_not_found: [s3("NoSuchBucket", 404)],
    provider_error: [s3("InternalError", 500), s3("SlowDown", 503)],
    endpoint_unreachable: [
      new TypeError("fetch failed: getaddrinfo ENOTFOUND canary.example"),
      new DOMException("timed out", "TimeoutError"),
    ],
  } as const;
  for (const [expected, errors] of Object.entries(outcomes)) {
    for (const error of errors) {
      assertEquals(mapProbeError(error), expected);
    }
  }
  assertEquals(
    new Set(Object.values(SkillStorageVerificationOutcome)).size,
    8,
  );
});
Deno.test("S3 failures expose only fixed codes and reject traversal before transport", async () => {
  const error = new S3ServiceException({
    name: "Denied",
    $fault: "client",
    $metadata: { httpStatusCode: 403 },
    message: "credential-canary",
  });
  assertEquals(
    mapSkillS3Error(error).message,
    "SKILL_FILE_DEPENDENCY_UNAVAILABLE",
  );
  assertEquals(mapSkillS3Error(error).cause, undefined);
  const client = new S3Client({
    region: "auto",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  });
  try {
    const store = new S3SkillObjectStore(client, "fixture");
    for (
      const key of [
        "../escape",
        "/root",
        "a\\b",
        "a%2fb",
        "organizations/a/skill-versions/b/sha256/c",
      ]
    ) {
      assertThrows(
        () => assertSkillObjectKey(key),
        SkillFileStoreError,
        "SKILL_FILE_KEY_INVALID",
      );
      await assertRejects(
        () => store.read(key, "0".repeat(64), 0),
        SkillFileStoreError,
        "SKILL_FILE_KEY_INVALID",
      );
    }
  } finally {
    client.destroy();
  }
});
Deno.test("filesystem obeys the shared immutable object contract", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/.bakery-source-scratch`, { mode: 0o700 });
    await Deno.writeTextFile(
      `${root}/.bakery-source-scratch/checkout`,
      "unpublished source checkout",
    );
    await skillObjectStoreContract(
      new SkillFileStore(root),
      (key, bytes) => Deno.writeFile(`${root}/${key}`, bytes),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const existing of ["matching", "different", "missing", "unavailable"] as const
) {
  Deno.test(`S3 conditional conflict verifies ${existing} object before returning`, async () => {
    const bytes = new TextEncoder().encode("conditional bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = skillObjectKey(
      crypto.randomUUID(),
      crypto.randomUUID(),
      digest,
    );
    const requests: string[] = [];
    const client = new S3Client({
      region: "auto",
      endpoint: "http://localhost",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      maxAttempts: 1,
      requestHandler: {
        handle(request: { readonly method: string }) {
          requests.push(request.method);
          if (request.method === "PUT") {
            return Promise.resolve({
              response: {
                statusCode: 409,
                headers: {},
                body: new TextEncoder().encode(
                  "<Error><Code>ConditionalRequestConflict</Code></Error>",
                ),
              },
            });
          }
          const statusCode = existing === "missing"
            ? 404
            : existing === "unavailable"
            ? 503
            : 200;
          return Promise.resolve({
            response: {
              statusCode,
              headers: {},
              body: statusCode === 200
                ? Readable.from([
                  existing === "matching"
                    ? bytes
                    : new TextEncoder().encode("different bytes"),
                ])
                : new TextEncoder().encode(
                  "<Error><Code>NoSuchKey</Code></Error>",
                ),
            },
          });
        },
      },
    });
    try {
      const store = new S3SkillObjectStore(client, "fixture");
      if (existing === "matching") {
        await store.putIfAbsent(key, bytes, digest);
      } else {
        const error = await assertRejects(
          () => store.putIfAbsent(key, bytes, digest),
          SkillFileStoreError,
        );
        assertEquals(
          error.code,
          existing === "different"
            ? "SKILL_OBJECT_DIGEST_CONFLICT"
            : "SKILL_FILE_DEPENDENCY_UNAVAILABLE",
        );
      }
      assertEquals(requests, ["PUT", "GET"]);
    } finally {
      client.destroy();
    }
  });
}

Deno.test("the resolving store rebuilds only on a strictly newer settings version", async () => {
  const roots = new Map<number, string>();
  for (const version of [3, 5, 6]) {
    roots.set(version, await Deno.makeTempDir());
  }
  let readVersion = 0;
  const row = (version: number) => ({
    backend: "filesystem",
    accountId: null,
    bucket: null,
    endpointOverride: null,
    secretId: null,
    credentialRevision: null,
    credentialUpdatedAt: null,
    updatedAt: "2026-01-01T00:00:00.000000Z",
    version,
  });
  // The adapter root follows the version read at rebuild time, so the root a
  // write lands in shows which row the live adapter was built from.
  const store = new DatabaseSkillObjectStore(
    {
      query: () => Promise.resolve({ rows: [row(readVersion)], rowCount: 1 }),
    } as never,
    {
      get filesystemRoot() {
        return roots.get(readVersion);
      },
      allowLoopbackEndpoint: false,
    },
  );
  const put = async (label: string) => {
    const bytes = new TextEncoder().encode(label);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = skillObjectKey(
      crypto.randomUUID(),
      crypto.randomUUID(),
      digest,
    );
    await store.putIfAbsent(key, bytes, digest);
    return key;
  };
  const landed = async (key: string, version: number) => {
    try {
      await Deno.stat(`${roots.get(version)}/${key}`);
      return true;
    } catch {
      return false;
    }
  };
  try {
    readVersion = 5;
    const first = await put("first");
    // A slower concurrent read of an older row must not roll the adapter back.
    readVersion = 3;
    const stale = await put("stale");
    readVersion = 5;
    const again = await put("again");
    assertEquals(await landed(first, 5), true);
    assertEquals(await landed(stale, 5), true);
    assertEquals(await landed(stale, 3), false);
    assertEquals(await landed(again, 5), true);
    // A newer version still rebuilds.
    readVersion = 6;
    const newer = await put("newer");
    assertEquals(await landed(newer, 6), true);
  } finally {
    store.close();
    for (const root of roots.values()) {
      await Deno.remove(root, { recursive: true });
    }
  }
});
