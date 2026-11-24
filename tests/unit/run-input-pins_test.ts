import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import {
  declaredArtifactVersionIds,
  pinDeclaredRunInputs,
  recordInputPaths,
} from "../../apps/server/src/modules/work/run-input-pins.ts";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";

Deno.test("declared artifact versions are found at any depth and deduplicated", () => {
  const inputs = {
    brief: { artifactVersionId: V1 },
    context: [
      { artifactVersionId: V2 },
      { nested: { deeper: { artifactVersionId: V1 } } },
      { artifactVersionId: V2 },
    ],
  };
  assertEquals(declaredArtifactVersionIds(inputs), [V1, V2]);
});

Deno.test("a version key with a non-string value is not a declaration", () => {
  assertEquals(
    declaredArtifactVersionIds({
      artifactVersionId: 42,
      other: { artifactVersionId: null },
    }),
    [],
  );
});

Deno.test("unrelated keys never read as a declaration", () => {
  assertEquals(
    declaredArtifactVersionIds({
      artifactId: V1,
      artifactVersionID: V2,
      nested: [{ artifact_version_id: V3 }],
    }),
    [],
  );
});

Deno.test("inputs with no declaration pin nothing", () => {
  assertEquals(declaredArtifactVersionIds(undefined), []);
  assertEquals(declaredArtifactVersionIds(null), []);
  assertEquals(declaredArtifactVersionIds("plain string"), []);
  assertEquals(declaredArtifactVersionIds({ description: "no versions" }), []);
});

/**
 * A transaction holding one artifact version in the given publication status,
 * recording whether anything was pinned.
 */
function versionTransaction(status: string) {
  const pins: unknown[][] = [];
  const transaction = {
    query: (text: string, values: unknown[] = []) => {
      if (text.includes("insert into bakery.run_input_pins")) {
        pins.push(values);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes("from bakery.artifact_versions")) {
        return Promise.resolve({
          rows: [{
            id: V1,
            artifact_id: V2,
            sha256: "a".repeat(64),
            size_bytes: 3,
            publication_status: status,
          }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { transaction: transaction as unknown as PgTransactionClient, pins };
}

const issueOf = (error: StandardError) =>
  (error.params as { issues: { code: string; message: string }[] }).issues[0];

for (const status of ["staged", "refused"]) {
  Deno.test(`a ${status} version is refused as a declared run input and pins nothing`, async () => {
    const { transaction, pins } = versionTransaction(status);
    const error = await assertRejects(
      () =>
        pinDeclaredRunInputs(transaction, {
          organizationId: V3,
          runId: V3,
          inputs: { brief: { artifactVersionId: V1 } },
        }),
      StandardError,
    );
    assertEquals(issueOf(error).code, "input_artifact_version_not_current");
    assertEquals(
      issueOf(error).message,
      `artifact version ${V1} is ${status}, not current, so it cannot be a run input`,
    );
    assertEquals(pins.length, 0);
  });

  Deno.test(`a storage path resolving to a ${status} version is refused and pins nothing`, async () => {
    const { transaction, pins } = versionTransaction(status);
    const error = await assertRejects(
      () =>
        recordInputPaths(transaction, {
          organizationId: V3,
          runId: V3,
          resolved: [{
            inputName: "brief",
            storagePath: "/brief.png",
            entryId: V3,
            artifactId: V2,
            versionId: V1,
            sha256: "a".repeat(64),
          }],
        }),
      StandardError,
    );
    assertEquals(issueOf(error).code, "input_artifact_version_not_current");
    assertEquals(pins.length, 0);
  });
}

Deno.test("a current version is pinned as a declared run input", async () => {
  const { transaction, pins } = versionTransaction("current");
  await pinDeclaredRunInputs(transaction, {
    organizationId: V3,
    runId: V3,
    inputs: { brief: { artifactVersionId: V1 } },
  });
  assertEquals(pins.length, 1);
});
