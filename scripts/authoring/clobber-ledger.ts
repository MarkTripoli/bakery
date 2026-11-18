/**
 * Verifier-line clobber check.
 *
 * A pull request body is a shared surface: any seat can rewrite any line, and
 * GitHub keeps no record of the edit. The validator therefore keeps its own
 * snapshot of each verification line and compares the next body against it.
 *
 * The comparison has four outcomes per line: unchanged, a seat revising its own
 * claim with a verdict to show for it, and the three clobbers — an unowned
 * re-label, another seat taking the line, and a deleted line.
 *
 * This module holds only the pure comparison. Fetching the ledger comment and
 * writing it back belong to the caller, so the same functions serve the local
 * validator and the CI hook.
 *
 * The design is recorded in docs/technical-design/authoring-clobber-ledger.md.
 */

/** The marker that identifies the ledger comment, so it is upserted not appended. */
export const LEDGER_MARKER = "<!-- bakery-authoring-ledger -->";

/** One verification line as it stands in a body right now. */
export type VerifierLine = {
  /** The checklist item's label, lowercased and trimmed. */
  item: string;
  /** The seat the line is attributed to, lowercased; empty when unattributed. */
  seat: string;
  /** Everything after the attribution: the claim, including any head it names. */
  claim: string;
  /** A stable digest of the claim, so an edit is visible without storing it. */
  claimHash: string;
};

/** One line as the previous clean run saw it. */
export type LedgerEntry = {
  item: string;
  seat: string;
  claimHash: string;
  /** The pull request head the snapshot was taken at. */
  sha: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** A verdict comment, reduced to what corroboration needs. */
export type Verdict = {
  /** The seat that claims the verdict, read from the body, never from the author. */
  seat: string;
  /** The head the verdict names; empty when it names none. */
  sha: string;
  /** ISO timestamp of the comment. */
  at: string;
};

/**
 * A stable digest of a claim.
 *
 * FNV-1a keeps the check dependency-free and synchronous, and the ledger only
 * needs to notice that a claim changed, never to reconstruct it.
 */
export function hashClaim(claim: string): string {
  let hash = 0x811c9dc5;
  const text = claim.replace(/\s+/g, " ").trim();
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The seats the checklist may attribute a line to, most specific first. */
const SEAT_PATTERNS: [string, RegExp][] = [
  ["design-ux", /design-ux|\bux\b/i],
  ["qa", /\bqa\d*\b/i],
  ["reviewer", /\breviewer\b/i],
];

/**
 * Read a seat name out of an attribution or a verdict heading.
 *
 * The heading and the attribution are prose the author writes, so the seat is
 * recognised from the words the conventions use — "UX sign-off", "QA verdict",
 * "reviewer" — and never from the comment's author, which is the same account
 * for every seat.
 */
function seatOf(attribution: string): string {
  for (const [seat, pattern] of SEAT_PATTERNS) {
    if (pattern.test(attribution)) return seat;
  }
  return attribution.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** The checklist items the verification section may carry. */
const ITEMS = [
  "backend verified",
  "ui verified",
  "implementation clean",
  "tests cover",
] as const;

/**
 * Normalise a checklist label to the item it names.
 *
 * Authors write the head in three different places — `item @ head (seat)`,
 * `item (seat) @ head`, `item (seat @ head)` — so the label has to be read
 * without its head, or the ledger would key the same item twice.
 */
function itemOf(label: string): string {
  const text = label.replace(/\s*@\s*[0-9a-f]{7,40}\s*$/i, "").trim()
    .toLowerCase();
  return ITEMS.find((item) => text.startsWith(item)) ??
    text.replace(/[\s:,-]+$/, "");
}

/**
 * Extract the verification checklist's attributed lines.
 *
 * A line without an attribution is skipped: the checklist rail already
 * requires the item, and this check only guards lines that name a seat.
 */
export function parseVerifierLines(body: string): VerifierLine[] {
  const section =
    /^##[ \t]*Verification[ \t]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|(?![\s\S]))/im
      .exec(body);
  const text = section?.[1] ?? "";
  const lines: VerifierLine[] = [];
  for (const raw of text.split("\n")) {
    const match = /^[-*]\s+\[[ xX]\]\s*(.+)$/.exec(raw.trimEnd());
    if (!match) continue;
    const rest = match[1];
    const attribution = /\(([^)]*)\)/.exec(rest);
    if (!attribution) continue;
    const before = rest.slice(0, attribution.index);
    const after = rest.slice(attribution.index + attribution[0].length)
      .replace(/^[\s:,-]*/, "")
      .trim();
    // The head may sit before the attribution; it is part of the claim, so a
    // change of head is a change of claim and needs corroboration.
    const trailingHead = /@\s*([0-9a-f]{7,40})\s*$/i.exec(before.trim());
    // The head may also sit inside the attribution, as in
    // "ui verified (design-ux @ 583e043c3)". A change of that head is a change
    // of claim, so it has to reach the hash or the commonest re-label of all
    // would slip through unnoticed.
    const attributedHead = /@\s*([0-9a-f]{7,40})/i.exec(attribution[1]);
    const claim = [
      trailingHead ? `@${trailingHead[1]}` : "",
      attributedHead ? `@${attributedHead[1]}` : "",
      after,
    ].filter((part) => part !== "").join(" ").trim();
    lines.push({
      item: itemOf(before),
      seat: seatOf(attribution[1]),
      claim,
      claimHash: hashClaim(claim),
    });
  }
  return lines;
}

/** Read the ledger out of a comment body, or null when the comment is not one. */
export function parseLedger(commentBody: string): LedgerEntry[] | null {
  if (!commentBody.includes(LEDGER_MARKER)) return null;
  const json = commentBody.slice(
    commentBody.indexOf(LEDGER_MARKER) +
      LEDGER_MARKER.length,
  ).trim();
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as LedgerEntry[] : null;
  } catch {
    return null;
  }
}

/** Render the ledger comment for a set of entries. */
export function renderLedger(entries: LedgerEntry[]): string {
  return `${LEDGER_MARKER}\n${JSON.stringify(entries, null, 2)}\n`;
}

/**
 * Reduce a verdict comment to the seat and head it names.
 *
 * Every seat shares one GitHub account, so the seat is claimed in prose. This
 * reads the convention (`## UX sign-off`, `## QA verdict @ <sha>`, `Verdict:
 * Approve` with a `Head:` line) and never the comment's author.
 */
export function parseVerdict(
  commentBody: string,
  createdAt: string,
): Verdict | null {
  const head = /(?:^|\n)\s*(?:Head|head)\s*:\s*`?([0-9a-f]{7,40})`?/m
    .exec(commentBody);
  const inline = /@\s*`?([0-9a-f]{7,40})`?/i.exec(commentBody);
  const sha = (head?.[1] ?? inline?.[1] ?? "").slice(0, 9);

  const hasVerdict = /\bverdict\b/i.test(commentBody);
  const hasSignOff = /\bsign[- ]off\b/i.test(commentBody);
  if (!hasVerdict && !hasSignOff) return null;

  const prefix = commentBody.slice(0, 400);
  // A reviewer verdict leads with the bare convention ("Verdict: Approve"),
  // while the QA and UX verdicts name their seat. Neither is authorship.
  const seat = /\bverdict\s*:/i.test(prefix) &&
      !SEAT_PATTERNS.some(([, pattern]) => pattern.test(prefix))
    ? "reviewer"
    : seatOf(prefix);
  if (!seat) return null;
  return { seat, sha, at: createdAt };
}

/**
 * Compare the previous ledger with the current body.
 *
 * Returns one message per clobber; an empty list means no line changed hands.
 *
 * A same-seat claim change is allowed only when that seat posted a verdict
 * naming the new head. Without one the edit is an unowned re-label — the shape
 * a seat-change comparison misses, and the reason this check exists.
 */
export function compareLedger(
  previous: LedgerEntry[],
  current: VerifierLine[],
  verdicts: Verdict[],
  now: string = new Date().toISOString(),
): { errors: string[]; ledger: LedgerEntry[] } {
  const errors: string[] = [];
  const ledger: LedgerEntry[] = [];
  const byItem = new Map(previous.map((entry) => [entry.item, entry]));

  for (const line of current) {
    const before = byItem.get(line.item);
    byItem.delete(line.item);
    if (!before) {
      // A line the ledger has never seen is reviewable as a diff, not a fault.
      ledger.push({
        ...line,
        sha: "",
        firstSeenAt: now,
        lastSeenAt: now,
      });
      continue;
    }
    ledger.push({
      item: line.item,
      seat: line.seat,
      claimHash: line.claimHash,
      sha: before.sha,
      firstSeenAt: before.firstSeenAt,
      lastSeenAt: now,
    });
    if (line.seat !== before.seat) {
      errors.push(
        `Verification: the "${line.item}" line was written by ${before.seat} and is now attributed to ${line.seat}.`,
      );
      continue;
    }
    if (line.claimHash === before.claimHash) continue;
    // The claim changed under the same seat. That is legitimate only if the
    // seat itself says so, at the head the claim now names.
    const corroborated = verdicts.some((verdict) =>
      verdict.seat === line.seat &&
      (verdict.sha === "" || verdict.sha === headOf(line.claim) ||
        verdict.at >= before.lastSeenAt)
    );
    if (!corroborated) {
      errors.push(
        `Verification: the "${line.item}" line is attributed to ${line.seat} but its claim changed and ${line.seat} posted no verdict at ${
          headOf(line.claim) || "the new head"
        }; a body edit re-labelled another seat's claim.`,
      );
    }
  }

  for (const orphan of byItem.values()) {
    errors.push(
      `Verification: the "${orphan.item}" line was deleted; it was attributed to ${orphan.seat}.`,
    );
  }

  return { errors, ledger };
}

/** The head a claim names, if it names one. */
export function headOf(claim: string): string {
  return /([0-9a-f]{7,40})/.exec(claim.toLowerCase())?.[1]?.slice(0, 9) ?? "";
}
