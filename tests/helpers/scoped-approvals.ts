import {
  type CoordinationFixture,
  type FixturePrincipal,
  openCoordinationFixture,
} from "./coordination-fixture.ts";
import { cleanupAuthFixture } from "./auth.ts";
import { publishCoordinatorVersion } from "./coordinator-turns.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import type {
  CoordinatorEffect,
  CoordinatorTurnExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import { processNextConversationTurn } from "../../apps/server/src/modules/conversation/turn-runtime.ts";

export type ApprovalView = {
  id: string;
  kind: string;
  status: string;
  version: number;
  taskId: string;
  conversationId: string;
  subjectType: string;
  subjectId: string;
  subjectDigest: string;
  policyDigest: string;
  scope: { stage: string };
  decision: string | null;
  consumedByRunId: string | null;
  runId: string | null;
  expiresAt: string | null;
};
export type PlanRevisionView = {
  id: string;
  taskId: string;
  revision: number;
  digest: string;
  status: string;
  supersedesRevision: number | null;
  body: { title: string; steps: unknown[]; repositoryId: string | null };
};

export const HUMAN_APPROVAL = { plan: "human_approval" } as const;

export const PLAN_EFFECT = (title: string): CoordinatorEffect => ({
  type: "planRevision",
  title,
  steps: [{ id: "s1", title: "Do the work", detail: "Exactly as described." }],
});

export function scripted(
  ...effects: CoordinatorEffect[]
): CoordinatorTurnExecutor {
  return {
    execute: () => Promise.resolve({ status: "completed", effects }),
  };
}

type Identity = { cookie: string } | { bearer: string };

export type Call = (
  identity: Identity,
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  options?: {
    body?: unknown;
    key?: string;
    organizationId?: string;
    ifMatch?: number;
  },
) => Promise<Response>;

/** Real Postgres and the production Hono composition, with approval helpers. */
export async function openApprovalFixture() {
  const fx = await openCoordinationFixture();
  await publishCoordinatorVersion(
    {
      pgDatabase: fx.ownerPg,
      config: { auth: { secret: "unused" } },
      app: { fetch: () => new Response(null, { status: 500 }) },
    },
    fx.organizationId,
    fx.admin.principalId,
    1,
  );
  const cookies = new Map<string, string>();
  const tokenEmails: string[] = [];
  const cookie = async (principal: FixturePrincipal) => {
    const known = cookies.get(principal.principalId);
    if (known) return known;
    const made = await fx.cookieFor(principal);
    cookies.set(principal.principalId, made);
    return made;
  };

  const call: Call = async (identity, method, path, options = {}) => {
    const headers = new Headers({
      "Bakery-Organization-Id": options.organizationId ?? fx.organizationId,
    });
    if ("cookie" in identity) {
      headers.set("cookie", identity.cookie);
      if (method !== "GET") headers.set("origin", fx.publicBaseUrl);
    } else {
      headers.set("authorization", `Bearer ${identity.bearer}`);
    }
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (method !== "GET") {
      headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
    }
    if (options.ifMatch !== undefined) {
      headers.set("If-Match", `"${options.ifMatch}"`);
    }
    return await fx.productionApp.fetch(
      new Request(`${fx.publicBaseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      }),
    );
  };
  const as = async (principal: FixturePrincipal) => ({
    cookie: await cookie(principal),
  });

  /** A repository-bound draft task; `policy` null leaves the legacy policy. */
  const newTask = async (
    options: {
      policy?: unknown;
      planningOnly?: boolean;
      title?: string;
    } = {},
  ) => {
    const taskId = await fx.insertTask(options.title ?? "Approval task", {
      repo: "api",
    });
    if (options.policy !== undefined || options.planningOnly) {
      await fx.owner`
        update bakery.tasks
           set approval_policy = ${
        options.policy === undefined
          ? null
          : fx.owner.json(options.policy as never)
      },
               planning_only = ${options.planningOnly ?? false}
         where organization_id = ${fx.organizationId} and id = ${taskId}`;
    }
    const conversation = await fx.owner<{ conversation_id: string }[]>`
      select conversation_id from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${taskId}`;
    return { taskId, conversationId: conversation[0].conversation_id };
  };

  /** Sends an agent request and runs its turn with the given scripted effects. */
  const askAgent = async (
    task: { conversationId: string },
    effects: CoordinatorEffect[],
    text = "plan this",
  ) => {
    const sent = await call(
      await as(fx.admin),
      "POST",
      `/v1/conversations/${task.conversationId}/messages`,
      {
        body: {
          body: text,
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
        },
      },
    );
    if (sent.status !== 201) {
      throw new Error(`message failed ${sent.status}: ${await sent.text()}`);
    }
    return await processNextConversationTurn(
      {
        database: fx.appPg,
        executor: scripted(...effects),
        leaseMs: 60_000,
        heartbeatMs: 100,
      },
      {
        organizationId: fx.organizationId,
        conversationId: task.conversationId,
      },
    );
  };

  const approvalsFor = async (taskId: string): Promise<ApprovalView[]> => {
    const response = await call(
      await as(fx.developer),
      "GET",
      `/v1/approvals?taskId=${taskId}&limit=100`,
    );
    const body = await response.json() as { items: ApprovalView[] };
    return body.items.reverse();
  };
  const revisionsFor = async (taskId: string): Promise<PlanRevisionView[]> => {
    const response = await call(
      await as(fx.developer),
      "GET",
      `/v1/plan-revisions?taskId=${taskId}&limit=100`,
    );
    const body = await response.json() as { items: PlanRevisionView[] };
    return body.items.reverse();
  };
  const getApproval = async (id: string): Promise<ApprovalView> => {
    const response = await call(
      await as(fx.developer),
      "GET",
      `/v1/approvals/${id}`,
    );
    if (response.status !== 200) {
      throw new Error(`approval read ${response.status}`);
    }
    return await response.json() as ApprovalView;
  };

  const decide = async (
    approval: { id: string; version: number },
    decision: "approve" | "request_changes" | "reject",
    options: {
      identity?: Identity;
      comment?: string;
      expectedVersion?: number;
      key?: string;
    } = {},
  ) =>
    await call(
      options.identity ?? await as(fx.developer),
      "POST",
      `/v1/approvals/${approval.id}/decision`,
      {
        key: options.key,
        body: {
          decision,
          ...(options.comment === undefined
            ? {}
            : { comment: options.comment }),
          expectedVersion: options.expectedVersion ?? approval.version,
        },
      },
    );

  const revoke = async (
    approval: { id: string },
    identity?: Identity,
  ) =>
    await call(
      identity ?? await as(fx.developer),
      "POST",
      `/v1/approvals/${approval.id}/revoke`,
      { body: {} },
    );

  /** Plans, then approves the proposed revision; returns the approved approval. */
  const approvedPlan = async (
    task: { taskId: string; conversationId: string },
    title = "Plan",
  ) => {
    await askAgent(task, [PLAN_EFFECT(title)]);
    const [approval] = (await approvalsFor(task.taskId)).slice(-1);
    const response = await decide(approval, "approve");
    if (response.status !== 200) {
      throw new Error(`approve failed ${response.status}`);
    }
    return await response.json() as ApprovalView;
  };

  const startRun = async (
    taskId: string,
    options: {
      approvalId?: string;
      identity?: Identity;
      repositoryProfileId?: string;
      key?: string;
    } = {},
  ) => {
    const pinned = await fx.owner`
      select repository_profile_id as id from bakery.tasks
       where organization_id = ${fx.organizationId} and id = ${taskId}`;
    return await call(
      options.identity ?? await as(fx.developer),
      "POST",
      `/v1/tasks/${taskId}/runs`,
      {
        key: options.key,
        body: {
          workflowVersionId: fx.workflowVersionId,
          repositoryProfileId: options.repositoryProfileId ?? pinned[0].id,
          executionMode: "repository",
          budgetLimitUsd: "0.005000",
          inputs: { taskId },
          ...(options.approvalId === undefined
            ? {}
            : { approvalId: options.approvalId }),
        },
      },
    );
  };

  const runCount = async (taskId: string) => {
    const rows = await fx.owner<{ count: string }[]>`
      select count(*)::text as count from bakery.workflow_runs
       where organization_id = ${fx.organizationId} and task_id = ${taskId}`;
    return Number(rows[0].count);
  };

  /** A bearer token for a principal of the given type, live-capped by its developer role. */
  const tokenFor = async (
    type: "service" | "worker" | "human",
    options: { role?: string; organizationId?: string } = {},
  ) => {
    const organizationId = options.organizationId ?? fx.organizationId;
    const principalId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const now = new Date();
    if (type === "human") {
      tokenEmails.push(`token-${userId}@example.test`);
      await fx.owner`
        insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${userId}, 'token human', ${`token-${userId}@example.test`}, true, ${now}, ${now})`;
    }
    await fx.owner`
      insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${
      type === "human" ? userId : null
    }, ${`token ${type}`}, ${type})`;
    await fx.owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
      ) values (${crypto.randomUUID()}, ${organizationId}, ${principalId}, ${
      options.role ?? "developer"
    }, 'active', ${now}, ${now}, ${now}, 1)`;
    const body = btoa(
      String.fromCharCode(
        ...crypto.getRandomValues(new Uint8Array(32)),
      ),
    ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const secret = `bky_${body}`;
    await fx.owner`
      insert into bakery.access_tokens (
        organization_id, principal_id, created_by_principal_id, name, prefix,
        secret_sha256, scopes, expires_at
      ) values (${organizationId}, ${principalId}, ${fx.admin.principalId},
        'approval test', ${secret.slice(0, 12)}, ${await sha256Hex(secret)},
        ${["bakery:read", "bakery:operate"]}, ${new Date(
      now.getTime() + 3_600_000,
    )})`;
    return { bearer: secret, principalId };
  };

  return {
    fx,
    call,
    as,
    newTask,
    askAgent,
    approvalsFor,
    revisionsFor,
    getApproval,
    decide,
    revoke,
    approvedPlan,
    startRun,
    runCount,
    tokenFor,
    close: async () => {
      try {
        await cleanupAuthFixture(fx.ownerPg, tokenEmails);
      } finally {
        await fx.close();
      }
    },
  };
}

export type ApprovalFixture = Awaited<ReturnType<typeof openApprovalFixture>>;
export type { CoordinationFixture };
