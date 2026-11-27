import { ConversationImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { z } from "zod";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import {
  authorize,
  isOrganizationMember,
  permissionForAction,
} from "../auth/application/authorize.ts";
import { createConversationWithEvents } from "../conversation/conversations.ts";
import {
  assertMessageBodySize,
  lockConversationScope,
} from "../conversation/postgres.ts";
import { queueAgentRequest } from "../conversation/questions.ts";
import {
  isSlackAppId,
  isSlackEnterpriseId,
  isSlackTeamId,
  isSlackUserId,
  type SlackInstallation,
} from "./slack-scope.ts";
import { lockSlackIdentityLink } from "./slack-identity-links.ts";
import { SLACK_IGNORE_REASONS, SLACK_REMOVAL_CAUSES } from "./slack-request.ts";
import { markSlackConnectionsRemoved } from "./slack-removal.ts";

export const SLACK_RECEIPT_RETENTION_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9]{3,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export type SlackInstallationStatus = "active" | "disabled";

export type SlackInstallationRecord = {
  readonly installationId: string;
  readonly organizationId: string;
  readonly appId: string;
  readonly teamId: string;
  readonly enterpriseId?: string;
  readonly botUserId: string;

  readonly signingSecretId: string | null;
  readonly status: SlackInstallationStatus;
};

type InstallationRow = {
  installationId: string;
  organizationId: string;
  appId: string;
  teamId: string;
  enterpriseId: string | null;
  botUserId: string;
  signingSecretId: string | null;
  status: SlackInstallationStatus;
};

const INSTALLATION_COLUMNS = `id as "installationId",
  organization_id as "organizationId", app_id as "appId", team_id as "teamId",
  enterprise_id as "enterpriseId", bot_user_id as "botUserId",
  signing_secret_id as "signingSecretId", status`;

function installationRecord(row: InstallationRow): SlackInstallationRecord {
  return {
    installationId: row.installationId,
    organizationId: row.organizationId,
    appId: row.appId,
    teamId: row.teamId,
    ...(row.enterpriseId === null ? {} : { enterpriseId: row.enterpriseId }),
    botUserId: row.botUserId,
    signingSecretId: row.signingSecretId,
    status: row.status,
  };
}

export type RegisterSlackInstallationResult =
  | {
    readonly ok: true;
    readonly created: boolean;
    readonly reclaimed?: true;
    readonly installation: SlackInstallationRecord;
  }
  | {
    readonly ok: false;

    readonly reason: "malformed" | "claimed_elsewhere";
  };

export async function registerSlackInstallation(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly installation: SlackInstallation;
    readonly signingSecretId?: string;
  },
): Promise<RegisterSlackInstallationResult> {
  const { organizationId, installation, signingSecretId } = input;
  if (
    !isUuid(organizationId) || !isSlackAppId(installation.appId) ||
    !isSlackTeamId(installation.teamId) ||
    !isSlackUserId(installation.botUserId) ||
    (installation.enterpriseId !== undefined &&
      !isSlackEnterpriseId(installation.enterpriseId)) ||
    (signingSecretId !== undefined && !isUuid(signingSecretId))
  ) return { ok: false, reason: "malformed" };

  const insert = () =>
    transaction.query<InstallationRow>(
      `insert into bakery.slack_installations (
         id, organization_id, app_id, team_id, enterprise_id, bot_user_id,
         signing_secret_id, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'active')
       on conflict (app_id, team_id) where status = 'active' do nothing
       returning ${INSTALLATION_COLUMNS}`,
      [
        crypto.randomUUID(),
        organizationId,
        installation.appId,
        installation.teamId,
        installation.enterpriseId ?? null,
        installation.botUserId,
        signingSecretId ?? null,
      ],
    );
  const existing = await transaction.query<InstallationRow>(
    `select ${INSTALLATION_COLUMNS} from bakery.slack_installations
      where app_id = $1 and team_id = $2
      order by status = 'active' desc, organization_id = $3 desc
      for update`,
    [installation.appId, installation.teamId, organizationId],
  );
  const held = existing.rows[0];
  if (held?.status === "active" || held?.organizationId === organizationId) {
    return held.organizationId === organizationId
      ? { ok: true, created: false, installation: installationRecord(held) }
      : { ok: false, reason: "claimed_elsewhere" };
  }
  if (held !== undefined && await holderStillConnected(transaction, held)) {
    return { ok: false, reason: "claimed_elsewhere" };
  }
  const inserted = await insert();
  const made = inserted.rows[0];
  if (made === undefined) {
    return await registerSlackInstallation(transaction, input);
  }
  return {
    ok: true,
    created: true,
    ...(held === undefined ? {} : { reclaimed: true as const }),
    installation: installationRecord(made),
  };
}

async function holderStillConnected(
  transaction: PgTransactionClient,
  holder: InstallationRow,
): Promise<boolean> {
  const live = await transaction.query(
    `select 1 from bakery.integration_connections connection
       join bakery.integration_installations installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1
        and installation.external_authorization_id = $2
        and connection.status <> 'revoked'
      limit 1`,
    [holder.organizationId, holder.teamId],
  );
  return live.rows.length > 0;
}

export async function connectSlackInstallation(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly installation: SlackInstallation;
    readonly signingSecretId: string | null;
  },
): Promise<RegisterSlackInstallationResult> {
  const registered = await registerSlackInstallation(transaction, {
    organizationId: input.organizationId,
    installation: input.installation,
    ...(input.signingSecretId === null
      ? {}
      : { signingSecretId: input.signingSecretId }),
  });
  if (!registered.ok || registered.created) return registered;
  const current = registered.installation;
  const updated = await transaction.query<InstallationRow>(
    `update bakery.slack_installations
        set signing_secret_id = $3, status = 'active', updated_at = now(),
            version = version + 1
      where id = $1 and organization_id = $2
      returning ${INSTALLATION_COLUMNS}`,
    [current.installationId, input.organizationId, input.signingSecretId],
  );
  return {
    ok: true,
    created: false,
    installation: installationRecord(updated.rows[0]!),
  };
}

export async function followConnectionStatus(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly connectionId: string;
    readonly status: SlackInstallationStatus;
  },
): Promise<number> {
  const updated = await transaction.query(
    `update bakery.slack_installations as slack
        set status = $3, updated_at = now(), version = slack.version + 1
      where slack.organization_id = $1 and slack.status <> $3
        and not exists (
          select 1 from bakery.slack_installations other
           where $3 = 'active' and other.status = 'active'
             and other.app_id = slack.app_id and other.team_id = slack.team_id
             and other.id <> slack.id
        )
        and exists (
          select 1 from bakery.integration_connections connection
           join bakery.integration_installations installation
             on installation.id = connection.installation_id
          where connection.organization_id = $1 and connection.id = $2
            and installation.external_authorization_id = slack.team_id
        )`,
    [input.organizationId, input.connectionId, input.status],
  );
  return updated.rowCount ?? 0;
}

export async function adoptRegistrationSigningSecret(
  transaction: PgTransactionClient,
  input: { readonly registrationId: string; readonly signingSecretId: string },
): Promise<number> {
  const updated = await transaction.query(
    `update bakery.slack_installations as slack
        set signing_secret_id = $2, updated_at = now(),
            version = slack.version + 1
      where slack.signing_secret_id is null
        and exists (
          select 1 from bakery.integration_installations installation
           join bakery.integration_connections connection
             on connection.installation_id = installation.id
          where installation.registration_id = $1
            and installation.external_authorization_id = slack.team_id
            and connection.organization_id = slack.organization_id
            and connection.archived_at is null
        )`,
    [input.registrationId, input.signingSecretId],
  );
  return updated.rowCount ?? 0;
}

export async function findSlackInstallation(
  transaction: PgTransactionClient,
  input: { readonly appId: string; readonly teamId: string },
): Promise<SlackInstallationRecord | null> {
  if (!isSlackAppId(input.appId) || !isSlackTeamId(input.teamId)) return null;
  const result = await transaction.query<InstallationRow>(
    `select ${INSTALLATION_COLUMNS} from bakery.slack_installations
      where app_id = $1 and team_id = $2 and status = 'active'`,
    [input.appId, input.teamId],
  );
  const row = result.rows[0];
  return row === undefined ? null : installationRecord(row);
}

export type SlackReceiptOutcome = "accepted" | "ignored";

const SlackReceiptWorkFields = {
  eventId: z.string().regex(EVENT_ID).describe(
    "Slack event id shared by the verified envelope and durable receipt.",
  ),
  channelId: z.string().min(1).max(64).describe(
    "Slack channel containing the admitted message.",
  ),
  userId: z.string().refine(isSlackUserId, "Invalid Slack user id.").describe(
    "Slack user that authored the admitted message.",
  ),
  ts: z.string().min(1).max(64).describe(
    "Slack timestamp identifying the admitted message.",
  ),
  threadTs: z.string().min(1).max(64).describe(
    "Slack timestamp identifying the admitted message thread.",
  ),
  text: z.string().max(262_144).describe(
    "Verified Slack message text retained for later admission processing.",
  ),
};

const SlackIgnoredDecisionSchema = z.object({
  kind: z.literal("ignore").describe(
    "Marks a verified event that must not create work or retain message text.",
  ),
  reason: z.enum(SLACK_IGNORE_REASONS).describe(
    "Stable reason the verified event was excluded from work.",
  ),
}).strict().describe("Verified Slack event excluded before work persistence.");

const SlackMentionDecisionSchema = z.object({
  kind: z.literal("mention").describe(
    "Marks an app mention admitted for later processing.",
  ),
  ...SlackReceiptWorkFields,
}).strict().describe("Verified Slack app mention admitted as durable work.");

const SlackThreadReplyDecisionSchema = z.object({
  kind: z.literal("thread_reply").describe(
    "Marks a reply admitted only after a later binding-aware classifier proves its thread.",
  ),
  ...SlackReceiptWorkFields,
}).strict().describe("Verified and binding-authorized Slack thread reply.");

const SlackRemovedDecisionSchema = z.object({
  kind: z.literal("removed").describe(
    "Marks a verified event saying Slack removed Bakery from the workspace.",
  ),
  eventId: SlackReceiptWorkFields.eventId,
  cause: z.enum(SLACK_REMOVAL_CAUSES).describe(
    "Which Slack event removed Bakery: the app was uninstalled or its bot token revoked.",
  ),
  eventTime: z.number().int().nonnegative().nullable().describe(
    "Slack's event_time in Unix seconds; a removal dated before the workspace last connected is ignored.",
  ),
}).strict().describe(
  "Verified Slack removal that ends the workspace's connections as removed by Slack.",
);

export const PersistedSlackDecisionSchema = z.discriminatedUnion("kind", [
  SlackIgnoredDecisionSchema,
  SlackRemovedDecisionSchema,
  SlackMentionDecisionSchema,
  SlackThreadReplyDecisionSchema,
]).describe(
  "Application-validated Slack receipt decision; ignored events carry no work fields.",
);

export type PersistedSlackDecision = z.output<
  typeof PersistedSlackDecisionSchema
>;

export type CommitSlackReceiptResult =
  | {
    readonly kind: "recorded";
    readonly receiptId: string;
    readonly outcome: SlackReceiptOutcome;
  }
  | {
    readonly kind: "duplicate";
    readonly receiptId: string;
    readonly outcome: SlackReceiptOutcome;
  }
  | { readonly kind: "conflict" }
  | { readonly kind: "inactive" }
  | { readonly kind: "malformed" };

type ActiveSlackInstallation = {
  readonly organizationId: string;
  readonly teamId: string;
  readonly connectedAt: Date;
};

type SlackReceiptWork = Exclude<
  PersistedSlackDecision,
  { readonly kind: "ignore" } | { readonly kind: "removed" }
>;
const PERMANENT_SLACK_ADMISSION_CODES = new Set([
  "AUTH_FORBIDDEN",
  "BODY_TOO_LARGE",
  "RESOURCE_NOT_FOUND",
]);
const PERMANENT_SLACK_STATE_CONFLICT_REASONS = new Set([
  "conversation_archived",
]);

function isPermanentSlackAdmissionError(error: unknown): boolean {
  if (!(error instanceof StandardError)) return false;
  if (PERMANENT_SLACK_ADMISSION_CODES.has(error.code)) return true;
  return error.code === "STATE_CONFLICT" &&
    PERMANENT_SLACK_STATE_CONFLICT_REASONS.has(String(error.params?.reason));
}

async function findOrCreateSlackConversation(
  transaction: PgTransactionClient,
  installation: ActiveSlackInstallation & { readonly installationId: string },
  principalId: string,
  work: SlackReceiptWork,
  requestId: string,
  traceId: string,
): Promise<string | null> {
  await transaction.query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `slack-thread:${installation.installationId}:${work.channelId}:${work.threadTs}`,
    ],
  );
  const existing = await transaction.query<{ conversationId: string }>(
    `select conversation_id as "conversationId"
       from bakery.slack_thread_bindings
      where organization_id = $1 and installation_id = $2
        and channel_id = $3 and thread_ts = $4`,
    [
      installation.organizationId,
      installation.installationId,
      work.channelId,
      work.threadTs,
    ],
  );
  if (existing.rows[0]) return existing.rows[0].conversationId;
  if (work.kind === "thread_reply") return null;
  const opened = await createConversationWithEvents(transaction, {
    organizationId: installation.organizationId,
    principalId,
    title: "Slack thread",
    requestId,
    traceId,
  });
  const conversationId = opened.id;
  await transaction.query(
    `insert into bakery.slack_thread_bindings (
       id, organization_id, installation_id, channel_id, thread_ts,
       conversation_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      installation.organizationId,
      installation.installationId,
      work.channelId,
      work.threadTs,
      conversationId,
      principalId,
    ],
  );
  return conversationId;
}

async function handoffSlackWork(
  transaction: PgTransactionClient,
  input: {
    readonly installation: ActiveSlackInstallation & {
      readonly installationId: string;
    };
    readonly appId: string;
    readonly eventId: string;
    readonly work: SlackReceiptWork;
  },
): Promise<boolean> {
  const link = await lockSlackIdentityLink(transaction, {
    organizationId: input.installation.organizationId,
    appId: input.appId,
    teamId: input.installation.teamId,
    userId: input.work.userId,
  });
  if (!link || link.state !== "active" || !link.memberCurrent) return false;
  const principal = await transaction.query(
    `select 1 from bakery.principals
      where id = $1 and disabled_at is null
      for share`,
    [link.principalId],
  );
  if (principal.rows.length !== 1) return false;
  const action = ConversationImplementedAction.MessagesCreate;
  const actor = await resolveOrganizationActor(
    transaction,
    toPrincipalId(link.principalId),
    toOrganizationId(input.installation.organizationId),
  );
  authorize(actor, permissionForAction(action), { action });
  assertMessageBodySize(input.work.text);
  if (!isOrganizationMember(actor)) return false;
  const requestId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const conversationId = await findOrCreateSlackConversation(
    transaction,
    input.installation,
    link.principalId,
    input.work,
    requestId,
    traceId,
  );
  if (conversationId === null) return false;
  const conversationScope = await lockConversationScope(
    transaction,
    input.installation.organizationId,
    conversationId,
    "update",
  );
  await queueAgentRequest(transaction, {
    organizationId: input.installation.organizationId,
    conversationId,
    authorId: link.principalId,
    messageType: "human",
    body: input.work.text,
    clientMessageId: `slack:${input.appId}:${input.eventId}`,
    scope: {
      application_id: conversationScope.applicationId,
      repository_id: conversationScope.repositoryId,
      task_id: null,
    },
    traceId,
    audit: { principalId: link.principalId, requestId },
  });
  return true;
}

export async function commitSlackReceipt(
  transaction: PgTransactionClient,
  input: {
    readonly installationId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly decision: PersistedSlackDecision;
    readonly now: Date;
  },
): Promise<CommitSlackReceiptResult> {
  if (
    !isUuid(input.installationId) || !isSlackAppId(input.appId) ||
    !EVENT_ID.test(input.eventId) || !DIGEST.test(input.payloadDigest) ||
    Number.isNaN(input.now.getTime()) ||
    !PersistedSlackDecisionSchema.safeParse(input.decision).success
  ) return { kind: "malformed" };
  const work = input.decision.kind === "ignore" ? null : input.decision;
  if (work !== null && work.eventId !== input.eventId) {
    return { kind: "malformed" };
  }
  const found = await transaction.query<ActiveSlackInstallation>(
    `select organization_id as "organizationId", team_id as "teamId",
            updated_at as "connectedAt"
       from bakery.slack_installations
      where app_id = $1 and id = $2 and status = 'active'
      for share`,
    [input.appId, input.installationId],
  );
  const active = found.rows[0];
  if (!active) return { kind: "inactive" };
  const receiptId = crypto.randomUUID();
  const outcome: SlackReceiptOutcome = work === null ? "ignored" : "accepted";
  const status = work === null ? "ignored" : "pending";
  const expiresAt = new Date(
    input.now.getTime() + SLACK_RECEIPT_RETENTION_DAYS * 86_400_000,
  );
  const inserted = await transaction.query(
    `insert into bakery.slack_event_receipts (
       id, app_id, event_id, installation_id, payload_digest, outcome,
       status, received_at, processed_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (app_id, event_id) do nothing`,
    [
      receiptId,
      input.appId,
      input.eventId,
      input.installationId,
      input.payloadDigest,
      outcome,
      status,
      input.now,
      work === null ? input.now : null,
      expiresAt,
    ],
  );
  if (inserted.rowCount !== 1) {
    const existing = await transaction.query<{
      id: string;
      payloadDigest: string;
      outcome: SlackReceiptOutcome;
    }>(
      `select id, payload_digest as "payloadDigest", outcome
         from bakery.slack_event_receipts
        where app_id = $1 and event_id = $2`,
      [input.appId, input.eventId],
    );
    const row = existing.rows[0]!;
    return row.payloadDigest === input.payloadDigest
      ? { kind: "duplicate", receiptId: row.id, outcome: row.outcome }
      : { kind: "conflict" };
  }
  if (work === null) return { kind: "recorded", receiptId, outcome };
  let handedOff = false;
  if (work.kind === "removed") {
    const stale = work.eventTime !== null &&
      work.eventTime <
        Math.floor(new Date(active.connectedAt).getTime() / 1000);
    if (!stale) {
      await markSlackConnectionsRemoved(transaction, {
        organizationId: active.organizationId,
        teamId: active.teamId,
        eventId: input.eventId,
        cause: work.cause,
      });
    }
    handedOff = !stale;
  } else {
    try {
      handedOff = await handoffSlackWork(transaction, {
        installation: { ...active, installationId: input.installationId },
        appId: input.appId,
        eventId: input.eventId,
        work,
      });
    } catch (error) {
      if (!isPermanentSlackAdmissionError(error)) throw error;
    }
  }
  const settledOutcome: SlackReceiptOutcome = handedOff
    ? "accepted"
    : "ignored";
  await transaction.query(
    `update bakery.slack_event_receipts
        set outcome = $2, status = $3, processed_at = $4, expires_at = $5
      where id = $1`,
    [
      receiptId,
      settledOutcome,
      handedOff ? "completed" : "ignored",
      input.now,
      expiresAt,
    ],
  );
  return { kind: "recorded", receiptId, outcome: settledOutcome };
}

export type SlackReceiptSweepResult = {
  readonly deleted: number;
  readonly batches: number;
};

export async function sweepExpiredSlackReceipts(
  database: Pick<PgTransactionClient, "query">,
  input: {
    readonly now: Date;
    readonly limit: number;
    readonly maxBatches?: number;
  },
): Promise<SlackReceiptSweepResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 5000);
  const maxBatches = Math.min(
    Math.max(Math.trunc(input.maxBatches ?? 100), 1),
    1000,
  );
  const result = { deleted: 0, batches: 0 };
  while (result.batches < maxBatches) {
    const removed = await database.query(
      `with doomed as materialized (
         select id from bakery.slack_event_receipts
          where expires_at <= $1
            and status in ('completed', 'ignored', 'failed')
          order by expires_at, id
          limit $2
          for update skip locked
       )
       delete from bakery.slack_event_receipts receipt
        using doomed where receipt.id = doomed.id`,
      [input.now, limit],
    );
    const count = removed.rowCount ?? 0;
    if (count === 0) break;
    result.deleted += count;
    result.batches += 1;
    if (count < limit) break;
  }
  return result;
}
