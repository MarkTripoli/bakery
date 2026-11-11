import type {
  TicketIssueRef,
  TicketSnapshotInput,
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

/** Answer of `readActorRole`: the actor's repository permission. */
export type TicketActorRole =
  | {
    kind: "present";
    userId: string;
    permission: "admin" | "write" | "read" | "none";
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

export interface TicketSourceReader {
  readIssue(
    handle: TicketSourceHandle,
    number: number,
    signal: AbortSignal,
  ): Promise<TicketIssueRead>;
  readLinks(
    handle: TicketSourceHandle,
    number: number,
    signal: AbortSignal,
  ): Promise<TicketLinksRead>;
  readPredecessorProof(
    handle: TicketSourceHandle,
    blocker: IssueRef,
    signal: AbortSignal,
  ): Promise<PredecessorProof | TicketReadFailure>;
  readLabelProvenance(
    handle: TicketSourceHandle,
    number: number,
    label: string,
    signal: AbortSignal,
  ): Promise<TicketLabelProvenance>;
  readActorRole(
    handle: TicketSourceHandle,
    login: string,
    signal: AbortSignal,
  ): Promise<TicketActorRole>;
  listIssues(
    handle: TicketSourceHandle,
    request: { page: number; since: string | null },
    signal: AbortSignal,
  ): Promise<TicketIssueListPage>;
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
