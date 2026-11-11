/**
 * Paper p-18-0 synthetic data (frames 2IBL-0 through 2K4U-0). The E06
 * design fixtures answer the production API reads from this data, so the
 * production pages render the frame content without reaching a server.
 */
export const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
export const PRIYA_ID = "00000000-0000-4000-8000-000000000001";
export const DANA_ID = "00000000-0000-4000-8000-000000000002";
export const APPLICATION_ID = "00000000-0000-4000-8000-000000000004";
export const WEB_REPOSITORY_ID = "00000000-0000-4000-8000-000000000015";
export const PAYMENTS_REPOSITORY_ID = "00000000-0000-4000-8000-000000000005";
export const JOBS_REPOSITORY_ID = "00000000-0000-4000-8000-000000000025";
export const E2E_REPOSITORY_ID = "00000000-0000-4000-8000-000000000035";
export const CONVERSATION_ID = "00000000-0000-4000-8000-000000000008";
export const TASK_ID = "00000000-0000-4000-8000-000000000212";
export const QUESTION_ID = "00000000-0000-4000-8000-000000000601";
export const PLAN_ID = "00000000-0000-4000-8000-000000000701";

const childId = (n: number) => `00000000-0000-4000-8000-000000${n}000`;
export const CHILD_TASK_IDS = [213, 214, 215, 216].map(childId);

/** Task reference text the product has no source for yet (fixture only). */
export const FIXTURE_REFERENCES: Readonly<Record<string, string>> = {
  [TASK_ID]: "BKRY-212",
  [CHILD_TASK_IDS[0]]: "BKRY-213",
  [CHILD_TASK_IDS[1]]: "BKRY-214",
  [CHILD_TASK_IDS[2]]: "BKRY-215",
  [CHILD_TASK_IDS[3]]: "BKRY-216",
};

export type ConversationState =
  | "default"
  | "plan-review"
  | "question"
  | "empty"
  | "conflict";
export type CoordinationState =
  | "default"
  | "empty"
  | "partial"
  | "stale"
  | "workflow"
  | "ticket";

const stamp = (hour: number, minute: number) =>
  `2026-10-14T${String(hour).padStart(2, "0")}:${
    String(minute).padStart(2, "0")
  }:00.000Z`;

const task = () => ({
  id: TASK_ID,
  applicationId: APPLICATION_ID,
  repositoryId: WEB_REPOSITORY_ID,
  conversationId: CONVERSATION_ID,
  parentTaskId: null,
  title: "Shared checkout onboarding",
  description: "",
  taskType: "feature",
  status: "waiting_input",
  priority: 50,
  createdBy: PRIYA_ID,
  currentRunId: null,
  archivedAt: null,
  createdAt: stamp(10, 20),
  updatedAt: stamp(10, 27),
  version: 3,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  approvalPolicy: { plan: "human_approval", review: "human_approval" },
  planningOnly: false,
});

const message = (
  sequence: number,
  messageType: "user" | "assistant",
  authorId: string | null,
  hour: number,
  minute: number,
  body: string,
) => ({
  id: `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, "0")}`,
  conversationId: CONVERSATION_ID,
  authorId,
  agentSessionId: null,
  messageType,
  body,
  clientMessageId: `client-${sequence}`,
  replyToId: null,
  createdAt: stamp(hour, minute),
  updatedAt: stamp(hour, minute),
  version: 1,
  sequence: String(sequence),
  intent: messageType === "assistant" ? "agent_output" : "agent_request",
  commentContext: null,
});

const brief = message(
  1,
  "user",
  PRIYA_ID,
  10,
  21,
  "Checkout onboarding should work for both the storefront and the payments service. Can we plan it across the two repositories?",
);
const reply = message(
  2,
  "user",
  DANA_ID,
  10,
  23,
  "Payments needs the new webhook contract first. The storefront should wait for it.",
);
const planNote = message(
  3,
  "assistant",
  null,
  10,
  25,
  "I read the conversation and both repositories. Revision 2 of the plan adds the webhook contract as a prerequisite lane, so the storefront lane starts only after payments commits it.",
);
const rollback = message(
  4,
  "user",
  PRIYA_ID,
  10,
  27,
  "Add a rollback note for the payments migration, then I will approve.",
);
const questionNote = message(
  3,
  "assistant",
  null,
  10,
  25,
  "I read the conversation and both repositories. The webhook contract can live in either repository, and the lane order depends on that choice.",
);
const questionAsk = message(
  4,
  "assistant",
  null,
  10,
  28,
  "Before I plan, I need one answer from you.",
);

const phoneAgent = {
  ...planNote,
  body:
    "Revision 2 of the plan adds the webhook contract as a prerequisite lane.",
};
const messages = (state: ConversationState, phone = false) =>
  phone && state === "default"
    ? [reply, phoneAgent, rollback]
    : state === "empty"
    ? []
    : state === "question"
    ? [brief, reply, questionNote, questionAsk]
    : [brief, reply, planNote, rollback];

const turns = (state: ConversationState) =>
  state === "default"
    ? [{
      id: "00000000-0000-4000-8000-000000000301",
      conversationId: CONVERSATION_ID,
      triggerMessageId: rollback.id,
      agentSessionId: null,
      status: "queued",
      contextThroughSequence: null,
      finishedAt: null,
      failure: null,
      createdAt: stamp(10, 27),
      updatedAt: stamp(10, 27),
      version: 4,
    }]
    : [];

const defaultSteps = [
  { id: "s1", title: "Publish the webhook contract in payments", detail: "" },
  {
    id: "s2",
    title: "Add the checkout onboarding flow to the storefront",
    detail: "",
  },
  { id: "s3", title: "Verify both lanes end to end", detail: "" },
];
const reviewSteps = [
  {
    id: "s1",
    title: "Publish the webhook contract",
    detail:
      "Payments adds the checkout.completed schema and commits it as an output for the storefront lane.",
  },
  {
    id: "s2",
    title: "Migrate the payments ledger",
    detail:
      "One reversible migration. The rollback note lists the down step and the data check.",
  },
  {
    id: "s3",
    title: "Add checkout onboarding to the storefront",
    detail:
      "Starts after the contract is committed. Reads the schema, no direct database access.",
  },
  {
    id: "s4",
    title: "Verify both lanes end to end",
    detail:
      "Run the checkout smoke test against the preview of each repository.",
  },
];
const obsoleteSteps = [
  {
    id: "s1",
    title: "Add checkout onboarding to the storefront",
    detail: "",
  },
  { id: "s2", title: "Verify the storefront end to end", detail: "" },
];

const revision = (
  n: number,
  steps: readonly { id: string; title: string; detail: string }[],
  status = "proposed",
) => ({
  id: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  revision: n,
  body: {
    title: "Shared checkout onboarding",
    steps,
    repositoryId: WEB_REPOSITORY_ID,
  },
  digest: String(n).repeat(64).slice(0, 64),
  status,
  proposedByTurnId: null,
  supersedesRevision: n > 1 ? n - 1 : null,
  createdAt: stamp(10, 24 + n),
  updatedAt: stamp(10, 24 + n),
  version: 1,
});

const approval = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`,
  kind: "approval",
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  turnId: null,
  runId: null,
  prompt: `Approve plan revision ${n}`,
  status: "open",
  subjectType: "plan_revision",
  subjectId: `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`,
  subjectDigest: String(n).repeat(64).slice(0, 64),
  scope: { stage: "plan" },
  policyDigest: "c".repeat(64),
  decision: null,
  decisionComment: null,
  decidedBy: null,
  decidedAt: null,
  consumedAt: null,
  consumedByRunId: null,
  revokedAt: null,
  revokedBy: null,
  expiresAt: null,
  createdAt: stamp(10, 26),
  updatedAt: stamp(10, 26),
  version: 7,
  ...extra,
});

const question = {
  id: "00000000-0000-4000-8000-000000000601",
  taskId: TASK_ID,
  runId: null,
  conversationId: CONVERSATION_ID,
  prompt: "Which repository should publish the webhook contract?",
  responseSchema: null,
  status: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: stamp(10, 28),
  updatedAt: stamp(10, 28),
  version: 2,
  kind: "question",
  turnId: null,
  generation: 1,
  options: [
    { id: "payments", label: "northwind/payments" },
    { id: "web", label: "northwind/web" },
    { id: "contracts", label: "A new shared contracts repository" },
  ],
  allowFreeText: true,
  audience: { type: "task_participants" },
  expiresAt: null,
};

const people = {
  priya: {
    principalId: PRIYA_ID,
    principalType: "human",
    displayName: "Priya Raman",
  },
  dana: {
    principalId: DANA_ID,
    principalType: "human",
    displayName: "Dana Okafor",
  },
};

const specLane = (
  key: string,
  alias: string,
  extra: Record<string, unknown> = {},
) => ({
  key,
  repositoryAlias: alias,
  title: key,
  instructions: "Do the work.",
  prerequisites: [],
  outputs: [],
  inputs: [],
  ...extra,
});
const spec = {
  lanes: [
    specLane("contract", "contract", {
      outputs: [{
        key: "webhook-schema",
        kind: "artifact",
        artifactType: "design",
      }],
    }),
    specLane("storefront", "storefront", {
      prerequisites: ["contract"],
      inputs: [{ fromLane: "contract", outputKey: "webhook-schema" }],
    }),
    specLane("ledger", "ledger"),
    specLane("backfill", "backfill", { prerequisites: ["ledger"] }),
    specLane("e2e", "e2e", { prerequisites: ["storefront"] }),
  ],
  maxConcurrency: 2,
  join: "all-required",
  failurePolicy: "stop-dependent",
};
const lane = (
  key: string,
  repositoryId: string,
  status: string,
  childTaskId: string | null,
  extra: Record<string, unknown> = {},
) => ({
  laneKey: key,
  repositoryId,
  childTaskId,
  reusedFromLaneId: null,
  prerequisites: [],
  declaredOutputs: [],
  laneDigest: "d".repeat(64),
  status,
  ...extra,
});
const webhookOutput = {
  key: "webhook-schema",
  kind: "artifact",
  artifactType: "design",
};
const planLanes = (partial: boolean, stale = false) => [
  lane("contract", PAYMENTS_REPOSITORY_ID, "completed", CHILD_TASK_IDS[0], {
    declaredOutputs: [webhookOutput],
  }),
  lane(
    "storefront",
    WEB_REPOSITORY_ID,
    stale ? "stale" : partial ? "completed" : "running",
    CHILD_TASK_IDS[1],
    {
      prerequisites: ["contract"],
      declaredOutputs: [{
        key: "checkout-flow",
        kind: "artifact",
        artifactType: "patch",
      }],
    },
  ),
  lane("ledger", PAYMENTS_REPOSITORY_ID, "failed", CHILD_TASK_IDS[2], {
    declaredOutputs: [{
      key: "ledger-migration",
      kind: "artifact",
      artifactType: "patch",
    }],
  }),
  lane("backfill", JOBS_REPOSITORY_ID, "stopped", null, {
    prerequisites: ["ledger"],
    declaredOutputs: [{
      key: "backfill-report",
      kind: "artifact",
      artifactType: "report",
    }],
  }),
  lane(
    "e2e",
    E2E_REPOSITORY_ID,
    partial ? "completed" : "waiting",
    partial ? CHILD_TASK_IDS[3] : null,
    {
      prerequisites: ["storefront"],
      declaredOutputs: [{
        key: "smoke-report",
        kind: "artifact",
        artifactType: "report",
      }],
    },
  ),
];
const WORKFLOW_ID = "00000000-0000-4000-8000-0000000000c1";
const WORKFLOW_VERSION_ID = "aaaaaaaa-0000-4000-8000-0000000000c2";
const planOrigin = (state: CoordinationState) =>
  state === "workflow"
    ? {
      kind: "saved_workflow",
      workflowId: WORKFLOW_ID,
      workflowVersionId: WORKFLOW_VERSION_ID,
      nodeId: "fan-out",
    }
    : state === "ticket"
    ? {
      kind: "ticket",
      provider: "github",
      reference: "northwind/storefront#214",
      url: "https://github.com/northwind/storefront/issues/214",
    }
    : { kind: "ad_hoc" };
const coordinationPlan = (state: CoordinationState) => ({
  id: PLAN_ID,
  applicationId: APPLICATION_ID,
  parentTaskId: TASK_ID,
  revision: 2,
  spec,
  digest: "e".repeat(64),
  origin: planOrigin(state),
  budgetLimitUsd: "120.000000",
  status: state === "partial" ? "partially_delivered" : "materialized",
  createdBy: PRIYA_ID,
  lanes: planLanes(state === "partial", state === "stale"),
  createdAt: stamp(10, 26),
  updatedAt: stamp(10, 26),
  version: 4,
});

const repository = (
  id: string,
  owner: string,
  name: string,
  defaultBranch = "main",
) => ({
  id,
  applicationId: APPLICATION_ID,
  slug: name,
  integrationConnectionId: "00000000-0000-4000-8000-000000000007",
  providerRepoId: name,
  owner,
  name,
  defaultBranch,
  activeProfileId: null,
  archivedAt: null,
  createdAt: stamp(9, 0),
  updatedAt: stamp(9, 0),
  version: 1,
});
const repositories = [
  repository(PAYMENTS_REPOSITORY_ID, "northwind", "payments"),
  repository(WEB_REPOSITORY_ID, "northwind", "web"),
  repository(JOBS_REPOSITORY_ID, "northwind", "jobs"),
  repository(E2E_REPOSITORY_ID, "northwind", "e2e"),
];
const role = (alias: string, repositoryId: string, n: number) => ({
  id: `00000000-0000-4000-8000-00000000090${n}`,
  applicationId: APPLICATION_ID,
  alias,
  role: alias,
  repositoryId,
  createdAt: stamp(9, 0),
  updatedAt: stamp(9, 0),
  version: 1,
});
const roles = [
  role("contract", PAYMENTS_REPOSITORY_ID, 1),
  role("storefront", WEB_REPOSITORY_ID, 2),
  role("ledger", PAYMENTS_REPOSITORY_ID, 3),
  role("backfill", JOBS_REPOSITORY_ID, 4),
  role("e2e", E2E_REPOSITORY_ID, 5),
];
const application = {
  id: APPLICATION_ID,
  slug: "storefront",
  name: "Northwind storefront",
  description: "Checkout, catalog and payments services",
  archivedAt: null,
  createdAt: stamp(9, 0),
  updatedAt: stamp(9, 0),
  version: 1,
};
const committed = (
  n: number,
  taskId: string,
  name: string,
  artifactType: string,
) => ({
  id: `00000000-0000-4000-8000-000000000a0${n}`,
  taskId,
  artifactType,
  name,
  currentVersionId: `00000000-0000-4000-8000-000000000b0${n}`,
  createdAt: stamp(10, 26),
  updatedAt: stamp(10, 26),
  version: 1,
  pinnedAt: null,
  pinnedBy: null,
});
const committedArtifacts = (taskId: string, partial: boolean) =>
  taskId === CHILD_TASK_IDS[0]
    ? [committed(1, taskId, "webhook-schema", "design")]
    : partial && taskId === CHILD_TASK_IDS[1]
    ? [committed(2, taskId, "checkout-flow", "patch")]
    : partial && taskId === CHILD_TASK_IDS[3]
    ? [committed(3, taskId, "smoke-report", "report")]
    : [];

const page = <T>(items: readonly T[]) => ({ items, nextCursor: null });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export type FixtureWorld = Readonly<{
  /** Phone frames show the later part of the conversation, abridged. */
  phone?: boolean;
  conversation?: ConversationState;
  coordination?: CoordinationState;
  /** Paper 2JSH-0 onboarding data; answers the projects reads instead. */
  onboarding?: boolean;
}>;

/** Paper 2JSH-0 / 2K4U-0 projects-onboarding sample (read only). */
export const WAREHOUSE_APPLICATION_ID = "00000000-0000-4000-8000-000000000044";
export const ONBOARDING_INSPECTION_ID = "00000000-0000-4000-8000-000000000801";
const ONBOARDING_JOB_ID = "00000000-0000-4000-8000-000000000802";
const PAYMENTS_PROFILE_3 = "00000000-0000-4000-8000-000000000503";
const PAYMENTS_PROFILE_2 = "00000000-0000-4000-8000-000000000502";
const WEB_PROFILE_5 = "00000000-0000-4000-8000-000000000505";
const onboardingApplications = [
  application,
  {
    ...application,
    id: WAREHOUSE_APPLICATION_ID,
    slug: "warehouse",
    name: "Warehouse tools",
    description: "Inventory jobs and scanners",
    archivedAt: stamp(9, 30),
  },
];
const onboardingRepository = (
  base: ReturnType<typeof repository>,
  activeProfileId: string | null,
  defaultBranch = "main",
) => ({ ...base, defaultBranch, activeProfileId });
const onboardingRepositories = [
  onboardingRepository(repositories[0], PAYMENTS_PROFILE_3),
  onboardingRepository(repositories[1], WEB_PROFILE_5),
  onboardingRepository(repositories[3], null, "trunk"),
];
const onboardingProfile = (
  id: string,
  repositoryId: string,
  revision: number,
  digest: string,
  createdAt: string,
) => ({
  id,
  repositoryId,
  revision,
  config: {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["delivery/*"] },
    worktree: { root: ".agents/worktrees/payments" },
  },
  digest,
  createdBy: PRIYA_ID,
  createdAt,
  updatedAt: createdAt,
  version: 1,
});
const paymentsProfiles = [
  onboardingProfile(
    PAYMENTS_PROFILE_3,
    PAYMENTS_REPOSITORY_ID,
    3,
    `4be1${"0".repeat(56)}9c07`,
    "2026-10-12T09:00:00.000Z",
  ),
  onboardingProfile(
    PAYMENTS_PROFILE_2,
    PAYMENTS_REPOSITORY_ID,
    2,
    `91d0${"0".repeat(56)}2a4e`,
    "2026-10-09T09:00:00.000Z",
  ),
];
const webProfiles = [
  onboardingProfile(
    WEB_PROFILE_5,
    WEB_REPOSITORY_ID,
    5,
    `b7c2${"0".repeat(56)}13ef`,
    "2026-10-11T09:00:00.000Z",
  ),
];
const onboardingRole = (alias: string, n: number) => ({
  id: `00000000-0000-4000-8000-00000000091${n}`,
  organizationId: ORGANIZATION_ID,
  applicationId: APPLICATION_ID,
  role: "payments-api",
  alias,
  repositoryId: PAYMENTS_REPOSITORY_ID,
  repositorySlug: "payments",
  provenance: null,
  version: 1,
  archivedAt: null,
});
const onboardingRoles = [
  onboardingRole("contract", 1),
  onboardingRole("ledger", 2),
];
/** The inspection the Paper frame shows as running. */
export const FIXTURE_INSPECTION = {
  id: ONBOARDING_INSPECTION_ID,
  repositoryId: PAYMENTS_REPOSITORY_ID,
  jobId: ONBOARDING_JOB_ID,
  status: "running" as const,
  profileId: null,
  observationId: null,
  createdAt: stamp(10, 0),
  updatedAt: stamp(10, 0),
};

function onboardingRead(path: string): Response | null {
  if (path === "/v1/applications") return json(page(onboardingApplications));
  const app = /^\/v1\/applications\/([^/]+)$/.exec(path);
  if (app) {
    const found = onboardingApplications.find((item) => item.id === app[1]);
    return found ? json(found) : json({ title: "Not found" }, 404);
  }
  const roleList = /^\/v1\/applications\/([^/]+)\/roles$/.exec(path);
  if (roleList) {
    return json(page(roleList[1] === APPLICATION_ID ? onboardingRoles : []));
  }
  if (path === "/v1/repositories") return json(page(onboardingRepositories));
  const profiles = /^\/v1\/repositories\/([^/]+)\/profiles$/.exec(path);
  if (profiles) {
    return json(
      page(
        profiles[1] === PAYMENTS_REPOSITORY_ID
          ? paymentsProfiles
          : profiles[1] === WEB_REPOSITORY_ID
          ? webProfiles
          : [],
      ),
    );
  }
  const repo = /^\/v1\/repositories\/([^/]+)$/.exec(path);
  if (repo) {
    const found = onboardingRepositories.find((item) => item.id === repo[1]);
    return found ? json(found) : json({ title: "Not found" }, 404);
  }
  if (path === `/v1/repository-onboardings/${ONBOARDING_INSPECTION_ID}`) {
    return json(FIXTURE_INSPECTION);
  }
  return null;
}

/**
 * Answers the fixture's `fetch` calls. Reads come from the frame data; any
 * other request is refused so a fixture can never act on anything.
 */
export function e06Fetch(world: FixtureWorld): typeof fetch {
  const state = world.conversation ?? "default";
  return async (input, init) => {
    await Promise.resolve(); // the transport is asynchronous like the network
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
      globalThis.location.origin,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    if (method !== "GET") return json({ title: "Fixture is read only" }, 405);
    if (world.onboarding) {
      const answer = onboardingRead(path);
      if (answer !== null) return answer;
    }
    if (path === "/v1/me") {
      return json({
        principalId: PRIYA_ID,
        principalType: "human",
        displayName: "Priya Raman",
        locale: "en",
        direction: "ltr",
        catalogVersion: "2",
        twoFactorEnabled: false,
        timeZone: "UTC",
        email: "priya@northwind.example",
        backupCodesRemaining: null,
      });
    }
    if (path === `/v1/tasks/${TASK_ID}`) return json(task());
    if (path.endsWith("/messages")) {
      return json(page([...messages(state, world.phone)].reverse()));
    }
    if (path.endsWith("/participants")) {
      return json(
        page(state === "empty" ? [people.priya] : [people.priya, people.dana]),
      );
    }
    if (path.endsWith("/turns")) return json(page(turns(state)));
    if (path === "/v1/coordination-plans") {
      return json(
        page(
          world.coordination === undefined
            ? [coordinationPlan("default")]
            : world.coordination === "empty"
            ? []
            : [coordinationPlan(world.coordination)],
        ),
      );
    }
    if (path === "/v1/plan-revisions") {
      return json(
        page(
          state === "default"
            ? [revision(2, defaultSteps)]
            : state === "plan-review"
            ? [revision(2, reviewSteps)]
            : state === "conflict"
            ? [revision(1, obsoleteSteps, "superseded")]
            : [],
        ),
      );
    }
    if (path === "/v1/approvals") {
      return json(
        page(
          state === "plan-review"
            ? [approval(2)]
            : state === "conflict"
            ? [approval(1, { status: "superseded" })]
            : [],
        ),
      );
    }
    if (path === "/v1/questions") {
      return json(page(state === "question" ? [question] : []));
    }
    if (path === `/v1/applications/${APPLICATION_ID}`) return json(application);
    if (path === `/v1/applications/${APPLICATION_ID}/repository-roles`) {
      return json(page(roles));
    }
    if (path === `/v1/workflows/${WORKFLOW_ID}`) {
      return json({
        id: WORKFLOW_ID,
        slug: "checkout-fan-out",
        name: "Checkout fan-out",
        description: null,
        activeVersionId: WORKFLOW_VERSION_ID,
        enabled: true,
        createdAt: stamp(9, 0),
        updatedAt: stamp(9, 0),
        version: 1,
      });
    }
    if (path === "/v1/repositories") return json(page(repositories));
    const repositoryMatch = /^\/v1\/repositories\/([^/]+)$/.exec(path);
    if (repositoryMatch) {
      const found = repositories.find((item) => item.id === repositoryMatch[1]);
      return found ? json(found) : json({ title: "Not found" }, 404);
    }
    if (path === "/v1/artifacts") {
      return json(
        page(
          committedArtifacts(
            url.searchParams.get("taskId") ?? "",
            world.coordination === "partial",
          ),
        ),
      );
    }
    if (path === "/v1/workflow-presets") return json(page([]));
    if (path === "/v1/sync") return json(page([]));
    globalThis.console.warn(`E06 fixture: unhandled ${method} ${path}`);
    return json(page([]));
  };
}

export { coordinationPlan };
