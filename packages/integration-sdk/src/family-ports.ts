import type { DriverContext } from "./ports.ts";

/**
 * The family ports (chapter 09 section 12.3).
 *
 * A family is a question the engine asks that several providers can answer. The
 * port is written in the engine's words, not any provider's: `present()` returns
 * the strings the Issues pages already show, so lifting GitHub onto this port is a
 * move rather than a redesign.
 */

/**
 * Why a resource cannot be admitted as a ticket.
 *
 * A closed set, because these strings reach the UI and the audit record. Section
 * 12 keeps today's reason codes intact through the lift: a GitHub pull request
 * arrives as `not_a_ticket`, which is why that reason exists rather than a generic
 * "unsupported".
 */
export const TICKET_ADMISSION_REFUSALS = [
  "not_a_ticket",
  "missing_identifier",
  "wrong_container",
  "closed_and_archived",
] as const;

export type TicketAdmissionRefusal = (typeof TICKET_ADMISSION_REFUSALS)[number];

/**
 * What the engine is allowed to decide about a ticket.
 *
 * `status` is the provider's own string, carried through unchanged: the engine
 * groups tickets by the provider's status rather than translating every provider's
 * workflow into one vocabulary, which would lose the distinctions people use.
 */
export type TicketSnapshot = {
  /** Provider's identifier for the ticket, stable across renames where the provider allows it. */
  externalId: string;
  /** The identifier a person quotes, such as an issue number or a key like ENG-42. */
  externalKey: string;
  title: string;
  /** The container the ticket lives in, as the provider names it. */
  container: { externalId: string; label: string };
  status: {
    id: string;
    label: string; /** Groups statuses without erasing them. */
    rank: number;
  };
  url: string;
  updatedAt: Date;
  /** Provider-side actors, so the engine can attribute without knowing the provider's user model. */
  externalActorIds: readonly string[];
};

/**
 * The display form of a ticket, which is what the Issues pages render.
 *
 * Deliberately strings rather than structured values: the pages already show text,
 * and returning objects would make this a rendering API rather than a port.
 */
export type TicketPresentation = {
  title: string;
  statusLabel: string;
  containerLabel: string;
  url: string;
  /** One line the list can show without a second provider call. */
  summary: string;
};

/** One change to a ticket the engine wants the provider to make. */
export type TicketMutation =
  | { kind: "comment"; body: string }
  | { kind: "set_status"; statusId: string };

/** The ticket family: read a resource as a ticket, and write the two things the engine writes. */
export type TicketsPort = {
  /**
   * Decide whether a resource is a ticket and, if so, in what form.
   *
   * Returns a refusal rather than throwing, because a pull request arriving here is
   * an ordinary outcome of the engine asking about every resource it sees.
   */
  present(input: {
    resourceExternalId: string;
    ctx: DriverContext;
  }): Promise<
    | {
      kind: "ticket";
      snapshot: TicketSnapshot;
      presentation: TicketPresentation;
    }
    | { kind: "refused"; reason: TicketAdmissionRefusal }
  >;
  /** Apply one change. The host owns the audit record, not the provider. */
  mutate(input: {
    resourceExternalId: string;
    mutation: TicketMutation;
    ctx: DriverContext;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/**
 * A change in the code sense: a pull request, a merge request, a review.
 *
 * Separate from a ticket because the engine asks different questions: a change has
 * a head and a base and a review state, while a ticket has a status and a container.
 */
export type ChangeSnapshot = {
  externalId: string;
  /** The identifier a person quotes, such as a pull request number. */
  externalKey: string;
  title: string;
  url: string;
  state: "open" | "merged" | "closed" | "draft";
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  review: { decision: "approved" | "changes_requested" | "pending" | "none" };
  updatedAt: Date;
  externalActorIds: readonly string[];
};

/** What a check reports about a change. */
export type CheckSnapshot = {
  externalId: string;
  name: string;
  /** The change the check belongs to. */
  changeExternalId: string;
  conclusion:
    | "success"
    | "failure"
    | "pending"
    | "neutral"
    | "cancelled"
    | "skipped";
  url: string | null;
  updatedAt: Date;
};

/** The code family: read changes and the checks attached to them. */
export type CodePort = {
  readChange(input: {
    resourceExternalId: string;
    ctx: DriverContext;
  }): Promise<ChangeSnapshot | null>;
  listChecks(input: {
    changeExternalId: string;
    ctx: DriverContext;
  }): Promise<readonly CheckSnapshot[]>;
};
