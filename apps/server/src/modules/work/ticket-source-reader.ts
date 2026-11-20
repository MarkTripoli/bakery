import type {
  TicketIssueRef,
  TicketSnapshotInput,
  TicketStatusRef,
} from "@bakery/contracts/ticket-admission";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The port through which the work module reads GitHub for ticket admission.
 * Types only: the live implementation is `integrations/ticket-reads.ts`, the
 * tests use an in-memory reader, and `work` never imports the GitHub client.
 * Every read is bounded and happens outside any database transaction; an
 * answer is evidence about one moment, never a grant.
 */

/** Reference to one issue: provider id, number and repository. */
export type IssueRef = TicketIssueRef;

/**
 * Which ticket a read is about, in the engine's words rather than one provider's.
 *
 * The ordinal - GitHub's issue number - used to be the subject of every read,
 * which made the port itself GitHub-shaped: a tracker that addresses tickets as
 * `ENG-42` could not be read through it at all. The two halves are separate on
 * purpose:
 *
 * - `externalKey` is what a person quotes and what a link contains, so every
 *   entry point has it;
 * - `externalId` is the provider's immutable id, which survives a rename and is
 *   what the engine dedupes on. It is null when the caller genuinely does not
 *   know it yet - the poll returns ordinals and update markers, not ids - and a
 *   reader that can check it must: a key that now resolves to a different id
 *   means the ticket was not the one asked for.
 */
export type TicketRef = {
  externalId: string | null;
  externalKey: string;
};

/** Build a reference from the key a person quotes, and the id when it is known. */
export function ticketRef(
  externalKey: string | number,
  externalId: string | null = null,
): TicketRef {
  return { externalId, externalKey: String(externalKey) };
}

/**
 * Why a provider read gave no answer. Never treated as a pass. The reason is
 * internal to this port and reaches a report only as the evidence
 * `provider:<reason>` of a `provider_unavailable` check.
 */
export type TicketReadFailure = {
  kind: "unavailable";
  /**
   * `labels_truncated`: GitHub answered, but the issue has more labels than
   * the reader keeps, so a hold or execute label may sit in the cut part. It
   * lasts as long as the issue keeps that many labels, which is why it is
   * named apart from `provider_error`: it is no outage of the provider.
   */
  reason:
    | "rate_limited"
    | "forbidden"
    | "provider_error"
    | "timeout"
    | "labels_truncated";
  /** Seconds the provider asked the caller to wait, or null when unstated. */
  retryAfterSeconds: number | null;
};

/** The selected resource a ticket source reads through. */
export type TicketSourceHandle = {
  organizationId: string;
  connectionId: string;
  resourceId: string;
  /**
   * The provider slug of the connection this source reads.
   *
   * On the handle rather than looked up per read: every read already carries the
   * handle, and a lookup would be a database round trip per call to learn
   * something the caller loaded to build the handle in the first place. It is a
   * slug, not a type: the work module never enumerates providers.
   */
  provider: string;
  repositoryFullName: string;
  externalRepositoryId: string;
};

/**
 * Answer of `readIssue`: the issue, a pull request, or one of two absences.
 * An issue whose label list the provider answered past the reader's bound is
 * `unavailable` (`labels_truncated`), never `present` with a cut list: a label
 * that decides admission, such as the hold label, may sit in the cut part.
 */
export type TicketIssueRead =
  | {
    kind: "present";
    snapshot: TicketSnapshotInput;
    providerUpdatedAt: string;
    visibility: "public" | "private";
  }
  | { kind: "pull_request" }
  | { kind: "gone" }
  | { kind: "moved" }
  | TicketReadFailure;

/** Answer of `readLinks`: native parent, sub-issue and dependency data. */
export type TicketLinksRead =
  | {
    kind: "present";
    parent: IssueRef | null;
    subIssuesTotal: number;
    blockedBy: IssueRef[];
    blockingTotal: number;
    /**
     * True when the answer is incomplete: the blocker list was cut at its
     * bound, GitHub counts blockers the list did not show, or GitHub did not
     * report the blocker or the sub-issue count (unknown is never read as
     * zero). The evaluator waits on it (`links_truncated`).
     */
    truncated: boolean;
  }
  | TicketReadFailure;

/** Whether a blocking issue is done, shown by a merged pull request. */
export type PredecessorProof =
  | {
    kind: "satisfied";
    pullRequestNumber: number;
    mergeSha: string;
    mergedAt: string;
  }
  | { kind: "open" }
  | { kind: "closed_unmerged"; stateReason: string | null }
  | { kind: "inaccessible" }
  | { kind: "proof_unavailable"; detail: string };

/** Answer of `readLabelProvenance`: who applied a label, from issue events. */
export type TicketLabelProvenance =
  | { kind: "applied"; actorId: string; actorLogin: string; appliedAt: string }
  | { kind: "absent" }
  | { kind: "unverifiable"; reason: string }
  | TicketReadFailure;

/**
 * Answer of `readActorRole`: the actor's role, as its provider name and its
 * position on that provider's ladder. Admission compares the rank, so a
 * provider with other role names fits without admission learning them.
 */
export type TicketActorRole =
  | {
    kind: "present";
    userId: string;
    permission: "admin" | "write" | "read" | "none";
    rank: number;
  }
  | { kind: "absent" }
  | TicketReadFailure;

/**
 * One page of issue numbers for a source poll. The `labels` of an item are for
 * candidate selection only: GitHub's issue list gives them cut to the reader's
 * label bound without saying so, so they may be a prefix of the issue's labels.
 * A label missing from them, the hold label above all, is never evidence that
 * the issue does not carry it. Admission and holds read the issue again with
 * `readIssue`, which fails closed on a cut label list.
 */
export type TicketIssueListPage =
  | {
    kind: "present";
    numbers: { number: number; updatedAt: string; labels: string[] }[];
    hasNext: boolean;
  }
  | TicketReadFailure;

/** The statuses an item sits in, or the reason they could not be read. */
export type TicketStatusRead =
  | { kind: "present"; statuses: TicketStatusRef[] }
  | { kind: "unsupported" }
  | TicketReadFailure;

/** One label the provider holds; `id` is the opaque id routing rules store. */
export type TicketLabel = { id: string; name: string; color: string | null };

/**
 * One page of the provider's labels (#69). A provider without labels answers
 * `unsupported`, never an empty page, so a page can tell "none set up" from
 * "this tracker has no labels".
 */
export type TicketLabelPage =
  | { kind: "present"; labels: TicketLabel[]; hasNext: boolean }
  | { kind: "unsupported" }
  | TicketReadFailure;

export interface TicketSourceReader {
  readIssue(
    handle: TicketSourceHandle,
    ref: TicketRef,
    signal: AbortSignal,
  ): Promise<TicketIssueRead>;
  readLinks(
    handle: TicketSourceHandle,
    ref: TicketRef,
    signal: AbortSignal,
  ): Promise<TicketLinksRead>;
  readPredecessorProof(
    handle: TicketSourceHandle,
    blocker: IssueRef,
    signal: AbortSignal,
  ): Promise<PredecessorProof | TicketReadFailure>;
  readLabelProvenance(
    handle: TicketSourceHandle,
    ref: TicketRef,
    label: string,
    signal: AbortSignal,
  ): Promise<TicketLabelProvenance>;
  readActorRole(
    handle: TicketSourceHandle,
    login: string,
    signal: AbortSignal,
  ): Promise<TicketActorRole>;
  /**
   * The statuses the item currently sits in, in the provider's own terms.
   *
   * A provider that only labels answers `unsupported` rather than an empty
   * list: an empty list would read as "a provider with statuses, none of them
   * configured", which is a different thing and would let a misconfigured
   * source look like a ticket that simply is not ready.
   */
  /**
   * `issue` is the snapshot the caller has already read, when it has one: a
   * status comes from that snapshot's state and reason, so asking the provider
   * again would spend a second call to learn what is already known. It is
   * optional because a caller that has only a number still gets a correct
   * answer, at the cost of the read.
   */
  readStatuses(
    handle: TicketSourceHandle,
    ref: TicketRef,
    signal: AbortSignal,
    issue?: TicketSnapshotInput,
  ): Promise<TicketStatusRead>;
  listIssues(
    handle: TicketSourceHandle,
    request: { page: number; since: string | null },
    signal: AbortSignal,
  ): Promise<TicketIssueListPage>;
  /** One page (1-based) of the labels the source's container holds, read live. */
  readLabels(
    handle: TicketSourceHandle,
    request: { page: number },
    signal: AbortSignal,
  ): Promise<TicketLabelPage>;
}

/**
 * Source of issue numbers worth re-evaluating: issue facts newer than a
 * marker. Declared here so admission tests use an in-memory index; the live
 * implementation (`integrations/ticket-reads.ts`) reads
 * `integration_remote_facts`.
 *
 * The `labels` of an entry come from the stored fact's summary, which keeps at
 * most 50 labels and drops trailing ones to fit its size bound, so they may be
 * a prefix of the issue's labels. They are for candidate selection only, never
 * admission or hold evidence: a label missing from them, the hold label above
 * all, does not mean the issue lacks it. Every admission reads the issue again
 * with `TicketSourceReader.readIssue`, which fails closed on a cut label list.
 */
export interface TicketFactIndex {
  listIssueNumbers(
    tx: PgTransactionClient,
    request: {
      organizationId: string;
      resourceId: string;
      /** Exclusive lower bound on the provider-update marker. */
      afterMarker: string | null;
      /**
       * With `afterMarker`: keyset position inside a tie group. Entries with
       * the marker's own instant are returned only when their number is higher,
       * so a group larger than the index's row bound is paged through, never
       * skipped. Ignored without a marker.
       */
      afterNumber?: number | null;
      limit: number;
    },
  ): Promise<
    { number: number; providerUpdatedAt: string; labels: string[] }[]
  >;
}
