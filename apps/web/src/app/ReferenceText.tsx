import { Fragment, type ReactNode } from "react";
import { shortReference } from "@bakery/ui";
import { ReferenceLink } from "./ReferenceLink.tsx";

/** A whole id the page knows, which a translated sentence may name in its short form. */
export type KnownReference = Readonly<{ kind: "commit"; value: string }>;

const HEX = /[0-9a-f]/i;
/** Punctuation that stays with the reference so it never wraps away from it. */
const TRAILING = /^[.,;:!?)\]]+/;

type Match = Readonly<{ at: number; end: number; known: KnownReference }>;

function matches(
  text: string,
  known: readonly KnownReference[],
): readonly Match[] {
  const found: Match[] = [];
  const seen = new Set<string>();
  for (const entry of known) {
    const short = shortReference(entry.kind, entry.value);
    if (short === "" || seen.has(short)) continue;
    seen.add(short);
    let at = text.indexOf(short);
    while (at !== -1) {
      const end = at + short.length;
      const before = at === 0 ? "" : text[at - 1];
      const after = end >= text.length ? "" : text[end];
      if (!HEX.test(before) && !HEX.test(after)) {
        found.push({ at, end, known: entry });
      }
      at = text.indexOf(short, end);
    }
  }
  found.sort((a, b) => a.at - b.at);
  return found.filter((match, index) =>
    index === 0 || match.at >= found[index - 1].end
  );
}

/**
 * A translated sentence with every short id it names that the page knows in
 * full drawn as a reference (owner rule, #59): the id keeps its card with the
 * whole value and Copy. Text that names no known id comes back unchanged.
 */
export function ReferenceText(
  { text, known }: Readonly<{
    /** The final translated sentence. */
    text: string;
    /** The whole ids the page knows; each is found by its short form, as a whole token. */
    known: readonly KnownReference[];
  }>,
): ReactNode {
  const found = matches(text, known);
  if (found.length === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of found) {
    if (match.at < from) continue;
    if (match.at > from) parts.push(text.slice(from, match.at));
    const trailing = TRAILING.exec(text.slice(match.end))?.[0] ?? "";
    parts.push(
      <ReferenceLink
        key={match.at}
        kind={match.known.kind}
        value={match.known.value}
        {...(trailing === "" ? {} : { trailing })}
      />,
    );
    from = match.end + trailing.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <Fragment>{parts}</Fragment>;
}

/** The commits, as references a sentence may name. */
export function knownCommits(
  values: readonly (string | null | undefined)[],
): readonly KnownReference[] {
  return [...new Set(values)].flatMap((value) =>
    typeof value === "string" && value !== ""
      ? [{ kind: "commit" as const, value }]
      : []
  );
}
