import { seedProviderPricingSnapshot } from "./funded-model-job.ts";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { reserveCoordinatorTurn } from "../../apps/server/src/modules/work/budget.ts";
import { enqueueCoordinatorTurnJob } from "../../packages/persistence/src/coordinator-jobs.ts";
import { buildCoordinatorTurnJobInput } from "../../packages/contracts/src/coordinator-turn.ts";
import type { BillingConfig } from "../../packages/contracts/src/contracts.ts";

type Db = PgDatabase;

export const policy = {
  installationMonthlyLimitUsd: "1.000000",
  reservationTtlSeconds: 3_600,
  maxRunDurationSeconds: 86_400,
} as const;

export const billing = {
  provider: "anthropic",
  billingAccountId: "coordinator-turn-jobs-test",
  model: "claude-opus-5-5",
  billingRoute: "subscription",
  maxTokens: 8_000,
  maxUsdReservation: 0.25,
  pricingMetadataSnapshot: "coordinator-turn-jobs-price-v1",
} satisfies BillingConfig;

export type ScopeSeed = Readonly<{
  organizationId: string;
  principalId: string;
  applicationId: string;
  repositoryId: string;
  conversationId: string;
}>;

export type Scope = Readonly<{
  seed: ScopeSeed;
  turnId: string;
  agentVersionId: string;
  agentConfig: Record<string, unknown>;
}>;

/** Application, repository and conversation inside an existing organization. */
export async function seedConversation(
  db: Db,
  organizationId: string,
  principalId: string,
  label: string,
): Promise<ScopeSeed> {
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await db.query(
    `insert into bakery.applications (id, organization_id, slug, name, description)
     values ($1, $2, $3, $4, '')`,
    [applicationId, organizationId, `${label}-${applicationId}`, label],
  );
  await db.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch, version
     ) values ($1, $2, $3, $4, $5, 'bakery', $6, 'main', 1)`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `${label}/${repositoryId}`,
      label,
    ],
  );
  await db.query(
    `insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      organizationId,
      applicationId,
      repositoryId,
      label,
      principalId,
    ],
  );
  return {
    organizationId,
    principalId,
    applicationId,
    repositoryId,
    conversationId,
  };
}

/** Coordinator definition, one active version, and one active pinned turn. */
export async function seedAgentAndTurn(
  db: Db,
  seed: ScopeSeed,
  config: BillingConfig = billing,
  agentConfigOverride?: Record<string, unknown>,
): Promise<Scope> {
  await seedProviderPricingSnapshot(db, { billing: config });
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  const agentConfig = agentConfigOverride ?? {
    harness: "claude_code",
    billing: config,
    allowedCapabilities: ["model"],
  };
  await db.query(
    `insert into bakery.agent_definitions (id, organization_id, slug, name, enabled)
     values ($1, $2, 'coordinator', 'Coordinator', true)`,
    [agentId, seed.organizationId],
  );
  await db.query(
    `insert into bakery.agent_versions (id, organization_id, agent_id, revision, config, digest, created_by)
     values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      agentVersionId,
      seed.organizationId,
      agentId,
      JSON.stringify(agentConfig),
      `digest-${agentVersionId}`,
      seed.principalId,
    ],
  );
  await db.query(
    `update bakery.agent_definitions set active_version_id = $3
      where organization_id = $1 and id = $2`,
    [seed.organizationId, agentId, agentVersionId],
  );
  const messageId = crypto.randomUUID();
  await db.query(
    `insert into bakery.messages (
       id, organization_id, conversation_id, author_id, message_type, body,
       client_message_id, sequence, intent
     ) values ($1, $2, $3, $4, 'user', 'plan it', $5, 1, 'agent_request')`,
    [
      messageId,
      seed.organizationId,
      seed.conversationId,
      seed.principalId,
      crypto.randomUUID(),
    ],
  );
  const turnId = crypto.randomUUID();
  await db.query(
    `insert into bakery.conversation_turns (
       id, organization_id, conversation_id, trigger_message_id, status,
       context_through_sequence, agent_version_id
     ) values ($1, $2, $3, $4, 'active', 1, $5)`,
    [
      turnId,
      seed.organizationId,
      seed.conversationId,
      messageId,
      agentVersionId,
    ],
  );
  return { seed, turnId, agentVersionId, agentConfig };
}

export function jobInput(scope: Scope) {
  return buildCoordinatorTurnJobInput({
    turnId: scope.turnId,
    conversationId: scope.seed.conversationId,
    contextThroughSequence: "1",
    messages: [{
      sequence: "1",
      authorId: scope.seed.principalId,
      messageType: "user",
      intent: "agent_request",
      body: "plan it",
    }],
    scope: {
      applicationId: scope.seed.applicationId,
      repositoryId: scope.seed.repositoryId,
      taskId: null,
    },
    openQuestions: [],
    currentPlanRevision: null,
  });
}

/** Reserve then enqueue in one transaction on the application role. */
export async function fund(
  runtimeDb: Db,
  scope: Scope,
  options: { budget?: typeof policy | undefined; billing?: unknown } = {},
) {
  return await withPgTransaction(runtimeDb, async (tx) => {
    const reservation = await reserveCoordinatorTurn(tx, {
      organizationId: scope.seed.organizationId,
      turnId: scope.turnId,
      agentVersionId: scope.agentVersionId,
      billing: "billing" in options
        ? options.billing
        : scope.agentConfig.billing,
      policy: "budget" in options ? options.budget : policy,
    });
    const job = await enqueueCoordinatorTurnJob(tx, {
      organizationId: scope.seed.organizationId,
      turnId: scope.turnId,
      agentVersionId: scope.agentVersionId,
      agentConfig: scope.agentConfig,
      billing: scope.agentConfig.billing as Record<string, unknown>,
      installationReservationId: reservation.reservationId,
      input: jobInput(scope),
    });
    return { reservation, job };
  });
}

/**
 * Removes the coordinator rows a scope seeded so the organization deletes
 * cleanly: jobs (restrict FK to turns), turns, messages, agent versions.
 */
export async function cleanupCoordinatorScopes(
  db: Db,
  organizationId: string,
): Promise<void> {
  const params = [organizationId];
  // Give held coordinator funding back to the shared installation account.
  await db.query(
    `with released as (
       update bakery.budget_reservations
          set status = 'released', updated_at = now(), version = version + 1
        where organization_id = $1 and status = 'held'
          and dedupe_key like 'coordinator-turn:%'
        returning budget_account_id, reserved_usd
     ), totals as (
       select budget_account_id, sum(reserved_usd) as amount
         from released group by budget_account_id
     )
     update bakery.budget_accounts account
        set reserved_usd = account.reserved_usd - totals.amount
       from totals
      where account.id = totals.budget_account_id`,
    params,
  );
  await db.query(
    `delete from bakery.attempt_events where organization_id = $1`,
    params,
  );
  await db.query(
    `delete from bakery.job_attempts where organization_id = $1`,
    params,
  );
  await db.query(
    `delete from bakery.jobs
      where organization_id = $1 and conversation_turn_id is not null`,
    params,
  );
  await db.query(
    `delete from bakery.conversation_turns where organization_id = $1`,
    params,
  );
  await db.query(
    `delete from bakery.messages where organization_id = $1`,
    params,
  );
  await db.query(
    `update bakery.agent_definitions set active_version_id = null
      where organization_id = $1`,
    params,
  );
  await db.query(
    `delete from bakery.agent_versions where organization_id = $1`,
    params,
  );
  await db.query(
    `delete from bakery.agent_definitions where organization_id = $1`,
    params,
  );
}
