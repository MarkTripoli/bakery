import { assert, assertEquals } from "@std/assert";
import { agentVersionDigest } from "../../../apps/server/src/modules/agents/postgres.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import {
  assembleReviewReport,
  type ReviewerFinding,
  reviewPinsFromProfile,
} from "../../../apps/worker/src/review-report.ts";
import {
  type AuthenticatedClients,
  postJson,
  responseJson,
} from "../durable-core/engine-admission.ts";
import type { DurableCoreStack } from "../durable-core/stack.ts";
import { appDatabaseUrl } from "../deterministic-checks/e2e-world.ts";
import { seedProviderPricingSnapshot } from "../funded-model-job.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../repository-inspection.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import { workerCredential } from "../worker-execution.ts";
import {
  createLoopCommits,
  type LoopCommits,
  loopFixedPolicy,
} from "./e2e-candidate.ts";

/**
 * The world the real-process review and repair proof runs in (issue #94).
 * Everything goes through real routes except two substituted steps:
 *
 * - The onboarding inspection (`repository.inspect`) runs through the same
 *   server routes mounted in this process against the stack's database, because
 *   the compose server has no trusted-repository mapping (the #83 technique).
 * - The model-backed jobs, `harness.implement`, `harness.repair` and
 *   `review.independent`, are completed by a substitute worker in this process.
 *   It speaks the real worker protocol to the compose server over HTTP
 *   (enrolment, registration, heartbeat, claim, result), so the server, its
 *   result hooks and the engine are the production ones. What the substitute
 *   replaces is the model: it reports the commits and findings a script names.
 *   The review report is built by the production worker module
 *   (`apps/worker/src/review-report.ts`) the Claude reviewer uses.
 *
 * The production worker process runs `quality.check` and `task.brief` for real.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Terminal run statuses. */
export const TERMINAL_STATUSES = ["completed", "failed", "canceled"];

/** A small reservation keeps the stack's one-dollar budget from starving runs. */
const LOOP_BILLING = {
  provider: "openai",
  billingAccountId: "review-loop-account",
  model: "gpt-5.6-luna",
  billingRoute: "api",
  maxTokens: 1_000,
  maxUsdReservation: 0.01,
  pricingMetadataSnapshot: "review-loop-price-v1",
} as const;

export const LOOP_ACTIONS = Object.freeze(
  ["harness.implement", "harness.repair", "review.independent"] as const,
);
export type LoopAction = typeof LOOP_ACTIONS[number];
export type LoopAgents = Readonly<Record<LoopAction, string>>;

/**
 * The SQL exception in this world: pricing is operator authority and
 * `bakery_app` can only read it (migration 0064), so the owner role seeds the
 * one snapshot every agent bills against. Agents themselves go through the API.
 */
async function seedPricing(stack: DurableCoreStack): Promise<void> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await seedProviderPricingSnapshot(database, { billing: LOOP_BILLING });
  } finally {
    await closePgDatabase(database);
  }
}

/** One funded agent version for each model action of the reviewed preset. */
export async function seedLoopAgents(
  stack: DurableCoreStack,
  clients: AuthenticatedClients,
): Promise<LoopAgents> {
  await seedPricing(stack);
  const versions: Partial<Record<LoopAction, string>> = {};
  for (const action of LOOP_ACTIONS) {
    const label = action.replace(".", "-");
    const agent = await responseJson(
      await postJson(
        clients.producer,
        "/v1/agents",
        {
          slug: `review-loop-${label}-${crypto.randomUUID().slice(0, 8)}`,
          name: `Review loop ${action}`,
          description: `Agent bound to ${action} in the reviewed preset.`,
        },
        `loop-agent-${crypto.randomUUID()}`,
      ),
      201,
      "AGENT_CREATE",
    );
    const config = { harness: "codex", billing: LOOP_BILLING };
    const version = await responseJson(
      await postJson(
        clients.producer,
        `/v1/agents/${agent.id}/versions`,
        { revision: 1, config, digest: await agentVersionDigest(config) },
        `loop-agent-version-${crypto.randomUUID()}`,
      ),
      201,
      "AGENT_VERSION_CREATE",
    );
    assert(typeof version.id === "string" && UUID.test(version.id));
    versions[action] = version.id;
  }
  return versions as LoopAgents;
}

export type LoopRepository = {
  readonly applicationId: string;
  readonly repositoryId: string;
  readonly profileId: string;
  readonly commits: LoopCommits;
};

const MAPPING_ENVIRONMENT = "BAKERY_TRUSTED_REPOSITORIES_JSON";

/**
 * Publishes the fixed-policy profile (all four effects, agent bindings for
 * implement, repair and review) through onboarding and returns the active
 * observed profile with the operator repository's commits built on the
 * inspected snapshot.
 */
export async function onboardLoopRepository(
  stack: DurableCoreStack,
  scope: { organizationId: string; principalId: string },
  operatorRepository: string,
  agents: LoopAgents,
): Promise<LoopRepository> {
  const ownerPg = openPgDatabase(stack.ownerDatabaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl(stack));
  const harness = await openRepositoryInspectionHarness(
    { authDb: ownerPg, appPg },
    scope,
  );
  try {
    const repository = await harness.createRepository(false, {
      profileConfig: {
        ...baseProfileConfig,
        agentBindings: { ...agents },
        fixedPolicy: loopFixedPolicy(),
      },
      profileHeaders: { "If-Match": '"1"' },
    });
    await harness.onboard(repository.repositoryId);
    const assignment = await readInspectionAssignment(await harness.claim());
    await harness.start(assignment);
    const receipt = await receiveInspectionSource(harness, assignment);
    const report = await harness.report(assignment.input, receipt);
    const result = await harness.result(assignment, report);
    assertEquals(result.status, 200, await result.clone().text());
    const snapshot = await harness.snapshot(
      repository.repositoryId,
      assignment.jobId,
    );
    const profileId = assignment.input.profile.id;
    assertEquals(snapshot.active_profile_id, profileId);

    const mapping = JSON.parse(Deno.env.get(MAPPING_ENVIRONMENT)!) as {
      entries: Array<{ repositoryUuid: string; bareRepositoryPath: string }>;
    };
    const entry = mapping.entries.find(({ repositoryUuid }) =>
      repositoryUuid === repository.repositoryId
    );
    assert(entry, "the inspected repository has no trusted mapping");
    const commits = await createLoopCommits(
      entry.bareRepositoryPath,
      operatorRepository,
    );
    // The profile pins the inspected snapshot as its base commit.
    assertEquals(commits.base, repository.snapshotSha);
    return {
      applicationId: repository.applicationId,
      repositoryId: repository.repositoryId,
      profileId,
      commits,
    };
  } finally {
    await harness.close();
    await closePgDatabase(appPg);
    await closePgDatabase(ownerPg);
  }
}

export type StartedLoopRun = {
  readonly taskId: string;
  readonly runId: string;
};

/** Creates a task and starts the reviewed preset on it in repository mode. */
export async function startLoopRun(
  clients: AuthenticatedClients,
  repository: LoopRepository,
  options: { title: string; budgetLimitUsd?: string },
): Promise<StartedLoopRun> {
  const task = await responseJson(
    await postJson(
      clients.producer,
      "/v1/tasks",
      {
        applicationId: repository.applicationId,
        repositoryId: repository.repositoryId,
        repositoryProfileId: repository.profileId,
        taskType: "feature",
        title: options.title,
        description:
          "Implement, review independently and repair within the bounds.",
      },
      `loop-task-${crypto.randomUUID()}`,
    ),
    201,
    "TASK_CREATE",
  );
  assert(typeof task.id === "string" && UUID.test(task.id));
  const run = await responseJson(
    await postJson(
      clients.producer,
      `/v1/tasks/${task.id}/runs`,
      {
        presetId: "fixed-coding-reviewed",
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
        budgetLimitUsd: options.budgetLimitUsd ?? "0.200000",
      },
      `loop-run-${crypto.randomUUID()}`,
    ),
    201,
    "RUN_CREATE",
  );
  assert(typeof run.id === "string" && UUID.test(run.id));
  return { taskId: task.id, runId: run.id };
}

/** The assignment a claim returns, reduced to what the substitute reads. */
export type SubstituteAssignment = {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerHostId: string;
  readonly leaseToken: string;
  readonly fence: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
  readonly currentCheckpoints: readonly unknown[];
  readonly agentSessionId?: string;
};

type Session = { workerSessionId: string; workerSessionGeneration: string };

const HEARTBEAT_MS = 1_000;

/**
 * A worker host in this process that speaks the real worker protocol to the
 * compose server over HTTP. It is enrolled with the model-backed capabilities
 * the production worker of the proof deliberately lacks, so the two never
 * race for a job. It keeps itself online with a heartbeat while it is used.
 */
export class SubstituteWorker {
  private session: Session;
  private readonly active = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatFailure: unknown;
  private beating = false;
  /** Serializes heartbeat, claim and result so they never overlap. */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly stack: DurableCoreStack,
    private readonly credential: string,
    readonly workerHostId: string,
    readonly capabilities: readonly string[],
    session: Session,
  ) {
    this.session = session;
  }

  /** Enrols and registers a host with `capabilities` and starts its heartbeat. */
  static async register(
    stack: DurableCoreStack,
    clients: AuthenticatedClients,
    capabilities: readonly string[],
  ): Promise<SubstituteWorker> {
    const name = `review-loop-substitute-${crypto.randomUUID().slice(0, 8)}`;
    const enrollment = await responseJson(
      await postJson(
        clients.producer,
        "/v1/worker-enrollments",
        {
          name,
          os: "linux",
          architecture: "x64",
          capabilities: [...capabilities],
          slots: 1,
        },
        `loop-enrollment-${crypto.randomUUID()}`,
      ),
      201,
      "WORKER_ENROLL",
    );
    assert(typeof enrollment.enrollmentToken === "string");
    const credential = workerCredential();
    const registered = await stack.fetch(
      new Request(`${stack.origin}/v1/worker/registration`, {
        method: "POST",
        headers: SubstituteWorker.headers(undefined, crypto.randomUUID()),
        body: JSON.stringify({
          enrollmentToken: enrollment.enrollmentToken,
          workerCredential: credential,
          name,
          os: "linux",
          architecture: "x64",
          capabilities: [...capabilities],
          toolchainVersions: {},
          slots: 1,
        }),
      }),
    );
    const registeredText = await registered.text();
    assertEquals(registered.status, 200, registeredText);
    const registration = JSON.parse(registeredText) as {
      workerHostId: string;
      workerSessionId: string;
      workerSessionGeneration: string;
    };
    const worker = new SubstituteWorker(
      stack,
      credential,
      registration.workerHostId,
      capabilities,
      {
        workerSessionId: registration.workerSessionId,
        workerSessionGeneration: registration.workerSessionGeneration,
      },
    );
    // The first heartbeat opens the session the later requests carry.
    await worker.heartbeat({
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    });
    worker.heartbeatTimer = setInterval(() => {
      if (worker.beating) return;
      worker.beating = true;
      worker.heartbeat().catch((error) => {
        worker.heartbeatFailure = error;
      }).finally(() => {
        worker.beating = false;
      });
    }, HEARTBEAT_MS);
    return worker;
  }

  private static headers(
    credential: string | undefined,
    idempotencyKey: string,
  ): Headers {
    const headers = new Headers({
      "content-type": "application/json",
      "X-Bakery-Worker-Protocol-Version": "2",
      "Idempotency-Key": idempotencyKey,
    });
    if (credential) headers.set("authorization", `Bearer ${credential}`);
    return headers;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<Response> {
    return await this.stack.fetch(
      new Request(`${this.stack.origin}${path}`, {
        method: "POST",
        headers: SubstituteWorker.headers(this.credential, idempotencyKey),
        body: JSON.stringify({
          workerSessionId: this.session.workerSessionId,
          workerSessionGeneration: this.session.workerSessionGeneration,
          ...body,
        }),
      }),
    );
  }

  /**
   * Runs `work` after every earlier call has finished. A heartbeat composed
   * before a claim returns would not list the attempt that claim leased, and
   * the server would read that as an abandoned lease; one call at a time keeps
   * the reported attempts exact, as the production worker's supervisor does.
   */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private heartbeat(session: Partial<Session> = {}): Promise<void> {
    return this.serialized(async () => {
      const response = await this.request("/v1/worker/heartbeat", {
        workerHostId: this.workerHostId,
        observedAt: new Date().toISOString(),
        load: 0,
        activeAttemptIds: [...this.active],
        ackCommandIds: [],
        rejectedCommandIds: [],
        ...session,
      });
      const text = await response.text();
      if (response.status !== 200) {
        throw new Error(
          `SUBSTITUTE_HEARTBEAT_FAILED:${response.status}:${text}`,
        );
      }
      const next = JSON.parse(text) as Partial<Session>;
      if (next.workerSessionId && next.workerSessionGeneration) {
        this.session = {
          workerSessionId: next.workerSessionId,
          workerSessionGeneration: next.workerSessionGeneration,
        };
      }
    });
  }

  /** Throws when a background heartbeat failed, so a dead host is not mistaken for no work. */
  assertOnline(): void {
    if (this.heartbeatFailure !== undefined) {
      throw new Error(
        `SUBSTITUTE_HEARTBEAT_LOST:${String(this.heartbeatFailure)}`,
      );
    }
  }

  /** Claims one job of `actions`, or null when none is queued for this host. */
  claim(actions: readonly string[]): Promise<SubstituteAssignment | null> {
    this.assertOnline();
    return this.serialized(async () => {
      const claimKey = crypto.randomUUID();
      const response = await this.request("/v1/worker/claims", {
        claimKey,
        workerHostId: this.workerHostId,
        capabilities: [...this.capabilities],
        supportedActions: [...actions],
      }, claimKey);
      if (response.status === 204) {
        await response.body?.cancel();
        return null;
      }
      const text = await response.text();
      assertEquals(response.status, 200, text);
      const assignment = JSON.parse(text) as SubstituteAssignment;
      this.active.add(assignment.attemptId);
      return assignment;
    });
  }

  /** Posts the attempt's result and returns the response (200 when accepted). */
  result(
    assignment: SubstituteAssignment,
    outcome:
      | { readonly status: "completed"; readonly result: unknown }
      | { readonly status: "failed"; readonly fault: unknown },
  ): Promise<Response> {
    return this.serialized(async () => {
      const response = await this.request(
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          ...outcome,
        },
      );
      this.active.delete(assignment.attemptId);
      return response;
    });
  }

  /** A failed-result fault in the shape the worker route stores. */
  static fault(code: string, retryable: boolean) {
    return {
      type: "about:blank",
      title: "Substitute reviewer could not run",
      status: retryable ? 503 : 500,
      detail: "The scripted substitute for the reviewer reports a failure.",
      code,
      requestId: crypto.randomUUID(),
      retryable,
    };
  }

  stop(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

/**
 * Builds the `ReviewOutput` a Claude reviewer would send for `assignment`, with
 * the production worker module: the pins come from the job's own profile and
 * the report is assembled (fingerprints, ordering, byte rule) by the same code.
 * Only the model's findings are scripted.
 */
export async function reviewReportFor(
  assignment: SubstituteAssignment,
  findings: readonly ReviewerFinding[],
): Promise<Record<string, unknown>> {
  const { repositoryProfile, ...registered } = assignment.input;
  const input = registeredWorkerActionInputSchema("review.independent").parse(
    registered,
  ) as { revision: string };
  const profile = RepositoryExecutionContextSchema.parse(repositoryProfile);
  const pins = await reviewPinsFromProfile(profile);
  assert(pins !== null, "the job carries no fixed-policy pins");
  assert(assignment.agentSessionId, "the review job has no server session");
  const assembled = await assembleReviewReport({
    sessionId: assignment.agentSessionId,
    headSha: input.revision,
    baseSha: pins.baseSha,
    policyDigest: pins.policyDigest,
  }, [...findings]);
  assertEquals(assembled.status, "ok");
  assert(assembled.status === "ok");
  return assembled.report as unknown as Record<string, unknown>;
}
