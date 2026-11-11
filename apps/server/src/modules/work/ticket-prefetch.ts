import type {
  TicketRequestOrigin,
  TicketSourcePolicy,
} from "@bakery/contracts/ticket-admission";
import { requestedIntentFromLabels } from "./ticket-policy.ts";
import type { BlockerProofEntry } from "./ticket-snapshot.ts";
import type {
  IssueRef,
  TicketActorRole,
  TicketIssueRead,
  TicketLabelProvenance,
  TicketLinksRead,
  TicketSourceHandle,
  TicketSourceReader,
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
  /** Who applied the request label; null when not read (manual origin, no label, hold). */
  provenance: TicketLabelProvenance | null;
  /** Repository role of the labelling actor; null when not read. */
  actorRole: TicketActorRole | null;
  /** The label whose application was read; null when none was. */
  provenanceLabel: string | null;
};

/** What a prefetch needs to know about the call it serves. */
export type TicketPrefetchRequest = {
  number: number;
  policy: TicketSourcePolicy;
  origin: TicketRequestOrigin;
};

/** Whether the origin acts on a label alone, so its applier must be verified. */
export function isAutomaticOrigin(origin: TicketRequestOrigin): boolean {
  return origin === "webhook" || origin === "poll";
}

/**
 * The request label an automatic origin relies on: the execute label when the
 * issue carries it (it covers planning too), else the planning-only label.
 * Null when the issue carries none or carries the hold label, which wins.
 */
export function requestLabelOf(
  labels: readonly string[],
  policy: Pick<TicketSourcePolicy, "labels">,
): string | null {
  if (labels.includes(policy.labels.hold)) return null;
  if (requestedIntentFromLabels(labels, policy) === null) return null;
  return labels.includes(policy.labels.execute)
    ? policy.labels.execute
    : policy.labels.planOnly;
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
  const issue = await reader.readIssue(handle, request.number, signal);
  if (issue.kind !== "present") {
    return {
      issue,
      links: null,
      proofs: [],
      provenance: null,
      actorRole: null,
      provenanceLabel: null,
    };
  }
  const links = await reader.readLinks(handle, request.number, signal);
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
    provenanceLabel = requestLabelOf(issue.snapshot.labels, request.policy);
    if (provenanceLabel !== null) {
      provenance = await reader.readLabelProvenance(
        handle,
        request.number,
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
  return { issue, links, proofs, provenance, actorRole, provenanceLabel };
}
