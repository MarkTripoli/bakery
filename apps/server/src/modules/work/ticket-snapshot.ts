import {
  TICKET_PROVIDER_BODY_MAX_CODE_POINTS,
  TICKET_SNAPSHOT_BODY_MAX_LENGTH,
  TICKET_SNAPSHOT_MAX_BLOCKERS,
  TICKET_SNAPSHOT_MAX_LABELS,
  TICKET_SNAPSHOT_TITLE_MAX_LENGTH,
  type TicketIssueRef,
  type TicketLinks,
  type TicketPresetPin,
  type TicketRequestIntent,
  type TicketSnapshot,
  type TicketSnapshotInput,
} from "@bakery/contracts/ticket-admission";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { TicketLabelBasis } from "./ticket-policy.ts";
import type {
  PredecessorProof,
  TicketLinksRead,
  TicketReadFailure,
} from "./ticket-source-reader.ts";

/**
 * Pure snapshot rules for ticket admission: bounding and normalizing an issue
 * as read, and the digests that decide whether a ticket changed. The
 * requirements digest covers the title and the full normalized body only, so
 * labels, state, timestamps and links never invalidate a plan. Dependencies
 * have their own digest. Digests use async WebCrypto, so they return promises.
 */

/**
 * UTF-16 code units reserved at the end of the task description for the
 * footer line that names the source issue. The worst footer is a 140-character
 * repository name and a 10-digit number: 161 units, so 200 leaves room.
 */
export const TASK_DESCRIPTION_FOOTER_RESERVE = 200;

/**
 * Longest stored body in UTF-16 code units: the snapshot body cap less the
 * footer reserve, so a task description built from it still fits the task cap.
 */
export const STORED_BODY_MAX_LENGTH = TICKET_SNAPSHOT_BODY_MAX_LENGTH -
  TASK_DESCRIPTION_FOOTER_RESERVE;

/** Footer line appended to a task description built from a ticket. */
export function taskDescriptionFooter(
  repositoryFullName: string,
  number: number,
): string {
  return `\n\nGitHub: ${repositoryFullName}#${number}`;
}

/** Converts CRLF and lone CR line endings to LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Number of Unicode code points in `text` (an astral character counts once). */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _point of text) count += 1;
  return count;
}

/**
 * Cuts `text` to at most `maxUnits` UTF-16 code units without splitting a
 * surrogate pair: when the cut would leave a high surrogate at the end, that
 * unit is dropped too.
 */
export function cutUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Orders issue references by repository, number, then provider id. */
export function sortIssueRefs(
  refs: readonly TicketIssueRef[],
): TicketIssueRef[] {
  return [...refs].sort((left, right) =>
    compareText(left.repositoryFullName, right.repositoryFullName) ||
    left.number - right.number || compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Links as stored: blockers ordered and cut to the snapshot bound. */
export function normalizeLinks(
  read: Extract<TicketLinksRead, { kind: "present" }>,
): TicketLinks {
  return {
    parent: read.parent,
    subIssuesTotal: read.subIssuesTotal,
    blockedBy: sortIssueRefs(read.blockedBy).slice(
      0,
      TICKET_SNAPSHOT_MAX_BLOCKERS,
    ),
    blockingTotal: read.blockingTotal,
  };
}

/**
 * An issue after bounding. `snapshot` is what `external_tickets` stores;
 * `body` is the full normalized text the digest and the acceptance-criteria
 * check read, kept in memory only.
 */
export type NormalizedTicketSnapshot = {
  snapshot: TicketSnapshot;
  /** Full normalized body; empty when the provider body was too large to keep. */
  body: string;
  /** True when the provider body exceeds 65,536 code points. */
  tooLarge: boolean;
  /** Provider update marker of the read; stands in for the body when too large. */
  providerUpdatedAt: string;
};

/**
 * Bounds and normalizes one issue as the reader hands it over. Newlines become
 * LF. The title is cut to 500 UTF-16 units and the stored body to
 * `STORED_BODY_MAX_LENGTH` units, never inside a surrogate pair; the full
 * normalized text stays on `body`. A body over 65,536 code points (or one the
 * reader flagged `bodyTooLarge`) is dropped: it is reported, never hashed or
 * stored.
 */
export function normalizeSnapshot(
  input: TicketSnapshotInput,
  context: { links: TicketLinks | null; providerUpdatedAt: string },
): NormalizedTicketSnapshot {
  const tooLarge = input.bodyTooLarge ||
    countCodePoints(input.body) > TICKET_PROVIDER_BODY_MAX_CODE_POINTS;
  const body = tooLarge ? "" : normalizeNewlines(input.body);
  const stored = cutUtf16(body, STORED_BODY_MAX_LENGTH);
  return {
    snapshot: {
      title: cutUtf16(
        normalizeNewlines(input.title),
        TICKET_SNAPSHOT_TITLE_MAX_LENGTH,
      ),
      body: stored,
      bodyTruncated: tooLarge || stored.length < body.length,
      labels: input.labels.slice(0, TICKET_SNAPSHOT_MAX_LABELS),
      state: input.state,
      stateReason: input.stateReason,
      locked: input.locked,
      repositoryFullName: input.repositoryFullName,
      links: context.links,
    },
    body,
    tooLarge,
    providerUpdatedAt: context.providerUpdatedAt,
  };
}

/**
 * SHA-256 of the canonical JSON of the title and the full normalized body.
 * Always a string: a too-large body hashes the title, a `tooLarge` marker and
 * the provider update marker instead, so a change to such an issue is still
 * detected. Labels, state, timestamps (for a normal body) and links never
 * enter it.
 */
export async function requirementsDigest(
  normalized: NormalizedTicketSnapshot,
): Promise<string> {
  const { snapshot, body, tooLarge, providerUpdatedAt } = normalized;
  return await sha256Hex(
    canonicalJson(
      tooLarge
        ? { title: snapshot.title, tooLarge: true, providerUpdatedAt }
        : { title: snapshot.title, body },
    ),
  );
}

/** One native blocker and what the reader found out about it. */
export type BlockerProofEntry = {
  blocker: TicketIssueRef;
  proof: PredecessorProof | TicketReadFailure;
};

/**
 * SHA-256 over the sorted blocker identities, the kind of proof each has, and
 * the merge commit of a satisfied proof. Nothing else enters it: proof detail
 * text, timestamps and every non-dependency link are left out. A blocker with
 * no proof entry counts as `missing`.
 */
export async function dependencyDigest(
  links: Pick<TicketLinks, "blockedBy">,
  proofs: readonly BlockerProofEntry[],
): Promise<string> {
  const byId = new Map(proofs.map((entry) => [entry.blocker.id, entry.proof]));
  const blockers = sortIssueRefs(links.blockedBy).map((blocker) => {
    const proof = byId.get(blocker.id);
    return {
      id: blocker.id,
      number: blocker.number,
      repositoryFullName: blocker.repositoryFullName,
      proof: proof === undefined ? "missing" : proof.kind,
      mergeSha: proof?.kind === "satisfied" ? proof.mergeSha : null,
    };
  });
  return await sha256Hex(canonicalJson({ blockers }));
}

/** Everything a readiness verdict depends on. */
export type BasisParts = {
  requirementsDigest: string | null;
  dependencyDigest: string | null;
  sourcePolicyRevision: number;
  preset: TicketPresetPin;
  intent: TicketRequestIntent | null;
  labelBasis: TicketLabelBasis;
  hold: boolean;
  /** Outcome of every evaluated check, so a changed verdict is a new basis. */
  checks: readonly { id: string; status: string; reason: string }[];
};

/**
 * SHA-256 of the canonical JSON of the verdict's inputs. A new readiness
 * report is stored only when this changes.
 */
export async function basisDigest(parts: BasisParts): Promise<string> {
  return await sha256Hex(canonicalJson(parts));
}
