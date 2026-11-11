import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertCompilerPinTogether,
  compilerPinOf,
} from "../../apps/server/src/modules/workflows/validation.ts";
import {
  insertWorkflowVersion,
  type WorkflowVersionInsert,
} from "../../apps/server/src/modules/workflows/postgres.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

// The pin columns on workflow_versions are set together or not at all. A CHECK
// would enforce that in the database, but the PostgreSQL responsibility
// boundary rail forbids CHECK constraints, so the write path enforces it.

const VERSION = "1";
const DIGEST = "a".repeat(64);

function refusal(
  compilerVersion: string | null,
  semanticDigest: string | null,
) {
  return assertThrows(
    () => assertCompilerPinTogether(compilerVersion, semanticDigest),
    StandardError,
  );
}

Deno.test("a pin with both columns set is accepted", () => {
  assertCompilerPinTogether(VERSION, DIGEST);
});

Deno.test("an unpinned version with both columns null is accepted", () => {
  assertCompilerPinTogether(null, null);
});

Deno.test("only the compiler version set is a typed internal refusal", () => {
  assertEquals(refusal(VERSION, null).code, "INTERNAL");
});

Deno.test("only the semantic digest set is a typed internal refusal", () => {
  assertEquals(refusal(null, DIGEST).code, "INTERNAL");
});

Deno.test("the refusal never carries the values it rejected", () => {
  const secret = "SECRET-DIGEST-VALUE-0123456789";
  for (const error of [refusal(VERSION, null), refusal(null, secret)]) {
    assertEquals(error.params, undefined);
    assert(!error.message.includes(secret), error.message);
    assert(!JSON.stringify(error).includes(secret));
  }
});

Deno.test("an empty string is a value, not null, so a half pin cannot hide behind it", () => {
  assertEquals(refusal("", null).code, "INTERNAL");
  assertEquals(refusal(null, "").code, "INTERNAL");
  assertCompilerPinTogether("", "");
});

Deno.test("every pin the compiler produces passes the guard", () => {
  const pin = compilerPinOf({
    compilerVersion: VERSION,
    semanticDigest: DIGEST,
  });
  assert(pin !== null);
  assertCompilerPinTogether(pin.compilerVersion, pin.semanticDigest);
  const none = compilerPinOf({
    compilerVersion: VERSION,
    semanticDigest: null,
  });
  assertEquals(none, null);
  assertCompilerPinTogether(
    none?.compilerVersion ?? null,
    none?.semanticDigest ?? null,
  );
});

// --- written through the repository: what reaches the database

type Recorded = { text: string; params: readonly unknown[] };

function recordingTransaction(): {
  transaction: PgTransactionClient;
  seen: Recorded[];
} {
  const seen: Recorded[] = [];
  const transaction = {
    query: (text: string, params: readonly unknown[] = []) => {
      seen.push({ text, params });
      return Promise.resolve({ rows: [{ id: "row" }], rowCount: 1 });
    },
  } as unknown as PgTransactionClient;
  return { transaction, seen };
}

const ROW: WorkflowVersionInsert = {
  id: "00000000-0000-4000-8000-0000000000a1",
  organizationId: "00000000-0000-4000-8000-0000000000b1",
  workflowId: "00000000-0000-4000-8000-0000000000c1",
  revision: 1,
  sourceYaml: "",
  normalizedSpec: "{}",
  digest: "d".repeat(64),
  createdBy: "00000000-0000-4000-8000-0000000000d1",
  compilerVersion: null,
  semanticDigest: null,
};

for (
  const [name, half] of [
    ["only compiler_version set", {
      compilerVersion: VERSION,
      semanticDigest: null,
    }],
    ["only semantic_digest set", {
      compilerVersion: null,
      semanticDigest: DIGEST,
    }],
  ] as const
) {
  Deno.test(`a version with ${name} is refused with a typed error and no statement reaches the database`, async () => {
    const { transaction, seen } = recordingTransaction();
    const error = await assertRejects(
      () => insertWorkflowVersion(transaction, { ...ROW, ...half }),
      StandardError,
    );
    assertEquals(error.code, "INTERNAL");
    assertEquals(seen, [], "no insert may be issued, so no row can be stored");
  });
}

Deno.test("a fully pinned version is written once with both pin values bound", async () => {
  const { transaction, seen } = recordingTransaction();
  await insertWorkflowVersion(transaction, {
    ...ROW,
    compilerVersion: VERSION,
    semanticDigest: DIGEST,
  });
  assertEquals(seen.length, 1);
  assert(seen[0].text.includes("insert into bakery.workflow_versions"));
  assertEquals(seen[0].params.slice(-2), [VERSION, DIGEST]);
});

Deno.test("an unpinned version is written once with both pin values null", async () => {
  const { transaction, seen } = recordingTransaction();
  await insertWorkflowVersion(transaction, ROW);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].params.slice(-2), [null, null]);
});

Deno.test("the other nine bound columns are passed through unchanged", async () => {
  const { transaction, seen } = recordingTransaction();
  await insertWorkflowVersion(transaction, ROW);
  assertEquals(seen[0].params.slice(0, 8), [
    ROW.id,
    ROW.organizationId,
    ROW.workflowId,
    ROW.revision,
    ROW.sourceYaml,
    ROW.normalizedSpec,
    ROW.digest,
    ROW.createdBy,
  ]);
});
