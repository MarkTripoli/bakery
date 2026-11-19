import { LoroDoc } from "loro-crdt/base64";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "./binary-frame.ts";
import type { Participant } from "./people.ts";
import {
  deriveSaveState,
  type SaveState,
  SENDING_VISIBLE_AFTER_MS,
} from "./save-state.ts";

/** The largest live document the server keeps (docs 20: "1 MiB UTF-8"). */
export const DOCUMENT_LIMIT_BYTES = 1024 * 1024;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const OPEN = 1;

/** The slice of the browser's WebSocket the session uses; tests pass a fake. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Text the person typed that the server did not keep. Never dropped silently. */
export type RefusedPiece = Readonly<{
  id: string;
  /** What was typed (or, for a deletion, the text that was removed), so it can be copied back. */
  text: string;
  /** `deleted`: the change removed this text and the server put it back. */
  change: "typed" | "deleted";
  /** When it was typed, epoch milliseconds. */
  typedAt: number;
  /** Why it is here; never shown to the person as a word. */
  cause: "rejected" | "stale" | "epoch" | "revoked" | "closed";
}>;

/** What the page tells the person above the editor. */
export type SessionBanner =
  | Readonly<{
    kind: "published";
    /** Who published, when known. */
    name: string | null;
    versionNumber: number;
  }>
  | Readonly<{ kind: "replaced" }>
  | Readonly<{ kind: "revoked" }>;

export type SessionSnapshot = Readonly<{
  /** `ended`: the server closed this person out; nothing reconnects. */
  connection: "connecting" | "online" | "offline" | "ended";
  /** Joined but not yet synchronized with the server's text. */
  syncing: boolean;
  /** The editor refuses input: syncing, ended or still connecting. */
  readOnly: boolean;
  saveState: SaveState;
  pendingCount: number;
  refused: readonly RefusedPiece[];
  banner: SessionBanner | null;
  participants: readonly Participant[];
  epoch: number;
  /** Bumps when the document is rebuilt from the server; the editor rebinds. */
  documentVersion: number;
}>;

type Timer = unknown;
export type SessionOptions = Readonly<{
  draftId: string;
  createSocket: () => SocketLike;
  createDocument?: () => LoroDoc;
  now?: () => number;
  uuid?: () => string;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** 0..1, for the reconnect jitter. */
  random?: () => number;
  /** Unsaved pieces survive a reload when a store is given (kept on this device). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}>;

type Pending = {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly change: "typed" | "deleted";
  readonly typedAt: number;
  /** Sent on this connection already. */
  sent: boolean;
  retried: boolean;
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PRESENCE_MIN_INTERVAL_MS = 200;
/** A socket that opens but never says hello is dead; give it this long. */
const HELLO_TIMEOUT_MS = 15_000;

/** The text a change inserted and the text it removed (common prefix and suffix excluded). */
export function changeBetween(
  before: string,
  after: string,
): { inserted: string; removed: string } {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start && endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return {
    inserted: after.slice(start, endAfter),
    removed: before.slice(start, endBefore),
  };
}

/** The text that was inserted between `before` and `after`. */
export function insertedBetween(before: string, after: string): string {
  return changeBetween(before, after).inserted;
}

/**
 * One person's live connection to one draft: joins the room, keeps the Loro
 * document in step with the server, sends each local change under its own
 * mutation id, and turns every way a change can fail into words the page can
 * show without ever losing what was typed.
 *
 * It owns no UI and no React; `subscribe`/`getSnapshot` make it a store.
 */
export class CollaborationSession {
  readonly #options: SessionOptions;
  readonly #listeners = new Set<() => void>();
  #socket: SocketLike | null = null;
  #doc: LoroDoc;
  #unsubscribeLocal: (() => void) | null = null;
  #lastText = "";
  #documentVersion = 0;
  #connection: SessionSnapshot["connection"] = "connecting";
  #syncing = true;
  #epoch = 0;
  #pending: Pending[] = [];
  #refused: RefusedPiece[] = [];
  #banner: SessionBanner | null = null;
  #lastPublication: { name: string | null; versionNumber: number } | null =
    null;
  #participants = new Map<string, Participant>();
  #sendingVisible = false;
  #sendingTimer: Timer | null = null;
  #reconnectTimer: Timer | null = null;
  #heartbeatTimer: Timer | null = null;
  #helloTimer: Timer | null = null;
  /** When any frame last arrived: a socket that stays silent is half-open. */
  #lastInboundAt = 0;
  #attempts = 0;
  #joinRequestId: string | null = null;
  #syncRequestId: string | null = null;
  #presenceAt = Number.NEGATIVE_INFINITY;
  #presenceTimer: Timer | null = null;
  #presencePending: Participant["state"] | null = null;
  #destroyed = false;
  #snapshot: SessionSnapshot;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#doc = this.#newDocument();
    this.#loadRefused();
    this.#snapshot = this.#build();
  }

  /** The document the editor binds to; a new one after a rebuild. */
  get document(): LoroDoc {
    return this.#doc;
  }

  subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.#snapshot;

  /** Opens the connection. Call once; reconnecting is the session's own job. */
  start(): void {
    if (this.#destroyed || this.#socket) return;
    this.#connect();
  }

  /** Leaves the room and stops every timer. */
  destroy(): void {
    if (this.#destroyed) return;
    // Leaving with text the server has not acknowledged: keep it on this
    // device, so the next visit offers it back instead of losing it.
    this.#moveAllPendingToRefused("closed");
    this.#destroyed = true;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen =
        socket.onmessage =
        socket.onclose =
        socket.onerror =
          null;
      try {
        socket.close(1000, "left");
      } catch {
        // Already closing.
      }
    }
    this.#unsubscribeLocal?.();
    this.#unsubscribeLocal = null;
  }

  /** The person copied or gave up on a piece; it leaves the sheet. */
  discardRefused(id: string): void {
    this.#refused = this.#refused.filter((piece) => piece.id !== id);
    this.#saveRefused();
    this.#emit();
  }

  dismissBanner(): void {
    this.#banner = null;
    this.#emit();
  }

  /** This person's own hint; coalesced to a few a second. */
  setPresence(state: Participant["state"]): void {
    this.#presencePending = state;
    const wait = this.#presenceAt + PRESENCE_MIN_INTERVAL_MS - this.#now();
    if (wait <= 0) return this.#flushPresence();
    if (this.#presenceTimer !== null) return;
    this.#presenceTimer = this.#setTimer(() => {
      this.#presenceTimer = null;
      this.#flushPresence();
    }, wait);
  }

  // ---- connection ----------------------------------------------------------

  #connect(): void {
    if (this.#destroyed) return;
    this.#connection = this.#attempts === 0 ? "connecting" : "offline";
    this.#syncing = true;
    const socket = this.#options.createSocket();
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#lastInboundAt = this.#now();
    this.#clearHello();
    this.#helloTimer = this.#setTimer(() => {
      this.#helloTimer = null;
      if (this.#socket === socket && this.#connection !== "online") {
        this.#lost();
      }
    }, HELLO_TIMEOUT_MS);
    socket.onmessage = (event) => this.#onMessage(socket, event.data);
    socket.onclose = (event) => this.#onClose(socket, event.code);
    socket.onerror = () => {};
    this.#emit();
  }

  #onClose(socket: SocketLike, _code: number): void {
    if (this.#socket !== socket || this.#destroyed) return;
    this.#lost();
  }

  /**
   * The connection is gone, whether the browser said so or it went silent
   * (a half-open socket never fires close): start the reconnect cycle.
   */
  #lost(): void {
    this.#clearHello();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen =
        socket.onmessage =
        socket.onclose =
        socket.onerror =
          null;
      try {
        socket.close(4000, "silent");
      } catch {
        // Already closed.
      }
    }
    this.#clearHeartbeat();
    for (const pending of this.#pending) pending.sent = false;
    this.#participants.clear();
    if (this.#connection === "ended") return this.#emit();
    this.#connection = "offline";
    this.#syncing = true;
    this.#scheduleReconnect();
    this.#emit();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null || this.#destroyed) return;
    const exponential = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** this.#attempts,
    );
    const jitter = 0.8 + (this.#options.random?.() ?? Math.random()) * 0.4;
    this.#attempts += 1;
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, Math.round(exponential * jitter));
  }

  #end(banner: SessionBanner | null): void {
    this.#connection = "ended";
    this.#syncing = false;
    this.#banner = banner;
    this.#moveAllPendingToRefused("revoked");
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, "ended");
      } catch {
        // Already closed.
      }
    }
    this.#emit();
  }

  // ---- frames --------------------------------------------------------------

  #onMessage(socket: SocketLike, data: unknown): void {
    if (this.#socket !== socket || this.#destroyed) return;
    this.#lastInboundAt = this.#now();
    if (data instanceof ArrayBuffer) {
      return this.#onBinary(new Uint8Array(data));
    }
    if (data instanceof Uint8Array) return this.#onBinary(data);
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = contractSchemas.CollaborationFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data as { type: string } & Record<string, unknown>;
    switch (frame.type) {
      case "hello":
        return this.#onHello(frame.heartbeatSeconds as number);
      case "joined": {
        if (frame.requestId !== this.#joinRequestId) return;
        this.#participants.clear();
        for (const participant of frame.participants as Participant[]) {
          this.#participants.set(participant.participantKey, participant);
        }
        this.#sendSync();
        return this.#emit();
      }
      case "synced":
        if (frame.requestId !== this.#syncRequestId) return;
        this.#observeEpoch(frame.epoch as number);
        return; // The snapshot bytes follow; synchronization ends when they land.
      case "presence": {
        const presence = frame.presence as Participant;
        this.#participants.set(presence.participantKey, presence);
        return this.#emit();
      }
      case "presence.removed":
        this.#participants.delete(frame.participantKey as string);
        return this.#emit();
      case "ack":
        return this.#onAck(frame.mutationId as string);
      case "committed":
        return;
      case "published": {
        const publication = frame.publication as {
          publishedByName: string;
          versionNumber: number;
        };
        this.#lastPublication = {
          name: publication.publishedByName || null,
          versionNumber: publication.versionNumber,
        };
        this.#banner = { kind: "published", ...this.#lastPublication };
        return this.#emit();
      }
      case "resync_required":
        return this.#onResync(
          frame.mutationId as string | null,
          frame.reason as string,
        );
      case "ping":
        return this.#sendJson({ type: "ping", requestId: frame.requestId });
      case "problem":
        return this.#onProblem(
          frame.problem as {
            status: number;
            code?: string;
            retryable?: boolean;
          },
        );
      default:
        return; // presence.update, suggestion and the like are not this layer's.
    }
  }

  #onBinary(bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeBinaryFrame(bytes);
    } catch {
      return;
    }
    if (frame.kind === BinaryFrameKind.ServerSnapshot) {
      this.#observeEpoch(frame.epoch);
      this.#importRemote(frame.payload);
      this.#finishSync();
    } else if (frame.kind === BinaryFrameKind.ServerUpdate) {
      this.#importRemote(frame.payload);
    }
  }

  #onHello(heartbeatSeconds: number): void {
    this.#clearHello();
    this.#attempts = 0;
    this.#connection = "online";
    this.#clearHeartbeat();
    this.#heartbeatTimer = this.#setTimer(
      () => this.#heartbeat(heartbeatSeconds),
      heartbeatSeconds * 1000,
    );
    this.#joinRequestId = this.#uuid();
    this.#sendJson({
      type: "join",
      requestId: this.#joinRequestId,
      room: { kind: "draft", id: this.#options.draftId },
    });
    this.#emit();
  }

  #heartbeat(seconds: number): void {
    // The server answers every ping, so two silent intervals mean the link is dead.
    if (this.#now() - this.#lastInboundAt >= 2 * seconds * 1000) {
      return this.#lost();
    }
    this.#sendJson({ type: "ping", requestId: this.#uuid() });
    this.#heartbeatTimer = this.#setTimer(
      () => this.#heartbeat(seconds),
      seconds * 1000,
    );
  }

  #sendSync(): void {
    this.#syncing = true;
    this.#syncRequestId = this.#uuid();
    this.#sendJson({
      type: "sync",
      requestId: this.#syncRequestId,
      room: { kind: "draft", id: this.#options.draftId },
    });
    this.#emit();
  }

  /** The server's text has landed: send what was typed meanwhile. */
  #finishSync(): void {
    this.#syncing = false;
    this.#lastText = this.#doc.getText("body").toString();
    this.#flush();
    this.#emit();
  }

  #importRemote(payload: Uint8Array): void {
    try {
      this.#doc.import(payload);
    } catch {
      return this.#sendSync(); // A bad update: start from the server's own state.
    }
    this.#lastText = this.#doc.getText("body").toString();
    this.#emit();
  }

  // ---- local changes -------------------------------------------------------

  #newDocument(): LoroDoc {
    this.#unsubscribeLocal?.();
    const doc = this.#options.createDocument?.() ?? new LoroDoc();
    this.#lastText = doc.getText("body").toString();
    this.#unsubscribeLocal = doc.subscribeLocalUpdates((bytes: Uint8Array) =>
      this.#onLocalUpdate(bytes)
    );
    return doc;
  }

  #onLocalUpdate(bytes: Uint8Array): void {
    if (this.#destroyed || this.#connection === "ended") return;
    const after = this.#doc.getText("body").toString();
    const { inserted, removed } = changeBetween(this.#lastText, after);
    this.#lastText = after;
    this.#pending.push({
      id: this.#uuid(),
      bytes,
      text: inserted !== "" ? inserted : removed,
      change: inserted !== "" ? "typed" : "deleted",
      typedAt: this.#now(),
      sent: false,
      retried: false,
    });
    this.#armSendingTimer();
    this.#flush();
    this.#emit();
  }

  #flush(): void {
    const socket = this.#socket;
    if (
      !socket || socket.readyState !== OPEN || this.#syncing ||
      this.#connection !== "online"
    ) return;
    for (const pending of this.#pending) {
      if (pending.sent) continue;
      pending.sent = true;
      socket.send(encodeBinaryFrame({
        kind: BinaryFrameKind.ClientUpdate,
        epoch: this.#epoch,
        draftId: this.#options.draftId,
        mutationId: pending.id,
        sequence: 0n,
        payload: pending.bytes,
      }));
    }
  }

  #armSendingTimer(): void {
    if (this.#sendingTimer !== null || this.#sendingVisible) return;
    this.#sendingTimer = this.#setTimer(() => {
      this.#sendingTimer = null;
      this.#sendingVisible = this.#pending.length > 0;
      this.#emit();
    }, SENDING_VISIBLE_AFTER_MS);
  }

  #onAck(mutationId: string): void {
    this.#pending = this.#pending.filter((pending) =>
      pending.id !== mutationId
    );
    if (this.#pending.length === 0) {
      this.#sendingVisible = false;
      if (this.#sendingTimer !== null) this.#clearTimer(this.#sendingTimer);
      this.#sendingTimer = null;
    }
    this.#emit();
  }

  // ---- ways a change can fail ----------------------------------------------

  #onResync(mutationId: string | null, reason: string): void {
    if (reason === "epoch") {
      this.#banner = this.#lastPublication
        ? { kind: "published", ...this.#lastPublication }
        : { kind: "replaced" };
      this.#lastPublication = null;
      // Text not yet sent was written against the old draft: it goes to the sheet, never dropped.
      this.#moveAllPendingToRefused("epoch");
      return this.#rebuild();
    }
    if (reason === "rejected") {
      this.#movePendingToRefused(mutationId, "rejected");
      return this.#rebuild();
    }
    if (reason === "stale") {
      const pending = this.#pending.find((item) => item.id === mutationId);
      if (pending && pending.retried) {
        this.#movePendingToRefused(mutationId, "stale");
        return this.#rebuild();
      }
      // First time: catch up on the server's text, then send it again.
      for (const item of this.#pending) {
        if (item.id === mutationId) item.retried = true;
        item.sent = false;
      }
      return this.#sendSync();
    }
    // left, closed, expired, revoked about this connection: start from the
    // server's text. A mutation the server names a second time is not coming
    // through by being sent again: refuse it rather than loop.
    const named = this.#pending.find((item) => item.id === mutationId);
    if (named?.retried) {
      this.#movePendingToRefused(mutationId, "rejected");
      return this.#rebuild();
    }
    if (named) named.retried = true;
    for (const item of this.#pending) item.sent = false;
    this.#sendSync();
    this.#emit();
  }

  #onProblem(
    problem: { status: number; code?: string; retryable?: boolean },
  ): void {
    if (problem.status === 401 || problem.status === 403) {
      return this.#end({ kind: "revoked" });
    }
    if (problem.status === 404) return this.#end(null);
    if (
      problem.status >= 400 && problem.status < 500 &&
      problem.retryable !== true
    ) {
      // A refusal of what we sent (too large, malformed) never gets better by
      // sending it again. Every unsent edit is refused with it: local edits in
      // one document build on each other, so a later one imported without the
      // refused one applies nothing and the server would ack it as "nothing
      // new", losing it silently. All of it is kept for the sheet and the
      // document starts again from the server's text.
      this.#moveAllPendingToRefused("rejected");
      this.#doc = this.#newDocument();
      this.#documentVersion += 1;
      this.#emit();
    }
    // Anything else is the server's trouble, not a verdict: reconnect after a pause.
    this.#socket?.close(1011, "problem");
  }

  /**
   * The server's epoch for this draft. A different one after the first means
   * the draft was replaced while this tab was away: whatever is unsent was
   * written against the old draft and must not be stamped with the new epoch,
   * so it goes to the sheet and the document starts again from the server's.
   */
  #observeEpoch(epoch: number): void {
    if (this.#epoch !== 0 && epoch !== this.#epoch) {
      this.#banner = this.#lastPublication
        ? { kind: "published", ...this.#lastPublication }
        : { kind: "replaced" };
      this.#lastPublication = null;
      this.#moveAllPendingToRefused("epoch");
      this.#doc = this.#newDocument();
      this.#documentVersion += 1;
    }
    this.#epoch = epoch;
  }

  #movePendingToRefused(
    mutationId: string | null,
    cause: RefusedPiece["cause"],
  ): void {
    const rest: Pending[] = [];
    for (const pending of this.#pending) {
      if (pending.id === mutationId) this.#addRefused(pending, cause);
      else rest.push(pending);
    }
    // What came after the refused change was written on top of it and cannot apply either.
    for (const pending of rest) this.#addRefused(pending, cause);
    this.#pending = [];
    this.#afterPendingCleared();
  }

  #moveAllPendingToRefused(cause: RefusedPiece["cause"]): void {
    for (const pending of this.#pending) this.#addRefused(pending, cause);
    this.#pending = [];
    this.#afterPendingCleared();
  }

  #afterPendingCleared(): void {
    this.#sendingVisible = false;
    if (this.#sendingTimer !== null) this.#clearTimer(this.#sendingTimer);
    this.#sendingTimer = null;
    this.#saveRefused();
  }

  #addRefused(pending: Pending, cause: RefusedPiece["cause"]): void {
    if (pending.text === "") return; // Nothing to give back.
    this.#refused = [{
      id: pending.id,
      text: pending.text,
      change: pending.change,
      typedAt: pending.typedAt,
      cause,
    }, ...this.#refused];
  }

  /** Starts a fresh document from the server's state; the editor rebinds. */
  #rebuild(): void {
    this.#doc = this.#newDocument();
    this.#documentVersion += 1;
    this.#sendSync();
    this.#emit();
  }

  // ---- presence ------------------------------------------------------------

  #flushPresence(): void {
    const state = this.#presencePending;
    if (!state) return;
    this.#presencePending = null;
    this.#presenceAt = this.#now();
    this.#sendJson({
      type: "presence.update",
      requestId: this.#uuid(),
      room: { kind: "draft", id: this.#options.draftId },
      state,
    });
  }

  // ---- plumbing ------------------------------------------------------------

  #sendJson(frame: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  #storageKey(): string {
    return `bakery.collaboration.unsaved.${this.#options.draftId}`;
  }

  #loadRefused(): void {
    try {
      const raw = this.#options.storage?.getItem(this.#storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as RefusedPiece[];
      if (Array.isArray(parsed)) {
        this.#refused = parsed.filter((piece) =>
          typeof piece?.id === "string" && typeof piece.text === "string" &&
          typeof piece.typedAt === "number"
        ).map((piece) => ({ ...piece, change: piece.change ?? "typed" }));
      }
    } catch {
      // An unreadable store is an empty one.
    }
  }

  #saveRefused(): void {
    const storage = this.#options.storage;
    if (!storage) return;
    try {
      if (this.#refused.length === 0) storage.removeItem(this.#storageKey());
      else storage.setItem(this.#storageKey(), JSON.stringify(this.#refused));
    } catch {
      // Best effort: the pieces are still in memory.
    }
  }

  #build(): SessionSnapshot {
    const online = this.#connection === "online";
    return {
      connection: this.#connection,
      syncing: this.#syncing,
      readOnly: this.#connection === "ended" || this.#syncing ||
        this.#connection === "connecting",
      saveState: deriveSaveState({
        online,
        syncing: this.#syncing,
        refusedCount: this.#refused.length,
        pendingCount: this.#pending.length,
        sendingVisible: this.#sendingVisible,
      }),
      pendingCount: this.#pending.length,
      refused: this.#refused,
      banner: this.#banner,
      participants: [...this.#participants.values()],
      epoch: this.#epoch,
      documentVersion: this.#documentVersion,
    };
  }

  #emit(): void {
    this.#snapshot = this.#build();
    for (const listener of [...this.#listeners]) listener();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #uuid(): string {
    const id = this.#options.uuid?.() ?? crypto.randomUUID();
    return id === ZERO_UUID ? crypto.randomUUID() : id;
  }

  #setTimer(callback: () => void, ms: number): Timer {
    return this.#options.setTimer?.(callback, ms) ??
      globalThis.setTimeout(callback, ms);
  }

  #clearTimer(timer: Timer): void {
    if (this.#options.clearTimer) this.#options.clearTimer(timer);
    else globalThis.clearTimeout(timer as number);
  }

  #clearHello(): void {
    if (this.#helloTimer !== null) this.#clearTimer(this.#helloTimer);
    this.#helloTimer = null;
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) this.#clearTimer(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #clearTimers(): void {
    this.#clearHeartbeat();
    for (
      const timer of [
        this.#sendingTimer,
        this.#helloTimer,
        this.#reconnectTimer,
        this.#presenceTimer,
      ]
    ) {
      if (timer !== null) this.#clearTimer(timer);
    }
    this.#sendingTimer =
      this.#helloTimer =
      this.#reconnectTimer =
      this.#presenceTimer =
        null;
  }
}
