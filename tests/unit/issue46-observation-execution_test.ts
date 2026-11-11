import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  admitRepositoryExecutionJob,
  admitRepositoryProfile,
  executionJobInputFitsTransport,
  repositoryExecutionRequirements,
} from "../../packages/persistence/src/repository-admission.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import {
  RepositoryInspectionJobInputSchema,
  RepositoryInspectionReportSchema,
  RepositoryProfileObservationPayloadSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = {
  organizationId: id(1),
  applicationId: id(2),
  repositoryId: id(3),
};
const hash = (value: unknown) => sha256Hex(canonicalJson(value));
const baseline = {
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

// Manufactured saved publication/report rows exercise the transaction boundary,
// not native inspection proof. Integration coverage uses the publication API.
async function publication() {
  const config = {
    ...baseline,
    schemaVersion: 2 as const,
    checkPolicy: {
      schemaVersion: 1 as const,
      platform: "linux" as const,
      tools: [{ tool: "git" as const, required: true }, {
        tool: "node" as const,
        required: true,
      }, { tool: "deno" as const, required: false }],
      checks: [
        {
          id: "source.integrity",
          template: "source.integrity.v1" as const,
          tool: null,
          required: true,
          paths: [],
        },
        ...(["git", "node", "deno"] as const).map((tool) => ({
          id: `tool.${tool}`,
          template: "tool.version.v1" as const,
          tool,
          required: tool !== "deno",
          paths: [],
        })),
      ],
    },
  };
  const profile = {
    id: id(4),
    revision: 2,
    config,
    digest: await hash(config),
  };
  const input = RepositoryInspectionJobInputSchema.parse({
    ...scope,
    inspectionId: id(5),
    jobId: id(6),
    profile,
    baseline: {
      profileId: id(7),
      revision: 1,
      digest: await hash(baseline),
      repositoryVersion: 2,
      defaultBranch: "main",
    },
    source: {
      mappingRevision: "transaction-fixture-1",
      mappingDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      manifestDigest: "c".repeat(64),
      envelopeDigest: "d".repeat(64),
      envelopeBytes: 100,
      decodedBytes: 1,
      entryCount: 1,
    },
  });
  const startedAt = "2026-09-01T00:00:00.000Z";
  const completedAt = "2026-09-01T00:00:00.100Z";
  const receipt = {
    ...scope,
    inspectionId: input.inspectionId,
    jobId: input.jobId,
    inputDigest: await hash(input),
    source: input.source,
    attemptId: id(8),
    fence: "1",
    workerHostId: id(9),
    workerSessionId: id(10),
    workerSessionGeneration: "1",
    expiresAt: "2026-09-01T00:01:00.000Z",
  };
  const host = {
    workerHostId: receipt.workerHostId,
    os: "linux",
    architecture: "x64",
    tools: config.checkPolicy.tools.map(({ tool }) =>
      tool === "deno"
        ? { tool, status: "missing", version: null, outputDigest: null }
        : {
          tool,
          status: "available",
          version: `${tool} transaction fixture`,
          outputDigest: "e".repeat(64),
        }
    ),
  };
  const checks = config.checkPolicy.checks.map((check) => ({
    id: check.id,
    template: check.template,
    required: check.required,
    durationMs: 0,
    ...(check.tool === null
      ? {
        status: "passed",
        reason: "verified",
        exitCode: null,
        outputDigest: input.source.manifestDigest,
      }
      : check.tool === "deno"
      ? {
        status: "missing",
        reason: "tool_missing",
        exitCode: null,
        outputDigest: null,
      }
      : {
        status: "passed",
        reason: "verified",
        exitCode: 0,
        outputDigest: "e".repeat(64),
      }),
  }));
  const report = RepositoryInspectionReportSchema.parse({
    input,
    receipt,
    host,
    checks,
    startedAt,
    completedAt,
  });
  const payload = RepositoryProfileObservationPayloadSchema.parse({
    schemaVersion: 1,
    ...scope,
    inspectionId: input.inspectionId,
    jobId: input.jobId,
    profileId: profile.id,
    profileRevision: profile.revision,
    profileDigest: profile.digest,
    source: input.source,
    receipt,
    host,
    checks,
    readiness: "eligible",
    observedAt: completedAt,
  });
  const row = {
    id: id(11),
    observation_digest: await hash(payload),
    base_sha: input.source.baseSha,
    source_mapping_revision: input.source.mappingRevision,
    source_mapping_digest: input.source.mappingDigest,
    readiness: "eligible",
    observed_at: completedAt,
    payload,
    input,
    input_digest: receipt.inputDigest,
    job_input: input,
    attempt_id: receipt.attemptId,
    fence: receipt.fence,
    worker_host_id: receipt.workerHostId,
    worker_session_id: receipt.workerSessionId,
    worker_session_generation: receipt.workerSessionGeneration,
    attempt_created_at: startedAt,
    attempt_result: report,
  };
  const transaction = (rows: unknown[]) =>
    ({
      query: () => Promise.resolve({ rows, rowCount: rows.length }),
    }) as unknown as PgTransactionClient;
  const pins = {
    repositoryProfileId: profile.id,
    repositoryProfileRevision: profile.revision,
    repositoryProfileDigest: profile.digest,
    observationId: row.id,
    observationDigest: row.observation_digest,
    baseSha: row.base_sha,
  };
  return { profile, row, transaction, pins };
}

Deno.test("immutable observed admission survives receipt expiry and ignores optional missing tools", async () => {
  const fixture = await publication();
  const admitted = await admitRepositoryProfile(
    fixture.transaction([fixture.row]),
    scope,
    fixture.profile,
    fixture.pins,
  );
  assertEquals(admitted.observationId, fixture.row.id);
  assertEquals(admitted.observationDigest, fixture.row.observation_digest);
  assertEquals(admitted.baseSha, fixture.row.base_sha);
  assertEquals(repositoryExecutionRequirements(admitted, "quality.check"), {
    capabilities: ["git", "shell", "browser", "node"],
    platform: "linux",
  });
});

Deno.test("strict-v1 admits only a null observation triple and retains action capabilities", async () => {
  const fixture = await publication();
  const profile = {
    id: id(7),
    revision: 1,
    config: baseline,
    digest: await hash(baseline),
  };
  const admitted = await admitRepositoryProfile(
    fixture.transaction([]),
    scope,
    profile,
  );
  assertEquals(repositoryExecutionRequirements(admitted, "quality.check"), {
    capabilities: ["git", "shell", "browser"],
  });
  assertEquals([
    admitted.observationId,
    admitted.observationDigest,
    admitted.baseSha,
  ], [null, null, null]);
  await assertRejects(
    () =>
      admitRepositoryProfile(fixture.transaction([]), scope, profile, {
        ...fixture.pins,
        repositoryProfileId: profile.id,
        repositoryProfileRevision: 1,
        repositoryProfileDigest: profile.digest,
      }),
    StandardError,
  );
});

Deno.test("absent, corrupt, foreign and incoherently eligible observed evidence fail closed", async () => {
  for (
    const defect of [
      "absent",
      "digest",
      "foreign",
      "source",
      "profile",
      "blocked",
      "checks",
      "missing-tool",
      "receipt",
      "saved-result",
    ] as const
  ) {
    const fixture = await publication();
    const row = structuredClone(fixture.row);
    if (defect === "digest") row.observation_digest = "0".repeat(64);
    if (defect === "foreign") row.payload.organizationId = id(12);
    if (defect === "source") row.payload.source.baseSha = "f".repeat(40);
    if (defect === "profile") row.payload.profileRevision++;
    if (defect === "blocked") row.payload.readiness = "blocked";
    if (defect === "checks") {
      row.payload.checks[0]!.reason = "source_invalid";
      row.attempt_result.checks = row.payload.checks;
    }
    if (defect === "missing-tool") {
      const tool = row.payload.host.tools.find((tool) => tool.tool === "node")!;
      tool.status = "missing";
      tool.version = null;
      tool.outputDigest = null;
      row.attempt_result.host = row.payload.host;
    }
    if (defect === "receipt") row.payload.receipt.workerSessionGeneration = "2";
    if (defect === "saved-result") {
      row.attempt_result.checks[0]!.outputDigest = "f".repeat(64);
    }
    if (defect !== "digest") row.observation_digest = await hash(row.payload);
    await assertRejects(
      () =>
        admitRepositoryProfile(
          fixture.transaction(defect === "absent" ? [] : [row]),
          scope,
          fixture.profile,
        ),
      StandardError,
    );
  }
});

Deno.test("exact frozen observed tuple rejects partial pins and newer profile revisions", async () => {
  const fixture = await publication();
  for (
    const change of [
      { observationId: null },
      { observationDigest: null },
      { baseSha: null },
      { observationDigest: "0".repeat(64) },
      { baseSha: "0".repeat(40) },
      { repositoryProfileRevision: 3 },
    ]
  ) {
    await assertRejects(
      () =>
        admitRepositoryProfile(
          fixture.transaction([fixture.row]),
          scope,
          fixture.profile,
          { ...fixture.pins, ...change },
        ),
      StandardError,
    );
  }
});

async function frozenJob(
  callerInput = {
    repositoryId: scope.repositoryId,
    revision: "a".repeat(40),
    checks: ["source.integrity"],
  },
) {
  const profile = {
    id: id(7),
    revision: 1,
    config: baseline,
    digest: await hash(baseline),
  };
  const context = {
    ...scope,
    ...profile,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  };
  const row = {
    application_id: scope.applicationId,
    repository_id: scope.repositoryId,
    task_repository_id: scope.repositoryId,
    repository_profile_id: profile.id,
    repository_profile_revision: profile.revision,
    repository_profile_digest: profile.digest,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    task_type: "feature",
    step_key: "check",
    step_outputs: { source: { revision: callerInput.revision } },
    snapshot: {
      executionMode: "repository",
      repositoryProfile: context,
      inputs: { checks: callerInput.checks },
      workflow: {
        normalizedSpec: {
          steps: [{
            id: "check",
            uses: "quality.check",
            with: callerInput,
          }],
        },
      },
    },
    action: "quality.check",
    input: { ...callerInput, repositoryProfile: context },
    requirements: {
      capabilities: ["git", "shell", "browser", "mcp.host_local"],
    },
    agent_version_id: null,
    agent_config: {},
    skill_refs: [],
  };
  const transaction = {
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes("from bakery.jobs job") ? [row] : [profile],
        rowCount: 1,
      }),
  } as unknown as PgTransactionClient;
  return { row, transaction, callerInput, context };
}

Deno.test("frozen job authority denies registered action substitution and same-repository revision drift", async () => {
  for (const defect of ["action", "revision", "extra"] as const) {
    const { row, transaction } = await frozenJob();
    if (defect === "action") row.action = "mcp.discover";
    if (defect === "revision") row.input.revision = "b".repeat(40);
    if (defect === "extra") {
      Object.assign(row.input, { callerExtra: "not-authorized" });
    }
    await assertRejects(
      () =>
        admitRepositoryExecutionJob(transaction, scope.organizationId, id(6)),
      StandardError,
    );
  }
});

Deno.test("frozen job admission resolves task identity, snapshot inputs and upstream outputs identically", async () => {
  const { row, transaction, callerInput } = await frozenJob();
  row.snapshot.workflow.normalizedSpec.steps[0]!.with = {
    repositoryId: "$task.repositoryId",
    revision: "$step.source.revision",
    checks: ["$input.checks.first"],
  };
  Object.assign(row.snapshot.inputs, {
    checks: { first: callerInput.checks[0] },
  });
  assertEquals(
    [row.agent_version_id, row.agent_config, row.skill_refs],
    [null, {}, []],
  );
  assertEquals(
    await admitRepositoryExecutionJob(transaction, scope.organizationId, id(6)),
    { capabilities: ["git", "shell", "browser", "mcp.host_local"] },
  );
  row.step_outputs.source.revision = "b".repeat(40);
  await assertRejects(
    () => admitRepositoryExecutionJob(transaction, scope.organizationId, id(6)),
    StandardError,
  );
});

Deno.test("complete injected input admits exactly 100000 canonical UTF-8 bytes and denies the next byte", async () => {
  const empty = await frozenJob({
    repositoryId: scope.repositoryId,
    revision: "",
    checks: ["source.integrity"],
  });
  const overhead =
    new TextEncoder().encode(canonicalJson(empty.row.input)).length;
  const revision = "é".repeat(40_000) +
    "a".repeat(100_000 - overhead - 80_000);
  const fixture = await frozenJob({ ...empty.callerInput, revision });
  contractSchemas.CheckInput.parse(fixture.callerInput);
  assertEquals(
    new TextEncoder().encode(canonicalJson(fixture.row.input)).length,
    100_000,
  );
  assertEquals(executionJobInputFitsTransport(fixture.row.input), true);
  assertEquals(
    await admitRepositoryExecutionJob(
      fixture.transaction,
      scope.organizationId,
      id(6),
    ),
    { capabilities: ["git", "shell", "browser", "mcp.host_local"] },
  );
  fixture.row.input.revision += "a";
  fixture.row.snapshot.workflow.normalizedSpec.steps[0]!.with.revision += "a";
  contractSchemas.CheckInput.parse(fixture.callerInput);
  assertEquals(
    executionJobInputFitsTransport({
      ...fixture.callerInput,
      revision: fixture.row.input.revision,
    }),
    true,
  );
  assertEquals(executionJobInputFitsTransport(fixture.row.input), false);
  await assertRejects(
    () =>
      admitRepositoryExecutionJob(
        fixture.transaction,
        scope.organizationId,
        id(6),
      ),
    StandardError,
  );
});
