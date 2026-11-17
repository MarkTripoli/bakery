import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

// #527 layer 1: a job assignment carries the input slots its step declared, as
// admission pinned them. The worker materializes exactly these bytes and never
// re-fetches the artifact, so the digest it verifies is the one admission
// pinned. The field is optional, so every assignment that declares no context
// inputs keeps validating exactly as before.

const UUID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);

const assignment = contractSchemas.JobAssignment;

function base(): Record<string, unknown> {
  return {
    jobId: UUID,
    attemptId: "22222222-2222-4222-8222-222222222222",
    workerHostId: "33333333-3333-4333-8333-333333333333",
    leaseToken: "lease",
    fence: "1",
    leaseExpiresAt: "2026-01-01T00:00:00Z",
    action: "task.brief",
    requirements: {},
    input: {
      brief: { title: "t", description: "", taskType: "feature" },
      repositoryId: UUID,
    },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    sealedCredentialOperation: null,
  };
}

function withInputs(inputs: unknown): Record<string, unknown> {
  return { ...base(), contextInputs: inputs };
}

const entry = {
  slot: "brief",
  path: "inputs/brief.md",
  digest: DIGEST,
  sizeBytes: 12,
  mediaType: "text/markdown",
};

Deno.test("an assignment without context inputs still validates", () => {
  const result = assignment.safeParse(base());
  assert(result.success, JSON.stringify(result.error?.issues));
});

Deno.test("a pinned context input validates and keeps its declared values", () => {
  const result = assignment.safeParse(withInputs([entry]));
  assert(result.success, JSON.stringify(result.error?.issues));
  const parsed = result.data as { contextInputs: typeof entry[] };
  assertEquals(parsed.contextInputs[0], entry);
});

Deno.test("an input path that could leave the context directory is refused", () => {
  for (const path of ["../escape", "/etc/passwd", "a/../../b", ""]) {
    const result = assignment.safeParse(withInputs([{ ...entry, path }]));
    assert(!result.success, `path ${JSON.stringify(path)} must be refused`);
  }
});

Deno.test("a digest that is not a SHA-256 is refused", () => {
  for (const digest of ["nothex", "a".repeat(63), "A".repeat(64) + "0"]) {
    const result = assignment.safeParse(withInputs([{ ...entry, digest }]));
    assert(!result.success, `digest ${digest} must be refused`);
  }
});

Deno.test("a slot name that is not an identifier is refused", () => {
  for (const slot of ["Not A Slug", "../x", "", "a".repeat(101)]) {
    const result = assignment.safeParse(withInputs([{ ...entry, slot }]));
    assert(!result.success, `slot ${JSON.stringify(slot)} must be refused`);
  }
});

Deno.test("a negative size is refused", () => {
  const result = assignment.safeParse(
    withInputs([{ ...entry, sizeBytes: -1 }]),
  );
  assert(!result.success);
});

Deno.test("more than 32 context inputs is refused", () => {
  const many = Array.from({ length: 33 }, (_, index) => ({
    ...entry,
    slot: `slot${index}`,
  }));
  assert(!assignment.safeParse(withInputs(many)).success);
  const atLimit = many.slice(0, 32);
  assert(assignment.safeParse(withInputs(atLimit)).success);
});

Deno.test("an unknown field on a context input is refused, not dropped", () => {
  const result = assignment.safeParse(
    withInputs([{ ...entry, artifactId: UUID }]),
  );
  assert(!result.success);
});
