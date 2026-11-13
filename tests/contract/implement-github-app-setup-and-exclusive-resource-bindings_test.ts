import { assert, assertEquals, assertThrows } from "@std/assert";
import { createNormalizedCommandMetadata } from "../../packages/contracts/src/http.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  IntegrationsImplementedAction,
  integrationsImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { createIntegrationsActionRegistry } from "../../apps/server/src/modules/integrations/actions.ts";
import {
  buildGitHubAppManifest,
  GITHUB_APP_DEFAULT_EVENTS,
  GitHubAppManifestSchema,
  GitHubInstallationSchema,
  GitHubOAuthTokenSchema,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import { SUPPORTED_EVENTS } from "../../apps/server/src/modules/integrations/intake-events.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { GITHUB_PROVIDER_ID } from "../../apps/server/src/modules/integrations/postgres.ts";
import { AuthAttemptVerifierCipherBindingSchema } from "../../apps/server/src/modules/secrets/crypto.ts";
import { createFakeGitHubApp } from "../helpers/fake-github-app.ts";

const expectedActions = [
  "integrationAppRegistrations.begin",
  "integrationAppRegistrations.get",
  "integrationAppRegistrations.put",
  "integrationAuth.githubManifestCallback",
];
const implementedIntegrationActions = [
  ...expectedActions,
  "integrationAuthAttempts.create",
  "integrationAuthAttempts.get",
  "integrationAuth.githubSetup",
  "integrationAuth.githubCallback",
  "integrationConnections.create",
  "integrationConnections.get",
  "integrationConnections.list",
  "integrationResources.list",
  "integrationConnections.update",
  "integrationConnections.remove",
  "integrationResources.update",
  "integrationConnections.check",
  "integrationDiscoveries.create",
  "integrationInstallations.list",
  "integrationInstallations.get",
  "intake.github",
].sort();

Deno.test("integrations registry implements exactly its listed catalog actions with catalog parity", () => {
  // Registration runs assertRegisteredActions: method, path, schemas, access
  // and organization context must equal the catalog entry.
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  assertEquals(
    registry.list().map(({ name }) => name).sort(),
    implementedIntegrationActions,
  );
  assertEquals(
    [...integrationsImplementedActions].sort(),
    implementedIntegrationActions,
  );
  assertEquals(
    Object.values(IntegrationsImplementedAction).sort(),
    implementedIntegrationActions,
  );
  const begin = registry.get("integrationAppRegistrations.begin");
  const callback = registry.get("integrationAuth.githubManifestCallback");
  assertEquals(begin.policy.sessionOnly, true);
  assertEquals(callback.policy.sessionOnly, true);
  const put = registry.get("integrationAppRegistrations.put");
  assertEquals(put.policy.sessionOnly, true);
  assertEquals(put.explicitIdempotency, "key");
});

Deno.test("catalog declares installation-administrator operations with the design paths", () => {
  const entries = Object.fromEntries(
    catalogActions.filter(({ action }) => expectedActions.includes(action))
      .map((entry) => [entry.action, entry]),
  );
  assertEquals(Object.keys(entries).length, 4);
  const expected = {
    "integrationAppRegistrations.get": [
      "GET",
      "/v1/integration-app-registrations/github",
      "installationSetting:read",
      "read",
    ],
    "integrationAppRegistrations.begin": [
      "POST",
      "/v1/integration-app-registrations/github/manifest",
      "installationSetting:manage",
      "none; each call issues a fresh single-use state that is never replayed",
    ],
    "integrationAppRegistrations.put": [
      "PUT",
      "/v1/integration-app-registrations/github",
      "installationSetting:manage",
      "Idempotency-Key required; If-Match with the current version once a registration exists",
    ],
    "integrationAuth.githubManifestCallback": [
      "GET",
      "/v1/integration-auth/github/manifest-callback",
      "installationSetting:manage",
      "single-use state hash + provider code; no Idempotency-Key",
    ],
  } as const;
  for (
    const [action, [method, path, permission, idempotency]] of Object.entries(
      expected,
    )
  ) {
    const entry = entries[action];
    assertEquals(entry.method, method, action);
    assertEquals(entry.path, path, action);
    assertEquals(entry.permission, permission, action);
    assertEquals(entry.idempotency, idempotency, action);
    assertEquals(entry.access, "Installation administrator", action);
    assertEquals(
      entry.organizationContext,
      "installation_administrator_scope",
      action,
    );
    assertEquals(entry.mcp, null, action);
  }
  assertEquals(
    entries["integrationAuth.githubManifestCallback"].output,
    "AuthRedirect",
  );
  const put = entries["integrationAppRegistrations.put"];
  assertEquals(put.input, "IntegrationAppRegistrationPut");
  assertEquals(put.output, "IntegrationAppRegistration");
  for (
    const code of [
      "MALFORMED_REQUEST",
      "UNPROCESSABLE",
      "PRECONDITION_REQUIRED",
      "PRECONDITION_FAILED",
      "STATE_CONFLICT",
      "DEPENDENCY_UNAVAILABLE",
    ]
  ) assert(put.errors.includes(code), code);
});

Deno.test("put input takes the App id, client id and write-only secrets and nothing else", () => {
  const schema = contractSchemas.IntegrationAppRegistrationPut;
  const full = {
    appId: 123,
    clientId: "Iv23liabc",
    clientSecret: "s",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    webhookSecret: "w",
  };
  assert(schema.safeParse(full).success);
  const { clientSecret: _c, webhookSecret: _w, ...required } = full;
  assert(schema.safeParse(required).success, "secrets are optional");
  for (
    const invalid of [
      { ...full, appId: 0 },
      { ...full, appId: "123" },
      { ...full, clientId: "" },
      { ...full, privateKey: "" },
      { ...full, privateKey: "x".repeat(16_385) },
      { ...full, clientSecret: "" },
      { ...full, slug: "other" },
      { clientId: "Iv23liabc", privateKey: "k" },
    ]
  ) {
    assert(
      !schema.safeParse(invalid).success,
      JSON.stringify(Object.keys(invalid)),
    );
  }
});

Deno.test("put parses If-Match only when sent and still requires an Idempotency-Key", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const action = registry.get("integrationAppRegistrations.put");
  const request = (headers: Record<string, string>) =>
    new Request(
      "https://bakery.example.test/v1/integration-app-registrations/github",
      {
        method: "PUT",
        headers,
      },
    );
  assertEquals(
    createNormalizedCommandMetadata(
      action,
      request({ "Idempotency-Key": "k" }),
      {},
    )
      .expectedVersion,
    undefined,
  );
  assertEquals(
    createNormalizedCommandMetadata(
      action,
      request({ "Idempotency-Key": "k", "If-Match": '"v3"' }),
      {},
    ).expectedVersion,
    3,
  );
  assertThrows(() => createNormalizedCommandMetadata(action, request({}), {}));
});

Deno.test("begin input accepts the optional choices and rejects unsafe values", () => {
  const schema = contractSchemas.IntegrationAppRegistrationBegin;
  for (
    const valid of [
      {},
      { name: "Bakery" },
      { public: true },
      { organizationLogin: "acme-org" },
      { name: "x".repeat(34), public: false, organizationLogin: "a" },
    ]
  ) assert(schema.safeParse(valid).success, JSON.stringify(valid));
  for (
    const invalid of [
      { name: "" },
      { name: "x".repeat(35) },
      { public: "true" },
      { organizationLogin: "a/b" },
      { organizationLogin: "trailing-" },
      { organizationLogin: "x".repeat(40) },
      { extra: 1 },
    ]
  ) assert(!schema.safeParse(invalid).success, JSON.stringify(invalid));
});

Deno.test("callback input requires code and state and nothing else", () => {
  const schema = contractSchemas.GitHubManifestCallback;
  assert(schema.safeParse({ code: "abc", state: "def" }).success);
  for (
    const invalid of [
      {},
      { code: "abc" },
      { state: "def" },
      { code: "", state: "def" },
      { code: "abc", state: "def", installation_id: "1" },
      { code: "x".repeat(4097), state: "def" },
    ]
  ) assert(!schema.safeParse(invalid).success, JSON.stringify(invalid));
});

Deno.test("outputs carry configured flags, never secret material", () => {
  const registration = contractSchemas.IntegrationAppRegistration;
  const fields = Object.keys(
    (registration as unknown as { shape: Record<string, unknown> }).shape,
  );
  for (const field of fields) {
    assert(
      !/secret(?!Configured|Revision)|privateKey(?!Configured|Revision)|pem|ciphertext|nonce|keyId/i
        .test(field),
      field,
    );
  }
  assert(
    registration.safeParse({
      provider: "github",
      status: "registered",
      appId: 1,
      slug: "bakery",
      name: "Bakery",
      clientId: "Iv1.abc",
      ownerLogin: "acme",
      ownerId: 2,
      ownerType: "Organization",
      htmlUrl: "https://github.com/apps/bakery",
      permissions: { checks: "write" },
      events: [],
      clientSecretConfigured: true,
      privateKeyConfigured: true,
      webhookSecretConfigured: false,
      clientSecretRevision: 2,
      privateKeyRevision: 1,
      webhookSecretRevision: null,
      registeredByPrincipalId: crypto.randomUUID(),
      registeredAt: new Date().toISOString(),
      version: 1,
    }).success,
  );
  assert(
    !registration.safeParse({
      provider: "github",
      status: "registered",
      clientSecret: "leak",
    }).success,
  );
  assert(
    contractSchemas.IntegrationAppManifestStart.safeParse({
      provider: "github",
      registrationUrl: "https://github.com/settings/apps/new?state=abc",
      manifest: "{}",
      state: "abc",
      expiresAt: new Date().toISOString(),
    }).success,
  );
  assert(
    contractSchemas.AuthRedirect.safeParse({
      status: "303",
      location:
        "/settings/installation/integrations?githubAppRegistration=registered",
    }).success,
  );
});

Deno.test("the built manifest satisfies the described manifest schema", () => {
  const manifest = buildGitHubAppManifest("https://bakery.example.test/");
  assertEquals(GitHubAppManifestSchema.parse(manifest), manifest);
  assertEquals(manifest.hook_attributes.active, true);
  assertEquals(manifest.default_events, [...GITHUB_APP_DEFAULT_EVENTS]);
});

Deno.test("the manifest schema allows exactly the five subscribed events and an active hook", () => {
  const manifest = buildGitHubAppManifest("https://bakery.example.test/");
  assertEquals(manifest.default_events, [
    "issues",
    "pull_request",
    "check_run",
    "check_suite",
    "repository",
  ]);
  const refused = (change: Record<string, unknown>) =>
    GitHubAppManifestSchema.safeParse({ ...manifest, ...change }).success;
  assertEquals(refused({}), true);
  assertEquals(refused({ default_events: [] }), false, "no event");
  assertEquals(
    refused({ default_events: manifest.default_events.slice(1) }),
    false,
    "one event missing",
  );
  assertEquals(
    refused({ default_events: [...manifest.default_events, "push"] }),
    false,
    "an event the receiver does not read",
  );
  assertEquals(
    refused({
      default_events: [
        "issues",
        "issues",
        "check_run",
        "check_suite",
        "repository",
      ],
    }),
    false,
    "five entries with one repeated",
  );
  // Six entries that hold all five events and one repeat: the set is right and
  // only the exact length rules them out, whichever event repeats and wherever
  // the repeat sits.
  for (const repeated of manifest.default_events) {
    const sixAtEnd = [...manifest.default_events, repeated];
    assertEquals(sixAtEnd.length, 6);
    assertEquals(new Set(sixAtEnd).size, 5);
    assertEquals(
      refused({ default_events: sixAtEnd }),
      false,
      `six entries, ${repeated} repeated at the end`,
    );
    assertEquals(
      refused({ default_events: [repeated, ...manifest.default_events] }),
      false,
      `six entries, ${repeated} repeated at the start`,
    );
  }
  assertEquals(
    refused({
      default_events: [...manifest.default_events.slice(1), "ping"],
    }),
    false,
    "one event replaced by another the receiver reads",
  );
  assertEquals(
    refused({
      hook_attributes: { ...manifest.hook_attributes, active: false },
    }),
    false,
    "an inactive hook",
  );
  // Installation events reach a GitHub App without a subscription, and every
  // event the manifest subscribes to is one the receiver reads.
  for (const event of GITHUB_APP_DEFAULT_EVENTS) {
    assert(
      (SUPPORTED_EVENTS as readonly string[]).includes(event),
      `${event} is a supported receiver event`,
    );
  }
  assertEquals(
    GITHUB_APP_DEFAULT_EVENTS.some((event) => event.startsWith("installation")),
    false,
  );
});

Deno.test("generated JSON schemas describe every new field", async () => {
  const generated = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/contracts/generated/contracts.json",
        import.meta.url,
      ),
    ),
  ) as { schemas: Record<string, Record<string, unknown>> };
  const defects: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      ("type" in record || "oneOf" in record || "anyOf" in record ||
        "const" in record) &&
      descriptionDefectKind(record.description, path) !== undefined
    ) defects.push(path);
    for (const [key, child] of Object.entries(record)) {
      if (key === "required" || key === "enum") continue;
      walk(child, `${path}.${key}`);
    }
  };
  for (
    const name of [
      "IntegrationAppRegistrationBegin",
      "IntegrationAppRegistrationPut",
      "GitHubManifestCallback",
      "IntegrationAppRegistration",
      "IntegrationAppManifestStart",
      "AuthRedirect",
    ]
  ) {
    assert(generated.schemas[name], name);
    walk(generated.schemas[name], name);
  }
  assertEquals(defects, []);
});

Deno.test("auth attempt operations match the catalog and create needs a browser session", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const create = registry.get("integrationAuthAttempts.create");
  const get = registry.get("integrationAuthAttempts.get");
  assertEquals(create.policy.sessionOnly, true);
  assertEquals(create.policy.access, "Admin");
  assertEquals(get.policy.access, "Initiating principal or Admin");
  const entries = Object.fromEntries(
    catalogActions.filter(({ action }) =>
      action.startsWith("integrationAuthAttempts.")
    ).map((entry) => [entry.action, entry]),
  );
  assertEquals(entries["integrationAuthAttempts.create"].method, "POST");
  assertEquals(
    entries["integrationAuthAttempts.create"].path,
    "/v1/integration-auth-attempts",
  );
  assertEquals(
    entries["integrationAuthAttempts.create"].idempotency,
    "Idempotency-Key required",
  );
  for (
    const code of [
      "STATE_CONFLICT",
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "PRECONDITION_REQUIRED",
      "AUTH_INVALID",
    ]
  ) {
    assert(
      (entries["integrationAuthAttempts.create"].errors as string[]).includes(
        code,
      ),
      code,
    );
  }
  assertEquals(
    entries["integrationAuthAttempts.get"].path,
    "/v1/integration-auth-attempts/{id}",
  );
});

Deno.test("auth attempt create input names the provider and nothing a caller could forge", () => {
  const schema = contractSchemas.IntegrationAuthAttemptCreate;
  for (
    const valid of [
      { provider: "github" },
      { provider: "github", returnPath: "/settings" },
      { provider: "github", reconnectConnectionId: crypto.randomUUID() },
    ]
  ) assert(schema.safeParse(valid).success, JSON.stringify(valid));
  for (
    const invalid of [
      {},
      { providerId: crypto.randomUUID() },
      { provider: "gitlab" },
      { provider: "github", returnPath: "/" + "x".repeat(500) },
      { provider: "github", organizationId: crypto.randomUUID() },
      { provider: "github", state: "x" },
    ]
  ) assert(!schema.safeParse(invalid).success, JSON.stringify(invalid));
});

Deno.test("auth attempt outputs never carry state, verifier or code material", () => {
  for (
    const name of [
      "IntegrationAuthAttempt",
      "IntegrationAuthAttemptCreated",
    ] as const
  ) {
    const fields = Object.keys(
      (contractSchemas[name] as unknown as { shape: Record<string, unknown> })
        .shape,
    );
    for (const field of fields) {
      assert(
        !/state|verifier|challenge|^code$|oauth|hash|cipher|nonce|keyId|secret|token/i
          .test(field),
        `${name}.${field}`,
      );
    }
  }
  assertEquals(
    Object.keys(
      (contractSchemas.IntegrationAuthAttemptCreated as unknown as {
        shape: Record<string, unknown>;
      }).shape,
    ).sort(),
    ["authorizationUrl", "expiresAt", "id", "installationUrl"],
  );
});

Deno.test("auth attempt schemas and the verifier binding carry meaningful descriptions", () => {
  for (
    const [name, schema] of [
      [
        "IntegrationAuthAttemptCreate",
        contractSchemas.IntegrationAuthAttemptCreate,
      ],
      ["IntegrationAuthAttempt", contractSchemas.IntegrationAuthAttempt],
      [
        "IntegrationAuthAttemptCreated",
        contractSchemas.IntegrationAuthAttemptCreated,
      ],
      [
        "AuthAttemptVerifierCipherBinding",
        AuthAttemptVerifierCipherBindingSchema,
      ],
    ] as const
  ) {
    assertEquals(
      descriptionDefectKind(schema.description, name),
      undefined,
      name,
    );
    const shape = (schema as unknown as {
      shape: Record<string, { description?: string }>;
    }).shape;
    for (const [field, child] of Object.entries(shape)) {
      assertEquals(
        descriptionDefectKind(child.description, `${name}.${field}`),
        undefined,
        `${name}.${field}`,
      );
    }
  }
});

Deno.test("GitHub callbacks are bound-attempt browser redirects and the connection read is a Developer query", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const entries = Object.fromEntries(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  for (
    const [name, path, input] of [
      [
        "integrationAuth.githubSetup",
        "/v1/integration-auth/github/setup",
        "GitHubSetupCallback",
      ],
      [
        "integrationAuth.githubCallback",
        "/v1/integration-auth/github/callback",
        "OAuthCallback",
      ],
    ] as const
  ) {
    const action = registry.get(name);
    assertEquals(action.policy.access, "Bound browser auth attempt");
    assertEquals(
      action.policy.organizationContext,
      "derived_bound_auth_attempt",
    );
    assertEquals(action.policy.sessionOnly, true);
    assertEquals(entries[name].method, "GET");
    assertEquals(entries[name].path, path);
    assertEquals(entries[name].input, input);
    assertEquals(entries[name].output, "AuthRedirect");
    assertEquals(entries[name].mcp, null);
    assertEquals(entries[name].event, "integration.auth_attempt_changed");
    for (
      const code of [
        "AUTH_REQUIRED",
        "AUTH_INVALID",
        "AUTH_EXPIRED",
        "SESSION_REQUIRED",
        "MALFORMED_REQUEST",
      ]
    ) assert((entries[name].errors as string[]).includes(code), code);
  }
  const get = registry.get("integrationConnections.get");
  assertEquals(get.policy.access, "Developer");
  assertEquals(
    get.policy.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(
    entries["integrationConnections.get"].permission,
    "integrationConnection:read",
  );
  for (
    const code of ["AUTH_REQUIRED", "AUTH_INVALID", "RESOURCE_NOT_FOUND"]
  ) {
    assert(
      (entries["integrationConnections.get"].errors as string[]).includes(code),
      code,
    );
  }
});

Deno.test("callback inputs carry only the provider's redirect fields", () => {
  const setup = contractSchemas.GitHubSetupCallback;
  assert(
    setup.safeParse({ state: "s", installationId: "1", setupAction: "install" })
      .success,
  );
  assert(setup.safeParse({ state: "s" }).success);
  for (
    const invalid of [
      {},
      { state: "s", setupAction: "request" },
      { state: "s", organizationId: crypto.randomUUID() },
      { state: "s", connectionId: crypto.randomUUID() },
    ]
  ) assert(!setup.safeParse(invalid).success, JSON.stringify(invalid));
  const oauth = contractSchemas.OAuthCallback;
  assert(oauth.safeParse({ state: "s", code: "c" }).success);
  assert(oauth.safeParse({ state: "s", error: "access_denied" }).success);
  for (
    const invalid of [
      { code: "c" },
      { state: "s", code: "c", installationId: "1" },
      { state: "s", code: "c", organizationId: crypto.randomUUID() },
    ]
  ) assert(!oauth.safeParse(invalid).success, JSON.stringify(invalid));
});

Deno.test("the connection projection names the provider, includes pending and carries no credential", () => {
  const schema = contractSchemas.IntegrationConnection as unknown as {
    shape: Record<string, unknown>;
  };
  assertEquals(Object.keys(schema.shape).sort(), [
    "config",
    "createdAt",
    "createdBy",
    "externalAccountId",
    "grantedScopes",
    "id",
    "label",
    "lastCheckedAt",
    "provider",
    "secretId",
    "status",
    "updatedAt",
    "version",
  ]);
  const base = {
    id: crypto.randomUUID(),
    provider: "github",
    label: "acme",
    externalAccountId: "4242",
    config: {},
    secretId: null,
    grantedScopes: { metadata: "read" },
    lastCheckedAt: null,
    createdAt: "2026-10-26T12:00:00.000000Z",
    createdBy: crypto.randomUUID(),
    updatedAt: "2026-10-26T12:00:00.000000Z",
    version: 1,
  };
  for (
    const status of ["pending", "enabled", "disabled", "degraded", "revoked"]
  ) {
    assert(
      contractSchemas.IntegrationConnection.safeParse({ ...base, status })
        .success,
      status,
    );
  }
  for (
    const invalid of [
      { ...base, status: "unknown" },
      { ...base, status: "pending", provider: "gitlab" },
      { ...base, status: "pending", providerId: crypto.randomUUID() },
    ]
  ) {
    assert(
      !contractSchemas.IntegrationConnection.safeParse(invalid).success,
      JSON.stringify(invalid),
    );
  }
  for (const field of Object.keys(schema.shape)) {
    assert(!/token|secretValue|cipher|nonce|code|state/i.test(field), field);
  }
  const redirect = contractSchemas.AuthRedirect as unknown as {
    shape: Record<string, unknown>;
  };
  assertEquals(Object.keys(redirect.shape).sort(), ["location", "status"]);
});

Deno.test("GitHub provider schemas drop every field Bakery does not store", () => {
  const token = GitHubOAuthTokenSchema.parse({
    access_token: "ghu_x",
    refresh_token: "ghr_x",
    expires_in: 28800,
    token_type: "bearer",
  });
  assertEquals(Object.keys(token), ["access_token"]);
  const installation = GitHubInstallationSchema.parse({
    id: 1,
    app_id: 2,
    account: { id: 3, login: "acme", type: "Organization", node_id: "x" },
    repository_selection: "selected",
    permissions: { metadata: "read" },
    suspended_at: null,
    access_tokens_url:
      "https://api.github.com/app/installations/1/access_tokens",
  });
  assertEquals(installation, {
    id: 1,
    appId: 2,
    account: { id: 3, login: "acme", type: "Organization" },
    repositorySelection: "selected",
    permissions: { metadata: "read" },
    suspended: false,
  });
  const enterprise = GitHubInstallationSchema.parse({
    id: 1,
    app_id: 2,
    account: { id: 3, slug: "acme-enterprise", type: "Enterprise" },
    repository_selection: "all",
    permissions: {},
  });
  assertEquals(enterprise.account.login, "acme-enterprise");
  for (
    const [name, schema] of [
      ["GitHubOAuthToken", GitHubOAuthTokenSchema],
      ["GitHubInstallation", GitHubInstallationSchema],
    ] as const
  ) {
    assertEquals(
      descriptionDefectKind(schema.description, name),
      undefined,
      name,
    );
  }
});

Deno.test("connection and resource lists are Developer cursor queries with the catalog's page shapes", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const entries = Object.fromEntries(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  for (
    const [name, path, input, output] of [
      [
        "integrationConnections.list",
        "/v1/integration-connections",
        "CursorQuery",
        "Page<IntegrationConnection>",
      ],
      [
        "integrationResources.list",
        "/v1/integration-connections/{id}/resources",
        "IntegrationResourceQuery",
        "Page<IntegrationResource>",
      ],
    ] as const
  ) {
    const action = registry.get(name);
    assertEquals(action.policy.type, "query");
    assertEquals(action.policy.access, "Developer");
    assertEquals(
      action.policy.organizationContext,
      "required_authenticated_context",
    );
    assertEquals(action.input, contractSchemas[input]);
    assertEquals(action.output, contractSchemas[output]);
    assertEquals(entries[name].method, "GET");
    assertEquals(entries[name].path, path);
    assertEquals(entries[name].input, input);
    assertEquals(entries[name].output, output);
    assertEquals(entries[name].idempotency, "read");
    for (
      const code of [
        "AUTH_REQUIRED",
        "AUTH_FORBIDDEN",
        // A non-member organization, or another organization's connection.
        "RESOURCE_NOT_FOUND",
        "INVALID_CURSOR",
        "MALFORMED_REQUEST",
      ]
    ) {
      assert(entries[name].errors.includes(code), `${name} ${code}`);
    }
  }
  // A resources page parses only with the resource projection's fields.
  const page = contractSchemas["Page<IntegrationResource>"].safeParse({
    items: [{
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      externalId: "123456",
      kind: "repository",
      displayName: "bakery-org/repo",
      safeUrl: "https://github.com/bakery-org/repo",
      selected: false,
      available: true,
      enabled: false,
      capabilitySnapshot: { private: true, archived: false },
      lastDiscoveryGeneration: 1,
      archivedAt: null,
      createdAt: "2026-10-27T12:00:00.000000Z",
      updatedAt: "2026-10-27T12:00:00.000000Z",
      version: 1,
    }],
    nextCursor: null,
  });
  assert(page.success, JSON.stringify(page.error?.issues));
});

Deno.test("integrationConnections.create is an Admin command that names its GitHub refusal", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const entry = catalogActions.find((item) =>
    item.action === "integrationConnections.create"
  )!;
  const action = registry.get("integrationConnections.create");
  assertEquals(action.policy.type, "command");
  assertEquals(action.policy.access, "Admin");
  assertEquals(
    action.policy.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(action.explicitIdempotency, "key");
  assertEquals(action.input, contractSchemas.IntegrationConnectionCreate);
  assertEquals(entry.method, "POST");
  assertEquals(entry.path, "/v1/integration-connections");
  assertEquals(entry.permission, "integrationConnection:manage");
  for (
    const code of [
      "AUTH_REQUIRED",
      "AUTH_FORBIDDEN",
      // GitHub binds only through a completed auth attempt.
      "STATE_CONFLICT",
      // Any provider id other than the bundled GitHub entry.
      "RESOURCE_NOT_FOUND",
      "PRECONDITION_REQUIRED",
    ]
  ) assert(entry.errors.includes(code), code);
  // The GitHub provider id parses; a top-level installation id never does.
  const body = { providerId: GITHUB_PROVIDER_ID, name: "GitHub", settings: {} };
  assert(contractSchemas.IntegrationConnectionCreate.safeParse(body).success);
  assert(
    !contractSchemas.IntegrationConnectionCreate.safeParse({
      ...body,
      installationId: "12345",
    }).success,
  );
});

Deno.test("connection and resource edits are Admin PATCH commands needing Idempotency-Key and If-Match", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const entries = Object.fromEntries(
    catalogActions.map((entry) => [entry.action, entry]),
  );
  for (
    const [name, path, input, output, event] of [
      [
        "integrationConnections.update",
        "/v1/integration-connections/{id}",
        "IntegrationConnectionUpdate",
        "IntegrationConnection",
        "integrationConnections.updated",
      ],
      [
        "integrationResources.update",
        "/v1/integration-connections/{id}/resources/{resourceId}",
        "IntegrationResourceUpdate",
        "IntegrationResource",
        "integration.resources_changed",
      ],
    ] as const
  ) {
    const action = registry.get(name);
    assertEquals(action.method, "PATCH");
    assertEquals(action.policy.type, "command");
    assertEquals(action.policy.access, "Admin");
    assertEquals(
      action.policy.organizationContext,
      "required_authenticated_context",
    );
    assertEquals(action.explicitIdempotency, "key-and-if-match");
    assertEquals(action.input, contractSchemas[input]);
    assertEquals(action.output, contractSchemas[output]);
    const entry = entries[name];
    assertEquals(entry.method, "PATCH");
    assertEquals(entry.path, path);
    assertEquals(entry.access, "Admin");
    assertEquals(entry.input, input);
    assertEquals(entry.output, output);
    assertEquals(entry.event, event);
    assertEquals(entry.organizationContext, "required_authenticated_context");
    for (
      const code of [
        "AUTH_REQUIRED",
        "AUTH_FORBIDDEN",
        "RESOURCE_NOT_FOUND",
        "MALFORMED_REQUEST",
        "UNPROCESSABLE",
        "STATE_CONFLICT",
        "PRECONDITION_REQUIRED",
        "PRECONDITION_FAILED",
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      ]
    ) {
      assert(entry.errors.includes(code), `${name} ${code}`);
    }
  }
  // The live recheck can fail at GitHub; enabling never asks GitHub.
  assert(
    entries["integrationResources.update"].errors.includes(
      "DEPENDENCY_UNAVAILABLE",
    ),
  );
  // Each edit schema accepts its fields and refuses unknown ones.
  const connection = contractSchemas.IntegrationConnectionUpdate;
  assert(connection.safeParse({ name: "Team", enabled: true }).success);
  assert(!connection.safeParse({ status: "enabled" }).success);
  assert(!connection.safeParse({ name: "x".repeat(201) }).success);
  const resource = contractSchemas.IntegrationResourceUpdate;
  assert(resource.safeParse({ selected: true }).success);
  assert(!resource.safeParse({ externalId: "1" }).success);
  assert(!resource.safeParse({ selected: "yes" }).success);
});

Deno.test("integrationConnections.check is an Admin POST command needing only Idempotency-Key and answering 200 ConnectionCheck", () => {
  const registry = createIntegrationsActionRegistry({} as PgDatabase, {
    publicBaseUrl: "https://bakery.example.test",
    github: createFakeGitHubApp().client,
    cursorSecret: "contract-test-cursor-secret-0123456789abcdef",
  });
  const action = registry.get("integrationConnections.check");
  assertEquals(action.method, "POST");
  assertEquals(action.path, "/v1/integration-connections/:id/checks");
  assertEquals(action.policy.type, "command");
  assertEquals(action.policy.access, "Admin");
  assertEquals(
    action.policy.organizationContext,
    "required_authenticated_context",
  );
  assertEquals(action.explicitIdempotency, "key");
  assertEquals(action.successStatus, 200);
  assertEquals(action.input, contractSchemas.Empty);
  assertEquals(action.output, contractSchemas.ConnectionCheck);
  const entry = catalogActions.find((candidate) =>
    candidate.action === "integrationConnections.check"
  )!;
  assertEquals(entry.method, "POST");
  assertEquals(entry.path, "/v1/integration-connections/{id}/checks");
  assertEquals(entry.access, "Admin");
  assertEquals(entry.input, "Empty");
  assertEquals(entry.output, "ConnectionCheck");
  assertEquals(entry.event, "integration.health_changed");
  for (
    const code of [
      "AUTH_REQUIRED",
      "AUTH_FORBIDDEN",
      "RESOURCE_NOT_FOUND",
      "STATE_CONFLICT",
      "PRECONDITION_REQUIRED",
      "PRECONDITION_FAILED",
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
      "DEPENDENCY_UNAVAILABLE",
      // A provider rate limit and a provider timeout.
      "PROVIDER_QUOTA_EXCEEDED",
      "DEPENDENCY_TIMEOUT",
    ]
  ) {
    assert(entry.errors.includes(code), code);
  }
  // The output carries no token field and refuses unknown ones.
  const check = contractSchemas.ConnectionCheck;
  const valid = {
    healthy: true,
    checkedAt: "2026-10-27T12:00:00.000Z",
    capabilities: ["metadata:read"],
    fault: null,
  };
  assert(check.safeParse(valid).success);
  assert(!check.safeParse({ ...valid, token: "ghs_x" }).success);
  // Health is optional (additive) and limited to the four health values.
  for (const health of ["unknown", "healthy", "degraded", "auth_required"]) {
    assert(check.safeParse({ ...valid, health }).success, health);
  }
  assert(!check.safeParse({ ...valid, health: "enabled" }).success);
  assert(
    !check.safeParse({ ...valid, capabilities: Array(101).fill("a:read") })
      .success,
  );
});
