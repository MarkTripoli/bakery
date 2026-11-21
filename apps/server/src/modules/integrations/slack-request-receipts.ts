/**
 * Claiming a Slack request so a retry cannot do the work twice (#415).
 *
 * Slack retries, and people double-click. Both arrive as the same signed bytes, so
 * verification cannot tell them apart from a first delivery -- the signature is
 * identical, deliberately, because it is the only thing the MAC covers together
 * with the body. What separates them is that one of them has already been answered,
 * and this is where that is recorded.
 *
 * The claim is a single insert with a conflict clause, so two workers racing on the
 * same retry cannot both win: the unique index decides, and the loser reads the
 * winner's receipt instead of inventing a second answer.
 *
 * Rows are not kept for ever. A request outside the freshness window is refused
 * before it gets here, so a receipt older than the window protects nothing; the
 * purge is a periodic sweep rather than a trigger because it runs on rows nobody is
 * waiting for.
 */
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";

/**
 * How long a receipt is kept, in seconds.
 *
 * The window Slack's own guidance names, plus a margin: a request that verified
 * inside the window can still be retried a little later and must still be
 * recognised as a duplicate. Keeping receipts longer than this costs space and buys
 * nothing.
 */
export const SLACK_RECEIPT_RETENTION_SECONDS = 600;

export type SlackReceiptDisposition = "accepted" | "duplicate";

export type SlackReceiptClaim = Readonly<{
  /** `accepted` for the first copy, `duplicate` for every later one. */
  disposition: SlackReceiptDisposition;
  /** The receipt this request maps to, the same value for a retry. */
  receiptId: string;
}>;

/**
 * Claims this request, or reports that it is a duplicate of one already claimed.
 *
 * `on conflict do nothing` rather than an upsert: a duplicate must change nothing
 * about the receipt, because the first answer is the record of what happened.
 */
export async function claimSlackRequest(
  database: Pick<PgTransactionClient, "query">,
  input: {
    readonly replayKey: string;
    readonly bodyDigest: string;
    readonly requestedAt: number;
    readonly teamId: string | null;
  },
): Promise<SlackReceiptClaim> {
  const inserted = await database.query<{ id: string }>(
    `insert into bakery.slack_request_receipts
       (replay_key, body_digest, requested_at, team_id)
     values ($1, $2, $3, $4)
     on conflict (replay_key) do nothing
     returning id`,
    [input.replayKey, input.bodyDigest, input.requestedAt, input.teamId],
  );
  const id = inserted.rows[0]?.id;
  if (id !== undefined) return { disposition: "accepted", receiptId: id };
  // The conflict means another copy got here first; its receipt is this request's
  // receipt too, so a caller answering a retry can name the same id.
  const existing = await database.query<{ id: string }>(
    "select id from bakery.slack_request_receipts where replay_key = $1",
    [input.replayKey],
  );
  const found = existing.rows[0]?.id;
  if (found === undefined) {
    // The row was claimed and purged between the two statements, which cannot
    // happen inside one transaction but must not become a wrong answer if it does.
    throw new Error("slack receipt disappeared while claiming");
  }
  return { disposition: "duplicate", receiptId: found };
}

/**
 * Deletes receipts older than the retention window and reports how many went.
 *
 * `received_at` rather than the signed `requested_at`: the row is kept for a while
 * after it arrives so a slightly late retry still collides, and that is what the
 * arrival time measures.
 */
export async function purgeSlackRequestReceipts(
  database: Pick<PgDatabase, "query">,
  options: { readonly retentionSeconds?: number } = {},
): Promise<number> {
  const retention = options.retentionSeconds ?? SLACK_RECEIPT_RETENTION_SECONDS;
  const { rowCount } = await database.query(
    `delete from bakery.slack_request_receipts
      where received_at < now() - make_interval(secs => $1)`,
    [retention],
  );
  return rowCount ?? 0;
}
