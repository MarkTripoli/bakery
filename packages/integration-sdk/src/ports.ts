import type { z } from "zod";

/**
 * The small vocabulary the provider ports share (chapter 09 section 12.6, the
 * "named stubs" that slice 2 freezes before the Linear spike checks the port
 * shapes).
 *
 * Everything here is a type or a helper over one, with no implementation: slice 2
 * ships the shapes and no callers, so a mistake costs a rename rather than a
 * migration. Each stub is deliberately the smallest thing that expresses the
 * constraint, because a port that guesses what a provider needs is exactly what
 * the modular split is undoing.
 */

/**
 * A secret slot's plaintext value, keyed by the slot name a strategy declares.
 *
 * Deliberately a record of bytes rather than a class: the host owns decryption and
 * zeroing, and a provider that received a token object would be a place for one to
 * be logged. `readonly` is the only protection a type can give here, so the naming
 * says the caller must not retain it.
 */
export type SecretSlots = Readonly<Record<string, Uint8Array>>;

/**
 * The identity a provider reports for the account it is connected as.
 *
 * `externalAccountId` is the provider's own identifier and is never a Bakery id:
 * the host maps it, because two providers can legitimately report the same string
 * and a shared id space would let one installation shadow another.
 */
export type Identity = {
  externalAccountId: string;
  accountLabel: string;
  /** Provider-side permission names to levels, exactly as the provider reports. */
  grantedPermissions: Readonly<Record<string, string>>;
};

/**
 * Where an installation's API lives.
 *
 * Self-hosted is in scope but not v1: every installation carries its own base URL,
 * so GitHub Enterprise Server, GitLab self-managed and Jira Data Center need no
 * interface change later. V1 accepts only the provider's cloud origin; accepting a
 * caller-supplied origin later adds SSRF controls (https only, no private,
 * link-local or loopback address after resolution, a pinned resolution per
 * request) without changing this type.
 */
export type InstallationOrigin = {
  /** Base the host binds every provider request to; templates stay relative to it. */
  apiBaseUrl: URL;
  /** Base for links a person follows, which is not always the API host. */
  webBaseUrl: URL;
};

/**
 * One outbound request the host performs on a provider's behalf.
 *
 * The provider describes a request; it never performs one. That is what lets the
 * host own the transport: the allowlist, the origin binding, the response bound,
 * redirects, retries and the audit record all live on one side of the boundary.
 */
export type ProviderRequestPort = {
  /**
   * Send one request. The body is already encoded by the caller, so the host does
   * not have to know the provider's serialisation.
   */
  send(request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** Path and query relative to the installation origin; never an absolute URL. */
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    /** Host-enforced ceiling on the response, independent of anything the provider asks for. */
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
  }>;
};

/**
 * What a provider is given for the duration of one driver call.
 *
 * `now()` rather than `Date.now()` so a test can move time, and `signal` rather
 * than a timeout so the host decides when to give up. A provider that read the
 * clock or set its own timeout could not be tested at the boundaries where the
 * interesting mistakes live.
 */
export type DriverContext = {
  provider: ProviderRequestPort;
  origin: InstallationOrigin;
  signal: AbortSignal;
  now(): Date;
};

/**
 * The result of proving a credential works.
 *
 * A failure is a value, not a thrown error: "this token is wrong" is an expected
 * outcome of connecting, and an exception would make the ordinary path
 * indistinguishable from a bug in the provider.
 */
export type VerifiedAuthorization = {
  installation: {
    externalAuthorizationId: string;
    externalAccountId: string;
    accountLabel: string;
    grantedPermissions: Readonly<Record<string, string>>;
    origin: InstallationOrigin;
  };
  credential:
    | { kind: "app-installation" }
    | {
      kind: "oauth2";
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    }
    | { kind: "api-token"; token: string };
};

/** Either a proven authorization or a reason a person can act on. */
export type AuthorizationOutcome =
  | VerifiedAuthorization
  | { failure: string };

/**
 * Installation lifecycle events a provider may react to (section 12.2).
 *
 * The names are the intake intents' vocabulary, so a delivery that classifies to
 * `lifecycle` and a lifecycle call use the same words for the same thing.
 */
export type LifecycleEvent =
  | "installed"
  | "suspended"
  | "unsuspended"
  | "revoked"
  | "repositories_changed";

/**
 * Lifecycle hooks. Every hook returns nothing: the host owns state, so a provider
 * cannot write a table, and a hook that fails cannot leave a half-updated row.
 */
export type InstallationLifecycle = {
  onEvent(event: {
    kind: LifecycleEvent;
    externalAuthorizationId: string;
    ctx: DriverContext;
  }): Promise<void>;
};

/** One page of a provider's resources, with the cursor that continues it. */
export type DiscoveredResource = {
  externalId: string;
  /** Which manifest resource kind this is; the host rejects an undeclared one. */
  resourceKindId: string;
  name: string;
  /** Provider-side parent, for a resource the provider nests (a repository under an org). */
  parentExternalId?: string;
};

/**
 * Discovery is its own paged port rather than a step of connect (section 12.2),
 * because a connection can be re-scanned long after it was made and a scan must be
 * resumable across a restart.
 */
export type ResourceDiscovery = {
  list(input: {
    resourceKindId: string;
    /** Provider-side parent to scope to, when the caller wants one container. */
    parentExternalId?: string;
    /** Provider-side search string; the host never implements search itself. */
    search?: string;
    cursor: string | null;
    ctx: DriverContext;
  }): Promise<
    { resources: readonly DiscoveredResource[]; nextCursor: string | null }
  >;
};

/** A health verdict a person can act on: healthy, or what is wrong. */
export type HealthProbe = {
  check(ctx: DriverContext): Promise<
    | { healthy: true }
    | {
      healthy: false;
      reason: string; /** Retrying may fix it; false means a person must. */
      retryable: boolean;
      retryAfterSeconds?: number;
    }
  >;
};

/** A field a person fills in to connect, described so the UI needs no provider code. */
export type CredentialField = {
  id: string;
  labelKey: string;
  secret: boolean;
  /**
   * The only shapes a credential field may take. A free-form "format" string would
   * push validation into the UI, where two providers would do it two ways.
   */
  format: "text" | "email" | "https-origin";
};

/**
 * A schema whose parsed output is `T`, used where a provider hands the host a
 * response shape to validate rather than parsing it itself.
 */
export type ProviderSchema<T> = z.ZodType<T>;
