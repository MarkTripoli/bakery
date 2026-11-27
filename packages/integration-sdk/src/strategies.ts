import type {
  AuthorizationOutcome,
  CredentialField,
  DriverContext,
  InstallationOrigin,
  LifecycleEvent,
  ProviderRequestPort,
  SecretSlots,
  VerifiedAuthorization,
} from "./ports.ts";

/**
 * The provider-authored strategies (chapter 09 section 12.2).
 *
 * Each strategy exists because the host cannot own that step: completing a GitHub
 * App installation needs the provider's own protocol, while OAuth2 and API tokens
 * are run once in core and only parameterised here. Keeping the split explicit is
 * what stops "one more provider-specific hook" from becoming the seam it used to
 * be.
 *
 * Every method returns a value rather than writing anything. A provider cannot
 * reach a database, so strategy code is testable with a fake `DriverContext` and
 * the host keeps every write.
 */

/**
 * `connect.kind: "github-app"` - the only provider-authored connect code.
 *
 * The host re-checks the URLs `begin` returns against the installation origin's
 * allowlist, so a strategy that returned an arbitrary host would be caught rather
 * than followed.
 */
export type ConnectStrategy = {
  /** Where to send the person, and the state the host must match on return. */
  begin(input: {
    /** Opaque value the host generated and will verify; the strategy only passes it on. */
    state: string;
    /** PKCE challenge the host generated, for providers that require one. */
    pkceChallenge: string;
    /** Absolute URL the provider must call back, already allowlisted by the host. */
    callbackUrl: URL;
    /** Whether this replaces an existing connection rather than creating one. */
    reconnect: boolean;
  }): { steps: URL[] };
  /**
   * Turn the provider's callback into a proven authorization.
   *
   * `input` is whatever the provider sent back, unvalidated by the host because
   * only the strategy knows its shape. No database access: the host writes.
   */
  complete(
    input: unknown,
    ctx: DriverContext & { secrets: SecretSlots },
  ): Promise<AuthorizationOutcome>;
};

/**
 * `connect.kind: "oauth2"` - one audited flow in core, parameterised per provider.
 *
 * This is a profile, not code: the host runs PKCE, state and refresh itself so
 * there is exactly one place those can be wrong.
 */
export type OAuth2Profile = {
  authorizeUrl: URL;
  tokenUrl: URL;
  scopes: readonly string[];
  scopeDelimiter: " " | ",";
  apiBaseUrl: URL;
  webBaseUrl: URL;
  /** Validates the token endpoint's response, because its shape is the provider's. */
  tokenResponse: unknown;
  /** Reads the connected account out of the provider's API. */
  identify(ctx: DriverContext): Promise<
    { externalAccountId: string; accountLabel: string }
  >;
  connectedResource?(input: ConnectedResourceInput): ConnectedResource;
  refusal?(tokenResponse: unknown): ConnectRefusal | null;
};

export type ConnectRefusal = "enterprise_install";

export type ConnectedResourceInput = Readonly<{
  tokenResponse: unknown;
  externalAccountId: string;
  accountLabel: string;
}>;

export type ConnectedResourceGrant = Readonly<{
  capability: string;
  actionVersion: number;
}>;

export type SignedEventSource = Readonly<{
  appId: string;
  workspaceId: string;
  enterpriseId?: string;
  botUserId: string;
}>;

export type ConnectedResource = Readonly<{
  kind: string;
  externalId: string;
  displayName: string;
  binding: Readonly<Record<string, string>>;
  servicePrincipalName: string;
  servicePurpose: string;
  serviceGrants: readonly ConnectedResourceGrant[];
  signedEventSource?: SignedEventSource;
}>;

/**
 * `connect.kind: "api-token"` - core stores and encrypts; the provider only proves it.
 *
 * `probe` is the whole surface on purpose: a provider that could store its own
 * token would need its own encryption, rotation and audit.
 */
export type ApiTokenProbe = {
  probe(
    token: string,
    ctx: DriverContext,
  ): Promise<AuthorizationOutcome>;
};

/**
 * How a provider turns its secrets into a request credential.
 *
 * `secretSlots` names what the host must decrypt before calling `mint`, so the
 * host can refuse a strategy that asks for a slot the installation does not have
 * rather than handing it an empty record.
 */
export type CredentialStrategy = {
  secretSlots: readonly string[];
  mint(input: {
    /** The stored binding, opaque to the host, as the provider wrote it. */
    binding: unknown;
    /** The provider permissions the host is brokering for. */
    permissions: Readonly<Record<string, string>>;
    secrets: SecretSlots;
    ctx: DriverContext;
  }): Promise<{
    token: string;
    expiresAt: Date | null;
    /**
     * Where the credential goes on the wire. Closed, because each placement is a
     * different header and the host owns the request.
     */
    placement: "bearer" | "basic" | "raw-authorization";
  }>;
};

/** One thing a delivery asks the host to do, after the provider classified it. */
export type IntakeIntent =
  | { kind: "lifecycle"; event: LifecycleEvent }
  | { kind: "discovery" }
  | {
    kind: "refresh";
    /** Which engine subject the delivery is about. */
    subject: "ticket" | "change" | "check";
    resourceExternalId: string;
    subjectExternalId: string;
  };

/**
 * Webhook ingress (chapter 09 section 12.2).
 *
 * Core reads the body first, bounded, and passes bytes: the provider never sees an
 * unbounded stream, so a hostile payload cannot exhaust memory before signature
 * verification.
 */
export type WebhookIngress = {
  /** Hard ceiling the provider declares; the host enforces the smaller of this and its own. */
  maxBodyBytes: number;
  verify(input: {
    body: Uint8Array;
    headers: Headers;
    /** Candidate secrets, so a rotation window can accept the old one briefly. */
    secrets: readonly Uint8Array[];
    now: Date;
    /**
     * Whether `secret` signs `body` to `signature`, compared in constant time.
     *
     * Supplied by the host because HMAC is cryptography, and the rule that keeps
     * providers from implementing any is the same rule that keeps the arithmetic in
     * a maintained library: `node:crypto` is banned in a provider package (rail
     * B1f), and a hand-written SHA-256 here would be a second implementation of a
     * primitive to get right. It stays synchronous on purpose - the body must not
     * be held open across an `await` between the signature check and the parse -
     * which Web Crypto cannot offer and `createHmac` can.
     *
     * Optional so a provider that does not sign ignores it, and absent means "the
     * host supplied no verifier": a provider must then refuse rather than accept,
     * because an unverifiable delivery is indistinguishable from a forged one.
     */
    signatureMatches?: (input: {
      secret: Uint8Array;
      body: Uint8Array;
      signature: Uint8Array;
    }) => boolean;
  }):
    | {
      ok: true;
      delivery: unknown;
      /**
       * The provider's own id for this delivery, when it sends one. It is the
       * key the host's receipt deduplicates on, so a redelivered id is
       * acknowledged rather than applied twice.
       *
       * It is not a freshness signal: a provider can replay an old delivery
       * under its original id, which is exactly the case the receipt refuses.
       * A provider that sends no id omits this, and the host falls back to the
       * body digest.
       */
      deliveryId?: string;
    }
    | { ok: false; reason: "signature" | "stale" | "malformed" };
  classify(delivery: unknown):
    | { kind: "ignored" }
    | { kind: "challenge"; response: unknown }
    | {
      kind: "routed";
      externalAuthorizationId: string;
      projection: unknown;
      intents: readonly IntakeIntent[];
    };
  /**
   * Subscriptions the provider must keep alive (Jira expiry, GitLab hook
   * registration). Optional because most providers need nothing here.
   */
  ensureSubscriptions?(ctx: DriverContext): Promise<void>;
};

/**
 * The transport a provider is given, restated here so a strategy signature reads
 * without importing the ports module.
 */
export type { ProviderRequestPort };

/** Where a completed connection points, as the provider reported it. */
export type { InstallationOrigin, VerifiedAuthorization };

/** A field a connect form renders, declared as data. */
export type { CredentialField };
