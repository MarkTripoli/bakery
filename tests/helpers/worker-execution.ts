import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  type AppFixture,
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "./auth.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import type { ServerAuthConfig } from "../../packages/config/src/env.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  type AgentVersionCreateConfig,
  workerActionCapabilities,
} from "../../packages/contracts/src/contracts.ts";
import { RepositoryExecutionContextSchema } from "../../packages/contracts/src/repository-inspection.ts";
import type { SkillFileStoreOperations } from "../../apps/server/src/modules/catalog/storage.ts";
export { seedFundedModelJob } from "./funded-model-job.ts";

export const workerFixtureCapabilities = [
  ...new Set([
    ...workerActionCapabilities("harness.implement"),
    ...workerActionCapabilities("quality.check"),
    ...workerActionCapabilities("mcp.discover"),
  ]),
];

export type WorkerScope = {
  email: string;
  organizationId: string;
  principalId: string;
  adminCookie: string;
  ownsAuthIdentity: boolean;
};

export type WorkerFixture = WorkerScope & {
  app: AppFixture["app"];
  pgDatabase: PgDatabase;
  runtimePgDatabase: PgDatabase;
  config: {
    publicBaseUrl: string;
    auth?: ServerAuthConfig;
  };
  close(): Promise<void>;
  releaseFixture(): void;
  workerHostIds: string[];
};

let workerFixtureTail = Promise.resolve();

export type WorkerEnrollment = {
  enrollmentId: string;
  enrollmentToken: string;
  expiresAt: string;
};

export type WorkerRegistration = {
  workerHostId: string;
  principalId: string;
  status: "registered" | "updated";
  registrationGeneration: number;
  workerSessionId: string;
  workerSessionGeneration: string;
};

export type JobSeed = {
  applicationId: string;
  conversationId: string;
  taskId: string;
  workflowId: string;
  workflowVersionId: string;
  runId: string;
  runStepId: string;
  sessionId: string;
  jobId: string;
};

export type ExecutionState = {
  job: {
    status: string;
    currentFence: string;
    cancelRequestedAt: string | null;
  };
  run: { status: string; finishedAt: string | null };
  step: { status: string; output: unknown; error: unknown };
  attempts: Array<{
    id: string;
    workerHostId: string;
    fence: string;
    status: string;
    lastEventSeq: string;
    leaseExpiresAt: string;
    result: unknown;
  }>;
  events: Array<{
    id: string;
    localSeq: string;
    eventType: string;
    payload: unknown;
    payloadDigest: string;
    savedAck: unknown;
  }>;
};

export function workerCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function createWorkerScope(
  fixture: {
    app: AppFixture["app"];
    pgDatabase: PgDatabase;
    config: { publicBaseUrl: string; auth?: ServerAuthConfig };
  },
  prefix = "issue39-worker",
  existingScope?: Pick<
    WorkerScope,
    "email" | "principalId" | "adminCookie"
  >,
): Promise<WorkerScope> {
  const suffix = crypto.randomUUID();
  const email = existingScope?.email ??
    `${prefix}-${suffix}@example.test`;
  let organizationId: string | undefined;
  try {
    if (existingScope) {
      organizationId = crypto.randomUUID();
      const now = new Date();
      await fixture.pgDatabase.query(
        `insert into bakery.organizations (
           id, name, slug, metadata, created_at, updated_at, version
         ) values ($1, $2, $3, '{}'::jsonb, $4, $4, 1)`,
        [
          organizationId,
          "Issue 39 Worker",
          `${prefix}-${organizationId}`,
          now,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status,
           joined_at, created_at, updated_at, version
         ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
        [crypto.randomUUID(), organizationId, existingScope.principalId, now],
      );
      return {
        ...existingScope,
        organizationId,
        ownsAuthIdentity: false,
      };
    }

    const password = `Issue39-${suffix}`;
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Issue 39 Admin", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signIn.status, 200);
    const adminCookie = sessionCookie(signIn);
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
        where provider_user.email = $1
          and membership.role = 'admin'
          and membership.status = 'active'
        order by membership.created_at desc
        limit 1`,
      [email],
    );
    assertExists(scope.rows[0]);
    return {
      email,
      organizationId: scope.rows[0].organizationId,
      principalId: scope.rows[0].principalId,
      adminCookie,
      ownsAuthIdentity: true,
    };
  } catch (error) {
    if (organizationId) {
      await closeWorkerOrganization(fixture.pgDatabase, organizationId).catch(
        () => undefined,
      );
    } else if (!existingScope) {
      await cleanupAuthFixture(fixture.pgDatabase, [email]).catch(() =>
        undefined
      );
    }
    throw error;
  }
}
async function deleteWorkerOrganization(
  pgDatabase: PgTransactionClient,
  organizationId: string,
): Promise<void> {
  const organizationIds = [organizationId];
  // Ledger rows are never deleted by the application; the fixture clears the
  // reservation link and the effects before the steps they reference.
  await pgDatabase.query(
    `update bakery.budget_reservations set external_effect_id = null
      where organization_id = any($1::uuid[])
        and external_effect_id is not null`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.external_effects
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.questions
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.plan_revisions
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.outbox
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.run_steps
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.workflow_runs
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.task_dependencies
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.workflow_versions
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.workflow_definitions
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.audit_events
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.domain_events
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.idempotency_records
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.tasks
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.conversations
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.repository_role_bindings
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `update bakery.repositories set active_profile_id = null
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.repository_profiles
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.repositories
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.applications
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.organization_invitations
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.organization_memberships
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.event_clock
      where organization_id = any($1::uuid[])`,
    [organizationIds],
  );
  await pgDatabase.query(
    `delete from bakery.organizations
      where id = any($1::uuid[])`,
    [organizationIds],
  );
}

export async function openWorkerFixture(options: {
  skillFileRoot?: string;
  skillFileStore?: SkillFileStoreOperations;
  env?: Record<string, string>;
} = {}): Promise<WorkerFixture> {
  let releaseFixture!: () => void;
  const turn = new Promise<void>((resolve) => releaseFixture = resolve);
  const previous = workerFixtureTail;
  workerFixtureTail = workerFixtureTail.then(() => turn);
  await previous;
  const fixture = await openAuthFixture(options).catch((error) => {
    releaseFixture();
    throw error;
  });
  try {
    const scope = await createWorkerScope(fixture);
    return {
      ...fixture,
      ...scope,
      releaseFixture,
      workerHostIds: [],
    };
  } catch (error) {
    await fixture.close();
    releaseFixture();
    throw error;
  }
}

export async function closeWorkerOrganization(
  pgDatabase: PgDatabase,
  organizationId: string,
): Promise<void> {
  await withPgTransaction(pgDatabase, async (pgDatabase) => {
    // Check rows reference artifact versions (their evidence) without
    // cascading, so they go before the versions do.
    await pgDatabase.query(
      `delete from bakery.check_runs
        where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.artifact_versions
        where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.artifacts
        where organization_id = $1`,
      [organizationId],
    );
    const workerPrincipals = await pgDatabase.query<{ id: string }>(
      `select principal_id as id from bakery.worker_hosts
        where organization_id = $1`,
      [organizationId],
    );
    const ownedInstallationAccounts = await pgDatabase.query<{ id: string }>(
      `with owned as (
         select budget_account_id,
                sum(case when status = 'held' then reserved_usd else 0 end) as held,
                sum(coalesce(settled_usd, 0)) as settled
           from bakery.budget_reservations
          where organization_id = $1
          group by budget_account_id
       )
       update bakery.budget_accounts account
          set reserved_usd = account.reserved_usd - owned.held,
              settled_usd = account.settled_usd - owned.settled
         from owned
        where account.id = owned.budget_account_id
          and account.scope = 'installation'
       returning account.id`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.provider_authoritative_receipts
        where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.budget_release_evidence where organization_id = $1`,
      [organizationId],
    );
    // Onboarding references its job/attempt and observation. Keep deletion in
    // one transaction so deferred task/run/job observation pins remain valid
    // until their owned parent rows have also been removed.
    await pgDatabase.query(
      `delete from bakery.repository_onboardings onboarding
        using bakery.applications application
        where onboarding.organization_id = $1
          and application.organization_id = $1
          and onboarding.application_id = application.id`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.repository_profile_observations observation
        using bakery.applications application
        where observation.organization_id = $1
          and application.organization_id = $1
          and observation.application_id = application.id`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.attempt_events where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.job_attempts where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.jobs where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.worker_enrollments where organization_id = $1`,
      [organizationId],
    );
    await pgDatabase.query(
      `delete from bakery.worker_hosts where organization_id = $1`,
      [organizationId],
    );
    if (workerPrincipals.rows.length > 0) {
      await pgDatabase.query(
        `delete from bakery.principals where id = any($1::uuid[])`,
        [workerPrincipals.rows.map(({ id }) => id)],
      );
    }
    await deleteWorkerOrganization(pgDatabase, organizationId);
    if (ownedInstallationAccounts.rows.length > 0) {
      await pgDatabase.query(
        `delete from bakery.budget_accounts account
          where account.id = any($1::uuid[])
            and not exists (
              select 1 from bakery.budget_reservations reservation
               where reservation.budget_account_id = account.id
            )`,
        [ownedInstallationAccounts.rows.map((row) => row.id)],
      );
    }
  });
}

export async function closeWorkerScope(
  fixture: { pgDatabase: PgDatabase },
  scope: WorkerScope,
): Promise<void> {
  await closeWorkerOrganization(fixture.pgDatabase, scope.organizationId);
  if (scope.ownsAuthIdentity) {
    await cleanupAuthFixture(fixture.pgDatabase, [scope.email]);
  }
}

export async function closeWorkerFixture(
  fixture: WorkerFixture,
): Promise<void> {
  try {
    await closeWorkerScope(fixture, fixture);
    await fixture.close();
  } finally {
    fixture.releaseFixture();
  }
}

function jsonHeaders(
  headers: HeadersInit = {},
): Headers {
  const result = new Headers(headers);
  result.set("content-type", "application/json");
  return result;
}

export async function adminRequest(
  fixture: WorkerFixture,
  path: string,
  body: unknown,
  options: {
    idempotencyKey?: string;
    method?: string;
    headers?: HeadersInit;
    scope?: WorkerScope;
  } = {},
): Promise<Response> {
  const scope = options.scope ?? fixture;
  const headers = jsonHeaders({
    cookie: scope.adminCookie,
    origin: fixture.config.publicBaseUrl,
    "Bakery-Organization-Id": scope.organizationId,
    ...(options.headers ?? {}),
  });
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: options.method ?? "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

export async function workerRequest(
  fixture: WorkerFixture,
  credential: string,
  path: string,
  body: unknown,
  options: {
    idempotencyKey?: string;
    headers?: HeadersInit;
    includeWorkerSession?: boolean;
  } = {},
): Promise<Response> {
  const headers = jsonHeaders({
    authorization: `Bearer ${credential}`,
    ...(options.headers ?? {}),
  });
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  let requestBody = body;
  const mutationPath = path === "/v1/worker/claims" ||
    path === "/v1/worker/heartbeat" ||
    /^\/v1\/worker\/attempts\/[^/]+\/(events|lease-renewals|result)$/.test(
      path,
    );
  if (mutationPath) {
    const host = await fixture.pgDatabase.query<{
      workerSessionId: string | null;
      workerSessionGeneration: string;
      protocolVersion: number;
    }>(
      `select worker_session_id as "workerSessionId",
              worker_session_generation::text as "workerSessionGeneration",
              protocol_version as "protocolVersion"
         from bakery.worker_hosts
        where credential_hash = $1`,
      [await sha256Hex(credential)],
    );
    const hostRow = host.rows[0];
    if (!headers.has("X-Bakery-Worker-Protocol-Version") && hostRow) {
      headers.set(
        "X-Bakery-Worker-Protocol-Version",
        String(hostRow.protocolVersion),
      );
    }
    if (
      options.includeWorkerSession !== false &&
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body)
    ) {
      const record = body as Record<string, unknown>;
      if (
        !("workerSessionId" in record) &&
        !("workerSessionGeneration" in record) &&
        hostRow?.workerSessionId !== null &&
        hostRow?.workerSessionId !== undefined
      ) {
        requestBody = {
          ...record,
          workerSessionId: hostRow.workerSessionId,
          workerSessionGeneration: hostRow.workerSessionGeneration,
        };
      }
    }
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    }),
  );
}

export async function enrollWorker(
  fixture: WorkerFixture,
  options: {
    name?: string;
    capabilities?: string[];
    slots?: number;
    idempotencyKey?: string;
    scope?: WorkerScope;
  } = {},
): Promise<Response> {
  return await adminRequest(
    fixture,
    "/v1/worker-enrollments",
    {
      name: options.name ?? `issue39-host-${crypto.randomUUID()}`,
      os: "linux",
      architecture: "x64",
      capabilities: options.capabilities ?? ["git"],
      slots: options.slots ?? 1,
    },
    {
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      scope: options.scope,
    },
  );
}

export async function registerWorker(
  fixture: WorkerFixture,
  enrollmentToken: string,
  credential: string,
  options: {
    name?: string;
    capabilities?: string[];
    slots?: number;
    idempotencyKey?: string;
    protocolVersion?: number;
  } = {},
): Promise<Response> {
  const headers = jsonHeaders({
    "Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
    ...(options.protocolVersion === undefined ? {} : {
      "X-Bakery-Worker-Protocol-Version": String(options.protocolVersion),
    }),
  });
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}/v1/worker/registration`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        enrollmentToken,
        workerCredential: credential,
        name: options.name ?? `issue39-worker-${crypto.randomUUID()}`,
        os: "linux",
        architecture: "x64",
        capabilities: options.capabilities ?? ["git"],
        toolchainVersions: { deno: "2.x" },
        slots: options.slots ?? 1,
      }),
    }),
  );
}

export async function registeredWorker(
  fixture: WorkerFixture,
  options: {
    name?: string;
    capabilities?: string[];
    slots?: number;
    enrollmentIdempotencyKey?: string;
    registrationIdempotencyKey?: string;
    scope?: WorkerScope;
  } = {},
): Promise<{
  enrollment: WorkerEnrollment;
  registration: WorkerRegistration;
  credential: string;
}> {
  const capabilities = options.capabilities ?? workerFixtureCapabilities;
  const name = options.name ?? `issue39-worker-${crypto.randomUUID()}`;
  const enrollmentResponse = await enrollWorker(fixture, {
    name,
    capabilities,
    slots: options.slots,
    idempotencyKey: options.enrollmentIdempotencyKey,
    scope: options.scope,
  });
  assertEquals(enrollmentResponse.status, 201);
  const enrollment = await enrollmentResponse.json() as WorkerEnrollment;
  const credential = workerCredential();
  const registrationResponse = await registerWorker(
    fixture,
    enrollment.enrollmentToken,
    credential,
    {
      name,
      capabilities,
      slots: options.slots,
      idempotencyKey: options.registrationIdempotencyKey,
      protocolVersion: 2,
    },
  );
  assertEquals(registrationResponse.status, 200);
  const registration = await registrationResponse.json() as WorkerRegistration;
  const initialHeartbeat = await workerRequest(
    fixture,
    credential,
    "/v1/worker/heartbeat",
    {
      workerHostId: registration.workerHostId,
      observedAt: "2026-09-20T00:00:00.000Z",
      load: 0,
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    },
    {
      idempotencyKey: crypto.randomUUID(),
      includeWorkerSession: false,
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
    },
  );
  assertEquals(initialHeartbeat.status, 200);
  const initialHeartbeatBody = await initialHeartbeat.json() as {
    workerSessionId: string;
    workerSessionGeneration: string;
  };
  registration.workerSessionId = initialHeartbeatBody.workerSessionId;
  registration.workerSessionGeneration =
    initialHeartbeatBody.workerSessionGeneration;
  if (!options.scope) fixture.workerHostIds.push(registration.workerHostId);
  return { enrollment, registration, credential };
}

/** Raw fixture for deliberate invalid, legacy, and non-model jobs. */
export async function seedEligibleJob(
  database: PgDatabase,
  organizationId: string,
  principalId: string,
  options: {
    priority?: number;
    capabilities?: string[];
    action?: string;
    input?: Record<string, unknown>;
    legacy?: boolean;
    skillRefs?: readonly { versionId: string; digest: string }[];
    agentConfig?: AgentVersionCreateConfig;
  } = {},
): Promise<JobSeed> {
  const ids = {
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowVersionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    runStepId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    agentVersionId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
  };
  const suffix = ids.jobId.slice(0, 8);
  const now = new Date();
  const action = options.action ?? "harness.implement";
  // A supplied repository identifier stays caller input. Fresh identifiers can
  // identify this fixture's repository; existing/foreign rows are never rebound.
  const suppliedRepositoryId = RepositoryExecutionContextSchema.shape
    .repositoryId.safeParse(options.input?.repositoryId);
  let repositoryId = suppliedRepositoryId.success
    ? suppliedRepositoryId.data
    : crypto.randomUUID();
  if (!options.legacy && suppliedRepositoryId.success) {
    const existing = await database.query(
      "select id from bakery.repositories where id = $1",
      [repositoryId],
    );
    if (existing.rows.length > 0) repositoryId = crypto.randomUUID();
  }
  const input = options.input ?? {
    repositoryId: options.legacy ? crypto.randomUUID() : repositoryId,
    planArtifact: crypto.randomUUID(),
  };
  const profileId = crypto.randomUUID();
  const profileConfig = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  const profileDigest = await sha256Hex(canonicalJson(profileConfig));
  const skillRefs = [...(options.skillRefs ?? [])];
  const fixtureAgentConfig = options.agentConfig ??
    (skillRefs.length === 0 ? null : {
      harness: "pi",
      skillBindings: Object.fromEntries(
        skillRefs.map((ref, index) => [`fixture-${index}`, ref.versionId]),
      ),
    });
  const fixtureAgentDigest = fixtureAgentConfig === null
    ? null
    : await sha256Hex(canonicalJson(fixtureAgentConfig));
  const context = options.legacy
    ? null
    : RepositoryExecutionContextSchema.parse({
      organizationId,
      applicationId: ids.applicationId,
      repositoryId,
      id: profileId,
      revision: 1,
      digest: profileDigest,
      config: profileConfig,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    });
  const spec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: `issue39-${suffix}`,
    ...(options.legacy ? {} : { workflow: { kind: "fixed" } }),
    ...(fixtureAgentConfig === null
      ? {}
      : { agents: { [action]: ids.agentVersionId } }),
    steps: [{
      id: "worker",
      uses: action,
      ...(options.legacy ? {} : { with: input }),
    }],
  };
  const workflowDigest = await sha256Hex(canonicalJson(spec));
  let capabilities = options.capabilities;
  if (capabilities === undefined) {
    if (options.legacy) capabilities = ["git"];
    else {
      try {
        capabilities = [...workerActionCapabilities(action)];
      } catch (error) {
        // Preserve deliberately unknown action fixtures as denied work; do not
        // substitute a supported action or fabricate its required capabilities.
        if (options.action === undefined) throw error;
        capabilities = [];
      }
    }
  }
  const jobInput = context === null || Object.hasOwn(input, "repositoryProfile")
    ? input
    : { ...input, repositoryProfile: context };
  await database.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, $4)`,
    [ids.applicationId, organizationId, `issue39-${suffix}`, "Issue 39 worker"],
  );
  if (context !== null) {
    await database.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch
       ) values ($1, $2, $3, $4, $5, 'bakery-worker', $5, 'main')`,
      [
        repositoryId,
        organizationId,
        ids.applicationId,
        crypto.randomUUID(),
        `issue39-${suffix}`,
      ],
    );
    await database.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision, config,
         digest, created_by
       ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
      [
        profileId,
        organizationId,
        ids.applicationId,
        repositoryId,
        JSON.stringify(context.config),
        profileDigest,
        principalId,
      ],
    );
    await database.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [organizationId, repositoryId, profileId],
    );
  }
  await database.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by, repository_id
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      ids.conversationId,
      organizationId,
      ids.applicationId,
      "Issue 39 worker",
      principalId,
      context?.repositoryId ?? null,
    ],
  );
  await database.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title,
       task_type, status, priority, created_by, repository_id,
       repository_profile_id, repository_profile_revision, repository_profile_digest
     ) values ($1, $2, $3, $4, $5, 'feature', 'queued', 50, $6, $7, $8, $9, $10)`,
    [
      ids.taskId,
      organizationId,
      ids.applicationId,
      ids.conversationId,
      "Issue 39 queued job",
      principalId,
      context?.repositoryId ?? null,
      context?.id ?? null,
      context?.revision ?? null,
      context?.digest ?? null,
    ],
  );
  if (fixtureAgentConfig !== null && fixtureAgentDigest !== null) {
    // Mechanism-only fixture projection. Authenticated producer proof must not
    // use this helper; these rows satisfy frozen-context claim invariants for
    // tests whose subject starts at a pre-existing persisted job.
    await database.query(
      `insert into bakery.agent_definitions (
         id, organization_id, slug, name, description, enabled
       ) values ($1, $2, $3, 'Worker mechanism fixture agent', '', true)`,
      [ids.agentId, organizationId, `worker-fixture-${suffix}`],
    );
    await database.query(
      `insert into bakery.agent_versions (
         id, organization_id, agent_id, revision, config, digest, created_by
       ) values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        ids.agentVersionId,
        organizationId,
        ids.agentId,
        JSON.stringify(fixtureAgentConfig),
        fixtureAgentDigest,
        principalId,
      ],
    );
  }
  await database.query(
    `insert into bakery.workflow_definitions (
       id, organization_id, slug, name, enabled, version
     ) values ($1, $2, $3, $4, true, 1)`,
    [ids.workflowId, organizationId, `issue39-${suffix}`, `Issue 39 ${suffix}`],
  );
  await database.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml,
       normalized_spec, digest, status, created_by
     ) values ($1, $2, $3, 1, $4, $5::jsonb, $6, 'published', $7)`,
    [
      ids.workflowVersionId,
      organizationId,
      ids.workflowId,
      JSON.stringify(spec),
      JSON.stringify(spec),
      workflowDigest,
      principalId,
    ],
  );
  await database.query(
    `update bakery.workflow_definitions
        set active_version_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, ids.workflowVersionId, ids.workflowId],
  );
  await database.query(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id, requested_by,
       status, snapshot, budget_limit_usd, application_id, repository_id,
       repository_profile_id, repository_profile_revision, repository_profile_digest
     ) values ($1, $2, $3, $4, $5, 'running', $6::jsonb, 0.005000, $7, $8, $9, $10, $11)`,
    [
      ids.runId,
      organizationId,
      ids.taskId,
      ids.workflowVersionId,
      principalId,
      JSON.stringify(
        options.legacy
          ? { workflowVersionId: ids.workflowVersionId, input: {} }
          : {
            schemaVersion: 1,
            executionMode: "repository",
            inputs: {},
            workflow: {
              id: ids.workflowVersionId,
              revision: 1,
              digest: workflowDigest,
              normalizedSpec: spec,
            },
            repositoryProfile: context,
            stepAgents: fixtureAgentConfig === null ? {} : {
              worker: {
                agentVersionId: ids.agentVersionId,
                revision: 1,
                digest: fixtureAgentDigest,
                config: fixtureAgentConfig,
                skillRefs,
              },
            },
            admission: { dependencies: [], status: "queued", reason: null },
          },
      ),
      context?.applicationId ?? null,
      context?.repositoryId ?? null,
      context?.id ?? null,
      context?.revision ?? null,
      context?.digest ?? null,
    ],
  );
  await database.query(
    `update bakery.tasks set current_run_id = $2 where organization_id = $1 and id = $3`,
    [organizationId, ids.runId, ids.taskId],
  );
  await database.query(
    `insert into bakery.run_steps (
       id, organization_id, run_id, step_key, position, iteration,
       status, input
     ) values ($1, $2, $3, 'worker', 1, 0, 'pending', $4::jsonb)`,
    [
      ids.runStepId,
      organizationId,
      ids.runId,
      JSON.stringify(options.legacy ? {} : input),
    ],
  );
  await database.query(
    `insert into bakery.agent_sessions (
       id, organization_id, run_step_id, conversation_id, agent_version_id,
       harness, status
     ) values ($1, $2, $3, $4, $5, 'codex', 'active')`,
    [
      ids.sessionId,
      organizationId,
      ids.runStepId,
      ids.conversationId,
      ids.agentVersionId,
    ],
  );
  await database.query(
    `insert into bakery.jobs (
       id, organization_id, run_step_id, action, requirements, input, status,
       available_at, priority, current_fence, max_attempts,
       application_id, repository_id, repository_profile_id,
       repository_profile_revision, repository_profile_digest, skill_refs,
       agent_version_id, agent_config
     ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'queued', $7, $8, 0,
               $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb)`,
    [
      ids.jobId,
      organizationId,
      ids.runStepId,
      action,
      JSON.stringify({ capabilities }),
      JSON.stringify(jobInput),
      now,
      options.priority ?? 50,
      action === "secret.identity.read" ? 1 : 3,
      context?.applicationId ?? null,
      context?.repositoryId ?? null,
      context?.id ?? null,
      context?.revision ?? null,
      context?.digest ?? null,
      JSON.stringify(skillRefs),
      fixtureAgentConfig === null ? null : ids.agentVersionId,
      JSON.stringify(fixtureAgentConfig ?? {}),
    ],
  );
  return ids;
}

export async function readExecutionState(
  database: PgDatabase,
  jobId: string,
): Promise<ExecutionState> {
  const result = await database.query<{
    jobStatus: string;
    currentFence: string;
    cancelRequestedAt: string | null;
    runStatus: string;
    finishedAt: string | null;
    stepStatus: string;
    output: unknown;
    error: unknown;
  }>(
    `select job.status as "jobStatus",
            job.current_fence::text as "currentFence",
            job.cancel_requested_at::text as "cancelRequestedAt",
            run.status as "runStatus", run.finished_at::text as "finishedAt",
            step.status as "stepStatus", step.output, step.error
       from bakery.jobs as job
       join bakery.run_steps as step on step.id = job.run_step_id
       join bakery.workflow_runs as run on run.id = step.run_id
      where job.id = $1`,
    [jobId],
  );
  assertExists(result.rows[0]);
  const attempts = await database.query<ExecutionState["attempts"][number]>(
    `select id, worker_host_id as "workerHostId", fence::text,
            status, last_event_seq::text as "lastEventSeq",
            lease_expires_at::text as "leaseExpiresAt", result
       from bakery.job_attempts
      where job_id = $1
      order by attempt_no, id`,
    [jobId],
  );
  const events = await database.query<ExecutionState["events"][number]>(
    `select event.id, event.local_seq::text as "localSeq",
            event.event_type as "eventType", event.payload,
            event.payload_digest as "payloadDigest", event.saved_ack as "savedAck"
       from bakery.attempt_events as event
       join bakery.job_attempts as attempt on attempt.id = event.attempt_id
      where attempt.job_id = $1
      order by event.local_seq, event.id`,
    [jobId],
  );
  return {
    job: {
      status: result.rows[0].jobStatus,
      currentFence: result.rows[0].currentFence,
      cancelRequestedAt: result.rows[0].cancelRequestedAt,
    },
    run: {
      status: result.rows[0].runStatus,
      finishedAt: result.rows[0].finishedAt,
    },
    step: {
      status: result.rows[0].stepStatus,
      output: result.rows[0].output,
      error: result.rows[0].error,
    },
    attempts: attempts.rows,
    events: events.rows,
  };
}

export async function problemCode(response: Response): Promise<string> {
  const body = await response.json() as { code?: string };
  assert(
    typeof body.code === "string",
    "standard problem response must include code",
  );
  return body.code;
}

export async function expireAndSupersedeAttempt(
  database: PgDatabase,
  jobId: string,
): Promise<{ attemptId: string; fence: string; leaseToken: string }> {
  const attempt = await database.query<{
    id: string;
    fence: string;
    leaseToken: string;
  }>(
    `select id, fence::text, '' as "leaseToken"
       from bakery.job_attempts
      where job_id = $1
      order by attempt_no desc
      limit 1`,
    [jobId],
  );
  assertExists(attempt.rows[0]);
  await database.query(
    `update bakery.job_attempts
        set status = 'lost', lease_expires_at = now() - interval '1 minute'
      where id = $1`,
    [attempt.rows[0].id],
  );
  await database.query(
    `update bakery.jobs
        set current_fence = current_fence + 1,
            status = 'queued', updated_at = now()
      where id = $1`,
    [jobId],
  );
  return {
    attemptId: attempt.rows[0].id,
    fence: attempt.rows[0].fence,
    leaseToken: "",
  };
}

export async function updateAttemptExpiry(
  database: PgDatabase,
  attemptId: string,
): Promise<void> {
  await database.query(
    `update bakery.job_attempts
        set lease_expires_at = now() - interval '1 minute'
      where id = $1`,
    [attemptId],
  );
}

export async function setAttemptExpiryAfter(
  database: PgDatabase,
  attemptId: string,
  milliseconds: number,
): Promise<void> {
  await database.query(
    `update bakery.job_attempts
        set lease_expires_at =
          clock_timestamp() + ($2::integer * interval '1 millisecond')
      where id = $1`,
    [attemptId, milliseconds],
  );
}

export async function waitForWorkerHostLockWait(
  database: PgDatabase,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    const result = await database.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_stat_activity
         where wait_event_type = 'Lock'
           and state = 'active'
           and cardinality(pg_blocking_pids(pid)) > 0
       ) as waiting`,
    );
    if (result.rows[0]?.waiting) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error("WORKER_HOST_LOCK_WAIT_NOT_OBSERVED");
}

export async function withWorkerHostLock<T>(
  database: PgDatabase,
  workerHostId: string,
  work: (release: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await client.query("rollback");
    } finally {
      client.release();
    }
  };
  try {
    await client.query("begin");
    await client.query(
      `select id
         from bakery.worker_hosts
        where id = $1
        for update`,
      [workerHostId],
    );
    return await work(release);
  } finally {
    await release();
  }
}
