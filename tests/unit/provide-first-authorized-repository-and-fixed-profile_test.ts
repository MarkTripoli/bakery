import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { resolveExecutableBinding } from "../../apps/server/src/modules/projects/binding.ts";
import { assertNextRevision } from "../../apps/server/src/modules/projects/postgres.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000003";
const PROFILE_ID = "00000000-0000-4000-8000-000000000004";

function bindingTransaction(rows: unknown[]): {
  transaction: PgTransactionClient;
} {
  const transaction = {
    query: () => Promise.resolve({ rows, rowCount: rows.length }),
  } as unknown as PgTransactionClient;
  return { transaction };
}

Deno.test("resolveExecutableBinding gives RESOURCE_NOT_FOUND when no repository row is visible", async () => {
  const { transaction } = bindingTransaction([]);
  const error = await assertRejects(
    () =>
      resolveExecutableBinding(
        transaction,
        ORGANIZATION_ID,
        APPLICATION_ID,
        REPOSITORY_ID,
      ),
    StandardError,
  );
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("resolveExecutableBinding gives STATE_CONFLICT when the repository is archived", async () => {
  const { transaction } = bindingTransaction([
    {
      archived_at: new Date("2026-09-12T00:00:00.000Z"),
      profile_id: PROFILE_ID,
      profile_revision: 1,
      profile_digest: "a".repeat(64),
    },
  ]);
  const error = await assertRejects(
    () =>
      resolveExecutableBinding(
        transaction,
        ORGANIZATION_ID,
        APPLICATION_ID,
        REPOSITORY_ID,
      ),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(error.params, { reason: "repository_archived" });
});

Deno.test("resolveExecutableBinding gives STATE_CONFLICT when the repository has no active profile", async () => {
  const { transaction } = bindingTransaction([
    {
      archived_at: null,
      profile_id: null,
      profile_revision: null,
      profile_digest: null,
    },
  ]);
  const error = await assertRejects(
    () =>
      resolveExecutableBinding(
        transaction,
        ORGANIZATION_ID,
        APPLICATION_ID,
        REPOSITORY_ID,
      ),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(error.params, { reason: "no_active_profile" });
});

Deno.test("resolveExecutableBinding returns the pinned profile identity, revision and digest", async () => {
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  const digest = await sha256Hex(canonicalJson(config));
  const { transaction } = bindingTransaction([
    {
      archived_at: null,
      profile_id: PROFILE_ID,
      profile_revision: 3,
      profile_digest: digest,
      profile_config: config,
      default_branch: "main",
    },
  ]);
  const binding = await resolveExecutableBinding(
    transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    REPOSITORY_ID,
  );
  assertEquals(binding, {
    repositoryProfileId: PROFILE_ID,
    repositoryProfileRevision: 3,
    repositoryProfileDigest: digest,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  });
});

Deno.test("profileDigest (sha256Hex of canonicalJson) is stable across key order", async () => {
  const configA = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  const configB = {
    worktree: { root: ".bakery/worktrees" },
    branches: { allowedPatterns: ["feature/*"], base: "main" },
    workflow: { kind: "fixed" },
    schemaVersion: 1,
  };
  const digestA = await sha256Hex(canonicalJson(configA));
  const digestB = await sha256Hex(canonicalJson(configB));
  assertEquals(digestA, digestB);
  assert(/^[a-f0-9]{64}$/.test(digestA));
});

Deno.test("assertNextRevision accepts exactly the next revision and rejects any other", () => {
  assertNextRevision(0, 1);
  assertNextRevision(1, 2);
  for (const requested of [1, 3]) {
    const error = assertThrows(
      () => assertNextRevision(1, requested),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params, {
      reason: "revision_not_next",
      expectedRevision: 2,
    });
  }
});
