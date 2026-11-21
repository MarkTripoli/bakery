/**
 * The install-scoped broker a plugin job talks to (#29, B14.02).
 *
 * A plugin job is untrusted generated code. It gets one short-lived token that
 * names one install and one job, and nothing else: no database, no raw network,
 * no supervisor credential. Every call it makes passes through `call` below,
 * which checks, in this order and each time:
 *
 *  1. the token is ours, unexpired and for this install (a forged, edited or
 *     lapsed token is refused before anything is read);
 *  2. the request is small enough, well formed, and inside the rate limit;
 *  3. the sequence number is strictly higher than the last accepted one;
 *  4. the install is enabled and holds the grant for exactly this operation,
 *     read fresh, so turning the plugin off or removing a grant stops the very
 *     next call, with no cache to wait out;
 *  5. the operation is one of the typed operations the host registered.
 *
 * A request id names one effect. Replaying an id after it ran returns the
 * recorded outcome and does not run the operation again.
 */

/** Longest a token lives. A job that needs longer asks for a new one. */
export const BROKER_TOKEN_MAX_TTL_MS = 5 * 60 * 1000;
/** Largest request body the broker reads, in bytes of its JSON text. */
export const BROKER_MAX_REQUEST_BYTES = 64 * 1024;
/** Calls one token may make inside `BROKER_RATE_WINDOW_MS`. */
export const BROKER_RATE_LIMIT = 60;
export const BROKER_RATE_WINDOW_MS = 10_000;
/** Request ids remembered per token for replay. */
export const BROKER_MAX_REMEMBERED_REQUESTS = 256;

const TOKEN_VERSION = 1;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;

export type BrokerDenial =
  | "token_invalid"
  | "token_expired"
  | "token_stale"
  | "install_mismatch"
  | "request_too_large"
  | "request_malformed"
  | "rate_limited"
  | "sequence_replayed"
  | "install_off"
  | "install_gone"
  | "not_granted"
  | "unknown_operation"
  | "operation_failed";

export type BrokerOutcome =
  | { ok: true; result: unknown; replayed: boolean }
  | { ok: false; denial: BrokerDenial };

export type BrokerClaims = Readonly<{
  organizationId: string;
  installId: string;
  jobId: string;
  /**
   * Names the broker run that issued the token. A restart starts a new run, so
   * a token from before it is refused and the job must ask for a new one; its
   * spent request ids were only ever remembered in memory.
   */
  epoch: string;
  /** Names this token for sequence, rate and replay bookkeeping. */
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
}>;

/** What the broker needs to know about an install, read fresh on every call. */
export type InstallAuthority = Readonly<{
  status: "enabled" | "disabled" | "uninstalled";
  grants: readonly string[];
}>;

export type InstallAuthorityPort = {
  load(
    organizationId: string,
    installId: string,
  ): Promise<InstallAuthority | null>;
};

/** One typed operation. The only things a plugin job may ask the host to do. */
export type BrokerOperation = Readonly<{
  /** Dotted name, also the capability an install grant must carry, unchanged. */
  name: string;
  run(
    claims: BrokerClaims,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}>;

export type BrokerOptions = Readonly<{
  /** HMAC key, at least 32 bytes, never given to a job. */
  key: Uint8Array;
  /** Fresh for each start of the server, for example a random UUID. */
  epoch: string;
  authority: InstallAuthorityPort;
  operations: readonly BrokerOperation[];
  now?: () => number;
}>;

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(key: Uint8Array, usage: "sign" | "verify") {
  return await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Issues a token for one install and job. Throws on a malformed claim. */
export async function mintBrokerToken(
  key: Uint8Array,
  claims: Omit<BrokerClaims, "issuedAt" | "expiresAt" | "tokenId"> & {
    now: number;
    ttlMs: number;
  },
): Promise<{ token: string; claims: BrokerClaims }> {
  if (key.byteLength < 32) throw new Error("BROKER_KEY_TOO_SHORT");
  for (
    const value of [
      claims.organizationId,
      claims.installId,
      claims.jobId,
      claims.epoch,
    ]
  ) {
    if (!ID.test(value)) throw new Error("BROKER_CLAIM_INVALID");
  }
  if (
    !Number.isFinite(claims.ttlMs) || claims.ttlMs <= 0 ||
    claims.ttlMs > BROKER_TOKEN_MAX_TTL_MS
  ) throw new Error("BROKER_TTL_INVALID");
  const full: BrokerClaims = {
    organizationId: claims.organizationId,
    installId: claims.installId,
    jobId: claims.jobId,
    epoch: claims.epoch,
    tokenId: crypto.randomUUID(),
    issuedAt: claims.now,
    expiresAt: claims.now + claims.ttlMs,
  };
  const body = base64url(
    new TextEncoder().encode(JSON.stringify({ v: TOKEN_VERSION, ...full })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(key, "sign"),
      new TextEncoder().encode(body),
    ),
  );
  return { token: `${body}.${base64url(signature)}`, claims: full };
}

async function readClaims(
  key: Uint8Array,
  token: string,
): Promise<BrokerClaims | null> {
  if (token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const signature = fromBase64url(mac);
  if (signature === null) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(key, "verify"),
    signature as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(body),
  );
  if (!valid) return null;
  const bytes = fromBase64url(body);
  if (bytes === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const { v, organizationId, installId, jobId, tokenId, epoch } = parsed;
  const { issuedAt, expiresAt } = parsed;
  if (
    v !== TOKEN_VERSION || typeof organizationId !== "string" ||
    typeof installId !== "string" || typeof jobId !== "string" ||
    typeof epoch !== "string" ||
    typeof tokenId !== "string" || typeof issuedAt !== "number" ||
    typeof expiresAt !== "number"
  ) return null;
  return {
    organizationId,
    installId,
    jobId,
    epoch,
    tokenId,
    issuedAt,
    expiresAt,
  };
}

type TokenState = {
  expiresAt: number;
  lastSequence: number;
  calls: number[];
  /**
   * Held from the moment an effect starts, not when it ends, so a second call
   * with the same request id while the first still runs waits for it and does
   * not start the effect again.
   */
  outcomes: Map<
    string,
    { operation: string; settled: Promise<{ ok: boolean; result?: unknown }> }
  >;
};

export type PluginBroker = {
  /**
   * The same checks for claims the server itself established, such as a job
   * attempt it has just authenticated by lease and fence. The caller supplies
   * no token, and `tokenId` should be stable for the attempt so sequence, rate
   * and replay state carry across its calls.
   */
  callAs(
    input: { claims: Omit<BrokerClaims, "epoch">; body: string },
  ): Promise<BrokerOutcome>;
  call(
    input: {
      token: string;
      /** The install the caller believes it is acting for; never trusted, only compared. */
      installId: string;
      body: string;
    },
  ): Promise<BrokerOutcome>;
};

export function createPluginBroker(options: BrokerOptions): PluginBroker {
  if (options.key.byteLength < 32) throw new Error("BROKER_KEY_TOO_SHORT");
  if (!ID.test(options.epoch)) throw new Error("BROKER_EPOCH_INVALID");
  const now = options.now ?? Date.now;
  const operations = new Map(options.operations.map((o) => [o.name, o]));
  for (const name of operations.keys()) {
    if (!OPERATION.test(name)) throw new Error("BROKER_OPERATION_NAME_INVALID");
  }
  const states = new Map<string, TokenState>();

  const deny = (denial: BrokerDenial): BrokerOutcome => ({ ok: false, denial });

  async function handle(
    claims: BrokerClaims,
    installId: string,
    body: string,
  ): Promise<BrokerOutcome> {
    const at = now();
    // Bookkeeping for lapsed tokens goes with them, so a long-running server
    // does not keep one entry per job it has ever served.
    for (const [id, held] of states) {
      if (at >= held.expiresAt) states.delete(id);
    }
    if (at >= claims.expiresAt || at < claims.issuedAt) {
      states.delete(claims.tokenId);
      return deny("token_expired");
    }
    if (claims.installId !== installId) return deny("install_mismatch");

    if (
      new TextEncoder().encode(body).byteLength > BROKER_MAX_REQUEST_BYTES
    ) {
      return deny("request_too_large");
    }
    let request: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body);
      if (
        typeof parsed !== "object" || parsed === null ||
        Array.isArray(parsed)
      ) return deny("request_malformed");
      request = parsed;
    } catch {
      return deny("request_malformed");
    }
    const { requestId, sequence, operation, args } = request;
    if (
      typeof requestId !== "string" || !ID.test(requestId) ||
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) ||
      sequence < 1 || typeof operation !== "string" ||
      !OPERATION.test(operation) ||
      typeof args !== "object" || args === null || Array.isArray(args)
    ) return deny("request_malformed");

    let state = states.get(claims.tokenId);
    if (state === undefined) {
      state = {
        expiresAt: claims.expiresAt,
        lastSequence: 0,
        calls: [],
        outcomes: new Map(),
      };
      states.set(claims.tokenId, state);
    }
    state.calls = state.calls.filter((t) => at - t < BROKER_RATE_WINDOW_MS);
    if (state.calls.length >= BROKER_RATE_LIMIT) return deny("rate_limited");
    state.calls.push(at);

    // Authority is read fresh, before the sequence moves, so a refused call
    // costs the job nothing it could replay and a revoked install stops now.
    const authority = await options.authority.load(
      claims.organizationId,
      claims.installId,
    );
    if (authority === null || authority.status === "uninstalled") {
      return deny("install_gone");
    }
    if (authority.status !== "enabled") return deny("install_off");
    if (!authority.grants.includes(operation)) {
      return deny("not_granted");
    }
    const typed = operations.get(operation);
    if (typed === undefined) return deny("unknown_operation");

    const remembered = state.outcomes.get(requestId);
    if (remembered !== undefined) {
      if (remembered.operation !== operation) {
        return deny("request_malformed");
      }
      const earlier = await remembered.settled;
      return earlier.ok
        ? { ok: true, result: earlier.result, replayed: true }
        : deny("operation_failed");
    }
    if (sequence <= state.lastSequence) return deny("sequence_replayed");
    state.lastSequence = sequence;

    // Recorded before the effect starts, with no await in between. A failure
    // is recorded too: an effect that half ran must not run again under the
    // same id, and the caller never sees the raw error, which may name
    // internals or secrets.
    const settled = (async () => {
      try {
        return {
          ok: true,
          result: await typed.run(
            claims,
            args as Readonly<Record<string, unknown>>,
          ),
        };
      } catch {
        return { ok: false };
      }
    })();
    if (state.outcomes.size >= BROKER_MAX_REMEMBERED_REQUESTS) {
      const oldest = state.outcomes.keys().next().value;
      if (oldest !== undefined) state.outcomes.delete(oldest);
    }
    state.outcomes.set(requestId, { operation, settled });
    const done = await settled;
    return done.ok
      ? { ok: true, result: done.result, replayed: false }
      : deny("operation_failed");
  }

  return {
    async call({ token, installId, body }) {
      const claims = await readClaims(options.key, token);
      if (claims === null) return deny("token_invalid");
      if (claims.epoch !== options.epoch) return deny("token_stale");
      return await handle(claims, installId, body);
    },
    callAs({ claims, body }) {
      return handle(
        { ...claims, epoch: options.epoch },
        claims.installId,
        body,
      );
    },
  };
}
