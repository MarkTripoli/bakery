import type {
  ApiFailure,
  MentionCandidate,
  MentionSource,
} from "../api/client.ts";

/** The most people one message or comment may mention (the server's limit). */
export const MAX_MENTIONS = 20;

/** One person chosen from the picker, shown as a chip and sent as `mentions`. */
export type Mention = {
  readonly principalId: string;
  readonly name: string;
  /** Sending would give this person access to the conversation. */
  readonly gainsAccess: boolean;
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

/**
 * The text without a person's `@Name` (and the space after it), for removing a
 * chip. It cuts the whole word the chip stands for, never the start of a longer
 * name such as `@Samir` when the chip is `@Sam`.
 */
export function withoutMention(text: string, mention: Mention): string {
  const at = find(text, mention);
  if (at < 0) return text;
  const end = at + mention.name.length + 1;
  return text.slice(0, at) + text.slice(text[end] === " " ? end + 1 : end);
}

/**
 * The text with only the `@` taken off a person's `@Name`, so the name stays as
 * words ("Hi @Sam Patel" becomes "Hi Sam Patel"). It is for "Don't mention":
 * the chip's own remove button cuts the whole word instead.
 */
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
export type RowKind = "ready" | "gains" | "blocked";

/**
 * A person who can already read here is an ordinary row. In a conversation a
 * person who would gain access carries the badge; anyone else cannot be added.
 * A comment never widens access, so a person who cannot see the document is
 * blocked whatever else the server says.
 */
export function rowKind(
  candidate: Pick<MentionCandidate, "hasAccess" | "gainsAccessOnSend">,
  source: MentionSource["kind"],
): RowKind {
  if (candidate.hasAccess) return "ready";
  if (source === "conversation" && candidate.gainsAccessOnSend) return "gains";
  return "blocked";
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
