import { assert, assertEquals } from "@std/assert";
import {
  ActionKind,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import type { ClientInputMap } from "../../packages/contracts/src/client.ts";
import {
  ActionAccess,
  type ContractOutput,
  contractSchemas,
  OrganizationContextPolicy,
} from "../../packages/contracts/src/contracts.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  TaskImplementedAction,
} from "../../packages/contracts/src/implemented-actions.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import {
  createTaskActionRegistry,
  type TaskActionHandlers,
} from "../../apps/server/src/task-actions.ts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true
  : false;
type Expect<Value extends true> = Value;

// The generated client types accept a preset run and reject a mixed selector
// shape only at runtime; both ids are optional in the generated input type.
type RunCreateInput = ClientInputMap["RunCreate"];
const presetRun: RunCreateInput = {
  presetId: "fixed-coding",
  executionMode: "repository",
};
const unknownPreset: RunCreateInput = {
  // @ts-expect-error presetId is a closed enum of catalog preset identifiers.
  presetId: "other",
  executionMode: "repository",
};
type PresetIdIsClosed = Expect<
  Equal<
    NonNullable<RunCreateInput["presetId"]>,
    "fixed-coding" | "fixed-coding-reviewed"
  >
>;
const _presetIdIsClosed: PresetIdIsClosed = true;
type AvailabilityStatus = ContractOutput<
  "WorkflowPresetAvailability"
>["status"];
type AvailabilityStatusIsClosed = Expect<
  Equal<AvailabilityStatus, "ready" | "setup_required">
>;
const _availabilityStatusIsClosed: AvailabilityStatusIsClosed = true;
type AssignmentSession = ContractOutput<"JobAssignment">["agentSessionId"];
type AssignmentSessionIsOptional = Expect<
  Equal<AssignmentSession, string | undefined>
>;
const _assignmentSessionIsOptional: AssignmentSessionIsOptional = true;
void presetRun;
void unknownPreset;

const ID = "00000000-0000-4000-8000-000000000001";
const preset = {
  id: "fixed-coding",
  revision: FIXED_CODING_PRESET.revision,
  digest: FIXED_CODING_PRESET.digest,
  nameKey: FIXED_CODING_PRESET.nameKey,
  steps: [
    { id: "brief", uses: "task.brief" },
    { id: "implement", uses: "harness.implement" },
  ],
  defaultBudgetLimitUsd: "5.00",
  availability: {
    status: "ready",
    reasons: [],
    minimumBudgetLimitUsd: "1.500000",
  },
};

Deno.test("workflowPresets.list is a Developer read route with the generated query and page shapes", async () => {
  const seen: unknown[] = [];
  const handlers: TaskActionHandlers = {
    list: () => null as never,
    get: () => null as never,
    create: () => null as never,
    update: () => null as never,
    createDependency: () => null as never,
    deleteDependency: () => null as never,
    runsCreate: () => null as never,
    runsList: () => null as never,
    runsGet: () => null as never,
    runStepsList: () => null as never,
    usageList: () => null as never,
    sync: () => null as never,
    workflowPresetsList: (_context, input) => {
      seen.push(input);
      return { items: [preset as never], nextCursor: null };
    },
  };
  const registry = createTaskActionRegistry(handlers);
  const guarded = createTaskActionRegistry(handlers, {
    authorityRunner: {
      run: (_action, context, _input, next) => next(context),
    },
  });
  const descriptor = registry.list().find((action) =>
    action.name === TaskImplementedAction.WorkflowPresetsList
  );
  assert(descriptor);
  assertEquals(descriptor.method, HttpMethod.Get);
  assertEquals(descriptor.path, "/v1/workflow-presets");
  assertEquals(descriptor.policy.type, ActionKind.Query);
  assertEquals(descriptor.policy.access, ActionAccess.Developer);
  assertEquals(
    descriptor.policy.organizationContext,
    OrganizationContextPolicy.RequiredAuthenticatedContext,
  );

  const app = createApiRouter({
    registry: guarded,
    createContext: () => ({ principal: null }) as never,
  });
  const client = createBakeryClient({
    baseUrl: "http://test",
    getContext: () => ({ organizationId: ID }),
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const page = await client.actions["workflowPresets.list"]({
    repositoryId: ID,
  });
  assertEquals(seen, [{ repositoryId: ID }]);
  assertEquals(page.items[0].digest, FIXED_CODING_PRESET.digest);
  assertEquals(page.items[0].availability?.status, "ready");
  assertEquals(page.nextCursor, null);
  assert(contractSchemas["Page<WorkflowPreset>"].safeParse(page).success);
  assert(
    !contractSchemas.WorkflowPresetsListQuery.safeParse({ page: 2 }).success,
  );
});

Deno.test("runs.create accepts a preset selector and the assignment schema carries the harness session", () => {
  assert(
    contractSchemas.RunCreate.safeParse({
      presetId: "fixed-coding",
      executionMode: "repository",
      repositoryProfileId: ID,
      budgetLimitUsd: "5.00",
    }).success,
  );
  assert(
    contractSchemas.RunCreate.safeParse({
      workflowVersionId: ID,
      executionMode: "cloud_only",
    }).success,
  );
  assert(
    !contractSchemas.RunCreate.safeParse({
      presetId: "fixed-coding",
      workflowVersionId: ID,
      executionMode: "repository",
    }).success,
  );
  assert(
    !contractSchemas.RunCreate.safeParse({ executionMode: "cloud_only" })
      .success,
  );

  const assignment = {
    jobId: ID,
    attemptId: ID,
    workerHostId: ID,
    leaseToken: "lease",
    fence: "1",
    leaseExpiresAt: "2026-10-09T00:00:45.000Z",
    action: "quality.check",
    requirements: {},
    input: { repositoryId: ID, revision: "HEAD", checks: ["fmt"] },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    workerSessionId: ID,
    workerSessionGeneration: "1",
    leaseDurationSeconds: 45,
    serverTime: "2026-10-09T00:00:00.000Z",
    sealedCredentialOperation: null,
  };
  assert(contractSchemas.JobAssignment.safeParse(assignment).success);
  assert(
    contractSchemas.JobAssignment.safeParse({
      ...assignment,
      agentSessionId: ID,
    }).success,
  );
  assert(
    !contractSchemas.JobAssignment.safeParse({
      ...assignment,
      agentSessionId: "not-a-uuid",
    }).success,
  );
});
