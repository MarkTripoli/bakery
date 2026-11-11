import {
  ActionAccess,
  isUuid,
  OrganizationContextPolicy,
  type OrganizationId,
  organizationId,
  type PrincipalId,
  principalId,
} from "@bakery/contracts/contracts";
import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
} from "@bakery/contracts/action-registry";
import {
  getTraceId,
  type Problem,
  problemResponse,
  StandardError,
  toProblem,
} from "@bakery/contracts/http";
import { contractSchemas } from "@bakery/contracts/contracts";
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
import {
  assertScope,
  type ClockRow,
  isOutsideRetention,
  readEventClock,
  readScopedEvents,
  type SyncScope,
  type SyncScopeType,
  toEvent,
} from "./event-stream.ts";
import {
  type CursorBinding,
  decodeSequenceCursorFilters,
  encodeSequenceCursor,
} from "../../platform/cursor.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { loadAuthorizedOutputStream } from "@bakery/persistence";
import {
  OUTPUT_STREAMS_READ_ACTION,
  readOutputPage,
} from "../execution/output-read.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MAX_DECIMAL_DIGITS = 19;
const FILTER_LETTERS = Object.freeze(
  {
    application: "a",
    repository: "r",
    task: "t",
    conversation: "c",
  } as const,
);
const FILTER_ORDER = Object.freeze({ a: 0, r: 1, t: 2, c: 3 });
const LETTER_TYPES: Readonly<Record<string, SyncScopeType>> = Object.freeze({
  a: "application",
  r: "repository",
  t: "task",
  c: "conversation",
  e: "worker_enrollment",
  w: "worker",
});
const CURSOR_ACTION = "events.connect";
const CURSOR_ORDERING = "sequence:asc";
const CURSOR_SCHEMA_VERSION = 1;
const OUTPUT_SOCKET_BATCH_LIMIT = 64;
/** `subscribe.after: null` — start at the highwater read inside the subscription transaction. */
const CURRENT_HIGHWATER = "current";
const INBOUND_FRAME_TYPES: Record<string, true> = {
  subscribe: true,
  resume: true,
  ack: true,
  ping: true,
  "output.subscribe": true,
};
/** Problem codes that mean the caller lost access: the socket closes with 1008. */
const POLICY_CLOSE_CODES: Record<string, true> = {
  AUTH_REQUIRED: true,
  AUTH_INVALID: true,
  AUTH_EXPIRED: true,
  AUTH_FORBIDDEN: true,
  AUTH_FACTOR_REQUIRED: true,
};

/**
 * Bounds applied to one authenticated notification socket.
 *
 * - `maxFrameBytes`: UTF-8 bound for every inbound and outbound frame. Inbound
 *   frames are rejected only after the runtime has assembled the message; the
 *   runtime's own message ceiling is therefore the effective wire-level bound.
 *   Frames above `maxFrameBytes` get `BODY_TOO_LARGE` and close 1009; `events`
 *   frames are packed so they never exceed it. Enforce a lower wire-level limit
 *   at the ingress or reverse proxy when required.
 * - `maxScopes`: scopes per subscription and per cursor.
 * - `maxEventsPerFrame` / `maxReplayFramesPerTick`: count bounds for one
 *   `events` frame and for the frames emitted by one subscription or poll
 *   tick; their product bounds the delivered `(eventId, sequence)` pairs kept
 *   for `ack` validation.
 * - `pollIntervalMs`: live tail period (one committed clock read per tick).
 * - `heartbeatMs`: application `ping` period and the maximum age of the
 *   session/membership/scope re-authorization.
 * - `idleTimeoutSeconds`: protocol ping/pong idle timeout enforced by the
 *   runtime; listen-only subscribers stay open as long as they answer pongs.
 * - `maxBufferedBytes` / `backpressureGraceMs`: output budget. No frame of any
 *   class is enqueued past the budget; a withheld frame is retried at
 *   `pollIntervalMs` cadence and a peer still over budget after the grace
 *   period is closed with 1008 "backpressure". A withheld `hello` is terminal:
 *   a peer over budget before its first byte closes 1008 immediately, since a
 *   retained `hello` cannot carry an upgrade-time `after` resume.
 * - `maxConnectionsPerPrincipal`: slots reserved before the upgrade; the next
 *   handshake gets `RATE_LIMITED` 429.
 * - `maxPendingFrames` / `maxPendingBytes`: inbound frames admitted to the
 *   per-connection executor, including the active frame; exceeding either
 *   sends `RATE_LIMITED` and closes 1008.
 */
export type EventsSocketLimits = Readonly<{
  maxFrameBytes: number;
  maxScopes: number;
  maxEventsPerFrame: number;
  maxReplayFramesPerTick: number;
  pollIntervalMs: number;
  heartbeatMs: number;
  idleTimeoutSeconds: number;
  maxBufferedBytes: number;
  backpressureGraceMs: number;
  maxConnectionsPerPrincipal: number;
  maxPendingFrames: number;
  maxPendingBytes: number;
}>;

export const EVENTS_SOCKET_LIMITS: EventsSocketLimits = Object.freeze({
  maxFrameBytes: 262_144,
  maxScopes: 4,
  maxEventsPerFrame: 500,
  maxReplayFramesPerTick: 10,
  pollIntervalMs: 500,
  heartbeatMs: 30_000,
  idleTimeoutSeconds: 60,
  maxBufferedBytes: 1_048_576,
  backpressureGraceMs: 5_000,
  maxConnectionsPerPrincipal: 8,
  maxPendingFrames: 32,
  maxPendingBytes: 1_048_576,
});

/** Canonical cursor filter serialization, sorted by the a/r/t/c scope letter. */
export function scopeFilters(scopes: readonly SyncScope[]): string {
  return [...scopes]
    .map((scope) => {
      const letter = FILTER_LETTERS[
        scope.type as keyof typeof FILTER_LETTERS
      ];
      if (!letter) throw new StandardError({ code: "MALFORMED_REQUEST" });
      return {
        ...scope,
        id: scope.id.toLowerCase(),
        letter,
      };
    })
    .sort((left, right) =>
      FILTER_ORDER[left.letter] - FILTER_ORDER[right.letter] ||
      left.id.localeCompare(right.id)
    )
    .map((scope) => `${scope.letter}:${scope.id}`)
    .join(";");
}

/** Decodes and validates the canonical event cursor scope filters. */
export function parseScopeFilters(filters: string): readonly SyncScope[] {
  if (!filters) throw new StandardError({ code: "INVALID_CURSOR" });
  const parsed: SyncScope[] = [];
  const seen = new Set<string>();
  let previousRank = -1;
  let previousId = "";
  for (const part of filters.split(";")) {
    const separator = part.indexOf(":");
    const letter = separator < 0 ? "" : part.slice(0, separator);
    const id = separator < 0 ? "" : part.slice(separator + 1);
    const type = LETTER_TYPES[letter];
    const rank = typeof letter === "string" && letter in FILTER_ORDER
      ? FILTER_ORDER[letter as keyof typeof FILTER_ORDER]
      : -1;
    if (!type || !UUID.test(id) || rank < 0) {
      throw new StandardError({ code: "INVALID_CURSOR" });
    }
    const normalizedId = id.toLowerCase();
    const normalized = `${letter}:${normalizedId}`;
    if (
      rank < previousRank ||
      (rank === previousRank && normalizedId <= previousId) ||
      seen.has(normalized)
    ) {
      throw new StandardError({ code: "INVALID_CURSOR" });
    }
    previousRank = rank;
    previousId = normalizedId;
    seen.add(normalized);
    parsed.push(Object.freeze({ type, id: normalizedId as SyncScope["id"] }));
  }
  if (parsed.length === 0 || parsed.length > EVENTS_SOCKET_LIMITS.maxScopes) {
    throw new StandardError({ code: "INVALID_CURSOR" });
  }
  return Object.freeze(parsed);
}

const EVENT_SCOPE_TYPES: Record<SyncScopeType, true> = {
  application: true,
  conversation: true,
  repository: true,
  task: true,
  worker_enrollment: true,
  worker: true,
};

function freezeLimits(
  limits: Partial<EventsSocketLimits> | undefined,
): EventsSocketLimits {
  const values = { ...EVENTS_SOCKET_LIMITS, ...(limits ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `events socket limit ${key} must be a positive integer`,
      );
    }
  }
  return Object.freeze(values);
}

type SocketConnection = {
  close(code: number, reason: string): void;
};

/**
 * One per-principal slot. Reserved synchronously before any admission await
 * so concurrent handshakes cannot exceed the cap; `connection` is attached
 * once the socket exists.
 */
type RegistryEntry = {
  readonly principalId: PrincipalId;
  connection?: SocketConnection;
};

type RegistryInternals = {
  readonly reserve: (
    principalId: PrincipalId,
    limit: number,
  ) => RegistryEntry | undefined;
  readonly release: (entry: RegistryEntry) => void;
};

const registryInternals = new WeakMap<
  EventsSocketRegistry,
  RegistryInternals
>();

export type EventsSocketRegistry = {
  readonly size: number;
  closeAll(code?: number, reason?: string): void;
};

export function createEventsSocketRegistry(): EventsSocketRegistry {
  const entries = new Set<RegistryEntry>();
  const byPrincipal = new Map<PrincipalId, Set<RegistryEntry>>();
  const registry: EventsSocketRegistry = {
    get size() {
      return entries.size;
    },
    closeAll(code = 1001, reason = "server shutdown") {
      for (const entry of [...entries]) entry.connection?.close(code, reason);
    },
  };
  registryInternals.set(registry, {
    reserve(principalId, limit) {
      let principalEntries = byPrincipal.get(principalId);
      if (principalEntries && principalEntries.size >= limit) return undefined;
      if (!principalEntries) {
        principalEntries = new Set();
        byPrincipal.set(principalId, principalEntries);
      }
      const entry: RegistryEntry = { principalId };
      principalEntries.add(entry);
      entries.add(entry);
      return entry;
    },
    release(entry) {
      if (!entries.delete(entry)) return;
      const principalEntries = byPrincipal.get(entry.principalId);
      principalEntries?.delete(entry);
      if (principalEntries?.size === 0) byPrincipal.delete(entry.principalId);
    },
  });
  return registry;
}

export const EVENTS_CONNECT_IS_NOT_AN_HTTP_ACTION =
  "EVENTS_CONNECT_IS_NOT_AN_HTTP_ACTION";

export const EVENTS_CONNECT_ACTION: ActionDefinition = Object.freeze({
  name: "events.connect",
  method: "GET",
  path: "/v1/events",
  input: contractSchemas.WebSocketUpgrade,
  output: contractSchemas.WebSocketFrames,
  policy: Object.freeze({
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  }),
  handler(_context: ActionContext, _input: unknown): never {
    throw new Error(EVENTS_CONNECT_IS_NOT_AN_HTTP_ACTION);
  },
});

export type EventsSocketHandlerOptions = {
  database: PgDatabase;
  store: SessionStore;
  secret: string;
  publicBaseUrl: string;
  registry?: EventsSocketRegistry;
  limits?: Partial<EventsSocketLimits>;
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

/** Upgrade handler mounted at `/v1/events`; the context is the Hono subset it reads. */
export type EventsSocketHandler = (context: {
  req: {
    raw: Request;
    header(name: string): string | undefined;
    query(name: string): string | undefined;
  };
  get(name: string): unknown;
}) => Promise<Response>;

type WireFrame = Record<string, unknown> & { type: string };
type ResetReason = "cursor_expired" | "scope_revoked";

type Subscription = {
  readonly requestId: string;
  readonly scopes: readonly SyncScope[];
  readonly filters: string;
  /** Scan position: every retained event at or below it has been inspected. */
  checkpoint: bigint;
};
type UpgradeResume = { scopes: readonly SyncScope[]; sequence: string };

type DeliveredPair = { readonly id: string; readonly sequence: string };
type OutputSubscription = {
  readonly requestId: string;
  readonly streamId: string;
  cursor: string;
  highwater: string;
};
type EventsPage = {
  readonly frame: WireFrame;
  readonly checkpoint: bigint;
  readonly delivered: readonly DeliveredPair[];
};
type ScanResult = {
  readonly pages: readonly EventsPage[];
  /** Checkpoint once every page is delivered: the highwater when the scan is complete. */
  readonly checkpoint: bigint;
  /** Sequence of an event that cannot fit in one frame on its own. */
  readonly oversized?: bigint;
};
type SubscriptionOutcome =
  | { readonly kind: "reset"; readonly clock: ClockRow }
  | {
    readonly kind: "scan";
    readonly clock: ClockRow;
    readonly subscription: Subscription;
    readonly scan: ScanResult;
  };
type TickOutcome =
  | {
    readonly kind: "reset";
    readonly clock: ClockRow;
    readonly authorized: boolean;
  }
  | {
    readonly kind: "idle";
    readonly clock: ClockRow;
    readonly authorized: boolean;
  }
  | {
    readonly kind: "scan";
    readonly clock: ClockRow;
    readonly scan: ScanResult;
    readonly authorized: boolean;
  };

type PendingFrame = {
  readonly frame: WireFrame;
  /** Validated wire text and its UTF-8 size, computed once when first withheld. */
  readonly text: string;
  readonly bytes: number;
  readonly onSent?: () => void;
  /** Re-authorize sensitive data before retrying it after backpressure. */
  readonly beforeSend?: () => Promise<void>;
  /** Continue a delivery after a withheld frame is finally sent. */
  readonly afterSent?: () => Promise<void>;
};

type QueueItem =
  | { readonly kind: "frame"; readonly data: string; readonly bytes: number }
  | { readonly kind: "work"; readonly run: () => Promise<void> };

type ConnectionState = SocketConnection & {
  readonly entry: RegistryEntry;
  readonly socket: WebSocket;
  readonly connectionId: string;
  readonly traceId: string;
  readonly token: string;
  readonly organizationId: OrganizationId;
  readonly principalId: PrincipalId;
  readonly initialClock: ClockRow;
  readonly queue: QueueItem[];
  /** Delivered `eventId → sequence`, insertion ordered, capped for `ack`. */
  readonly delivered: Map<string, string>;
  queuedFrames: number;
  queuedBytes: number;
  activeFrames: number;
  pumping: boolean;
  heartbeatQueued: boolean;
  subscription?: Subscription;
  outputSubscription?: OutputSubscription;
  pendingFrame?: PendingFrame;
  closed: boolean;
  pendingClose?: { code: number; reason: string };
  lastAuthorizedAt: number;
  pollTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  backpressureTimer?: ReturnType<typeof setTimeout>;
  blockedFrameBytes?: number;
};

class ScopeRevokedError extends Error {
  constructor(readonly clock: ClockRow) {
    super("EVENTS_SOCKET_SCOPE_REVOKED");
    this.name = "ScopeRevokedError";
  }
}

class MembershipRevokedError extends Error {
  constructor(cause: unknown) {
    super("EVENTS_SOCKET_MEMBERSHIP_REVOKED", { cause });
    this.name = "MembershipRevokedError";
  }
}

class OutputAuthorityRevokedError extends Error {
  constructor(cause: unknown) {
    super("EVENTS_SOCKET_OUTPUT_AUTHORITY_REVOKED", { cause });
    this.name = "OutputAuthorityRevokedError";
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Rejects a non-WebSocket GET before `Deno.upgradeWebSocket` can throw. */
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

function isWebSocketUpgrade(value: unknown): value is {
  after?: string;
  organizationId?: string;
} {
  return typeof value === "object" && value !== null;
}

function requestIdFrom(value: unknown, fallback: string): string {
  const candidate = value && typeof value === "object"
    ? (value as Record<string, unknown>).requestId
    : undefined;
  return typeof candidate === "string" && UUID.test(candidate)
    ? candidate
    : fallback;
}

function requestIdFromText(value: string, fallback: string): string {
  const candidate = /"requestId"\s*:\s*"([^"]+)"/.exec(value)?.[1];
  return candidate && UUID.test(candidate) ? candidate : fallback;
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

function binding(
  principal: PrincipalId,
  organization: OrganizationId,
  filters: string,
): CursorBinding {
  return {
    action: CURSOR_ACTION,
    principalId: principal,
    organizationId: organization,
    ordering: CURSOR_ORDERING,
    filters,
    schemaVersion: CURSOR_SCHEMA_VERSION,
  };
}

function normalizeScope(scope: SyncScope): SyncScope {
  if (!EVENT_SCOPE_TYPES[scope.type] || !UUID.test(scope.id)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return Object.freeze({
    type: scope.type,
    id: scope.id.toLowerCase() as SyncScope["id"],
  });
}

function baseBinding(
  principal: PrincipalId,
  organization: OrganizationId,
): Omit<CursorBinding, "filters"> {
  return {
    action: CURSOR_ACTION,
    principalId: principal,
    organizationId: organization,
    ordering: CURSOR_ORDERING,
    schemaVersion: CURSOR_SCHEMA_VERSION,
  };
}

function validateScopes(
  value: unknown,
  limits: EventsSocketLimits,
): readonly SyncScope[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.length > limits.maxScopes
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const result = value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const scope = entry as Record<string, unknown>;
    return normalizeScope({
      type: scope.type as SyncScopeType,
      id: scope.id as SyncScope["id"],
    });
  });
  const keys = result.map((scope) => `${scope.type}:${scope.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return Object.freeze(result);
}

function validateAfter(value: unknown): string {
  if (
    typeof value !== "string" || !DECIMAL.test(value) ||
    value.length > MAX_DECIMAL_DIGITS
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return value;
}

function mapProblemError(error: unknown): unknown {
  if (
    error instanceof MembershipRevokedError ||
    error instanceof OutputAuthorityRevokedError ||
    error instanceof IdentityResolutionError
  ) {
    return new StandardError({ code: "AUTH_FORBIDDEN", cause: error });
  }
  return error;
}

/** 1008 when access was lost, 1011 for server failures, open otherwise. */
function closeCodeForProblem(problem: Problem): number | undefined {
  if (POLICY_CLOSE_CODES[problem.code]) return 1008;
  if (problem.status >= 500) return 1011;
  return undefined;
}

function internalsOf(registry: EventsSocketRegistry): RegistryInternals {
  const internals = registryInternals.get(registry);
  if (!internals) {
    throw new TypeError(
      "events socket registry was not created by this module",
    );
  }
  return internals;
}

export function createEventsSocketHandler(
  options: EventsSocketHandlerOptions,
): EventsSocketHandler {
  const registry = options.registry ?? createEventsSocketRegistry();
  const internals = internalsOf(registry);
  const limits = freezeLimits(options.limits);
  const now = options.now ?? (() => new Date());
  const upgradeWebSocket = options.upgradeWebSocket ?? Deno.upgradeWebSocket;
  const deliveredCapacity = limits.maxEventsPerFrame *
    limits.maxReplayFramesPerTick;

  return async function eventsSocketHandler(context): Promise<Response> {
    const request = context.req.raw;
    const traceId = getTraceId(request);
    const connectionId = crypto.randomUUID();
    const requestHeader = context.req.header("x-request-id");
    const requestId = requestHeader && UUID.test(requestHeader)
      ? requestHeader
      : connectionId;
    const fail = (error: unknown) =>
      problemResponse(context as never, error, {
        publicBaseUrl: options.publicBaseUrl,
        requestId,
        traceId,
      });

    let organization: OrganizationId;
    let input: { after?: string; organizationId?: string };
    let principal: AuthenticatedSubject;
    let entry: RegistryEntry;
    try {
      const headerOrganization = context.req.header("Bakery-Organization-Id");
      organization = requireOrganizationIdValue(
        headerOrganization ?? context.req.query("organizationId"),
      );
      const after = context.req.query("after");
      const parsed = contractSchemas.WebSocketUpgrade.safeParse({
        ...(after === undefined ? {} : { after }),
        organizationId: organization,
      });
      if (!parsed.success || !isWebSocketUpgrade(parsed.data)) {
        throw parsed.success
          ? new StandardError({ code: "MALFORMED_REQUEST" })
          : parsed.error;
      }
      input = parsed.data;
      assertWebSocketHandshake(request.headers);
      principal = principalFromContext(context);
      const reserved = internals.reserve(
        principal.principalId,
        limits.maxConnectionsPerPrincipal,
      );
      if (!reserved) throw new StandardError({ code: "RATE_LIMITED" });
      entry = reserved;
    } catch (error) {
      return fail(error);
    }

    const principalValue = principalId(principal.principalId);
    const organizationValue = organizationId(organization);
    let token: string;
    let initialClock: ClockRow;
    let upgradeResume: UpgradeResume | undefined;
    let upgraded: { socket: WebSocket; response: Response };
    try {
      let sessionToken: string | null;
      try {
        sessionToken = await readSessionToken(request.headers, options.secret);
      } catch (cause) {
        throw new StandardError({ code: "AUTH_INVALID", cause });
      }
      if (!sessionToken) throw new StandardError({ code: "AUTH_INVALID" });
      token = sessionToken;
      const state = await options.store.findSessionState(token);
      if (!state) throw new StandardError({ code: "AUTH_INVALID" });
      if (state.expiresAt.getTime() <= now().getTime()) {
        throw new StandardError({ code: "AUTH_EXPIRED" });
      }
      if (resolveSessionAssurance(state) === SessionAssurance.Pending) {
        throw new StandardError({ code: "AUTH_FACTOR_REQUIRED" });
      }
      initialClock = await withPgTransaction(
        options.database,
        async (transaction) => {
          const actor = await resolveOrganizationActor(
            transaction,
            principalValue,
            organizationValue,
          );
          authorize(actor, "event:read", { action: "events.connect" });
          return await readEventClock(transaction, organizationValue);
        },
        undefined,
        "read committed",
      );
      if (input.after !== undefined) {
        const decoded = await decodeSequenceCursorFilters(
          options.secret,
          input.after,
          baseBinding(principalValue, organizationValue),
        );
        upgradeResume = {
          scopes: parseScopeFilters(decoded.filters),
          sequence: decoded.sequence,
        };
      }
      try {
        upgraded = upgradeWebSocket(request, {
          idleTimeout: limits.idleTimeoutSeconds,
        });
      } catch (cause) {
        throw cause instanceof TypeError
          ? new StandardError({ code: "MALFORMED_REQUEST", cause })
          : cause;
      }
    } catch (error) {
      internals.release(entry);
      return fail(error);
    }

    const state: ConnectionState = {
      entry,
      socket: upgraded.socket,
      connectionId,
      traceId,
      token,
      organizationId: organizationValue,
      principalId: principalValue,
      initialClock,
      queue: [],
      delivered: new Map(),
      queuedFrames: 0,
      queuedBytes: 0,
      activeFrames: 0,
      pumping: false,
      heartbeatQueued: false,
      closed: false,
      lastAuthorizedAt: now().getTime(),
      close(code, reason) {
        if (state.closed) return;
        teardown(state);
        if (state.socket.readyState === WebSocket.CONNECTING) {
          state.pendingClose = { code, reason };
          return;
        }
        try {
          state.socket.close(code, reason);
        } catch {
          // A concurrently closed socket has no further action to take.
        }
      },
    };
    entry.connection = state;

    state.socket.onopen = () => {
      if (state.closed) {
        if (state.pendingClose) {
          try {
            state.socket.close(
              state.pendingClose.code,
              state.pendingClose.reason,
            );
          } catch {
            // Already closed by the peer.
          }
        }
        return;
      }
      enqueue(state, {
        kind: "work",
        run: () => onOpen(state, upgradeResume),
      });
    };
    state.socket.onmessage = (event) => {
      onMessage(state, event.data);
    };
    state.socket.onerror = () => {
      state.close(1011, "socket error");
    };
    state.socket.onclose = () => {
      teardown(state);
    };
    startHeartbeat(state);
    return upgraded.response;
  };

  function teardown(state: ConnectionState): void {
    state.closed = true;
    clearTimers(state);
    state.queue.length = 0;
    state.queuedFrames = 0;
    state.queuedBytes = 0;
    state.activeFrames = 0;
    internals.release(state.entry);
  }

  /** Per-connection executor: inbound frames, poll ticks and heartbeats run one at a time, in order. */
  function enqueue(state: ConnectionState, item: QueueItem): void {
    state.queue.push(item);
    if (item.kind === "frame") {
      state.queuedFrames += 1;
      state.queuedBytes += item.bytes;
    }
    void pump(state);
  }

  async function pump(state: ConnectionState): Promise<void> {
    if (state.pumping) return;
    state.pumping = true;
    try {
      while (!state.closed) {
        // A false retry means output is still blocked: the frame is withheld,
        // its continuation withheld the next one, or the failure was reported.
        if (state.pendingFrame && !(await retryPendingFrame(state))) break;
        const item = state.queue[0];
        if (!item) break;
        state.queue.shift();
        if (item.kind === "frame") {
          state.queuedFrames -= 1;
          state.queuedBytes -= item.bytes;
          state.activeFrames += 1;
          try {
            await processFrame(state, item.data);
          } finally {
            state.activeFrames -= 1;
          }
        } else {
          await item.run();
        }
      }
    } catch (error) {
      reportError(state, error, state.connectionId, true);
    } finally {
      state.pumping = false;
    }
  }

  async function onOpen(
    state: ConnectionState,
    upgradeResume?: UpgradeResume,
  ): Promise<void> {
    if (state.closed) return;
    try {
      if (
        !sendFrame(state, {
          type: "hello",
          protocolVersion: 1,
          connectionId: state.connectionId,
          highwater: state.initialClock.highwater,
          retainedFrom: state.initialClock.retainedFrom,
        })
      ) {
        // Over budget before the first byte: a retained hello has no
        // continuation for an upgrade-time resume, so fail closed.
        state.close(1008, "backpressure");
        return;
      }
      if (upgradeResume) {
        await startSubscription(
          state,
          upgradeResume.scopes,
          upgradeResume.sequence,
          state.connectionId,
        );
      }
    } catch (error) {
      reportError(state, error, state.connectionId, false);
    }
  }

  function onMessage(state: ConnectionState, data: unknown): void {
    if (state.closed) return;
    if (typeof data !== "string") {
      sendProblemAndClose(
        state,
        new StandardError({ code: "MALFORMED_REQUEST" }),
        state.connectionId,
        1003,
        "text frames required",
      );
      return;
    }
    const bytes = utf8Length(data);
    if (bytes > limits.maxFrameBytes) {
      sendProblemAndClose(
        state,
        new StandardError({
          code: "BODY_TOO_LARGE",
          params: { limit: limits.maxFrameBytes },
        }),
        state.connectionId,
        1009,
        "frame too large",
      );
      return;
    }
    if (
      state.activeFrames + state.queuedFrames >= limits.maxPendingFrames ||
      state.queuedBytes + bytes > limits.maxPendingBytes
    ) {
      sendProblemAndClose(
        state,
        new StandardError({ code: "RATE_LIMITED" }),
        state.connectionId,
        1008,
        "pending frames exceeded",
      );
      return;
    }
    enqueue(state, { kind: "frame", data, bytes });
  }

  async function processFrame(
    state: ConnectionState,
    data: string,
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (cause) {
      sendProblem(
        state,
        new StandardError({ code: "MALFORMED_JSON", cause }),
        requestIdFromText(data, state.connectionId),
      );
      return;
    }
    const requestId = requestIdFrom(value, state.connectionId);
    const parsed = contractSchemas.WebSocketFrame.safeParse(value);
    if (!parsed.success || !value || typeof value !== "object") {
      sendProblem(
        state,
        new StandardError({ code: "MALFORMED_REQUEST" }),
        requestId,
      );
      return;
    }
    const frame = value as WireFrame;
    if (!INBOUND_FRAME_TYPES[frame.type]) {
      sendProblem(
        state,
        new StandardError({ code: "MALFORMED_REQUEST" }),
        requestId,
      );
      return;
    }
    try {
      switch (frame.type) {
        case "ping":
          sendFrame(state, { type: "ping", requestId });
          return;
        case "ack":
          handleAck(state, frame, requestId);
          return;
        case "subscribe":
          await handleSubscribe(state, frame, requestId);
          return;
        case "resume":
          await handleResume(state, frame, requestId);
          return;
        case "output.subscribe":
          await handleOutputSubscribe(state, frame, requestId);
          return;
      }
    } catch (error) {
      reportError(state, error, requestId, false);
    }
  }

  function handleAck(
    state: ConnectionState,
    frame: WireFrame,
    requestId: string,
  ): void {
    const eventId = frame.eventId;
    const sequence = frame.sequence;
    if (typeof eventId !== "string" || typeof sequence !== "string") {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const accepted = state.delivered.get(eventId) === sequence;
    sendFrame(state, {
      type: "ack",
      requestId,
      eventId,
      sequence,
      status: accepted ? "accepted" : "rejected",
    });
  }

  async function handleSubscribe(
    state: ConnectionState,
    frame: WireFrame,
    requestId: string,
  ): Promise<void> {
    const scopes = validateScopes(frame.scopes, limits);
    const start = frame.after === null
      ? CURRENT_HIGHWATER
      : validateAfter(frame.after);
    await startSubscription(state, scopes, start, requestId);
  }

  async function handleResume(
    state: ConnectionState,
    frame: WireFrame,
    requestId: string,
  ): Promise<void> {
    if (typeof frame.cursor !== "string" || !frame.cursor) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const decoded = await decodeSequenceCursorFilters(
      options.secret,
      frame.cursor,
      baseBinding(state.principalId, state.organizationId),
    );
    const scopes = parseScopeFilters(decoded.filters);
    await startSubscription(state, scopes, decoded.sequence, requestId);
  }

  async function handleOutputSubscribe(
    state: ConnectionState,
    frame: WireFrame,
    requestId: string,
  ): Promise<void> {
    if (
      typeof frame.streamId !== "string" || !UUID.test(frame.streamId) ||
      (frame.after !== null && typeof frame.after !== "string")
    ) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    await startOutputSubscription(
      state,
      frame.streamId.toLowerCase(),
      frame.after === null ? undefined : frame.after as string,
      requestId,
    );
  }

  async function assertSession(state: ConnectionState): Promise<void> {
    const sessionState = await options.store.findSessionState(state.token);
    if (!sessionState) throw new StandardError({ code: "AUTH_INVALID" });
    if (sessionState.expiresAt.getTime() <= now().getTime()) {
      throw new StandardError({ code: "AUTH_EXPIRED" });
    }
    if (resolveSessionAssurance(sessionState) === SessionAssurance.Pending) {
      throw new StandardError({ code: "AUTH_FACTOR_REQUIRED" });
    }
  }

  async function authorizeMembership(
    transaction: PgTransactionClient,
    state: ConnectionState,
  ): Promise<void> {
    try {
      const actor = await resolveOrganizationActor(
        transaction,
        state.principalId,
        state.organizationId,
      );
      authorize(actor, "event:read", { action: "events.connect" });
    } catch (error) {
      if (
        error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
      ) {
        throw new MembershipRevokedError(error);
      }
      throw error;
    }
  }

  /** Live re-authorization: a scope that disappeared is reported with the clock of this tick. */
  async function authorizeLive(
    transaction: PgTransactionClient,
    state: ConnectionState,
    scopes: readonly SyncScope[],
    clock: ClockRow,
  ): Promise<void> {
    await authorizeMembership(transaction, state);
    for (const scope of scopes) {
      try {
        await assertScope(transaction, state.organizationId, scope);
      } catch (error) {
        if (
          error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
        ) {
          throw new ScopeRevokedError(clock);
        }
        throw error;
      }
    }
  }

  async function reauthorizePendingPage(
    state: ConnectionState,
    subscription: Subscription,
  ): Promise<void> {
    if (state.closed || state.subscription !== subscription) {
      throw new StandardError({ code: "AUTH_INVALID" });
    }
    await assertSession(state);
    const current = now().getTime();
    await withPgTransaction(
      options.database,
      async (transaction) => {
        const clock = await readEventClock(
          transaction,
          state.organizationId,
        );
        await authorizeLive(transaction, state, subscription.scopes, clock);
      },
      undefined,
      "read committed",
    );
    state.lastAuthorizedAt = current;
  }

  async function authorizeOutputSubscription(
    transaction: PgTransactionClient,
    state: ConnectionState,
    subscription: OutputSubscription,
  ): Promise<void> {
    try {
      const actor = await resolveOrganizationActor(
        transaction,
        state.principalId,
        state.organizationId,
      );
      authorize(actor, "outputStream:read", {
        action: OUTPUT_STREAMS_READ_ACTION.name,
      });
    } catch (error) {
      if (
        error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
      ) {
        throw new MembershipRevokedError(error);
      }
      throw error;
    }
    try {
      await loadAuthorizedOutputStream(
        transaction,
        state.organizationId,
        subscription.streamId,
      );
    } catch (error) {
      if (
        error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
      ) {
        throw new OutputAuthorityRevokedError(error);
      }
      throw error;
    }
  }

  async function reauthorizePendingOutput(
    state: ConnectionState,
    subscription: OutputSubscription,
  ): Promise<void> {
    if (state.closed || state.outputSubscription !== subscription) {
      throw new StandardError({ code: "AUTH_INVALID" });
    }
    await assertSession(state);
    const current = now().getTime();
    await withPgTransaction(
      options.database,
      (transaction) =>
        authorizeOutputSubscription(transaction, state, subscription),
      undefined,
      "read committed",
    );
    state.lastAuthorizedAt = current;
  }

  /**
   * Pages retained events after the subscription checkpoint up to the clock
   * highwater, packing each `events` frame by count and encoded bytes.
   */
  async function scanEvents(
    transaction: PgTransactionClient,
    state: ConnectionState,
    subscription: Subscription,
    clock: ClockRow,
  ): Promise<ScanResult> {
    const { requestId, scopes } = subscription;
    const envelopeBytes = utf8Length(JSON.stringify({
      type: "events",
      requestId,
      events: [],
      highwater: clock.highwater,
    }));
    const budget = limits.maxFrameBytes - envelopeBytes;
    const batchLimit = limits.maxEventsPerFrame + 1;
    const pages: EventsPage[] = [];
    let events: unknown[] = [];
    let delivered: DeliveredPair[] = [];
    let bytes = 0;
    let position = subscription.checkpoint;
    const flush = () => {
      if (events.length === 0) return;
      pages.push({
        frame: {
          type: "events",
          requestId,
          events,
          highwater: clock.highwater,
        },
        checkpoint: position,
        delivered,
      });
      events = [];
      delivered = [];
      bytes = 0;
    };
    while (true) {
      const rows = await readScopedEvents(
        transaction,
        state.organizationId,
        scopes,
        position.toString(),
        clock.highwater,
        batchLimit,
      );
      for (const row of rows) {
        const event = toEvent(row);
        const size = utf8Length(JSON.stringify(event));
        if (size > budget) {
          flush();
          return {
            pages,
            checkpoint: position,
            oversized: BigInt(row.sequence),
          };
        }
        if (
          events.length >= limits.maxEventsPerFrame ||
          bytes + size + (events.length > 0 ? 1 : 0) > budget
        ) {
          flush();
          if (pages.length >= limits.maxReplayFramesPerTick) {
            return { pages, checkpoint: position };
          }
        }
        bytes += size + (events.length > 0 ? 1 : 0);
        events.push(event);
        delivered.push({ id: row.id, sequence: row.sequence });
        position = BigInt(row.sequence);
      }
      if (rows.length < batchLimit) {
        flush();
        return { pages, checkpoint: BigInt(clock.highwater) };
      }
    }
  }

  async function startSubscription(
    state: ConnectionState,
    scopes: readonly SyncScope[],
    start: string,
    requestId: string,
  ): Promise<void> {
    const normalizedScopes = scopes.map(normalizeScope);
    const filters = scopeFilters(normalizedScopes);
    await assertSession(state);
    const outcome = await withPgTransaction<SubscriptionOutcome>(
      options.database,
      async (transaction) => {
        await authorizeMembership(transaction, state);
        for (const scope of normalizedScopes) {
          await assertScope(transaction, state.organizationId, scope);
        }
        const clock = await readEventClock(transaction, state.organizationId);
        const after = start === CURRENT_HIGHWATER
          ? BigInt(clock.highwater)
          : BigInt(start);
        if (isOutsideRetention(after, clock)) return { kind: "reset", clock };
        const subscription: Subscription = {
          requestId,
          scopes: normalizedScopes,
          filters,
          checkpoint: after,
        };
        return {
          kind: "scan",
          clock,
          subscription,
          scan: await scanEvents(transaction, state, subscription, clock),
        };
      },
      undefined,
      "repeatable read",
    );
    state.lastAuthorizedAt = now().getTime();
    if (outcome.kind === "reset") {
      sendReset(state, requestId, "cursor_expired", outcome.clock);
      return;
    }
    state.outputSubscription = undefined;
    state.subscription = outcome.subscription;
    await deliver(state, outcome.subscription, outcome.scan, outcome.clock);
    schedulePoll(state);
  }

  /** Emits scanned pages, advancing the checkpoint per frame; stops at the output budget. */
  async function deliver(
    state: ConnectionState,
    subscription: Subscription,
    scan: ScanResult,
    clock: ClockRow,
  ): Promise<void> {
    const sendCursor = async (): Promise<void> => {
      const cursor = await encodeSequenceCursor(
        options.secret,
        binding(state.principalId, state.organizationId, subscription.filters),
        { sequence: scan.checkpoint.toString() },
      );
      if (state.closed || state.subscription !== subscription) return;
      sendFrame(
        state,
        {
          type: "cursor",
          requestId: subscription.requestId,
          cursor,
          highwater: clock.highwater,
        },
        () => {
          subscription.checkpoint = scan.checkpoint;
          if (
            scan.oversized !== undefined && state.subscription === subscription
          ) {
            const result = sendProblem(
              state,
              new StandardError({
                code: "BODY_TOO_LARGE",
                params: { limit: limits.maxFrameBytes },
              }),
              subscription.requestId,
            );
            if (!result.sent) state.close(1008, "backpressure");
            else state.subscription = undefined;
          }
        },
      );
    };
    const sendPages = async (startIndex: number): Promise<void> => {
      for (
        let pageIndex = startIndex;
        pageIndex < scan.pages.length;
        pageIndex++
      ) {
        const page = scan.pages[pageIndex];
        if (!page) continue;
        const sent = sendFrame(
          state,
          page.frame,
          () => {
            subscription.checkpoint = page.checkpoint;
            for (const pair of page.delivered) recordDelivered(state, pair);
          },
          () => reauthorizePendingPage(state, subscription),
          async () => {
            await sendPages(pageIndex + 1);
          },
        );
        if (!sent) return;
      }
      await sendCursor();
    };
    await sendPages(0);
  }

  async function startOutputSubscription(
    state: ConnectionState,
    streamId: string,
    cursor: string | undefined,
    requestId: string,
  ): Promise<void> {
    await assertSession(state);
    const page = await withPgTransaction(
      options.database,
      async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          state.principalId,
          state.organizationId,
        );
        authorize(actor, "outputStream:read", {
          action: OUTPUT_STREAMS_READ_ACTION.name,
        });
        return await readOutputPage({
          transaction,
          secret: options.secret,
          principalId: state.principalId,
          organizationId: state.organizationId,
          action: "output.subscribe",
          streamId,
          ...(cursor === undefined ? {} : { cursor }),
          limit: OUTPUT_SOCKET_BATCH_LIMIT,
          maxBytes: limits.maxFrameBytes,
        });
      },
      undefined,
      "repeatable read",
    );
    state.lastAuthorizedAt = now().getTime();
    state.subscription = undefined;
    if (page.disposition === "reset_required") {
      if (page.cursor === null) throw new Error("OUTPUT_CURSOR_MISSING");
      const resetSubscription: OutputSubscription = {
        requestId,
        streamId,
        cursor: page.cursor,
        highwater: page.highwater,
      };
      state.outputSubscription = resetSubscription;
      sendFrame(
        state,
        {
          type: "output.reset_required",
          stream: page.stream,
          requestId,
          streamId,
          cursor: page.cursor,
          retainedFrom: page.retainedFrom,
          resumeAfter: page.resumeAfter,
          highwater: page.highwater,
        },
        () => {
          if (state.outputSubscription === resetSubscription) {
            state.outputSubscription = undefined;
          }
        },
        () => reauthorizePendingOutput(state, resetSubscription),
      );
      return;
    }
    if (page.cursor === null) throw new Error("OUTPUT_CURSOR_MISSING");
    const subscription: OutputSubscription = {
      requestId,
      streamId,
      cursor: page.cursor,
      highwater: page.highwater,
    };
    state.outputSubscription = subscription;
    await deliverOutput(state, subscription, page);
    schedulePoll(state);
  }

  async function deliverOutput(
    state: ConnectionState,
    subscription: OutputSubscription,
    page: Awaited<ReturnType<typeof readOutputPage>>,
  ): Promise<void> {
    if (page.disposition !== "page") return;
    const sendCursor = (): void => {
      if (state.closed || state.outputSubscription !== subscription) return;
      sendFrame(
        state,
        {
          type: "output.cursor",
          requestId: subscription.requestId,
          streamId: subscription.streamId,
          cursor: page.cursor,
          highwater: page.highwater,
        },
        () => {
          subscription.cursor = page.cursor as string;
          subscription.highwater = page.highwater;
        },
        () => reauthorizePendingOutput(state, subscription),
      );
    };
    const sendBatches = (startIndex: number): Promise<void> => {
      for (let index = startIndex; index < page.batches.length; index++) {
        const batch = page.batches[index];
        if (!batch) continue;
        const sent = sendFrame(
          state,
          {
            type: "output.batch",
            requestId: subscription.requestId,
            streamId: subscription.streamId,
            batch,
          },
          undefined,
          () => reauthorizePendingOutput(state, subscription),
          () => sendBatches(index + 1),
        );
        if (!sent) return Promise.resolve();
      }
      sendCursor();
      return Promise.resolve();
    };
    await sendBatches(0);
  }

  function recordDelivered(
    state: ConnectionState,
    pair: DeliveredPair,
  ): void {
    if (
      !state.delivered.has(pair.id) && state.delivered.size >= deliveredCapacity
    ) {
      const oldest = state.delivered.keys().next();
      if (!oldest.done) state.delivered.delete(oldest.value);
    }
    state.delivered.set(pair.id, pair.sequence);
  }

  async function tickOutput(
    state: ConnectionState,
    subscription: OutputSubscription,
  ): Promise<void> {
    if (state.pendingFrame && !(await retryPendingFrame(state))) return;
    if (state.socket.bufferedAmount > limits.maxBufferedBytes) {
      armBackpressure(state);
      return;
    }
    try {
      await assertSession(state);
      const page = await withPgTransaction(
        options.database,
        async (transaction) => {
          await authorizeOutputSubscription(transaction, state, subscription);
          return await readOutputPage({
            transaction,
            secret: options.secret,
            principalId: state.principalId,
            organizationId: state.organizationId,
            action: "output.subscribe",
            streamId: subscription.streamId,
            cursor: subscription.cursor,
            limit: OUTPUT_SOCKET_BATCH_LIMIT,
            maxBytes: limits.maxFrameBytes,
          });
        },
        undefined,
        "repeatable read",
      );
      state.lastAuthorizedAt = now().getTime();
      if (state.closed || state.outputSubscription !== subscription) return;
      if (page.disposition === "reset_required") {
        sendFrame(
          state,
          {
            type: "output.reset_required",
            stream: page.stream,
            requestId: subscription.requestId,
            streamId: subscription.streamId,
            cursor: page.cursor,
            retainedFrom: page.retainedFrom,
            resumeAfter: page.resumeAfter,
            highwater: page.highwater,
          },
          () => {
            if (state.outputSubscription === subscription) {
              state.outputSubscription = undefined;
            }
          },
          () => reauthorizePendingOutput(state, subscription),
        );
        return;
      }
      if (page.batches.length > 0) {
        await deliverOutput(state, subscription, page);
      }
    } catch (error) {
      reportError(state, error, subscription.requestId, true);
    }
  }

  async function tick(state: ConnectionState): Promise<void> {
    const outputSubscription = state.outputSubscription;
    if (outputSubscription) {
      await tickOutput(state, outputSubscription);
      return;
    }
    const subscription = state.subscription;
    if (state.closed || !subscription) return;
    if (state.pendingFrame && !(await retryPendingFrame(state))) return;
    if (state.socket.bufferedAmount > limits.maxBufferedBytes) {
      armBackpressure(state);
      return;
    }
    try {
      const hintClock = await withPgTransaction(
        options.database,
        (transaction) => readEventClock(transaction, state.organizationId),
        undefined,
        "read committed",
      );
      const hintedAdvanced =
        BigInt(hintClock.highwater) > subscription.checkpoint;
      const current = now().getTime();
      const reauthorizeHint = hintedAdvanced ||
        current - state.lastAuthorizedAt >= limits.heartbeatMs;
      if (!hintedAdvanced && !reauthorizeHint) return;
      if (reauthorizeHint) await assertSession(state);
      const outcome = await withPgTransaction<TickOutcome>(
        options.database,
        async (transaction) => {
          const clock = await readEventClock(
            transaction,
            state.organizationId,
          );
          const advanced = BigInt(clock.highwater) > subscription.checkpoint;
          const authorized = reauthorizeHint || advanced;
          if (authorized) {
            await authorizeLive(transaction, state, subscription.scopes, clock);
          }
          if (isOutsideRetention(subscription.checkpoint, clock)) {
            return { kind: "reset", clock, authorized };
          }
          if (!advanced) return { kind: "idle", clock, authorized };
          return {
            kind: "scan",
            clock,
            authorized,
            scan: await scanEvents(transaction, state, subscription, clock),
          };
        },
        undefined,
        "repeatable read",
      );
      if (outcome.authorized) state.lastAuthorizedAt = current;
      if (state.closed || state.subscription !== subscription) return;
      switch (outcome.kind) {
        case "reset":
          sendReset(
            state,
            subscription.requestId,
            "cursor_expired",
            outcome.clock,
          );
          return;
        case "idle":
          return;
        case "scan":
          await deliver(state, subscription, outcome.scan, outcome.clock);
          return;
      }
    } catch (error) {
      reportError(state, error, subscription.requestId, true);
    }
  }

  async function heartbeat(state: ConnectionState): Promise<void> {
    if (state.closed) return;
    try {
      const current = now().getTime();
      if (current - state.lastAuthorizedAt >= limits.heartbeatMs) {
        await assertSession(state);
        await withPgTransaction(
          options.database,
          async (transaction) => {
            if (state.outputSubscription) {
              await authorizeOutputSubscription(
                transaction,
                state,
                state.outputSubscription,
              );
              return;
            }
            const clock = await readEventClock(
              transaction,
              state.organizationId,
            );
            await authorizeLive(
              transaction,
              state,
              state.subscription?.scopes ?? [],
              clock,
            );
          },
          undefined,
          "read committed",
        );
        state.lastAuthorizedAt = current;
      }
      if (state.pendingFrame && !(await retryPendingFrame(state))) return;
      sendFrame(state, { type: "ping", requestId: state.connectionId });
    } catch (error) {
      reportError(
        state,
        error,
        state.outputSubscription?.requestId ??
          state.subscription?.requestId ?? state.connectionId,
        true,
      );
    }
  }

  function startHeartbeat(state: ConnectionState): void {
    state.heartbeatTimer = setInterval(() => {
      if (state.closed || state.heartbeatQueued) return;
      state.heartbeatQueued = true;
      enqueue(state, {
        kind: "work",
        run: () => {
          state.heartbeatQueued = false;
          return heartbeat(state);
        },
      });
    }, limits.heartbeatMs);
  }

  /** Live-tail ticks while subscribed; poll-cadence retries while a frame is withheld. */
  function schedulePoll(state: ConnectionState): void {
    if (
      state.closed || state.pollTimer !== undefined ||
      (!state.subscription && !state.outputSubscription && !state.pendingFrame)
    ) {
      return;
    }
    state.pollTimer = setTimeout(() => {
      state.pollTimer = undefined;
      if (state.closed) return;
      if (state.pendingFrame) {
        // Retry from the executor loop head. A tick queued behind the withheld
        // frame never runs, so it must not be what re-arms this timer.
        if (!state.pumping) void pump(state);
        schedulePoll(state);
        return;
      }
      if (!state.subscription && !state.outputSubscription) return;
      if (state.pumping || state.queue.length > 0) {
        schedulePoll(state);
        return;
      }
      enqueue(state, {
        kind: "work",
        run: () => tick(state).finally(() => schedulePoll(state)),
      });
    }, limits.pollIntervalMs);
  }

  function armBackpressure(
    state: ConnectionState,
    blockedFrameBytes?: number,
  ): void {
    if (
      blockedFrameBytes !== undefined &&
      state.blockedFrameBytes === undefined
    ) {
      state.blockedFrameBytes = blockedFrameBytes;
    }
    schedulePoll(state);
    if (state.backpressureTimer !== undefined) return;
    state.backpressureTimer = setTimeout(() => {
      state.backpressureTimer = undefined;
      if (state.closed) return;
      const projected = state.socket.bufferedAmount +
        (state.blockedFrameBytes ?? 0);
      if (projected > limits.maxBufferedBytes) {
        state.close(1008, "backpressure");
        return;
      }
      state.blockedFrameBytes = undefined;
      enqueue(state, {
        kind: "work",
        run: async () => {
          if (state.pendingFrame) await retryPendingFrame(state);
          if (!state.pendingFrame) schedulePoll(state);
        },
      });
    }, limits.backpressureGraceMs);
  }

  async function retryPendingFrame(state: ConnectionState): Promise<boolean> {
    const pending = state.pendingFrame;
    if (!pending) return true;
    // Re-authorize only once the frame can actually go out, so the check is
    // adjacent to the send instead of racing revocations while still blocked.
    if (state.socket.bufferedAmount + pending.bytes > limits.maxBufferedBytes) {
      armBackpressure(state);
      return false;
    }
    try {
      await pending.beforeSend?.();
    } catch (error) {
      state.pendingFrame = undefined;
      state.blockedFrameBytes = undefined;
      const requestId = typeof pending.frame.requestId === "string"
        ? pending.frame.requestId
        : state.outputSubscription?.requestId ??
          state.subscription?.requestId ?? state.connectionId;
      reportError(state, error, requestId, true);
      return false;
    }
    if (!transmit(state, pending, true)) return false;
    await pending.afterSent?.();
    // The continuation may have withheld the next page or cursor.
    return state.pendingFrame === undefined;
  }

  /** Validates one frame, then sends it within the output budget. */
  function sendFrame(
    state: ConnectionState,
    frame: WireFrame,
    onSent?: () => void,
    beforeSend?: () => Promise<void>,
    afterSent?: () => Promise<void>,
  ): boolean {
    if (state.closed || state.pendingFrame) return false;
    const text = JSON.stringify(frame);
    const bytes = utf8Length(text);
    const parsed = contractSchemas.WebSocketFrame.safeParse(frame);
    if (!parsed.success || bytes > limits.maxFrameBytes) {
      console.error(
        "EVENTS_SOCKET_FRAME_INVALID",
        parsed.success ? "frame too large" : parsed.error,
      );
      const requestId =
        typeof frame.requestId === "string" && UUID.test(frame.requestId)
          ? frame.requestId
          : state.connectionId;
      try {
        state.socket.send(JSON.stringify({
          type: "problem",
          requestId,
          problem: toProblem(new StandardError({ code: "INTERNAL" }), {
            requestId,
            traceId: state.traceId,
            publicBaseUrl: options.publicBaseUrl,
          }),
        }));
      } catch {
        // The close below is the only remaining action.
      } finally {
        state.close(1011, "invalid server frame");
      }
      return false;
    }
    return transmit(
      state,
      { frame, text, bytes, onSent, beforeSend, afterSent },
      false,
    );
  }

  /**
   * Sends an already validated frame if it fits the output budget; otherwise
   * retains it as the single pending frame and arms the grace deadline. A
   * successful send ends the current backpressure episode so the next
   * withheld frame is judged by a fresh grace window.
   */
  function transmit(
    state: ConnectionState,
    pending: PendingFrame,
    retry: boolean,
  ): boolean {
    if (state.socket.bufferedAmount + pending.bytes > limits.maxBufferedBytes) {
      if (!retry) state.pendingFrame = pending;
      armBackpressure(state, pending.bytes);
      return false;
    }
    try {
      state.socket.send(pending.text);
    } catch {
      state.close(1011, "socket error");
      return false;
    }
    state.blockedFrameBytes = undefined;
    clearTimeout(state.backpressureTimer);
    state.backpressureTimer = undefined;
    if (retry) state.pendingFrame = undefined;
    pending.onSent?.();
    return true;
  }

  type ProblemDelivery = { readonly problem: Problem; readonly sent: boolean };

  function sendProblem(
    state: ConnectionState,
    error: unknown,
    requestId: string,
  ): ProblemDelivery {
    const problem = toProblem(mapProblemError(error), {
      requestId,
      traceId: state.traceId,
      publicBaseUrl: options.publicBaseUrl,
    });
    const sent = sendFrame(state, { type: "problem", requestId, problem });
    return { problem, sent };
  }

  function sendProblemAndClose(
    state: ConnectionState,
    error: unknown,
    requestId: string,
    code: number,
    reason: string,
  ): void {
    if (state.closed) return;
    const { sent } = sendProblem(state, error, requestId);
    state.close(sent ? code : 1008, sent ? reason : "backpressure");
  }

  function sendReset(
    state: ConnectionState,
    requestId: string,
    reason: ResetReason,
    clock: ClockRow,
    closeAfterSend?: string,
  ): boolean {
    return sendFrame(
      state,
      {
        type: "reset_required",
        requestId,
        reason,
        retainedFrom: clock.retainedFrom,
        highwater: clock.highwater,
      },
      () => {
        state.subscription = undefined;
        if (closeAfterSend) state.close(1008, closeAfterSend);
      },
    );
  }

  /**
   * Reports a failure on the socket. Scope loss becomes `reset_required
   * scope_revoked` + 1008; access loss closes 1008; server failures close
   * 1011; recoverable client faults stay open unless `fatal`.
   */
  function reportError(
    state: ConnectionState,
    error: unknown,
    requestId: string,
    fatal: boolean,
  ): void {
    if (state.closed) return;
    if (error instanceof ScopeRevokedError) {
      sendReset(
        state,
        requestId,
        "scope_revoked",
        error.clock,
        "scope revoked",
      );
      return;
    }
    const { problem, sent } = sendProblem(state, error, requestId);
    if (!sent) {
      state.close(1008, "backpressure");
      return;
    }
    const code = closeCodeForProblem(problem) ?? (fatal ? 1011 : undefined);
    if (code === 1008) state.close(1008, "access revoked");
    else if (code !== undefined) state.close(code, "internal error");
  }

  function clearTimers(state: ConnectionState): void {
    clearTimeout(state.pollTimer);
    clearInterval(state.heartbeatTimer);
    clearTimeout(state.backpressureTimer);
    state.pollTimer = undefined;
    state.heartbeatTimer = undefined;
    state.backpressureTimer = undefined;
    state.blockedFrameBytes = undefined;
    state.pendingFrame = undefined;
  }
}
