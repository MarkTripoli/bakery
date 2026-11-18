import { deepFreeze } from "./src/context.ts";
import type {
  ActionContext,
  BakeryOperation,
  ReconciliationContext,
  RequestRef,
  ResourceProjection,
} from "./src/context.ts";
import type { ProviderManifest } from "./src/provider-manifest.ts";
import type { DriverContext, InstallationOrigin } from "./src/ports.ts";
import type { ProviderRequestPort } from "./src/ports.ts";
import type { ServerImpl } from "./src/server-provider.ts";

/** Deterministic uuid-shaped effect id for tests; no crypto, never production. */
export function deterministicEffectId(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError("effect id seed must be a non-negative safe integer");
  }
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Error thrown by fake ports for operations or requests the fixture denies. */
export class FakePermissionDenied extends Error {
  constructor(what: string) {
    super(`permission denied: ${what}`);
    this.name = "FakePermissionDenied";
  }
}

export type FakeContextOptions = {
  effectId?: string;
  resource?: ResourceProjection;
  signal?: AbortSignal;
  /** Responses keyed by `id@version`; a function computes one from the input. */
  providerResponses?: Record<string, unknown | ((input: unknown) => unknown)>;
  bakeryResponses?: Partial<Record<BakeryOperation, unknown>>;
  /** Operations that throw FakePermissionDenied, the default-deny fixture. */
  deniedOperations?: readonly BakeryOperation[];
  deniedRequests?: readonly string[];
};

type Recorder = {
  providerCalls: { ref: RequestRef; input: unknown }[];
  bakeryCalls: { operation: BakeryOperation; input: unknown }[];
};

function ports(options: FakeContextOptions, rec: Recorder) {
  const provider = {
    request(ref: RequestRef, input: unknown): Promise<unknown> {
      const k = `${ref.id}@${ref.version}`;
      rec.providerCalls.push({ ref, input });
      if (options.deniedRequests?.includes(k)) {
        return Promise.reject(new FakePermissionDenied(k));
      }
      const response = options.providerResponses?.[k];
      return Promise.resolve(
        typeof response === "function" ? response(input) : response,
      );
    },
  };
  const bakery = {
    call(operation: BakeryOperation, input: unknown): Promise<unknown> {
      rec.bakeryCalls.push({ operation, input });
      if (options.deniedOperations?.includes(operation)) {
        return Promise.reject(new FakePermissionDenied(operation));
      }
      return Promise.resolve(options.bakeryResponses?.[operation]);
    },
  };
  return { provider, bakery };
}

function frozenNull<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

/** Recording ActionContext: frozen, null prototype, no credential accessors. */
export function createFakeActionContext(options: FakeContextOptions = {}) {
  const rec: Recorder = { providerCalls: [], bakeryCalls: [] };
  const p = ports(options, rec);
  const context: ActionContext = frozenNull({
    signal: options.signal ?? new AbortController().signal,
    bakery: p.bakery,
    provider: p.provider,
    effect: Object.freeze({ id: options.effectId ?? deterministicEffectId(1) }),
    resource: Object.freeze(options.resource ?? { kind: "fixture.resource" }),
  });
  return { context, ...rec };
}

/** Recording ReconciliationContext: exactly signal, provider, effect, input, resource. */
export function createFakeReconciliationContext<I>(
  input: I,
  options: Omit<FakeContextOptions, "bakeryResponses" | "deniedOperations"> =
    {},
) {
  const rec: Recorder = { providerCalls: [], bakeryCalls: [] };
  const p = ports(options, rec);
  const context: ReconciliationContext<I> = frozenNull({
    signal: options.signal ?? new AbortController().signal,
    provider: p.provider,
    effect: Object.freeze({ id: options.effectId ?? deterministicEffectId(1) }),
    input: deepFreeze(structuredClone(input)),
    resource: Object.freeze(options.resource ?? { kind: "fixture.resource" }),
  });
  return { context, ...rec };
}

/**
 * Test doubles for the provider tier (`@bakery/integration-sdk/testing`).
 *
 * A provider's own tests need a transport, a clock and an origin, and the host
 * needs to run a provider against a recorded response without a network. Shipping
 * the doubles here rather than in each provider package means every provider is
 * tested the same way, and a provider that works only against its own bespoke
 * harness is a provider that will not work in the host.
 *
 * These are real helpers with no I/O: a fake transport is a queue of responses, and
 * a fake context is a fixed clock plus a signal the test can abort.
 */

/** One response a fake transport will return, in order. */
export type RecordedResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** Encoded as UTF-8 when returned. */
  body?: string;
};

/** What a caller asked the fake transport for, so a test can assert on requests. */
export type RecordedRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array | undefined;
  maxResponseBytes: number;
};

export type FakeTransport = ProviderRequestPort & {
  /** Every request seen, in order. */
  readonly requests: readonly RecordedRequest[];
  /** Responses still queued; a test asserts this reached zero. */
  readonly pending: number;
};

/**
 * A transport that returns queued responses and records what it was asked.
 *
 * Fails loudly on an unexpected extra request rather than returning an empty body:
 * a provider that calls an endpoint its test did not anticipate is a defect, and a
 * silent empty response would hide it behind a confusing parse error.
 */
export function fakeTransport(
  responses: readonly RecordedResponse[],
): FakeTransport {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  return {
    get requests() {
      return requests;
    },
    get pending() {
      return queue.length;
    },
    send(request) {
      requests.push({
        method: request.method,
        path: request.path,
        headers: request.headers ?? {},
        body: request.body,
        maxResponseBytes: request.maxResponseBytes,
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          `The provider sent ${request.method} ${request.path}, but the test queued no further response. Queued responses must match the requests a provider makes.`,
        );
      }
      return Promise.resolve({
        status: next.status ?? 200,
        headers: next.headers ?? {},
        body: new TextEncoder().encode(next.body ?? ""),
      });
    },
  };
}

/** A controller for the context's abort signal, so a test can cancel a call. */
export type FakeDriverController = {
  ctx: DriverContext;
  /** Abort the signal the provider was given, as the host would on a timeout. */
  abort(reason?: string): void;
  /** Whether the provider observed the abort, for assertions. */
  readonly aborted: boolean;
};

/**
 * A `DriverContext` with a fixed clock and a controllable signal.
 *
 * `now` is fixed rather than advancing so a signature-verification test can place a
 * delivery outside a tolerance window without sleeping.
 */
export function fakeDriverContext(input: {
  transport?: ProviderRequestPort;
  origin?: InstallationOrigin;
  now?: Date;
} = {}): FakeDriverController {
  const controller = new AbortController();
  const now = input.now ?? new Date("2026-01-01T00:00:00.000Z");
  const origin = input.origin ?? {
    apiBaseUrl: new URL("https://api.example.com/"),
    webBaseUrl: new URL("https://example.com/"),
  };
  const ctx: DriverContext = {
    provider: input.transport ?? fakeTransport([]),
    origin,
    signal: controller.signal,
    now: () => now,
  };
  return {
    ctx,
    abort: (reason?: string) => controller.abort(reason),
    get aborted() {
      return controller.signal.aborted;
    },
  };
}

/**
 * A minimal manifest for tests that need a provider but do not care what it does.
 *
 * `overrides` is shallow on purpose: a test that needs a nested change should build
 * the manifest it means rather than patch a fixture into a shape no real provider
 * has.
 */
export function testManifest(
  overrides: Partial<ProviderManifest> = {},
): ProviderManifest {
  const slug = overrides.slug ?? "testprov";
  return {
    slug,
    integrationId: `bakery.${slug}`,
    providerUuid: "00000000-0000-4000-8000-000000000000",
    nameKey: `integrations.${slug}.name`,
    families: [],
    appRegistration: null,
    connect: {
      kind: "api-token",
      fields: [{
        id: "token",
        labelKey: `integrations.${slug}.fields.token`,
        secret: true,
        format: "text",
      }],
    },
    ingress: null,
    resourceKinds: [{
      id: "project",
      nameKey: `integrations.${slug}.kinds.project`,
      serves: ["projects"],
    }],
    ...overrides,
  };
}

/**
 * A server implementation that satisfies the manifest's shape and does nothing, so
 * a test can override only the port under examination.
 *
 * The casts are load-bearing and confined to this file: the helpers exist to build
 * shapes the conditional types normally forbid, and a test double that failed to
 * compile would push every provider test back to hand-rolling its own.
 */
export function testServerImpl(
  manifest: ProviderManifest,
  overrides: Partial<ServerImpl<ProviderManifest>> = {},
): ServerImpl<ProviderManifest> {
  const ctxless = (): never => {
    throw new Error(
      "The test implementation was called; override the port it reached.",
    );
  };
  const base = {
    connect: { probe: ctxless },
    credentials: {
      secretSlots: ["token"],
      mint: () =>
        Promise.resolve({
          token: "test-token",
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
          placement: "bearer" as const,
        }),
    },
    ingress: undefined,
    lifecycle: { onEvent: () => Promise.resolve() },
    discovery: {
      list: () => Promise.resolve({ resources: [], nextCursor: null }),
    },
    health: { check: () => Promise.resolve({ healthy: true as const }) },
    hostProfile: `profile-${manifest.slug}`,
  };
  return { ...base, ...overrides } as ServerImpl<ProviderManifest>;
}
