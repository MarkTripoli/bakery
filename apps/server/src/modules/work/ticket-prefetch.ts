import type {
  TicketRequestOrigin,
  TicketSourcePolicy,
} from "@bakery/contracts/ticket-admission";
import {
  carriedLabelName,
  labelSetOf,
  type TicketLabels,
} from "./ticket-policy.ts";
import type { BlockerProofEntry } from "./ticket-snapshot.ts";
import type {
  IssueRef,
  TicketActorRole,
  TicketIssueRead,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketRef,
  TicketSourceHandle,
  TicketSourceReader,
  TicketStatusRead,
} from "./ticket-source-reader.ts";

/**
 * The single home of provider reads for ticket admission. Everything the
 * readiness evaluator needs from GitHub is read here, once, before any
 * transaction that writes: the issue, its native links, one predecessor proof
 * per blocker and, for automatic origins, who applied the request label and
 * what role that actor holds. This module never touches the database, so a
 * caller can run it with no transaction open. An answer is evidence about one
 * moment, never a grant; the admission transaction re-verifies authority, the
 * provider marker and the actor under its locks.
 */

/** Most predecessor proofs read at once. */
export const PREFETCH_PROOF_PARALLELISM = 5;

/**
 * Thrown when a call needs provider answers it does not have and may not read
 * them: it runs inside a transaction (`readsAllowed` false) with `prefetch`
 * null. The caller must prefetch outside the transaction and pass the answers.
 */
export class TicketPrefetchRequiredError extends Error {
  readonly reason = "TICKET_PREFETCH_REQUIRED" as const;
  constructor() {
    super("TICKET_PREFETCH_REQUIRED");
    this.name = "TicketPrefetchRequiredError";
  }
}

/** The provider answers one admission or recheck evaluates. */
export type TicketPrefetch = {
  issue: TicketIssueRead;
  /** Null when the issue was not present, so no links were read. */
  links: TicketLinksRead | null;
  /** One proof per native blocker the links name. */
  proofs: BlockerProofEntry[];
  /**
   * Statuses the item sits in; null when the policy names none, because a source
   * that decides on its label alone never pays for the read.
   */
  statuses: TicketStatusRead | null;
  /** Who applied the request label; null when not read (manual origin, no label, hold). */
  provenance: TicketLabelProvenance | null;
  /** Repository role of the labelling actor; null when not read. */
  actorRole: TicketActorRole | null;
  /** The label whose application was read; null when none was. */
  provenanceLabel: string | null;
};

/** What a prefetch needs to know about the call it serves. */
export type TicketPrefetchRequest = {
  /**
   * Which ticket to read. A reference rather than an ordinal: the poll and the
   * webhook both know the key the person quotes, and only GitHub's readers care
   * that the key is a number.
   */
  ref: TicketRef;
  policy: TicketSourcePolicy;
  origin: TicketRequestOrigin;
};

/** Whether the origin acts on a label alone, so its applier must be verified. */
export function isAutomaticOrigin(origin: TicketRequestOrigin): boolean {
  return origin === "webhook" || origin === "poll";
}

export function requestLabelOf(
  labels: TicketLabels,
  policy: Pick<TicketSourcePolicy, "labels">,
): string | null {
  if (carriedLabelName(labels, policy, "hold") !== null) return null;
  return carriedLabelName(labels, policy, "execute") ??
    carriedLabelName(labels, policy, "planOnly");
}

export async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Reads everything one evaluation needs. Calls the reader only: it takes no
 * database handle, so it cannot run inside a caller's transaction by
 * accident. Reads stop early where a later read would be meaningless: links
 * and proofs only for a present issue, provenance only for an automatic
 * origin whose issue carries a request label, the actor role only for an
 * applied label.
 */
export async function prefetchTicketReads(
  reader: TicketSourceReader,
  handle: TicketSourceHandle,
  request: TicketPrefetchRequest,
  signal: AbortSignal,
): Promise<TicketPrefetch> {
  const issue = await reader.readIssue(handle, request.ref, signal);
  if (issue.kind !== "present") {
    return {
      issue,
      links: null,
      proofs: [],
      statuses: null,
      provenance: null,
      actorRole: null,
      provenanceLabel: null,
    };
  }
  const wantsStatus = (request.policy.readiness.statuses?.length ?? 0) > 0;
  const [links, statuses] = await Promise.all([
    reader.readLinks(handle, request.ref, signal),
    wantsStatus
      // The snapshot is already in hand, so this costs no second read.
      ? reader.readStatuses(handle, request.ref, signal, issue.snapshot)
      : Promise.resolve(null),
  ]);
  const blockers: IssueRef[] = links.kind === "present" ? links.blockedBy : [];
  const proofs = await mapPool(
    blockers,
    PREFETCH_PROOF_PARALLELISM,
    async (blocker): Promise<BlockerProofEntry> => ({
      blocker,
      proof: await reader.readPredecessorProof(handle, blocker, signal),
    }),
  );
  let provenance: TicketLabelProvenance | null = null;
  let actorRole: TicketActorRole | null = null;
  let provenanceLabel: string | null = null;
  if (isAutomaticOrigin(request.origin)) {
    provenanceLabel = requestLabelOf(
      labelSetOf(issue.snapshot),
      request.policy,
    );
    if (provenanceLabel !== null) {
      provenance = await reader.readLabelProvenance(
        handle,
        request.ref,
        provenanceLabel,
        signal,
      );
      if (provenance.kind === "applied") {
        actorRole = await reader.readActorRole(
          handle,
          provenance.actorLogin,
          signal,
        );
      }
    }
  }
  return {
    issue,
    links,
    proofs,
    statuses,
    provenance,
    actorRole,
    provenanceLabel,
  };
}
