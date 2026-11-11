import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { persistAssignmentRejectionBudgetEvidence } from "../../packages/persistence/src/budget-release.ts";
import {
  createEffectExecutor,
  type EffectExecutor,
  type EffectExecutorDeps,
} from "../../apps/server/src/modules/effects/index.ts";
import type { ClaimDeps } from "../../apps/server/src/modules/effects/claim.ts";
import type { IntegrationInvokeDeps } from "../../apps/server/src/modules/catalog/integration-invoke.ts";
import {
  admitFundedModelRun as admit,
  seedAdmissibleRun as seedRun,
  seedProviderPricingSnapshot,
} from "./funded-model-job.ts";
import { prepareEffect } from "../../apps/server/src/modules/effects/index.ts";
import type { WorkerFixture } from "./worker-execution.ts";
import type { ProviderRequestPort } from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { opaqueCredential } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import { HOST_AUTH_PROFILES } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  type AuthoritySnapshotPort,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";

export const GITHUB_ACTION = "github.issue.comment.create";
export const GITHUB_ARGS = { issueNumber: 7, body: "hello" } as const;
export const GITHUB_BINDING = {
  owner: "bakery-org",
  repo: "bakery-repo",
  repositoryId: 1234,
  installationId: 987654,
  botUserId: 4242,
} as const;

export const effectRegistry = activateDeployedIntegrations(
  deployedIntegrations,
);

/** A fake authority port whose snapshot tests can edit between calls. */
export type EffectRig = Readonly<{
  organizationId: string;
  principalId: string;
  connectionId: string;
  resourceId: string;
  snapshot: { current: AuthoritySnapshot };
  port: AuthoritySnapshotPort & { loads: number };
  input(args?: Record<string, unknown>): {
    actionId: string;
    actionVersion: number;
    resourceId: string;
    arguments: Record<string, unknown>;
  };
  envelope: { actorRef: string; connectionId: string };
}>;

export function effectRig(
  organizationId: string,
  principalId: string,
): EffectRig {
  const connectionId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const grant = {
    grantId: crypto.randomUUID(),
    organizationId,
    connectionId,
    subjectType: "principal",
    subjectPrincipalId: principalId,
    direction: "out_of_bakery",
    capability: GITHUB_ACTION,
    actionVersion: 1,
    resourceId,
    revokedAt: null,
    policyRevision: 1,
  } as IntegrationGrantRecord;
  const snapshot: { current: AuthoritySnapshot } = {
    current: {
      organizationId,
      actor: {
        principalId,
        subjectType: "principal",
        active: true,
        permissions: ["integrationConnection:invoke"],
      },
      install: {
        id: "inst-1",
        providerId: "bakery.github",
        manifestDigest: effectRegistry.integrations[0]!.manifestDigest,
        enabled: true,
        approvedScopes: [],
      },
      connection: {
        id: connectionId,
        installId: "inst-1",
        state: "active",
        providerPermissions: { issues: "write" },
      },
      resource: {
        id: resourceId,
        kind: "github.repository",
        selected: true,
        available: true,
        binding: { ...GITHUB_BINDING },
        repositoryId: crypto.randomUUID(),
      },
      grants: [grant],
      policyRevision: 1,
    },
  };
  const port = {
    loads: 0,
    load() {
      port.loads++;
      return Promise.resolve(snapshot.current);
    },
  };
  return {
    organizationId,
    principalId,
    connectionId,
    resourceId,
    snapshot,
    port,
    input: (args = GITHUB_ARGS) => ({
      actionId: GITHUB_ACTION,
      actionVersion: 1,
      resourceId,
      arguments: { ...args },
    }),
    envelope: { actorRef: principalId, connectionId },
  };
}

/**
 * effectRig whose connection and resource exist: external_effects references
 * both (migration 0135), so a rig whose effects are inserted needs real rows.
 * Seeds the host GitHub App registration once (reusing one that exists), a
 * fresh installation, an enabled connection in `organizationId` and its
 * selected repository resource, under the rig's ids. The organization's
 * deletion removes the connection and resource; the registration and
 * installation leave with the principal's GitHub App rows.
 */
export async function seededEffectRig(
  db: PgDatabase,
  organizationId: string,
  principalId: string,
): Promise<EffectRig> {
  const rig = effectRig(organizationId, principalId);
  await seedRigIntegration(db, rig);
  return rig;
}

/** Inserts the connection and resource rows an effect rig names. */
export async function seedRigIntegration(
  db: PgDatabase,
  rig: Pick<
    EffectRig,
    "organizationId" | "principalId" | "connectionId" | "resourceId"
  >,
): Promise<void> {
  await withPgTransaction(db, async (tx) => {
    const existing = await tx.query<{ id: string }>(
      "select id from bakery.integration_app_registrations where provider = 'github'",
    );
    let registrationId = existing.rows[0]?.id;
    if (registrationId === undefined) {
      registrationId = crypto.randomUUID();
      const [clientSecretId, privateKeyId] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      await tx.query(
        `insert into bakery.secrets (id, name) values
           ($1, 'effect-rig-client-secret'), ($2, 'effect-rig-private-key')`,
        [clientSecretId, privateKeyId],
      );
      await tx.query(
        `insert into bakery.integration_app_registrations (
           id, provider, external_app_id, slug, name, client_id, owner_login,
           owner_id, owner_type, html_url, permissions, events,
           client_secret_id, private_key_secret_id, status, registered_by
         ) values ($1, 'github', 1, 'bakery-effect-rig', 'Bakery effect rig',
           'Iv1.effectrig', 'bakery-org', 1, 'Organization',
           'https://github.com/apps/bakery-effect-rig', '{}'::jsonb,
           '[]'::jsonb, $2, $3, 'registered', $4)`,
        [registrationId, clientSecretId, privateKeyId, rig.principalId],
      );
    }
    const installationId = crypto.randomUUID();
    // Unique per rig: installations outlive the organization.
    const externalId = String(1e12 + Math.floor(Math.random() * 9e12));
    const accountId = String(GITHUB_BINDING.botUserId);
    await tx.query(
      `insert into bakery.integration_installations (
         id, provider, registration_id, external_authorization_id,
         external_account_id, account_login, account_type,
         repository_selection, granted_permissions, status
       ) values ($1, 'github', $2, $3, $4, $5, 'Organization', 'selected',
         '{"issues":"write"}'::jsonb, 'enabled')`,
      [
        installationId,
        registrationId,
        externalId,
        accountId,
        GITHUB_BINDING.owner,
      ],
    );
    await tx.query(
      `insert into bakery.integration_connections (
         id, organization_id, provider, installation_id,
         external_authorization_id, external_account_id, label,
         adapter_version, granted_permissions, status, health, created_by
       ) values ($1, $2, 'github', $3, $4, $5, $6, 'github@effect-rig',
         '{"issues":"write"}'::jsonb, 'enabled', 'healthy', $7)`,
      [
        rig.connectionId,
        rig.organizationId,
        installationId,
        externalId,
        accountId,
        GITHUB_BINDING.owner,
        rig.principalId,
      ],
    );
    await tx.query(
      `insert into bakery.integration_resources (
         id, organization_id, connection_id, installation_id, kind,
         external_id, display_name, selected, enabled,
         last_discovery_generation
       ) values ($1, $2, $3, $4, 'repository', $5, $6, true, true, 1)`,
      [
        rig.resourceId,
        rig.organizationId,
        rig.connectionId,
        installationId,
        String(GITHUB_BINDING.repositoryId),
        `${GITHUB_BINDING.owner}/${GITHUB_BINDING.repo}`,
      ],
    );
  });
}

export type SeededApproval = Readonly<{
  approvalId: string;
  revisionId: string;
  stage: string;
  policyDigest: string;
}>;

/**
 * SQL-seeds an approved plan revision and an approval question bound to it.
 * Plan admission already consumes the one stage that exists, so tests that
 * need an unconsumed approval seed it directly and label themselves SYNTHETIC.
 */
export async function seedPlanApproval(
  db: PgDatabase,
  run: {
    organizationId: string;
    taskId: string;
    conversationId: string;
    runId: string;
  },
  options: {
    consumed?: boolean;
    stage?: string;
    policyDigest?: string;
    revision?: number;
  } = {},
): Promise<SeededApproval> {
  const stage = options.stage ?? "plan";
  // Real approvals carry sha-256 hex digests; the approvals API validates them.
  const sha = async (text: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  const policyDigest = options.policyDigest ?? await sha("effect-policy");
  const revisionId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const digest = await sha(`revision-${revisionId}`);
  await db.query(
    `insert into bakery.plan_revisions
       (id, organization_id, task_id, conversation_id, revision, body, digest, status)
     values ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 'approved')`,
    [
      revisionId,
      run.organizationId,
      run.taskId,
      run.conversationId,
      options.revision ?? 1,
      digest,
    ],
  );
  await db.query(
    `insert into bakery.questions
       (id, organization_id, kind, conversation_id, task_id, generation, prompt,
        status, decision, subject_type, subject_id, subject_digest, scope,
        policy_digest, consumed_at, consumed_by_run_id)
     values ($1, $2, 'approval', $3, $4, 1, 'approve the plan',
        $5, 'approve', 'plan_revision', $6, $7, $8::jsonb, $9,
        case when $10::boolean then now() end,
        case when $10::boolean then $11::uuid end)`,
    [
      approvalId,
      run.organizationId,
      run.conversationId,
      run.taskId,
      options.consumed ? "consumed" : "answered",
      revisionId,
      digest,
      JSON.stringify({ stage }),
      policyDigest,
      options.consumed === true,
      run.runId,
    ],
  );
  return { approvalId, revisionId, stage, policyDigest };
}

/** Claim collaborators over the rig's fake authority port. */
export function claimDepsFor(db: PgDatabase, rig: EffectRig): ClaimDeps {
  return {
    database: db,
    registry: effectRegistry,
    snapshotsFor: () => rig.port,
  };
}

/** How the fake GitHub answers a comment creation request. */
export type PostBehavior =
  | "ok"
  | "hang"
  | "unparseable"
  | "stored_then_500"
  | Readonly<{ status: number; headers?: Record<string, string> }>;

/** How the fake GitHub answers a comment listing request. */
export type ListBehavior = "normal" | "malformed";

type StoredComment = {
  id: number;
  body: string | null;
  user: { id: number; type: string } | null;
};

/** In-memory GitHub that records every request the broker sends. */
export type FakeGithub = {
  calls: { method: string; path: string }[];
  comments: StoredComment[];
  post: PostBehavior;
  list: ListBehavior;
  posts(): number;
  lists(): number;
  fetch: typeof fetch;
};

export function fakeGithub(): FakeGithub {
  let nextId = 5000;
  const fake: FakeGithub = {
    calls: [],
    comments: [],
    post: "ok",
    list: "normal",
    posts: () => fake.calls.filter((c) => c.method === "POST").length,
    lists: () => fake.calls.filter((c) => c.method === "GET").length,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      const method = init?.method ?? "GET";
      fake.calls.push({ method, path: url.pathname });
      if (method === "POST") {
        if (fake.post === "hang") {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (typeof fake.post === "object") {
          return Promise.resolve(
            new Response("{}", {
              status: fake.post.status,
              headers: fake.post.headers ?? {},
            }),
          );
        }
        if (fake.post === "unparseable") {
          return Promise.resolve(new Response("not json", { status: 201 }));
        }
        const body = JSON.parse(String(init?.body)) as { body: string };
        const comment: StoredComment = {
          id: nextId++,
          body: body.body,
          user: { id: GITHUB_BINDING.botUserId, type: "Bot" },
        };
        fake.comments.push(comment);
        if (fake.post === "stored_then_500") {
          return Promise.resolve(new Response("{}", { status: 500 }));
        }
        return Promise.resolve(Response.json(comment, { status: 201 }));
      }
      if (fake.list === "malformed") {
        return Promise.resolve(Response.json([{ id: "x" }]));
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "100");
      return Promise.resolve(
        Response.json(fake.comments.slice((page - 1) * size, page * size)),
      );
    }) as typeof fetch,
  };
  return fake;
}

/** Shared testing broker over the fake GitHub and the rig's authority port. */
function testBroker(
  rig: EffectRig,
  github: FakeGithub,
): { broker: ProviderRequestPort } {
  return {
    broker: createBrokerForTesting({
      registry: effectRegistry,
      credentials: {
        resolve: () => Promise.resolve(opaqueCredential("ghs_EXECUTOR_token")),
      },
      fetch: github.fetch,
      snapshotPort: rig.port,
      profiles: {
        "github-app": {
          ...HOST_AUTH_PROFILES["github-app"]!,
          origin: "http://127.0.0.1:1",
        },
      },
    }),
  };
}

/** Executor over the rig's authority and a real broker whose fetch is the fake GitHub. */
export function executorFor(
  db: PgDatabase,
  rig: EffectRig,
  github: FakeGithub,
  options: Partial<
    Pick<
      EffectExecutorDeps,
      "leaseSeconds" | "deadlineMs" | "maxDispatchGenerations"
    >
  > = {},
  providerRequests?: ProviderRequestPort,
): EffectExecutor {
  const { broker } = testBroker(rig, github);
  return createEffectExecutor({
    database: db,
    registry: effectRegistry,
    snapshotsFor: () => rig.port,
    providerRequests: providerRequests ?? broker,
    ...options,
  });
}

/**
 * Consumer-door collaborators: the same ledger stack as `executorFor` plus the
 * standalone snapshot port `invokeIntegration` authorizes sends against.
 */
export function consumerDepsFor(
  db: PgDatabase,
  rig: EffectRig,
  github: FakeGithub,
  options: Partial<
    Pick<
      EffectExecutorDeps,
      "leaseSeconds" | "deadlineMs" | "maxDispatchGenerations"
    >
  > = {},
): IntegrationInvokeDeps {
  const { broker } = testBroker(rig, github);
  return {
    database: db,
    registry: effectRegistry,
    snapshots: rig.port,
    snapshotsFor: () => rig.port,
    providerRequests: broker,
    ...options,
  };
}

/**
 * Makes an admitted, never-claimed job a budget release candidate: fails the
 * job, records the rejection audit event, persists the production evidence
 * row. Returns the evidence id `releaseWorkflowAction` takes.
 */
export async function persistReleaseEvidence(
  db: PgDatabase,
  run: Readonly<{
    organizationId: string;
    principalId: string;
    jobId: string;
    installationReservationId: string;
  }>,
): Promise<string> {
  return await withPgTransaction(db, async (tx) => {
    const job = (await tx.query<{ version: number }>(
      `update bakery.jobs
          set status = 'failed', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'queued'
        returning version`,
      [run.organizationId, run.jobId],
    )).rows[0];
    if (!job) throw new Error("RELEASE_EVIDENCE_REQUIRES_QUEUED_JOB");
    await tx.query(
      `insert into bakery.audit_events (
         organization_id, principal_id, operation, resource_type, resource_id,
         outcome, request_id, trace_id, details
       ) values (
         $1, $2, 'workers.claim.assignment_payload_rejected', 'job', $3,
         'denied', $4, $5, $6::jsonb
       )`,
      [
        run.organizationId,
        run.principalId,
        run.jobId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({
          code: "INVALID_ASSIGNMENT_PAYLOAD",
          version: job.version,
        }),
      ],
    );
    await persistAssignmentRejectionBudgetEvidence(tx, {
      organizationId: run.organizationId,
      jobId: run.jobId,
      jobVersion: job.version,
    });
    const evidence = (await tx.query<{ id: string }>(
      `select id from bakery.budget_release_evidence
        where organization_id = $1 and installation_reservation_id = $2`,
      [run.organizationId, run.installationReservationId],
    )).rows[0];
    if (!evidence) throw new Error("RELEASE_EVIDENCE_NOT_PERSISTED");
    return evidence.id;
  });
}

/** Test-side status flip for budget-hold cases; the executor owns real transitions. */
export async function forceEffectStatus(
  db: PgDatabase,
  organizationId: string,
  effectId: string,
  status: "prepared" | "submitted" | "uncertain" | "failed" | "confirmed",
): Promise<void> {
  await db.query(
    `update bakery.external_effects
        set status = $3, updated_at = now(), version = version + 1,
            failure_code = case when $3 = 'failed' then 'test_forced' else null end
      where organization_id = $1 and id = $2`,
    [organizationId, effectId, status],
  );
}

/**
 * A funded, admitted run plus an effect already prepared on it. `prepare`
 * adds more effects on the same step and reservation.
 */
export async function stageEffectRun(fixture: WorkerFixture, stepKey: string) {
  const db = fixture.pgDatabase;
  await seedProviderPricingSnapshot(db);
  const run = await admit(
    db,
    await seedRun(db, fixture.organizationId, fixture.principalId, {
      reservationUsd: "0.1",
      stepKey,
    }),
  );
  const rig = await seededEffectRig(
    db,
    fixture.organizationId,
    fixture.principalId,
  );
  let n = 0;
  const prepare = (extra: Record<string, unknown> = {}) =>
    prepareEffect({
      database: db,
      registry: effectRegistry,
      snapshots: rig.port,
    }, {
      organizationId: fixture.organizationId,
      envelope: rig.envelope,
      input: rig.input(),
      idempotencyKey: `${stepKey}-${n++}`,
      runStepId: run.runStepId,
      budgetReservationId: run.runReservationId,
      ...extra,
    });
  const prepared = await prepare();
  return { db, run, rig, prepare, effectId: prepared.effectId };
}

/** A broker aimed at a loopback origin, wrapped in the executor, for real-socket tests. */
export function loopbackExecutor(
  deps: Readonly<{
    database: PgDatabase;
    port: AuthoritySnapshotPort;
    origin: string;
    wrap?: (inner: ProviderRequestPort) => ProviderRequestPort;
    options?: Partial<
      Pick<
        EffectExecutorDeps,
        "leaseSeconds" | "deadlineMs" | "maxDispatchGenerations"
      >
    >;
  }>,
): EffectExecutor {
  const broker = createBrokerForTesting({
    registry: effectRegistry,
    credentials: {
      resolve: () => Promise.resolve(opaqueCredential("ghs_EXECUTOR_token")),
    },
    fetch,
    snapshotPort: deps.port,
    profiles: {
      "github-app": {
        ...HOST_AUTH_PROFILES["github-app"]!,
        origin: deps.origin,
      },
    },
  });
  return createEffectExecutor({
    database: deps.database,
    registry: effectRegistry,
    snapshotsFor: () => deps.port,
    providerRequests: deps.wrap ? deps.wrap(broker) : broker,
    ...deps.options,
  });
}
