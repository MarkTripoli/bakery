import type { BrowserSession, BrowserSessionList } from "../api/client.ts";

/** Every session other than the one this browser holds, most recently refreshed first. */
export function otherSessions(
  list: BrowserSessionList,
): readonly BrowserSession[] {
  return list.items
    .filter((session) => !session.current)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Picks the row glyph for a session from its recorded user agent: handheld
 * browsers announce themselves with one of these tokens, everything else
 * (including an unrecorded agent) reads as a desktop.
 */
export function deviceKind(userAgent: string | null): "desktop" | "phone" {
  return userAgent !== null && /\b(?:Mobi|Android|iPhone|iPad|iPod)\b/i.test(
      userAgent,
    )
    ? "phone"
    : "desktop";
}
