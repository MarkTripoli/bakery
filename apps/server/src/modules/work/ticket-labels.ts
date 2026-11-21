/**
 * Bakery's progress labels on a ticket (#32): `bakery:queued`,
 * `bakery:working`, `bakery:review`, `bakery:blocked` and `bakery:done`.
 * This module names no provider: a `TicketLabelWriter` changes only the labels
 * it is told to, one add and one remove at a time, so a person's labels stay.
 */

/** One change to Bakery's own labels on one issue. */
export type TicketLabelChange = {
  organizationId: string;
  /** The principal the write runs as; the gate requires their grant for the label actions. */
  actorPrincipalId: string;
  provider: string;
  connectionId: string;
  resourceId: string;
  issueNumber: number;
  /** Bakery labels to put on the issue. */
  add: readonly string[];
  /** Bakery labels to take off the issue. */
  remove: readonly string[];
  /** Names the effects: a resend with the same key is the same effects. */
  idempotencyKey: string;
  signal: AbortSignal;
};

/** Whether every change went out, or the fixed code of the first that did not. */
export type TicketLabelResult =
  | { kind: "applied" }
  | { kind: "failed"; problemCode: string };

/** Changes Bakery's labels; implemented over the integration gate, in memory in tests. */
export type TicketLabelWriter = {
  apply(change: TicketLabelChange): Promise<TicketLabelResult>;
};
