import { Fragment, type ReactNode } from "react";

/**
 * The value a sentence is formatted with where part of it becomes a link. The
 * translated sentence keeps its own word order; this puts the link where the
 * translator put the placeholder.
 */
export const LINK_SLOT = "\u0000";

/** The sentence with `link` in place of its slot (the slot is dropped if none). */
export function withLink(sentence: string, link: ReactNode): ReactNode {
  const parts = sentence.split(LINK_SLOT);
  if (parts.length !== 2) return parts.join("");
  return <Fragment>{parts[0]}{link}{parts[1]}</Fragment>;
}
