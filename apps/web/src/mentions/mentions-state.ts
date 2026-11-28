import type { ApiFailure, MentionCandidate } from "../api/client.ts";

/** The most people one message or comment may mention (the server's limit). */
export const MAX_MENTIONS = 20;

/** One person chosen from the picker, shown as a chip and sent as `mentions`. */
export type Mention = {
  readonly principalId: string;
  readonly name: string;
  /** Sending would give this person access to the conversation or document. */
  readonly gainsAccess: boolean;
  /**
   * This person has no access and the writer may not give it: someone who can
   * has to be asked (design-ux #73 revision 3, section 3). Sending is off until
   * the mention is removed.
   */
  readonly needsSharer: boolean;
};

/** The `@word` the caret is in: where it starts and what has been typed after the `@`. */
export type Trigger = { readonly start: number; readonly query: string };

/**
 * The mention being typed at the caret, or null. It opens on an `@` at the
 * start of the text or after a space or line break, and the typed word runs
 * up to the caret with no space in it (design-ux #73, section 1).
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

/** The text and caret after a person is chosen: `@Sam Patel ` replaces the typed `@sa`. */
export function insertMention(
  text: string,
  trigger: Trigger,
  caret: number,
  name: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret);
  // One space after the name is enough when the text goes on with a space.
  const tail = after.startsWith(" ") ? after.slice(1) : after;
  return {
    text: text.slice(0, trigger.start) + inserted + tail,
    caret: trigger.start + inserted.length,
  };
}

/** Where the `@Name` inserted for a person stands in the text, as a whole word; -1 when it is gone. */
function find(text: string, mention: Mention): number {
  const token = `@${mention.name}`;
  let from = 0;
  for (;;) {
    const found = text.indexOf(token, from);
    if (found < 0) return -1;
    const end = found + token.length;
    const startsWord = found === 0 || /\s/.test(text[found - 1]);
    const endsWord = end === text.length || !/[\p{L}\p{N}]/u.test(text[end]);
    if (startsWord && endsWord) return found;
    from = found + 1;
  }
}

/** Whether the text still carries the `@Name` that was inserted for a person. */
function carries(text: string, mention: Mention): boolean {
  return find(text, mention) >= 0;
}

/** Editing the inserted name removes its chip: only the people still named in the text stay. */
export function reconcile(
  text: string,
  mentions: readonly Mention[],
): Mention[] {
  return mentions.filter((mention) => carries(text, mention));
}

export function withoutAtSign(text: string, mention: Mention): string {
  const at = find(text, mention);
  if (at < 0) return text;
  return text.slice(0, at) + text.slice(at + 1);
}

/** Adds a person once: choosing the same person again keeps one chip. */
export function addMention(
  mentions: readonly Mention[],
  mention: Mention,
): Mention[] {
  return mentions.some((entry) => entry.principalId === mention.principalId)
    ? [...mentions]
    : [...mentions, mention];
}

/** What a picker row is, from what the server says about the person and where the writer is. */
export type RowKind = "ready" | "gains";

/**
 * A person who can already read here is an ordinary row. Anyone without access
 * can be chosen, in a conversation or on a document, and wears the badge:
 * whether sending gives the access or someone else has to is `needsSharer`.
 */
export function rowKind(
  candidate: Pick<MentionCandidate, "hasAccess">,
): RowKind {
  return candidate.hasAccess ? "ready" : "gains";
}

/** A person without access whom the writer may not give it to: someone who can share must be asked. */
export function needsSharer(
  candidate: Pick<MentionCandidate, "hasAccess" | "gainsAccessOnSend">,
): boolean {
  return !candidate.hasAccess && !candidate.gainsAccessOnSend;
}

/** The mentions with these people marked as needing a sharer, when the server says the writer may not share after all. */
export function markNeedsSharer(
  mentions: readonly Mention[],
  principalIds: ReadonlySet<string>,
): Mention[] {
  return mentions.map((mention) =>
    principalIds.has(mention.principalId)
      ? { ...mention, gainsAccess: false, needsSharer: true }
      : mention
  );
}

/**
 * Whether these people are exactly the ones a server refusal marked. The
 * "Not sent." wording is true only for them: once the writer swaps one of
 * them for someone else, no send involving the new person has failed.
 */
export function onlyThese(
  people: readonly Mention[],
  principalIds: readonly string[],
): boolean {
  return people.length > 0 && people.length === principalIds.length &&
    people.every((mention) => principalIds.includes(mention.principalId));
}

/**
 * The mentions with these people marked as gaining access on send, when the
 * server says they cannot see the conversation after all: the offer comes back
 * and the same Send gives the access.
 */
export function markGainsAccess(
  mentions: readonly Mention[],
  principalIds: ReadonlySet<string>,
): Mention[] {
  return mentions.map((mention) =>
    principalIds.has(mention.principalId)
      ? { ...mention, gainsAccess: true, needsSharer: false }
      : mention
  );
}

/**
 * The text with one more line at the end, and where that line stands, so the
 * field can select it and typing replaces it (an "Ask {name}" line).
 */
export function appendLine(
  text: string,
  line: string,
): { readonly text: string; readonly start: number; readonly end: number } {
  const gap = text === "" || text.endsWith("\n") ? "" : "\n";
  const start = text.length + gap.length;
  return { text: text + gap + line, start, end: start + line.length };
}

/** The arguments the "names" messages take: how many, the first two, and how many are left. */
export function nameParts(names: readonly string[]): {
  readonly count: number;
  readonly first: string;
  readonly second: string;
  readonly rest: number;
} {
  return {
    count: names.length,
    first: names[0] ?? "",
    second: names[1] ?? "",
    rest: Math.max(0, names.length - 2),
  };
}

/** The candidates still to offer: not already mentioned. */
export function offered(
  candidates: readonly MentionCandidate[],
  mentions: readonly Mention[],
): MentionCandidate[] {
  const taken = new Set(mentions.map((mention) => mention.principalId));
  return candidates.filter((candidate) => !taken.has(candidate.principalId));
}

/** Why the server refused one mention, as the issue code names it. */
export type RefusalCode = "not_member" | "share_forbidden" | "no_thread_access";

/** One refused mention: its place in the `mentions` sent, and why. */
export type Refusal = { readonly index: number; readonly code: RefusalCode };

const REFUSAL_WORDS: Readonly<Record<string, RefusalCode>> = {
  "mention not member": "not_member",
  "mention share forbidden": "share_forbidden",
  "mention no thread access": "no_thread_access",
};

/**
 * The refused mentions in an `UNPROCESSABLE` answer. The server names each as
 * an issue at `/mentions/<index>` whose message is its code with spaces for
 * underscores; any other failure has none.
 */
export function refusalsOf(failure: ApiFailure): Refusal[] {
  if (failure.kind !== "problem" || failure.problem.issues === undefined) {
    return [];
  }
  return failure.problem.issues.flatMap((issue) => {
    const match = /^\/mentions\/(\d+)$/.exec(issue.path);
    const code = REFUSAL_WORDS[issue.message];
    return match !== null && code !== undefined
      ? [{ index: Number(match[1]), code }]
      : [];
  });
}

/** The refused people, in the order they were sent, for the sentence above the box. */
export function refusedPeople(
  mentions: readonly Mention[],
  refusals: readonly Refusal[],
): { readonly mention: Mention; readonly code: RefusalCode }[] {
  return refusals.flatMap((refusal) => {
    const mention = mentions[refusal.index];
    return mention === undefined ? [] : [{ mention, code: refusal.code }];
  });
}
