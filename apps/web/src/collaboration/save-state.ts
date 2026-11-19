/** Where this person's own changes stand; the words are the caller's. */
export type SaveState =
  | "saved"
  | "sending"
  | "offline"
  | "catching-up"
  | "refused";

/**
 * Which save state to show. Not reaching the server outranks everything,
 * because nothing typed then is saved; a sync in progress comes next (the
 * editor is read-only for that moment); a refusal stays until its pieces are
 * dealt with; "sending" shows only once the wait has passed 500 ms, so a fast
 * save never flickers.
 */
export function deriveSaveState(
  input: Readonly<{
    online: boolean;
    syncing: boolean;
    refusedCount: number;
    pendingCount: number;
    sendingVisible: boolean;
  }>,
): SaveState {
  if (!input.online) return "offline";
  if (input.syncing) return "catching-up";
  if (input.refusedCount > 0) return "refused";
  if (input.pendingCount > 0 && input.sendingVisible) return "sending";
  return "saved";
}

/** A save shows "Saving…" only after waiting this long (design, #71). */
export const SENDING_VISIBLE_AFTER_MS = 500;
