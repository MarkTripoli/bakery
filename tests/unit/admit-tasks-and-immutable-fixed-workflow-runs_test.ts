import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  resolveDependencyReadiness,
  toRun,
  validateBudgetLimitUsd,
  validateRunInputs,
} from "../../apps/server/src/modules/work/run-command.ts";
import {
  createRunQueryHandlers,
} from "../../apps/server/src/modules/work/run-query.ts";
import {
  extractFixedWorkflowSteps,
  WorkflowNotFixedError,
  workflowRequiresRepository,
} from "../../apps/server/src/modules/work/run-steps.ts";

const WORKFLOW = {
  apiVersion: "bakery.dev/v1",
  kind: "workflow",
  name: "fixed admission",
  steps: [
    { id: "research", uses: "rpi.research", with: { taskId: "$input.taskId" } },
    { id: "review", uses: "review.independent", needs: ["research"] },
  ],
};

Deno.test("fixed workflow extraction preserves step keys and intent input", () => {
  assertEquals(extractFixedWorkflowSteps(WORKFLOW), [
    {
      key: "research",
      action: "rpi.research",
      input: { taskId: "$input.taskId" },
      position: 0,
      workflowAgentVersionId: null,
      stepAgentVersionId: null,
    },
    {
      key: "review",
      action: "review.independent",
      input: {},
      position: 1,
      workflowAgentVersionId: null,
      stepAgentVersionId: null,
    },
  ]);
});

Deno.test("fixed workflow extraction carries a valid step agent selector", () => {
  const selector = "00000000-0000-4000-8000-000000000009";
  const [step] = extractFixedWorkflowSteps({
    ...WORKFLOW,
    steps: [{ id: "research", uses: "rpi.research", agentVersionId: selector }],
  });
  assertEquals(step.stepAgentVersionId, selector);
  assertEquals(step.workflowAgentVersionId, null);
});

Deno.test("fixed workflow repository requirements use declarative markers", () => {
  assertEquals(workflowRequiresRepository(WORKFLOW), false);
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      inputs: {
        repositoryId: {
          type: "string",
          description: "Optional workflow input not consumed by a step.",
        },
      },
    }),
    false,
  );
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{ id: "maintenance", requires: ["git"] }],
    }),
    true,
  );
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "maintenance",
        repository: "$input.repositoryId",
      }],
    }),
    true,
  );
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "repeat",
        repeat: {
          steps: [{
            id: "nested",
            with: { repositoryId: "$input.repositoryId" },
          }],
        },
      }],
    }),
    true,
  );
  assertThrows(() =>
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{ id: "malformed", requires: ["git", null] }],
    })
  );
});
Deno.test("fixed workflow repository references use documented typed forms", () => {
  for (
    const reference of [
      "$input.repositoryId",
      "$task.repositoryId",
      "$step.repair.repair_test.repositoryId",
      "$repeat.currentCandidate.repositoryId",
    ]
  ) {
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{ id: "reference", with: reference }],
      }),
      true,
    );
  }
  for (
    const reference of [
      "$other.repositoryId",
      "$steps.repair.repositoryId",
      "$step.repair-repair_test.repositoryId",
      "$input.repositoryIdentifier",
    ]
  ) {
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{ id: "reference", with: reference }],
      }),
      false,
    );
  }
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "reference",
        with: { repositoryId: "$other.repositoryId" },
      }],
    }),
    true,
  );
});
Deno.test("step input mappings with repositoryId destinations require a repository", () => {
  for (
    const mapping of [
      { repositoryId: "literal-repository-id" },
      { repositoryId: "$input.repo" },
      { repositoryId: "$step.lookup_repo.id" },
    ]
  ) {
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{ id: "mapping", with: mapping }],
      }),
      true,
    );
  }
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "input-mapping",
        input: { repositoryId: "$input.repo" },
      }],
    }),
    true,
  );
});

Deno.test("top-level repositoryId workflow inputs do not require a repository", () => {
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      inputs: { repositoryId: { type: "string" } },
    }),
    false,
  );
});

Deno.test(
  "fixed workflow repository requirements conservatively inspect repeat seed repositoryId fields",
  () => {
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{
          id: "repeat",
          repeat: {
            seed: {
              currentCandidate: {
                repositoryId: "$input.repositoryId",
              },
              steps: [{ id: "seed_initial" }],
              outputs: {},
            },
            steps: [],
          },
        }],
      }),
      true,
    );
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{
          id: "repeat",
          repeat: {
            seed: {
              metadata: { repositoryId: "opaque metadata" },
              steps: [{ id: "seed_initial" }],
              outputs: {},
            },
            steps: [],
          },
        }],
      }),
      true,
    );
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{
          id: "repeat",
          repeat: {
            seed: {
              metadata: { repositoryId: "$input.repositoryId" },
              steps: [{ id: "seed_initial" }],
              outputs: {},
            },
            steps: [],
          },
        }],
      }),
      true,
    );
  },
);

Deno.test("fixed workflow repository requirements traverse repeat seed sequences", () => {
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "repeat",
        repeat: {
          seed: {
            steps: [{ id: "seed_git", requires: ["git"] }],
            outputs: {},
          },
          steps: [],
        },
      }],
    }),
    true,
  );
});

Deno.test("fixed workflow repository requirements traverse bounded parallel lanes", () => {
  assertEquals(
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "parallel",
        parallel: {
          branches: [
            {
              repositoryId: "literal-repository-id",
              steps: [{ id: "lane_one" }],
            },
            { steps: [{ id: "lane_two", requires: ["git"] }] },
          ],
        },
      }],
    }),
    true,
  );
  assertThrows(() =>
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "parallel",
        parallel: {
          branches: [
            { steps: [{ id: "repository_lane", requires: ["git"] }] },
            { steps: [{ id: "malformed_lane", requires: ["git", null] }] },
          ],
        },
      }],
    })
  );
});

Deno.test(
  "fixed workflow repository requirements traverse branch and sequence children",
  () => {
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{
          id: "branch",
          branch: {
            when: '$task.status == "waiting_input"',
            then: [{ id: "then_step", requires: ["git"] }],
            else: [{
              id: "else_step",
              with: "$repeat.currentCandidate.repositoryId",
            }],
          },
        }],
      }),
      true,
    );
    assertEquals(
      workflowRequiresRepository({
        ...WORKFLOW,
        steps: [{
          id: "sequence",
          steps: [{ id: "nested_step", requires: ["git"] }],
        }],
      }),
      true,
    );
  },
);

Deno.test(
  "fixed workflow rejects malformed nested requirements and containers",
  () => {
    const malformedSteps = [
      [{ id: "requirements", requires: ["git", null] }],
      [{ id: "repeat_container", repeat: {} }],
      [{ id: "branch_container", branch: { then: {} } }],
      [{ id: "parallel_container", parallel: { branches: [null] } }],
    ];
    for (const steps of malformedSteps) {
      assertThrows(() => workflowRequiresRepository({ ...WORKFLOW, steps }));
    }
  },
);

Deno.test("fixed workflow validates malformed requires after a valid git step", () => {
  assertThrows(() =>
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [
        { id: "maintenance", requires: ["git"] },
        { id: "malformed", requires: ["git", null] },
      ],
    })
  );
});

Deno.test("fixed workflow validates malformed nested requires below a repository parent", () => {
  assertThrows(() =>
    workflowRequiresRepository({
      ...WORKFLOW,
      steps: [{
        id: "parent",
        repository: "$input.repositoryId",
        repeat: {
          steps: [{
            id: "malformed",
            requires: ["git", null],
          }],
        },
      }],
    })
  );
});

Deno.test("fixed workflow extraction distinguishes document and execution kinds", () => {
  assertEquals(
    extractFixedWorkflowSteps(WORKFLOW, "fixed"),
    extractFixedWorkflowSteps(WORKFLOW),
  );
  assertThrows(
    () =>
      extractFixedWorkflowSteps({
        ...WORKFLOW,
        workflow: { kind: "dynamic" },
      }, "fixed"),
    WorkflowNotFixedError,
  );
  assertThrows(
    () => extractFixedWorkflowSteps({ ...WORKFLOW, kind: "fixed" }, "dynamic"),
    WorkflowNotFixedError,
  );
  assertThrows(
    () =>
      extractFixedWorkflowSteps({
        ...WORKFLOW,
        workflow: { kind: 42 },
      }, "fixed"),
    Error,
    "WORKFLOW_VERSION_INVALID",
  );
});

Deno.test("fixed workflow extraction rejects malformed and duplicate step keys", () => {
  assertThrows(
    () =>
      extractFixedWorkflowSteps({
        ...WORKFLOW,
        steps: [{ id: "Bad Key" }],
      }),
    Error,
  );
  assertThrows(
    () =>
      extractFixedWorkflowSteps({
        ...WORKFLOW,
        steps: [{ id: "research" }, { id: "research" }],
      }),
    Error,
  );
});
Deno.test(
  "fixed workflow extraction enforces documented step ID boundaries",
  () => {
    for (const id of ["a", "ab-c", `a${"b".repeat(64)}`]) {
      assertThrows(
        () =>
          extractFixedWorkflowSteps({
            ...WORKFLOW,
            steps: [{ id }],
          }),
        Error,
      );
    }
    const validBoundaryId = `a${"b".repeat(63)}`;
    assertEquals(
      extractFixedWorkflowSteps({
        ...WORKFLOW,
        steps: [{ id: validBoundaryId, uses: "quality.check" }],
      }),
      [{
        key: validBoundaryId,
        action: "quality.check",
        input: {},
        position: 0,
        workflowAgentVersionId: null,
        stepAgentVersionId: null,
      }],
    );
  },
);

Deno.test("run projection marks admission budget accounting as unknown", () => {
  const run = toRun({
    id: "00000000-0000-4000-8000-000000000001",
    task_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    repository_profile_id: null,
    repository_profile_revision: null,
    repository_profile_digest: null,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    workspace_base_sha: null,
    requested_by: "00000000-0000-4000-8000-000000000004",
    inngest_run_id: null,
    status: "queued",
    budget_limit_usd: "0.005000",
    started_at: null,
    finished_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    version: 1,
  });
  assertEquals(run.budgetSummary.installation, null);
  assertEquals(run.budgetLimitUsd, "0.005000");
  assertEquals(run.budgetSummary.run.periodStart, null);
  assertEquals(run.budgetSummary.run.periodEnd, null);
  assertEquals(run.budgetSummary.run.unknownCount, 1);
  assertEquals(run.budgetSummary.run.limitUsd, "0.005000");
  assertEquals(run.budgetSummary.run.reservedUsd, "0");
  assertEquals(run.budgetSummary.run.settledUsd, "0");
  assertEquals(run.budgetSummary.run.availableUsd, "0.005000");
});

Deno.test("dependency readiness distinguishes completed and incomplete prerequisites", () => {
  assertEquals(resolveDependencyReadiness([]), {
    status: "queued",
    reason: null,
  });
  assertEquals(
    resolveDependencyReadiness([{ taskId: "task-1", status: "completed" }]),
    { status: "queued", reason: null },
  );
  assertEquals(
    resolveDependencyReadiness([{ taskId: "task-1", status: "active" }]),
    { status: "blocked", reason: "dependency_incomplete" },
  );
});

Deno.test("run admission enforces the USD cap and UTF-8 input bounds", () => {
  assertEquals(validateBudgetLimitUsd(undefined), "0");
  assertEquals(validateBudgetLimitUsd("200"), "200");
  assertEquals(validateBudgetLimitUsd("200.000000"), "200.000000");
  const budgetError = assertThrows(
    () => validateBudgetLimitUsd("200.000001"),
    StandardError,
  );
  assertEquals(budgetError.code, "UNPROCESSABLE");
  assertEquals(budgetError.params?.issues, [{
    path: ["budgetLimitUsd"],
    code: "budget_limit_invalid",
    message: "budget limit invalid",
  }]);
  const formatError = assertThrows(
    () => validateBudgetLimitUsd("-1"),
    StandardError,
  );
  assertEquals(formatError.code, "UNPROCESSABLE");
  assertEquals(formatError.params?.issues, [{
    path: ["budgetLimitUsd"],
    code: "budget_limit_invalid",
    message: "budget limit invalid",
  }]);
  assert(validateRunInputs("é".repeat(49_999)) === "é".repeat(49_999));
  const inputsError = assertThrows(
    () => validateRunInputs("x".repeat(100_001)),
    StandardError,
  );
  assertEquals(inputsError.code, "UNPROCESSABLE");
  assertEquals(inputsError.params?.issues, [{
    path: ["inputs"],
    code: "inputs_too_large",
    message: "inputs too large",
  }]);
});

Deno.test("run cursors bind the task path and reject reuse for another task", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000010";
  const principalId = "00000000-0000-4000-8000-000000000011";
  const taskId = "00000000-0000-4000-8000-000000000012";
  const otherTaskId = "00000000-0000-4000-8000-000000000013";
  const runRows = [
    {
      id: "00000000-0000-4000-8000-000000000014",
      task_id: taskId,
      workflow_version_id: "00000000-0000-4000-8000-000000000015",
      repository_profile_id: null,
      repository_profile_revision: null,
      repository_profile_digest: null,
      observation_id: null,
      observation_digest: null,
      base_sha: null,
      workspace_base_sha: null,
      requested_by: principalId,
      inngest_run_id: null,
      status: "queued",
      budget_limit_usd: "0",
      started_at: null,
      finished_at: null,
      created_at: "2026-09-19T00:00:02.000Z",
      updated_at: "2026-09-19T00:00:02.000Z",
      version: 1,
      cursor_created_at: "2026-09-19T00:00:02.000000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000016",
      task_id: taskId,
      workflow_version_id: "00000000-0000-4000-8000-000000000015",
      repository_profile_id: null,
      repository_profile_revision: null,
      repository_profile_digest: null,
      observation_id: null,
      observation_digest: null,
      base_sha: null,
      workspace_base_sha: null,
      requested_by: principalId,
      inngest_run_id: null,
      status: "blocked",
      budget_limit_usd: "0",
      started_at: null,
      finished_at: null,
      created_at: "2026-09-19T00:00:01.000Z",
      updated_at: "2026-09-19T00:00:01.000Z",
      version: 1,
      cursor_created_at: "2026-09-19T00:00:01.000000Z",
    },
  ];
  const transaction = {
    query(sql: string) {
      if (sql.includes("from bakery.tasks")) {
        return Promise.resolve({ rows: [{ id: taskId }] });
      }
      if (sql.includes("from bakery.workflow_runs")) {
        return Promise.resolve({ rows: runRows });
      }
      if (sql.includes("from bakery.budget_accounts")) {
        // Runs without a budget account read as the empty run budget summary.
        return Promise.resolve({ rows: [] });
      }
      throw new Error("UNEXPECTED_RUN_QUERY");
    },
  } as unknown as PgTransactionClient;
  const context = (id: string): ActionContext =>
    ({
      request: new Request("http://test"),
      params: { id },
      requestId: "request-id",
      traceId: "trace-id",
      signal: new AbortController().signal,
      authority: { organizationId, subject: { principalId } },
      transaction,
    }) as ActionContext;
  const handlers = createRunQueryHandlers("cursor-binding-secret");
  const first = await handlers.runsList(context(taskId), { limit: 1 });
  assert(first.nextCursor !== null);
  const error = await assertRejects(
    () =>
      handlers.runsList(context(otherTaskId), {
        limit: 1,
        cursor: first.nextCursor!,
      }),
    StandardError,
  );
  assertEquals(error.code, "INVALID_CURSOR");
});
