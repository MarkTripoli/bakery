import { Cursor, type LoroDoc } from "loro-crdt/base64";
import type { Participant } from "./people.ts";

/** Where another person's caret and selection are, in this document's text. */
export type RemoteCaret = Readonly<{
  principalId: string;
  /** First name only: the label beside the caret. */
  name: string;
  /** Where the selection starts and where the caret is (they are equal for a bare caret). */
  anchor: number;
  head: number;
}>;

/** A person's first name; the whole name when it has no space. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

/** A position in the text as an opaque, edit-proof cursor, or null when there is none. */
export function encodeCursorAt(
  document: LoroDoc,
  position: number,
): string | null {
  try {
    const cursor = document.getText("body").getCursor(position, 0);
    if (!cursor) return null;
    return btoa(String.fromCharCode(...cursor.encode()));
  } catch {
    return null;
  }
}

/** The position an opaque cursor points at now, or null when it cannot be read. */
export function positionOf(document: LoroDoc, encoded: string): number | null {
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return document.getCursorPos(Cursor.decode(bytes))?.offset ?? null;
  } catch {
    return null;
  }
}

/**
 * One caret for each other person who has a cursor in this document: the most
 * recent of their sessions, never this person's own. Cursors that cannot be
 * resolved in this text are left out.
 */
export function remoteCarets(
  document: LoroDoc,
  participants: readonly Participant[],
  selfPrincipalId: string | null,
): RemoteCaret[] {
  const latest = new Map<string, Participant>();
  for (const participant of participants) {
    if (participant.principalId === selfPrincipalId) continue;
    if (participant.state.cursor === null) continue;
    const known = latest.get(participant.principalId);
    if (!known || known.receivedAt < participant.receivedAt) {
      latest.set(participant.principalId, participant);
    }
  }
  const carets: RemoteCaret[] = [];
  for (const participant of latest.values()) {
    const cursor = participant.state.cursor!;
    const anchor = positionOf(document, cursor.anchor);
    const head = positionOf(document, cursor.head);
    if (anchor === null || head === null) continue;
    carets.push({
      principalId: participant.principalId,
      // A person is known by their first name; an agent or worker has no first
      // name, so its whole name is the label ("Coding agent", not "Coding").
      name: participant.principalType === "human"
        ? firstName(participant.displayName)
        : participant.displayName,
      anchor,
      head,
    });
  }
  return carets;
}
