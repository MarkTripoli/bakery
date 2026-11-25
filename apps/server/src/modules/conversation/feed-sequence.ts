import type { PgTransactionClient } from "@bakery/persistence";

export async function allocateConversationFeedSequence(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<string> {
  const allocated = await transaction.query<{ sequence: string }>(
    `insert into bakery.conversation_feed_sequences (
       organization_id, conversation_id, last_sequence
     )
     select $1, $2, coalesce(max(message.sequence), 0) + 1
       from bakery.messages message
      where message.organization_id = $1 and message.conversation_id = $2
     on conflict (organization_id, conversation_id)
       do update set last_sequence =
         bakery.conversation_feed_sequences.last_sequence + 1
     returning last_sequence::text as sequence`,
    [organizationId, conversationId],
  );
  const sequence = allocated.rows[0]?.sequence;
  if (sequence === undefined) throw new Error("FEED_SEQUENCE_UNAVAILABLE");
  return sequence;
}
