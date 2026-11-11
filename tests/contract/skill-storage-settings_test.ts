import { assert, assertEquals, assertThrows } from "@std/assert";
import { createNormalizedCommandMetadata } from "../../packages/contracts/src/http.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  SkillStorageImplementedAction,
  skillStorageImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { createSkillStorageActionRegistry } from "../../apps/server/src/modules/catalog/skill-storage-actions.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const expectedActions = [
  "skillStorageSettings.get",
  "skillStorageSettings.put",
  "skillStorageSettings.verify",
];

function registry() {
  return createSkillStorageActionRegistry({} as PgDatabase, {
    allowLoopbackEndpoint: false,
  });
}

Deno.test("skill storage registry implements exactly its catalog actions with catalog parity", () => {
  // Registration runs assertRegisteredActions: method, path, schemas, access
  // and organization context must equal the catalog entry.
  assertEquals(
    registry().list().map(({ name }) => name).sort(),
    expectedActions,
  );
  assertEquals([...skillStorageImplementedActions].sort(), expectedActions);
  assertEquals(
    Object.values(SkillStorageImplementedAction).sort(),
    expectedActions,
  );
});

Deno.test("catalog declares the installation-administrator storage operations", () => {
  const entries = Object.fromEntries(
    catalogActions.filter(({ action }) => expectedActions.includes(action))
      .map((entry) => [entry.action, entry]),
  );
  assertEquals(Object.keys(entries).length, 3);
  const expected = {
    "skillStorageSettings.get": [
      "GET",
      "/v1/installation/skill-storage",
      "installationSetting:read",
      "read",
      "Empty",
      "SkillStorageSettings",
    ],
    "skillStorageSettings.put": [
      "PUT",
      "/v1/installation/skill-storage",
      "installationSetting:manage",
      "Idempotency-Key required; If-Match with the current version once settings exist",
      "SkillStorageSettingsPut",
      "SkillStorageSettings",
    ],
    "skillStorageSettings.verify": [
      "POST",
      "/v1/installation/skill-storage/verification",
      "installationSetting:manage",
      "Idempotency-Key required",
      "Empty",
      "SkillStorageVerification",
    ],
  } as const;
  for (
    const [action, [method, path, permission, idempotency, input, output]]
      of Object.entries(expected)
  ) {
    const entry = entries[action];
    assertEquals(entry.method, method, action);
    assertEquals(entry.path, path, action);
    assertEquals(entry.permission, permission, action);
    assertEquals(entry.idempotency, idempotency, action);
    assertEquals(entry.input, input, action);
    assertEquals(entry.output, output, action);
    assertEquals(entry.access, "Installation administrator", action);
    assertEquals(
      entry.organizationContext,
      "installation_administrator_scope",
      action,
    );
    assertEquals(entry.mcp, null, action);
  }
  for (
    const code of [
      "AUTH_FORBIDDEN",
      "SESSION_REQUIRED",
      "MALFORMED_REQUEST",
      "UNPROCESSABLE",
      "PRECONDITION_REQUIRED",
      "PRECONDITION_FAILED",
      "STATE_CONFLICT",
    ]
  ) {
    assert(
      (entries["skillStorageSettings.put"].errors as string[]).includes(code),
      code,
    );
  }
});

Deno.test("mutations need a browser session and an Idempotency-Key; reads need neither", () => {
  const actions = registry();
  assertEquals(actions.get("skillStorageSettings.get").policy.type, "query");
  for (
    const name of ["skillStorageSettings.put", "skillStorageSettings.verify"]
  ) {
    const action = actions.get(name as (typeof expectedActions)[number]);
    assertEquals(action.policy.sessionOnly, true, name);
    assertEquals(action.policy.access, "Installation administrator", name);
    assertEquals(action.explicitIdempotency, "key", name);
  }
});

Deno.test("put input takes account, bucket and write-only credentials and nothing else", () => {
  const schema = contractSchemas.SkillStorageSettingsPut;
  const full = {
    accountId: "a".repeat(32),
    bucket: "bakery-skills",
    accessKeyId: "AKIAFIXTURE",
    secretAccessKey: "fixture-secret",
  };
  assert(schema.safeParse(full).success);
  const { accessKeyId: _a, secretAccessKey: _s, ...nonSecret } = full;
  assert(schema.safeParse(nonSecret).success, "credentials are optional");
  for (
    const invalid of [
      { ...full, accountId: "a".repeat(31) },
      { ...full, accountId: "a".repeat(33) },
      { ...full, bucket: "ab" },
      { ...full, bucket: "b".repeat(64) },
      { ...full, accessKeyId: "" },
      { ...full, accessKeyId: "k".repeat(257) },
      { ...full, secretAccessKey: "s".repeat(1025) },
      { ...full, endpoint: "https://evil.example" },
      { ...full, endpointOverride: "http://127.0.0.1:9090" },
      { ...full, backend: "r2" },
      { bucket: "bakery-skills" },
    ]
  ) {
    assert(
      !schema.safeParse(invalid).success,
      JSON.stringify(Object.keys(invalid)),
    );
  }
});

Deno.test("put parses If-Match only when sent and still requires an Idempotency-Key", () => {
  const action = registry().get("skillStorageSettings.put");
  const request = (headers: Record<string, string>) =>
    new Request("https://bakery.example.test/v1/installation/skill-storage", {
      method: "PUT",
      headers,
    });
  assertEquals(
    createNormalizedCommandMetadata(
      action,
      request({ "Idempotency-Key": "k" }),
      {},
    ).expectedVersion,
    undefined,
  );
  assertEquals(
    createNormalizedCommandMetadata(
      action,
      request({ "Idempotency-Key": "k", "If-Match": '"v3"' }),
      {},
    ).expectedVersion,
    3,
  );
  assertThrows(() => createNormalizedCommandMetadata(action, request({}), {}));
});

Deno.test("outputs carry configured flags and fixed codes, never credential material", () => {
  const settings = contractSchemas.SkillStorageSettings;
  const base = {
    backend: "filesystem",
    configured: true,
    accountId: "a".repeat(32),
    bucket: "bakery-skills",
    credentialUpdatedAt: "2026-10-28T12:00:00.000Z",
    credentialRevision: 2,
    updatedAt: "2026-10-28T12:00:00.000Z",
    version: 3,
  };
  assert(settings.safeParse(base).success);
  assert(
    settings.safeParse({
      backend: "filesystem",
      configured: false,
      accountId: null,
      bucket: null,
      credentialUpdatedAt: null,
      credentialRevision: null,
      updatedAt: null,
      version: 0,
    }).success,
  );
  for (
    const extra of [
      { accessKeyId: "AKIA" },
      { secretAccessKey: "secret" },
      { secretId: crypto.randomUUID() },
      { ciphertext: "x" },
      { endpoint: "https://x" },
    ]
  ) assert(!settings.safeParse({ ...base, ...extra }).success);
  assert(!settings.safeParse({ ...base, backend: "s3" }).success);
  const verification = contractSchemas.SkillStorageVerification;
  for (
    const outcome of [
      "verified",
      "not_configured",
      "credentials_rejected",
      "access_denied",
      "bucket_not_found",
      "endpoint_unreachable",
      "integrity_failed",
      "provider_error",
    ]
  ) {
    assert(
      verification.safeParse({ outcome, checkedAt: "2026-10-28T12:00:00Z" })
        .success,
      outcome,
    );
  }
  assert(
    !verification.safeParse({
      outcome: "AccessDenied: key AKIA rejected",
      checkedAt: "2026-10-28T12:00:00Z",
    }).success,
  );
  assert(
    !verification.safeParse({
      outcome: "verified",
      checkedAt: "2026-10-28T12:00:00Z",
      message: "provider text",
    }).success,
  );
});

Deno.test("generated JSON schemas describe every storage field", async () => {
  const generated = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  ) as { schemas: Record<string, Record<string, unknown>> };
  const defects: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      ("type" in record || "oneOf" in record || "anyOf" in record ||
        "const" in record) &&
      descriptionDefectKind(record.description, path) !== undefined
    ) defects.push(path);
    for (const [key, child] of Object.entries(record)) {
      if (key === "required" || key === "enum") continue;
      walk(child, `${path}.${key}`);
    }
  };
  for (
    const name of [
      "SkillStorageSettingsPut",
      "SkillStorageSettings",
      "SkillStorageVerification",
    ]
  ) {
    assert(generated.schemas[name], name);
    walk(generated.schemas[name], name);
  }
  assertEquals(defects, []);
});
