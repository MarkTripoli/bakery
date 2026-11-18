/**
 * Persistence for the Slack intake: which organization a verified delivery
 * belongs to, and the committed receipt that lets Bakery acknowledge it.
 *
 * Every function takes the caller's transaction. Input that is wrong is refused
 * with a reason code before the database is touched, and no result or reason
 * carries a secret, a token or message text. A receipt keeps a digest and an
 * outcome only, so an ignored message (a bot echo, an unlinked person) is
 * recognised when Slack retries it without its content ever being stored. A
 * failure of the database itself throws and aborts the caller's transaction.
 */
import type { PgTransactionClient } from "@bakery/persistence";
import {
  isSlackAppId,
  isSlackEnterpriseId,
  isSlackTeamId,
  isSlackUserId,
  type SlackInstallation,
} from "./slack-scope.ts";

/** How long a receipt is kept, so a late retry is still recognised. */
export const SLACK_RECEIPT_RETENTION_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9]{3,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export type SlackInstallationStatus = "active" | "disabled";

/** A stored installation, as a caller may see it. */
export type SlackInstallationRecord = {
  readonly installationId: string;
  readonly organizationId: string;
  readonly appId: string;
  readonly teamId: string;
  readonly enterpriseId?: string;
  readonly botUserId: string;
  /** The secret that signs this app's deliveries; null refuses every one. */
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
    /** `claimed_elsewhere`: the workspace already serves another organization. */
    readonly reason: "malformed" | "claimed_elsewhere";
  };

/**
 * Records that a classified installation belongs to this organization. The
 * workspace is unique across organizations, so a second organization cannot
 * take it over; registering it again for the same organization changes nothing
 * and returns the row that is there.
 */
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

/**
 * The active installation a verified delivery for this app and workspace
 * belongs to, or null. A disabled installation and a workspace nobody
 * installed are the same answer: the delivery is not admitted.
 */
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

/** What became of a delivered event. */
export type SlackReceiptOutcome = "accepted" | "ignored";

export type CommitSlackReceiptResult =
  | { readonly kind: "recorded"; readonly receiptId: string }
  /** The same event again with the same bytes: answer as before, do nothing. */
  | {
    readonly kind: "duplicate";
    readonly receiptId: string;
    readonly outcome: SlackReceiptOutcome;
  }
  /** The same event id with different bytes: refuse; it is not a retry. */
  | { readonly kind: "conflict" }
  | { readonly kind: "malformed" };

/**
 * Commits one receipt. Slack acknowledges only after this returns, so a
 * crash between the insert and the answer leaves a receipt a retry will find.
 * Two deliveries of one event racing each other resolve on the unique key:
 * exactly one records, the other sees a duplicate.
 */
export async function commitSlackReceipt(
  transaction: PgTransactionClient,
  input: {
    readonly installationId: string;
    readonly appId: string;
    readonly eventId: string;
    readonly payloadDigest: string;
    readonly outcome: SlackReceiptOutcome;
    readonly now: Date;
  },
): Promise<CommitSlackReceiptResult> {
  if (
    !isUuid(input.installationId) || !isSlackAppId(input.appId) ||
    !EVENT_ID.test(input.eventId) || !DIGEST.test(input.payloadDigest) ||
    Number.isNaN(input.now.getTime())
  ) return { kind: "malformed" };
  const expiresAt = new Date(
    input.now.getTime() + SLACK_RECEIPT_RETENTION_DAYS * 86_400_000,
  );
  const receiptId = crypto.randomUUID();
  const inserted = await transaction.query(
    `insert into bakery.slack_event_receipts (
       id, app_id, event_id, installation_id, payload_digest, outcome,
       received_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (app_id, event_id) do nothing`,
    [
      receiptId,
      input.appId,
      input.eventId,
      input.installationId,
      input.payloadDigest,
      input.outcome,
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

/** Deletes receipts past their retention; returns how many. Oldest first, bounded. */
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
