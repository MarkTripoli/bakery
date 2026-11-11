import { assert, assertEquals } from "@std/assert";
import {
  contractSchemas,
  jobAssignmentPayloadSchema,
} from "../../packages/contracts/src/contracts.ts";

const ids = {
  jobId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  workerHostId: "33333333-3333-4333-8333-333333333333",
  agentVersionId: "44444444-4444-4444-8444-444444444444",
  installationReservationId: "55555555-5555-4555-8555-555555555555",
  researchArtifact: "66666666-6666-4666-8666-666666666666",
  repositoryId: "77777777-7777-4777-8777-777777777777",
};

const billing = {
  // Shape-only values; this test does not claim a funded reservation or execution.
  provider: "openai",
  billingAccountId: "shape-only-billing-account",
  model: "gpt-5.6",
  billingRoute: "api" as const,
  maxTokens: 1000,
  maxUsdReservation: 1,
  pricingMetadataSnapshot:
    "shape-only metadata; not an authorization or funding claim",
};

function validAssignment(
  action: "rpi.design" | "quality.check",
): Record<string, unknown> {
  return {
    jobId: ids.jobId,
    attemptId: ids.attemptId,
    workerHostId: ids.workerHostId,
    leaseToken: "lease-token-fixture",
    fence: "1",
    leaseExpiresAt: "2026-10-06T12:00:00.000Z",
    action,
    requirements: {},
    input: action === "rpi.design"
      ? { researchArtifact: ids.researchArtifact }
      : { repositoryId: ids.repositoryId, revision: "base", checks: ["test"] },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: ids.agentVersionId,
    billing,
    installationReservationId: ids.installationReservationId,
    sealedCredentialOperation: null,
  };
}

function validPayload(
  action: "rpi.design" | "quality.check",
): Record<string, unknown> {
  const assignment = validAssignment(action);
  return {
    action: assignment.action,
    requirements: assignment.requirements,
    input: assignment.input,
    currentCheckpoints: assignment.currentCheckpoints,
    agentConfig: assignment.agentConfig,
    skillRefs: assignment.skillRefs,
    agentVersionId: assignment.agentVersionId,
    billing: assignment.billing,
    installationReservationId: assignment.installationReservationId,
  };
}

const assignmentSchema = contractSchemas.JobAssignment;

function issues(result: ReturnType<typeof assignmentSchema.safeParse>) {
  assert(!result.success);
  return result.error.issues;
}

Deno.test("valid full model assignment passes the exported JobAssignment schema", () => {
  assertEquals(
    assignmentSchema.safeParse(validAssignment("rpi.design")).success,
    true,
  );
});

for (
  const field of [
    "agentVersionId",
    "billing",
    "installationReservationId",
  ] as const
) {
  Deno.test(`assignment structurally rejects omitted required nullable ${field}`, () => {
    const candidate: Record<string, unknown> = {
      ...validAssignment("rpi.design"),
    };
    delete candidate[field];
    assertEquals(
      issues(assignmentSchema.safeParse(candidate)).map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      })),
      [{ code: "invalid_union", path: [field], message: "Invalid input" }],
    );
  });

  Deno.test(`model assignment rejects null ${field}`, () => {
    const candidate = { ...validAssignment("rpi.design"), [field]: null };
    assertEquals(issues(assignmentSchema.safeParse(candidate)), [
      {
        code: "custom",
        path: [field],
        message: `${field} is required for model actions`,
      },
    ]);
  });
}

Deno.test("unknown action fails the registered action guard", () => {
  const result = assignmentSchema.safeParse({
    ...validAssignment("quality.check"),
    action: "unregistered.action",
  });
  const actionIssues = issues(result).filter((issue) =>
    issue.path.length === 1 && issue.path[0] === "action"
  );
  assertEquals(actionIssues.length, 1);
  assertEquals(actionIssues[0]?.code, "invalid_value");
});

Deno.test("registered action rejects another action's complete canonical input", () => {
  const result = assignmentSchema.safeParse({
    ...validAssignment("rpi.design"),
    input: validAssignment("quality.check").input,
  });
  assertEquals(issues(result), [
    {
      code: "custom",
      path: ["input"],
      message: "input does not match the registered action schema",
    },
  ]);
});

Deno.test("nonmodel registered action permits null model-only assignment fields", () => {
  const assignment = {
    ...validAssignment("quality.check"),
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
  };
  assertEquals(assignmentSchema.safeParse(assignment).success, true);
});

function payloadIssues(
  result: ReturnType<typeof jobAssignmentPayloadSchema.safeParse>,
) {
  assert(!result.success);
  return result.error.issues;
}

Deno.test("model-shaped stored assignment payload passes schema-only validation", () => {
  assertEquals(
    jobAssignmentPayloadSchema.safeParse(validPayload("rpi.design")).success,
    true,
  );
});

for (
  const field of [
    "agentVersionId",
    "billing",
    "installationReservationId",
  ] as const
) {
  Deno.test(`stored model payload structurally rejects omitted ${field}`, () => {
    const candidate = validPayload("rpi.design");
    delete candidate[field];
    assertEquals(
      payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)).map(
        (issue) => issue.path,
      ),
      [[field]],
    );
  });

  Deno.test(`stored model payload rejects null ${field}`, () => {
    const candidate = { ...validPayload("rpi.design"), [field]: null };
    assertEquals(
      payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)),
      [
        {
          code: "custom",
          path: [field],
          message: `${field} is required for model actions`,
        },
      ],
    );
  });
}

Deno.test("stored payload rejects another registered action's input", () => {
  const candidate = {
    ...validPayload("rpi.design"),
    input: validPayload("quality.check").input,
  };
  assertEquals(payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)), [
    {
      code: "custom",
      path: ["input"],
      message: "input does not match the registered action schema",
    },
  ]);
});

Deno.test("stored nonmodel payload permits null model-only fields", () => {
  const candidate = {
    ...validPayload("quality.check"),
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
  };
  assertEquals(jobAssignmentPayloadSchema.safeParse(candidate).success, true);
});

Deno.test("stored payload rejects an unknown action", () => {
  const candidate = {
    ...validPayload("quality.check"),
    action: "unregistered.action",
  };
  assertEquals(
    payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)).map(
      (issue) => issue.path,
    ),
    [["action"]],
  );
});

Deno.test("stored payload rejects an extraneous field", () => {
  const candidate = { ...validPayload("quality.check"), extraneous: true };
  assert(
    payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)).some(
      (issue) => issue.code === "unrecognized_keys",
    ),
  );
});

for (
  const field of [
    "jobId",
    "attemptId",
    "workerHostId",
    "leaseToken",
    "fence",
    "leaseExpiresAt",
    "workerSessionId",
    "workerSessionGeneration",
    "leaseDurationSeconds",
    "serverTime",
    "sealedCredentialOperation",
  ] as const
) {
  Deno.test(`stored payload rejects runtime field ${field}`, () => {
    const candidate = { ...validPayload("quality.check"), [field]: null };
    assert(
      payloadIssues(jobAssignmentPayloadSchema.safeParse(candidate)).some(
        (issue) => issue.code === "unrecognized_keys",
      ),
    );
  });
}
