import type { PgTransactionClient } from "@bakery/persistence";
import {
  isSlackAppId,
  isSlackEnterpriseId,
  isSlackTeamId,
  isSlackUserId,
  type SlackInstallation,
} from "./slack-scope.ts";
import type { SlackEventDecision } from "./slack-request.ts";

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

  const inserted = await transaction.query<InstallationRow>(
    `insert into bakery.slack_installations (
       id, organization_id, app_id, team_id, enterprise_id, bot_user_id,
       signing_secret_id, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'active')
     on conflict (app_id, team_id) do nothing
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
  if (inserted.rows.length === 1) {
    return {
      ok: true,
      created: true,
      installation: installationRecord(inserted.rows[0]!),
    };
  }
  const existing = await transaction.query<InstallationRow>(
    `select ${INSTALLATION_COLUMNS} from bakery.slack_installations
      where app_id = $1 and team_id = $2`,
    [installation.appId, installation.teamId],
  );
  const row = existing.rows[0]!;
  if (row.organizationId !== organizationId) {
    return { ok: false, reason: "claimed_elsewhere" };
  }
  return { ok: true, created: false, installation: installationRecord(row) };
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
export type PersistedSlackDecision = Exclude<
  SlackEventDecision,
  { readonly kind: "challenge" }
>;

export type CommitSlackReceiptResult =
  | { readonly kind: "recorded"; readonly receiptId: string }
  | {
    readonly kind: "duplicate";
    readonly receiptId: string;
    readonly outcome: SlackReceiptOutcome;
  }
  | { readonly kind: "conflict" }
  | { readonly kind: "malformed" };

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
  const work = input.decision.kind === "ignore" ? null : input.decision;
  if (
    !isUuid(input.installationId) || !isSlackAppId(input.appId) ||
    !EVENT_ID.test(input.eventId) || !DIGEST.test(input.payloadDigest) ||
    Number.isNaN(input.now.getTime()) ||
    (work !== null && work.eventId !== input.eventId)
  ) return { kind: "malformed" };
  const expiresAt = new Date(
    input.now.getTime() + SLACK_RECEIPT_RETENTION_DAYS * 86_400_000,
  );
  const receiptId = crypto.randomUUID();
  const outcome: SlackReceiptOutcome = work === null ? "ignored" : "accepted";
  const inserted = await transaction.query(
    `insert into bakery.slack_event_receipts (
       id, app_id, event_id, installation_id, payload_digest, outcome,
       processing_intent, channel_id, user_id, event_ts, thread_ts,
       message_text, received_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (app_id, event_id) do nothing`,
    [
      receiptId,
      input.appId,
      input.eventId,
      input.installationId,
      input.payloadDigest,
      outcome,
      work?.kind ?? null,
      work?.channelId ?? null,
      work?.userId ?? null,
      work?.ts ?? null,
      work?.threadTs ?? null,
      work?.text ?? null,
      input.now,
      expiresAt,
    ],
  );
  if (inserted.rowCount === 1) return { kind: "recorded", receiptId };
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

export async function sweepExpiredSlackReceipts(
  transaction: PgTransactionClient,
  input: { readonly now: Date; readonly limit: number },
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 1000);
  const result = await transaction.query(
    `delete from bakery.slack_event_receipts
      where id in (
        select id from bakery.slack_event_receipts
         where expires_at <= $1 order by expires_at limit $2)`,
    [input.now, limit],
  );
  return result.rowCount ?? 0;
}
