import { deepFreeze } from "./src/context.ts";
import type {
  ActionContext,
  BakeryOperation,
  ReconciliationContext,
  RequestRef,
  ResourceProjection,
} from "./src/context.ts";

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
