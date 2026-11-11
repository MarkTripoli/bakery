/**
 * Private per-task message draft. It lives only in this browser's
 * `localStorage`, keyed by organization, principal and task, and is never sent
 * until the person presses Send. The send id is minted at the first send of a
 * body and kept until the outcome is definitive, so a retry after an unknown
 * outcome or a reload replays the same client message id.
 */
export const DRAFT_PREFIX = "bakery.taskConversation.draft";

export type DraftIntent = "discuss" | "ask";

export type Draft = Readonly<{
  body: string;
  intent: DraftIntent;
  /** Client message id (and idempotency key) of an in-flight send, if any. */
  sendId: string | null;
  /** Body the `sendId` was minted for. */
  sendBody: string | null;
}>;

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const EMPTY_DRAFT: Draft = Object.freeze({
  body: "",
  intent: "discuss",
  sendId: null,
  sendBody: null,
});

export function draftKey(
  organizationId: string,
  principalId: string,
  taskId: string,
): string {
  return `${DRAFT_PREFIX}:${organizationId}:${principalId}:${taskId}`;
}

export function browserDraftStore(): DraftStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadDraft(store: DraftStore | undefined, key: string): Draft {
  try {
    const raw = store?.getItem(key);
    if (!raw) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.body !== "string") {
      return EMPTY_DRAFT;
    }
    return {
      body: parsed.body,
      intent: parsed.intent === "ask" ? "ask" : "discuss",
      sendId: typeof parsed.sendId === "string" ? parsed.sendId : null,
      sendBody: typeof parsed.sendBody === "string" ? parsed.sendBody : null,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(
  store: DraftStore | undefined,
  key: string,
  draft: Draft,
): void {
  try {
    if (draft.body === "" && draft.sendId === null) {
      // Keep the chosen intent even for an empty draft.
      if (draft.intent === "discuss") return store?.removeItem(key);
    }
    store?.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage may be full or blocked; the in-memory draft still holds.
  }
}
