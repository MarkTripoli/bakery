import type { z } from "zod";
import {
  isUuid,
  type OrganizationId,
  organizationId,
  type PrincipalId,
  principalId,
} from "@bakery/contracts/contracts";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  getTraceId,
  problemResponse,
  StandardError,
  toProblem,
} from "@bakery/contracts/http";
import {
  requireOrganizationIdValue,
  resolveOrganizationActor,
} from "../auth/adapters/authority-postgres.ts";
import { authorize } from "../auth/application/authorize.ts";
import {
  type AuthenticatedSubject,
  IdentityResolutionError,
} from "../auth/application/identity.ts";
import { readSessionToken } from "../auth/middleware.ts";
import type { SessionStore } from "../auth/adapters/postgres.ts";
import {
  resolveSessionAssurance,
  SessionAssurance,
} from "../auth/domain/assurance.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import {
  commitDraftUpdate,
  type DraftReceipt,
  prepareDraftUpdate,
  readDraft,
  readDraftState,
  StaleDraftCandidateError,
} from "./draft-persistence.ts";
import { type DraftIsolation, DraftIsolationError } from "./draft-isolation.ts";
import { DRAFT_LIMITS } from "./drafts.ts";
import { sha256Bytes } from "./bytes.ts";

type Frame = z.output<typeof contractSchemas.CollaborationFrame>;
type Room = z.output<typeof contractSchemas.CollaborationRoom>;
type PresenceState = z.output<
  typeof contractSchemas.CollaborationPresenceState
>;
type Presence = z.output<typeof contractSchemas.CollaborationPresence>;
type RemovalReason = "left" | "closed" | "expired" | "revoked";

export const COLLABORATION_PROTOCOL_VERSION = 1;

/** Binary frame kinds; see the CollaborationFrame contract description. */
export const BinaryFrameKind = Object.freeze(
  {
    ClientUpdate: 1,
    ServerSnapshot: 2,
    ServerUpdate: 3,
  } as const,
);
export const BINARY_HEADER_BYTES = 52;
const BINARY_VERSION = 1;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type BinaryFrame = {
  kind: number;
  epoch: number;
  draftId: string;
  mutationId: string;
  sequence: bigint;
  payload: Uint8Array;
};

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

/** Encodes one binary collaboration frame (52-byte big-endian header + payload). */
export function encodeBinaryFrame(frame: BinaryFrame): Uint8Array {
  const output = new Uint8Array(BINARY_HEADER_BYTES + frame.payload.length);
  const view = new DataView(output.buffer);
  view.setUint8(0, BINARY_VERSION);
  view.setUint8(1, frame.kind);
  view.setUint16(2, 0);
  view.setUint32(4, frame.epoch);
  output.set(uuidBytes(frame.draftId), 8);
  output.set(uuidBytes(frame.mutationId), 24);
  view.setBigUint64(40, frame.sequence);
  view.setUint32(48, frame.payload.length);
  output.set(frame.payload, BINARY_HEADER_BYTES);
  return output;
}

/** Decodes and validates a binary frame; the declared length must match exactly. */
export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame {
  if (bytes.length < BINARY_HEADER_BYTES) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(48);
  if (
    view.getUint8(0) !== BINARY_VERSION || view.getUint16(2) !== 0 ||
    declared !== bytes.length - BINARY_HEADER_BYTES
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return {
    kind: view.getUint8(1),
    epoch: view.getUint32(4),
    draftId: bytesUuid(bytes.subarray(8, 24)),
    mutationId: bytesUuid(bytes.subarray(24, 40)),
    sequence: view.getBigUint64(40),
    payload: bytes.slice(BINARY_HEADER_BYTES),
  };
}

/**
 * Bounds of the collaboration socket (docs/technical-design/20-collaborative-documents.md).
 * Presence is best-effort: under backpressure superseded presence frames are
 * dropped, and a peer that stays over budget past the grace period is closed
 * 1008 "backpressure" rather than buffered without limit.
 */
export type CollaborationSocketLimits = Readonly<{
  /** Largest inbound frame, in UTF-8 bytes. */
  maxFrameBytes: number;
  /** Largest presence.update frame, in UTF-8 bytes. */
  maxPresenceBytes: number;
  /** Rooms one connection may have joined at once. */
  maxRoomsPerConnection: number;
  /** Open collaboration connections per principal. */
  maxConnectionsPerPrincipal: number;
  /** Participants one room may hold. */
  maxParticipantsPerRoom: number;
  /** Accepted presence updates per participant per second; extra ones coalesce. */
  presenceUpdatesPerSecond: number;
  /** Inbound frames per connection per second before RATE_LIMITED and close. */
  inboundFramesPerSecond: number;
  heartbeatSeconds: number;
  presenceTtlSeconds: number;
  /** How often expiry runs and every joined room's access is checked anew. */
  sweepMilliseconds: number;
  /** Socket send buffer above which presence frames are withheld. */
  maxBufferedBytes: number;
  /** How long a peer may stay over the buffer budget before it is closed. */
  backpressureGraceMilliseconds: number;
}>;

export const COLLABORATION_SOCKET_LIMITS: CollaborationSocketLimits = Object
  .freeze({
    maxFrameBytes: 8 * 1024,
    maxPresenceBytes: 2 * 1024,
    maxRoomsPerConnection: 16,
    maxConnectionsPerPrincipal: 16,
    maxParticipantsPerRoom: 64,
    presenceUpdatesPerSecond: 5,
    inboundFramesPerSecond: 50,
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
    sweepMilliseconds: 5_000,
    maxBufferedBytes: 256 * 1024,
    backpressureGraceMilliseconds: 5_000,
  });

export type CollaborationSocketHandlerOptions = {
  database: PgDatabase;
  /** Isolated Loro import for untrusted updates; the same one the draft routes use. */
  isolation: DraftIsolation;
  store: SessionStore;
  secret: string;
  publicBaseUrl: string;
  registry?: CollaborationRegistry;
  limits?: Partial<CollaborationSocketLimits>;
  now?: () => Date;
  /**
   * Test seam replacing `Deno.upgradeWebSocket`, used to drive the output
   * budget (`bufferedAmount`) deterministically. `createApp` never sets it.
   */
  upgradeWebSocket?: (
    request: Request,
    options: Deno.UpgradeWebSocketOptions,
  ) => Deno.WebSocketUpgrade;
};

export type CollaborationSocketHandler = (context: {
  req: {
    raw: Request;
    header(name: string): string | undefined;
    query(name: string): string | undefined;
  };
  get(name: string): unknown;
}) => Promise<Response>;

type Participant = {
  readonly key: string;
  readonly connection: Connection;
  readonly room: string;
  presence: Presence;
  /** Accepted-update timestamps in the current one-second window. */
  windowStart: number;
  windowCount: number;
  /** Latest coalesced state waiting for the rate window to reopen. */
  pending?: PresenceState;
  pendingTimer?: ReturnType<typeof setTimeout>;
};

type Connection = {
  readonly id: string;
  readonly socket: WebSocket;
  readonly token: string;
  readonly principal: AuthenticatedSubject;
  readonly organizationId: OrganizationId;
  readonly rooms: Map<string, { room: Room; participant: Participant }>;
  inboundWindowStart: number;
  inboundCount: number;
  overBudgetSince?: number;
  closed: boolean;
  queue: Promise<void>;
  close(code: number, reason: string): void;
};

/** In-memory rooms of this one collaboration-serving process. */
export type CollaborationRegistry = {
  readonly connections: number;
  /** Participants currently present in a room, for tests and diagnostics. */
  participants(room: Room): readonly Presence[];
  closeAll(code?: number, reason?: string): void;
};

type RegistryInternals = {
  readonly connections: Set<Connection>;
  readonly rooms: Map<string, Map<string, Participant>>;
};

const registryInternals = new WeakMap<
  CollaborationRegistry,
  RegistryInternals
>();

function roomKey(room: Room): string {
  return `${room.kind}:${room.id}`;
}

export function createCollaborationRegistry(): CollaborationRegistry {
  const internals: RegistryInternals = {
    connections: new Set(),
    rooms: new Map(),
  };
  const registry: CollaborationRegistry = {
    get connections() {
      return internals.connections.size;
    },
    participants(room) {
      return [...(internals.rooms.get(roomKey(room))?.values() ?? [])].map((
        participant,
      ) => participant.presence);
    },
    closeAll(code = 1001, reason = "server shutdown") {
      for (const connection of [...internals.connections]) {
        connection.close(code, reason);
      }
    },
  };
  registryInternals.set(registry, internals);
  return registry;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function assertWebSocketHandshake(headers: Headers): void {
  const upgrade = headers.get("upgrade")?.toLowerCase().split(",") ?? [];
  const connection = headers.get("connection")?.toLowerCase().split(",") ?? [];
  if (
    !upgrade.some((token) => token.trim() === "websocket") ||
    !connection.some((token) => token.trim() === "upgrade") ||
    !headers.get("sec-websocket-key") ||
    headers.get("sec-websocket-version") !== "13"
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
}

function principalFromContext(context: {
  get(name: string): unknown;
}): AuthenticatedSubject {
  const value = context.get("principal");
  if (!value || typeof value !== "object") {
    throw new StandardError({ code: "AUTH_REQUIRED" });
  }
  const principal = value as Partial<AuthenticatedSubject>;
  if (
    !isUuid(principal.principalId) ||
    typeof principal.displayName !== "string" ||
    !principal.displayName ||
    (principal.principalType !== "human" &&
      principal.principalType !== "service" &&
      principal.principalType !== "worker")
  ) {
    throw new StandardError({ code: "AUTH_INVALID" });
  }
  return {
    principalId: principalId(principal.principalId),
    principalType: principal.principalType,
    displayName: principal.displayName,
  };
}

/** Problem codes meaning the connection lost its access: close 1008. */
const ACCESS_LOST = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "AUTH_EXPIRED",
  "AUTH_FACTOR_REQUIRED",
]);

/**
 * Upgrade handler mounted at `/v1/collaboration`. The session, Origin and
 * organization membership are checked before the upgrade; every join, and
 * every sweep after it, re-checks read access to the room's draft. Presence
 * identity is taken from the session, never from a frame; presence lives only
 * in this process's memory, expires 30 seconds after the last accepted hint,
 * and is removed on leave, close, logout or lost access.
 */
export function createCollaborationSocketHandler(
  options: CollaborationSocketHandlerOptions,
): CollaborationSocketHandler {
  const registry = options.registry ?? createCollaborationRegistry();
  const internals = registryInternals.get(registry);
  if (!internals) throw new Error("unknown collaboration registry");
  const limits: CollaborationSocketLimits = Object.freeze({
    ...COLLABORATION_SOCKET_LIMITS,
    ...options.limits,
  });
  const now = options.now ?? (() => new Date());
  const upgradeWebSocket = options.upgradeWebSocket ?? Deno.upgradeWebSocket;

  /** Checks the session is still live and fully assured. */
  async function assertSession(token: string): Promise<void> {
    const state = await options.store.findSessionState(token);
    if (!state) throw new StandardError({ code: "AUTH_INVALID" });
    if (state.expiresAt.getTime() <= now().getTime()) {
      throw new StandardError({ code: "AUTH_EXPIRED" });
    }
    if (resolveSessionAssurance(state) === SessionAssurance.Pending) {
      throw new StandardError({ code: "AUTH_FACTOR_REQUIRED" });
    }
  }

  /** Current read access to one room, in a fresh transaction. */
  async function assertRoomAccess(
    connection: Pick<Connection, "principal" | "organizationId">,
    room: Room,
  ): Promise<void> {
    await withPgTransaction(
      options.database,
      async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          principalId(connection.principal.principalId),
          connection.organizationId,
        );
        authorize(actor, "draft:read", { action: "collaboration.connect" });
        await readDraft(transaction, connection.organizationId, room.id);
      },
      undefined,
      "read committed",
    );
  }

  function send(connection: Connection, frame: Frame): boolean {
    if (connection.closed) return false;
    const parsed = contractSchemas.CollaborationFrame.safeParse(frame);
    if (!parsed.success) {
      connection.close(1011, "invalid server frame");
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(parsed.data));
      return true;
    } catch {
      connection.close(1011, "socket error");
      return false;
    }
  }

  /** Presence is droppable: withhold it while the peer is over budget. */
  function sendPresence(connection: Connection, frame: Frame): void {
    if (connection.closed) return;
    if (connection.socket.bufferedAmount > limits.maxBufferedBytes) {
      const since = connection.overBudgetSince ??= now().getTime();
      if (now().getTime() - since >= limits.backpressureGraceMilliseconds) {
        connection.close(1008, "backpressure");
      }
      return;
    }
    connection.overBudgetSince = undefined;
    send(connection, frame);
  }

  function problem(
    connection: Connection,
    requestId: string | null,
    error: unknown,
  ): void {
    // A frame validation failure is answered with its closed code only; the
    // issue list would echo client input back.
    const safe = error instanceof StandardError ? error : new StandardError({
      code: error instanceof IdentityResolutionError
        ? "AUTH_FORBIDDEN"
        : error instanceof Error && error.name === "ZodError"
        ? "MALFORMED_REQUEST"
        : "INTERNAL",
    });
    const value = toProblem(safe, {
      requestId: requestId ?? connection.id,
      traceId: connection.id.replaceAll("-", ""),
      publicBaseUrl: options.publicBaseUrl,
    });
    send(connection, { type: "problem", requestId, problem: value } as Frame);
    if (ACCESS_LOST.has(value.code)) connection.close(1008, value.code);
  }

  function broadcast(room: string, frame: Frame, except?: Participant): void {
    for (const participant of internals!.rooms.get(room)?.values() ?? []) {
      if (participant === except) continue;
      sendPresence(participant.connection, frame);
    }
  }

  function removeParticipant(
    participant: Participant,
    reason: RemovalReason,
  ): void {
    const members = internals!.rooms.get(participant.room);
    if (!members?.delete(participant.key)) return;
    if (participant.pendingTimer !== undefined) {
      clearTimeout(participant.pendingTimer);
    }
    if (members.size === 0) internals!.rooms.delete(participant.room);
    const entry = [...participant.connection.rooms.values()].find((value) =>
      value.participant === participant
    );
    if (entry) participant.connection.rooms.delete(participant.room);
    broadcast(participant.room, {
      type: "presence.removed",
      room: entry?.room ?? roomFromKey(participant.room),
      participantKey: participant.key,
      reason,
    } as Frame);
  }

  function roomFromKey(key: string): Room {
    const [kind, id] = key.split(":");
    return { kind: kind as Room["kind"], id: id! };
  }

  function acceptPresence(participant: Participant, state: PresenceState) {
    participant.presence = {
      ...participant.presence,
      state,
      receivedAt: now().toISOString(),
    };
    const entry = participant.connection.rooms.get(participant.room);
    broadcast(participant.room, {
      type: "presence",
      room: entry!.room,
      presence: participant.presence,
    } as Frame, participant);
  }

  /**
   * At most `presenceUpdatesPerSecond` accepted hints per participant; extra
   * ones replace a single pending state that is flushed when the window
   * reopens, so superseded cursor traffic is dropped, never queued.
   */
  function updatePresence(participant: Participant, state: PresenceState) {
    const at = now().getTime();
    if (at - participant.windowStart >= 1000) {
      participant.windowStart = at;
      participant.windowCount = 0;
    }
    if (participant.windowCount < limits.presenceUpdatesPerSecond) {
      participant.windowCount += 1;
      acceptPresence(participant, state);
      return;
    }
    participant.pending = state;
    if (participant.pendingTimer !== undefined) return;
    const wait = Math.max(0, participant.windowStart + 1000 - at);
    participant.pendingTimer = setTimeout(() => {
      participant.pendingTimer = undefined;
      const pending = participant.pending;
      participant.pending = undefined;
      if (!pending || participant.connection.closed) return;
      if (!internals!.rooms.get(participant.room)?.has(participant.key)) return;
      participant.windowStart = now().getTime();
      participant.windowCount = 1;
      acceptPresence(participant, pending);
    }, wait);
  }

  async function onFrame(connection: Connection, data: unknown) {
    const at = now().getTime();
    if (at - connection.inboundWindowStart >= 1000) {
      connection.inboundWindowStart = at;
      connection.inboundCount = 0;
    }
    connection.inboundCount += 1;
    if (connection.inboundCount > limits.inboundFramesPerSecond) {
      problem(connection, null, new StandardError({ code: "RATE_LIMITED" }));
      connection.close(1008, "RATE_LIMITED");
      return;
    }
    if (data instanceof ArrayBuffer) {
      return await onBinary(connection, new Uint8Array(data));
    }
    if (typeof data !== "string") {
      problem(
        connection,
        null,
        new StandardError({ code: "MALFORMED_REQUEST" }),
      );
      return;
    }
    if (utf8Length(data) > limits.maxFrameBytes) {
      problem(connection, null, new StandardError({ code: "BODY_TOO_LARGE" }));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      problem(connection, null, new StandardError({ code: "MALFORMED_JSON" }));
      return;
    }
    const requestId = typeof raw === "object" && raw !== null &&
        typeof (raw as { requestId?: unknown }).requestId === "string" &&
        isUuid((raw as { requestId: string }).requestId)
      ? (raw as { requestId: string }).requestId
      : null;
    const parsed = contractSchemas.CollaborationFrame.safeParse(raw);
    if (!parsed.success) {
      problem(connection, requestId, parsed.error);
      return;
    }
    const frame = parsed.data as Frame & Record<string, unknown>;
    switch (frame.type) {
      case "join":
        return await join(
          connection,
          frame.requestId as string,
          frame.room as Room,
        );
      case "leave": {
        const room = frame.room as Room;
        const entry = connection.rooms.get(roomKey(room));
        if (entry) removeParticipant(entry.participant, "left");
        send(
          connection,
          { type: "left", requestId: frame.requestId, room } as Frame,
        );
        return;
      }
      case "presence.update": {
        if (utf8Length(data) > limits.maxPresenceBytes) {
          problem(
            connection,
            requestId,
            new StandardError({ code: "BODY_TOO_LARGE" }),
          );
          return;
        }
        const room = frame.room as Room;
        const entry = connection.rooms.get(roomKey(room));
        if (!entry) {
          problem(
            connection,
            requestId,
            new StandardError({ code: "RESOURCE_NOT_FOUND" }),
          );
          return;
        }
        updatePresence(entry.participant, frame.state as PresenceState);
        return;
      }
      case "sync":
        return await sync(
          connection,
          frame.requestId as string,
          frame.room as Room,
        );
      case "ping":
        send(connection, { type: "ping", requestId: frame.requestId } as Frame);
        return;
      default:
        // A server-direction frame sent by a client.
        problem(
          connection,
          requestId,
          new StandardError({ code: "MALFORMED_REQUEST" }),
        );
    }
  }

  /** Draft write access in a fresh transaction (operate permission, live membership). */
  async function assertWriteAccess(connection: Connection): Promise<void> {
    await withPgTransaction(
      options.database,
      async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          principalId(connection.principal.principalId),
          connection.organizationId,
        );
        authorize(actor, "draft:write", { action: "drafts.edit" });
      },
      undefined,
      "read committed",
    );
  }

  /** Sends draft bytes; a peer over the buffer budget is closed to resynchronize. */
  function sendBinary(connection: Connection, frame: Frame, bytes: Uint8Array) {
    if (connection.closed) return;
    if (connection.socket.bufferedAmount > limits.maxBufferedBytes) {
      connection.close(1008, "backpressure");
      return;
    }
    if (!send(connection, frame)) return;
    try {
      connection.socket.send(bytes);
    } catch {
      connection.close(1011, "socket error");
    }
  }

  /** `sync`: the committed state of a joined room, read now. */
  async function sync(connection: Connection, requestId: string, room: Room) {
    if (!connection.rooms.has(roomKey(room))) {
      problem(
        connection,
        requestId,
        new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      );
      return;
    }
    let state: Awaited<ReturnType<typeof readDraftState>>;
    try {
      await assertSession(connection.token);
      await assertRoomAccess(connection, room);
      state = await withPgTransaction(
        options.database,
        (transaction) =>
          readDraftState(transaction, connection.organizationId, room.id),
        undefined,
        "read committed",
      );
    } catch (error) {
      problem(connection, requestId, error);
      return;
    }
    sendBinary(
      connection,
      {
        type: "synced",
        requestId,
        room,
        epoch: state.epoch,
        serverSequence: state.serverSequence,
        checkpointId: state.checkpointId,
        byteLength: state.state.length,
      } as Frame,
      encodeBinaryFrame({
        kind: BinaryFrameKind.ServerSnapshot,
        epoch: state.epoch,
        draftId: room.id,
        mutationId: ZERO_UUID,
        sequence: BigInt(state.serverSequence),
        payload: state.state,
      }),
    );
  }

  /** Admission is serialized per draft in this process; Postgres CAS covers the rest. */
  const admissions = new Map<string, Promise<unknown>>();
  function serialize<T>(draftId: string, run: () => Promise<T>): Promise<T> {
    const previous = admissions.get(draftId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    const tail = next.catch(() => {});
    admissions.set(draftId, tail);
    tail.then(() => {
      if (admissions.get(draftId) === tail) admissions.delete(draftId);
    });
    return next;
  }

  function resync(
    connection: Connection,
    room: Room,
    mutationId: string | null,
    reason: "stale" | "epoch" | "rejected",
  ) {
    send(connection, {
      type: "resync_required",
      room,
      mutationId,
      reason,
    } as Frame);
  }

  /**
   * A client update: authorize, import outside any transaction in the
   * isolated worker, then commit with a highwater check and receipt before
   * acknowledging and only then relaying the committed bytes to the room.
   */
  async function onBinary(connection: Connection, bytes: Uint8Array) {
    if (bytes.length > BINARY_HEADER_BYTES + DRAFT_LIMITS.updateBytes) {
      problem(connection, null, new StandardError({ code: "BODY_TOO_LARGE" }));
      return;
    }
    let frame: BinaryFrame;
    try {
      frame = decodeBinaryFrame(bytes);
      if (
        frame.kind !== BinaryFrameKind.ClientUpdate || frame.sequence !== 0n ||
        !isUuid(frame.mutationId) || frame.mutationId === ZERO_UUID ||
        frame.payload.length === 0
      ) throw new StandardError({ code: "MALFORMED_REQUEST" });
    } catch (error) {
      problem(connection, null, error);
      return;
    }
    const room: Room = { kind: "draft", id: frame.draftId };
    const entry = connection.rooms.get(roomKey(room));
    if (!entry) {
      problem(
        connection,
        null,
        new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      );
      return;
    }
    await serialize(room.id, () => admit(connection, entry.room, frame));
  }

  async function admit(connection: Connection, room: Room, frame: BinaryFrame) {
    const input = {
      epoch: frame.epoch,
      mutationId: frame.mutationId,
      clientUpdateDigest: await sha256Bytes(frame.payload),
    };
    const principal = connection.principal.principalId;
    try {
      await assertSession(connection.token);
      await assertWriteAccess(connection);
    } catch (error) {
      problem(connection, null, error);
      return;
    }
    for (let attempt = 0; attempt < DRAFT_LIMITS.staleAttempts; attempt += 1) {
      if (connection.closed) return;
      let prepared;
      try {
        prepared = await withPgTransaction(
          options.database,
          (transaction) =>
            prepareDraftUpdate(
              transaction,
              connection.organizationId,
              principal,
              room.id,
              input,
            ),
          undefined,
          "read committed",
        );
      } catch (error) {
        if (
          error instanceof StandardError && error.code === "PRECONDITION_FAILED"
        ) {
          resync(connection, room, frame.mutationId, "epoch");
          return;
        }
        problem(connection, null, error);
        return;
      }
      if (!("kind" in prepared)) {
        // Exact replay of an already committed mutation.
        send(connection, {
          type: "ack",
          room,
          mutationId: frame.mutationId,
          receipt: prepared,
        } as Frame);
        return;
      }
      let candidate;
      try {
        candidate = await options.isolation.importUpdate(
          prepared.currentState,
          frame.payload,
        );
      } catch (error) {
        if (
          error instanceof DraftIsolationError && error.kind !== "unavailable"
        ) {
          resync(connection, room, frame.mutationId, "rejected");
          return;
        }
        problem(
          connection,
          null,
          new StandardError({ code: "DEPENDENCY_UNAVAILABLE" }),
        );
        return;
      }
      if (candidate.update.length === 0) {
        // Everything in the update is already committed: nothing new to save.
        send(connection, {
          type: "ack",
          room,
          mutationId: frame.mutationId,
          receipt: null,
        } as Frame);
        return;
      }
      let receipt: DraftReceipt;
      try {
        receipt = await withPgTransaction(
          options.database,
          async (transaction) => {
            const actor = await resolveOrganizationActor(
              transaction,
              principalId(principal),
              connection.organizationId,
            );
            authorize(actor, "draft:write", { action: "drafts.edit" });
            return await commitDraftUpdate(
              transaction,
              connection.organizationId,
              principal,
              input,
              prepared,
              candidate,
            );
          },
        );
      } catch (error) {
        if (error instanceof StaleDraftCandidateError) continue;
        problem(connection, null, error);
        return;
      }
      send(connection, {
        type: "ack",
        room,
        mutationId: frame.mutationId,
        receipt,
      } as Frame);
      const relayed = encodeBinaryFrame({
        kind: BinaryFrameKind.ServerUpdate,
        epoch: receipt.epoch,
        draftId: room.id,
        mutationId: frame.mutationId,
        sequence: BigInt(receipt.serverSequence),
        payload: candidate.update,
      });
      for (const peer of internals!.rooms.get(roomKey(room))?.values() ?? []) {
        if (peer.connection === connection) continue;
        sendBinary(peer.connection, {
          type: "committed",
          room,
          mutationId: frame.mutationId,
          serverSequence: receipt.serverSequence,
          byteLength: relayed.length,
        } as Frame, relayed);
      }
      return;
    }
    resync(connection, room, frame.mutationId, "stale");
  }

  async function join(connection: Connection, requestId: string, room: Room) {
    const key = roomKey(room);
    const existing = connection.rooms.get(key);
    if (!existing && connection.rooms.size >= limits.maxRoomsPerConnection) {
      problem(
        connection,
        requestId,
        new StandardError({ code: "RATE_LIMITED" }),
      );
      return;
    }
    try {
      await assertSession(connection.token);
      await assertRoomAccess(connection, room);
    } catch (error) {
      problem(connection, requestId, error);
      return;
    }
    if (connection.closed) return;
    let members = internals!.rooms.get(key);
    if (!existing && (members?.size ?? 0) >= limits.maxParticipantsPerRoom) {
      problem(
        connection,
        requestId,
        new StandardError({ code: "RATE_LIMITED" }),
      );
      return;
    }
    let participant = existing?.participant;
    if (!participant) {
      participant = {
        key: crypto.randomUUID(),
        connection,
        room: key,
        windowStart: 0,
        windowCount: 0,
        presence: {
          participantKey: "",
          principalId: connection.principal.principalId,
          principalType: connection.principal.principalType,
          displayName: connection.principal.displayName.slice(0, 200),
          state: { activity: "active", typing: false, cursor: null },
          receivedAt: now().toISOString(),
        },
      };
      participant.presence.participantKey = participant.key;
      if (!members) {
        members = new Map();
        internals!.rooms.set(key, members);
      }
      members.set(participant.key, participant);
      connection.rooms.set(key, { room, participant });
      broadcast(
        key,
        { type: "presence", room, presence: participant.presence } as Frame,
        participant,
      );
    }
    send(connection, {
      type: "joined",
      requestId,
      room,
      participants: [...members!.values()].map((value) => value.presence),
    } as Frame);
  }

  /** TTL expiry plus a fresh session and room-access check for every joined room. */
  async function sweep(): Promise<void> {
    const cutoff = now().getTime() - limits.presenceTtlSeconds * 1000;
    for (const members of [...internals!.rooms.values()]) {
      for (const participant of [...members.values()]) {
        if (Date.parse(participant.presence.receivedAt) <= cutoff) {
          removeParticipant(participant, "expired");
        }
      }
    }
    for (const connection of [...internals!.connections]) {
      if (connection.closed) continue;
      try {
        await assertSession(connection.token);
      } catch (error) {
        for (const { participant } of [...connection.rooms.values()]) {
          removeParticipant(participant, "revoked");
        }
        problem(connection, null, error);
        connection.close(1008, "session ended");
        continue;
      }
      for (const { room, participant } of [...connection.rooms.values()]) {
        try {
          await assertRoomAccess(connection, room);
        } catch (error) {
          removeParticipant(participant, "revoked");
          problem(connection, null, error);
        }
      }
    }
  }

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  function ensureSweep(): void {
    if (sweepTimer !== undefined) return;
    sweepTimer = setInterval(() => {
      if (sweeping) return;
      if (internals!.connections.size === 0) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
        return;
      }
      sweeping = true;
      sweep().catch(() => {}).finally(() => {
        sweeping = false;
      });
    }, limits.sweepMilliseconds);
  }

  return async function collaborationSocketHandler(context) {
    const request = context.req.raw;
    const connectionId = crypto.randomUUID();
    const traceId = getTraceId(request);
    const fail = (error: unknown) =>
      problemResponse(context as never, error, {
        publicBaseUrl: options.publicBaseUrl,
        requestId: connectionId,
        traceId,
      });
    let organization: OrganizationId;
    let principal: AuthenticatedSubject;
    let token: string;
    let upgraded: { socket: WebSocket; response: Response };
    try {
      organization = organizationId(requireOrganizationIdValue(
        context.req.header("Bakery-Organization-Id") ??
          context.req.query("organizationId"),
      ));
      const parsed = contractSchemas.CollaborationUpgrade.safeParse({
        organizationId: organization,
      });
      if (!parsed.success) throw parsed.error;
      assertWebSocketHandshake(request.headers);
      principal = principalFromContext(context);
      const open = [...internals!.connections].filter((value) =>
        value.principal.principalId === principal.principalId
      ).length;
      if (open >= limits.maxConnectionsPerPrincipal) {
        throw new StandardError({ code: "RATE_LIMITED" });
      }
      let sessionToken: string | null;
      try {
        sessionToken = await readSessionToken(request.headers, options.secret);
      } catch (cause) {
        throw new StandardError({ code: "AUTH_INVALID", cause });
      }
      if (!sessionToken) {
        throw new StandardError({ code: "AUTH_INVALID" });
      }
      token = sessionToken;
      await assertSession(token);
      await withPgTransaction(
        options.database,
        async (transaction) => {
          const actor = await resolveOrganizationActor(
            transaction,
            principalId(principal.principalId) as PrincipalId,
            organization,
          );
          authorize(actor, "draft:read", { action: "collaboration.connect" });
        },
        undefined,
        "read committed",
      );
      try {
        upgraded = upgradeWebSocket(request, {
          idleTimeout: limits.heartbeatSeconds * 3,
        });
      } catch (cause) {
        throw cause instanceof TypeError
          ? new StandardError({ code: "MALFORMED_REQUEST", cause })
          : cause;
      }
    } catch (error) {
      return fail(error);
    }

    upgraded.socket.binaryType = "arraybuffer";
    const connection: Connection = {
      id: connectionId,
      socket: upgraded.socket,
      token,
      principal,
      organizationId: organization,
      rooms: new Map(),
      inboundWindowStart: 0,
      inboundCount: 0,
      closed: false,
      queue: Promise.resolve(),
      close(code, reason) {
        if (connection.closed) return;
        teardown();
        try {
          connection.socket.close(code, reason);
        } catch {
          // Already closed by the peer.
        }
      },
    };
    const teardown = () => {
      if (connection.closed) return;
      connection.closed = true;
      internals!.connections.delete(connection);
      for (const { participant } of [...connection.rooms.values()]) {
        removeParticipant(participant, "closed");
      }
    };
    internals!.connections.add(connection);
    ensureSweep();
    connection.socket.onopen = () => {
      send(connection, {
        type: "hello",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        connectionId,
        heartbeatSeconds: limits.heartbeatSeconds,
        presenceTtlSeconds: limits.presenceTtlSeconds,
      } as Frame);
    };
    // Frames are handled one at a time, in order, per connection.
    connection.socket.onmessage = (event) => {
      connection.queue = connection.queue.then(() =>
        connection.closed ? undefined : onFrame(connection, event.data)
      ).catch(() => connection.close(1011, "internal error"));
    };
    connection.socket.onerror = () => connection.close(1011, "socket error");
    connection.socket.onclose = () => teardown();
    return upgraded.response;
  };
}
