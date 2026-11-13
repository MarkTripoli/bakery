import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  decryptAuthAttemptVerifier,
  decryptInstallationSecret,
  decryptSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import { pkceChallenge } from "../../apps/server/src/modules/integrations/auth-attempts.ts";
import { GITHUB_PROVIDER_ID } from "../../apps/server/src/modules/integrations/postgres.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { call, signIn } from "../helpers/installation-settings.ts";
import {
  type FakeInstallation,
  fakeRepositories,
} from "../helpers/fake-github-app.ts";
import {
  MAX_DISCOVERY_PAGES,
  MAX_REPOSITORY_PAGES,
} from "../../apps/server/src/modules/integrations/callbacks.ts";
import {
  type AttemptRow,
  attemptRows,
  begin,
  callback,
  completeFlow,
  connectionFlow,
  connectionRows,
  connectionSnapshot,
  connectionsPath,
  connectionText,
  connectionVersion,
  count,
  createAttempt,
  createdAttempt,
  type GitHubAppFixture,
  githubCallback,
  githubSetup,
  installationRows,
  openGitHubAppFixture,
  patchConnection,
  patchResource,
  pendingConnection,
  postConnection,
  readAttempt,
  readConnection,
  readRegistration,
  registerApp,
  registrationFacts,
  resourceRows,
  secondOrganization,
  settingsLocation,
  started,
  versionTag,
} from "../helpers/github-app-registration.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

Deno.test("begin returns a manifest built from the public base URL, the GitHub registration URL and a one-hour state", async () => {
  await withFixture(async (f) => {
    const before = Date.now();
    const start = await started(f);
    assertEquals(start.provider, "github");
    assertEquals(
      start.registrationUrl,
      `https://github.com/settings/apps/new?state=${start.state}`,
    );
    assert(/^[A-Za-z0-9_-]{43}$/.test(start.state), "32 random bytes");
    const ttl = Date.parse(start.expiresAt) - before;
    assert(ttl > 3_590_000 && ttl <= 3_610_000, `expiry ${ttl}ms`);
    assertEquals(JSON.parse(start.manifest), {
      name: "Bakery",
      url: authTestOrigin,
      hook_attributes: {
        url: `${authTestOrigin}/v1/webhooks/github`,
        active: true,
      },
      redirect_url:
        `${authTestOrigin}/v1/integration-auth/github/manifest-callback`,
      callback_urls: [`${authTestOrigin}/v1/integration-auth/github/callback`],
      setup_url: `${authTestOrigin}/v1/integration-auth/github/setup`,
      setup_on_update: true,
      public: false,
      default_permissions: {
        metadata: "read",
        issues: "write",
        contents: "write",
        pull_requests: "write",
        checks: "write",
      },
      default_events: [
        "issues",
        "pull_request",
        "check_run",
        "check_suite",
        "repository",
      ],
    });

    const custom = await started(f, f.adminCookie, {
      name: "Acme Bakery",
      public: true,
      organizationLogin: "acme-org",
    });
    assertEquals(
      custom.registrationUrl,
      `https://github.com/organizations/acme-org/settings/apps/new?state=${custom.state}`,
    );
    assertEquals(JSON.parse(custom.manifest).name, "Acme Bakery");
    assertEquals(JSON.parse(custom.manifest).public, true);
    assertNotEquals(custom.state, start.state);

    // Only the hash of each state is stored, bound to principal and session.
    const rows = await f.pgDatabase.query<{
      state_hash: string;
      initiating_principal_id: string;
      session_id: string;
      organization_login: string | null;
      consumed_at: Date | null;
    }>(
      `select state_hash, initiating_principal_id, session_id,
         organization_login, consumed_at
       from bakery.integration_app_registration_attempts order by created_at`,
    );
    assertEquals(rows.rows.length, 2);
    assertEquals(rows.rows[0].state_hash, await sha256Hex(start.state));
    assertEquals(rows.rows[1].state_hash, await sha256Hex(custom.state));
    assertEquals(rows.rows[1].organization_login, "acme-org");
    for (const row of rows.rows) {
      assertEquals(row.initiating_principal_id, f.adminId);
      assert(row.session_id.length > 0);
      assertEquals(row.consumed_at, null);
    }
    const stored = JSON.stringify(rows.rows);
    assert(!stored.includes(start.state) && !stored.includes(custom.state));
    assertEquals(f.github.calls.length, 0, "begin never calls GitHub");
  });
});

Deno.test("begin rejects names and organization logins GitHub would refuse", async () => {
  await withFixture(async (f) => {
    for (
      const body of [
        { name: "" },
        { name: "x".repeat(35) },
        { organizationLogin: "../evil" },
        { organizationLogin: "-lead" },
        { public: "yes" },
        { unexpected: true },
      ]
    ) {
      const response = await begin(f, f.adminCookie, body);
      assert(
        response.status === 400 || response.status === 422,
        `${JSON.stringify(body)} -> ${response.status}`,
      );
      await response.body?.cancel();
    }
    assertEquals((await registrationFacts(f)).attempts, 0);
  });
});

Deno.test("the callback converts the code once and stores the App identity and three encrypted secrets", async () => {
  await withFixture(async (f) => {
    assertEquals(await readRegistration(f), {
      provider: "github",
      status: "unregistered",
      appId: null,
      slug: null,
      name: null,
      clientId: null,
      ownerLogin: null,
      ownerId: null,
      ownerType: null,
      htmlUrl: null,
      permissions: null,
      events: null,
      clientSecretConfigured: false,
      privateKeyConfigured: false,
      webhookSecretConfigured: false,
      clientSecretRevision: null,
      privateKeyRevision: null,
      webhookSecretRevision: null,
      registeredByPrincipalId: null,
      registeredAt: null,
      version: 0,
    });
    const start = await started(f);
    const { code, app } = f.github.issueCode();
    const response = await callback(f, { code, state: start.state });
    assertEquals(response.status, 303, await response.clone().text());
    assertEquals(
      response.headers.get("location"),
      settingsLocation("registered"),
    );
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("referrer-policy"), "no-referrer");
    assertEquals(f.github.conversionCalls().length, 1);

    const registration = await readRegistration(f);
    assertEquals(registration.status, "registered");
    assertEquals(registration.appId, app.id);
    assertEquals(registration.slug, app.slug);
    assertEquals(registration.name, app.name);
    assertEquals(registration.clientId, app.clientId);
    assertEquals(registration.ownerLogin, app.ownerLogin);
    assertEquals(registration.ownerId, app.ownerId);
    assertEquals(registration.ownerType, "Organization");
    assertEquals(registration.htmlUrl, `https://github.com/apps/${app.slug}`);
    assertEquals(registration.events, []);
    assertEquals(
      (registration.permissions as Record<string, string>).checks,
      "write",
    );
    assertEquals(registration.clientSecretConfigured, true);
    assertEquals(registration.privateKeyConfigured, true);
    assertEquals(registration.webhookSecretConfigured, true);
    assertEquals(registration.registeredByPrincipalId, f.adminId);
    assertEquals(registration.version, 1);

    const attempt = await f.pgDatabase.query<{
      outcome: string;
      external_app_id: string;
      slug: string;
      registration_id: string | null;
    }>(
      `select outcome, external_app_id::text, slug, registration_id
       from bakery.integration_app_registration_attempts`,
    );
    assertEquals(attempt.rows[0].outcome, "registered");
    assertEquals(attempt.rows[0].external_app_id, String(app.id));
    assert(attempt.rows[0].registration_id);

    // The same code and state again: refused before any GitHub call.
    const replay = await callback(f, { code, state: start.state });
    assertEquals(replay.status, 303);
    assertEquals(
      replay.headers.get("location"),
      settingsLocation("state_rejected"),
    );
    assertEquals(
      f.github.conversionCalls().length,
      1,
      "converted exactly once",
    );

    // A second registration is refused while one exists.
    const again = await begin(f);
    assertEquals(again.status, 409);
    const problem = await again.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals((await registrationFacts(f)).attempts, 1);

    const audit = await f.pgDatabase.query<{
      operation: string;
      organization_id: string | null;
      principal_id: string;
      details: Record<string, unknown>;
    }>(
      `select operation, organization_id, principal_id, details
       from bakery.audit_events
       where operation in ('integrationAppRegistrations.begin',
         'integrationAuth.githubManifestCallback') and principal_id = $1
       order by created_at, id`,
      [f.adminId],
    );
    assertEquals(audit.rows.map((row) => row.operation), [
      "integrationAppRegistrations.begin",
      "integrationAuth.githubManifestCallback",
    ]);
    for (const row of audit.rows) {
      assertEquals(row.organization_id, null);
      assertEquals(row.principal_id, f.adminId);
    }
    assertEquals(audit.rows[1].details.appId, app.id);
  });
});

Deno.test("stored credentials are installation-scoped AES-GCM ciphertext only", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const { code, app } = f.github.issueCode();
    assertEquals(
      (await callback(f, { code, state: start.state })).status,
      303,
    );
    const secrets = await f.pgDatabase.query<{
      kind: string;
      secret_id: string;
      organization_id: string | null;
      application_id: string | null;
      revision: number;
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      key_id: string;
      active: boolean;
    }>(
      `select kind, s.id as secret_id, s.organization_id, s.application_id,
         v.revision, v.ciphertext, v.nonce, v.key_id,
         s.active_version_id = v.id as active
       from bakery.integration_app_registrations r
       cross join lateral (values ('clientSecret', r.client_secret_id),
         ('privateKey', r.private_key_secret_id),
         ('webhookSecret', r.webhook_secret_id)) as k(kind, secret_id)
       join bakery.secrets s on s.id = k.secret_id
       join bakery.secret_versions v on v.secret_id = s.id
       order by kind`,
    );
    assertEquals(secrets.rows.length, 3);
    const key = await loadSecretKey(f.secretsKey);
    const expected: Record<string, string> = {
      clientSecret: app.clientSecret,
      privateKey: app.pem,
      webhookSecret: app.webhookSecret!,
    };
    for (const row of secrets.rows) {
      assertEquals(row.organization_id, null);
      assertEquals(row.application_id, null);
      assertEquals(row.revision, 1);
      assertEquals(row.key_id, f.secretsKey.keyId);
      assertEquals(row.nonce.byteLength, 12);
      assert(row.active);
      const plaintext = new TextEncoder().encode(expected[row.kind]);
      assert(
        !new TextDecoder().decode(row.ciphertext).includes(expected[row.kind]),
        `${row.kind} stored in clear`,
      );
      // AES-GCM tag: ciphertext is the plaintext length plus 16 bytes.
      assertEquals(row.ciphertext.byteLength, plaintext.byteLength + 16);
      const cipher = {
        ciphertext: new Uint8Array(row.ciphertext),
        nonce: new Uint8Array(row.nonce),
      };
      const decrypted = await decryptInstallationSecret(key, {
        secretId: row.secret_id,
        revision: 1,
        keyId: row.key_id,
      }, cipher);
      assertEquals(new TextDecoder().decode(decrypted), expected[row.kind]);
      // Bound to its own secret id and the installation scope.
      await assertRejects(() =>
        decryptInstallationSecret(key, {
          secretId: crypto.randomUUID(),
          revision: 1,
          keyId: row.key_id,
        }, cipher)
      );
      await assertRejects(() =>
        decryptSecret(key, {
          organizationId: crypto.randomUUID(),
          applicationId: crypto.randomUUID(),
          secretId: row.secret_id,
          revision: 1,
          keyId: row.key_id,
        }, cipher)
      );
    }
  });
});

Deno.test("a missing webhook secret stores the App without one", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const { code } = f.github.issueCode({ webhookSecret: null });
    const response = await callback(f, { code, state: start.state });
    assertEquals(
      response.headers.get("location"),
      settingsLocation("registered"),
    );
    const registration = await readRegistration(f);
    assertEquals(registration.webhookSecretConfigured, false);
    assertEquals(registration.clientSecretConfigured, true);
    assertEquals((await registrationFacts(f)).installationSecrets, 2);
  });
});

Deno.test("racing callbacks register one App and record the other App for cleanup", async () => {
  await withFixture(async (f) => {
    const first = await started(f);
    const second = await started(f);
    const one = f.github.issueCode();
    const two = f.github.issueCode();
    f.github.holdConversions(2);
    const responses = await Promise.all([
      callback(f, { code: one.code, state: first.state }),
      callback(f, { code: two.code, state: second.state }),
    ]);
    assertEquals(
      responses.map((response) => response.headers.get("location")).sort(),
      [settingsLocation("already_registered"), settingsLocation("registered")],
    );
    const facts = await registrationFacts(f);
    assertEquals(facts.registrations, 1);
    assertEquals(facts.installationSecrets, 3, "loser's secrets rolled back");
    const attempts = await f.pgDatabase.query<
      { outcome: string; external_app_id: string | null }
    >(
      `select outcome, external_app_id::text
       from bakery.integration_app_registration_attempts order by outcome`,
    );
    assertEquals(attempts.rows.map((row) => row.outcome), [
      "already_registered",
      "registered",
    ]);
    assert(
      attempts.rows.every((row) => row.external_app_id !== null),
      "the losing App id is kept so an administrator can remove it",
    );
  });
});

Deno.test("a storage failure after conversion keeps the converted App id and slug", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const { code, app } = f.github.issueCode();
    await Deno.remove(f.secretsKey.file);
    const response = await callback(f, { code, state: start.state });
    assertEquals(
      response.headers.get("location"),
      settingsLocation("storage_failed"),
    );
    const attempt = await f.pgDatabase.query<
      { outcome: string; external_app_id: string; slug: string }
    >(
      `select outcome, external_app_id::text, slug
       from bakery.integration_app_registration_attempts`,
    );
    assertEquals(attempt.rows[0], {
      outcome: "storage_failed",
      external_app_id: String(app.id),
      slug: app.slug,
    });
    const facts = await registrationFacts(f);
    assertEquals(facts.registrations, 0);
    assertEquals(facts.installationSecrets, 0);
  });
});

Deno.test("a failed conversion consumes the state and stores nothing", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const response = await callback(f, {
      code: "never-issued",
      state: start.state,
    });
    assertEquals(
      response.headers.get("location"),
      settingsLocation("conversion_failed"),
    );
    assertEquals(f.github.conversionCalls().length, 1);
    const facts = await registrationFacts(f);
    assertEquals(facts.consumed, 1);
    assertEquals(facts.registrations, 0);
    assertEquals(facts.installationSecrets, 0);
  });
});

Deno.test("begin refuses when no secrets key is mounted", async () => {
  await withFixture(async (f) => {
    await Deno.remove(f.secretsKey.file);
    const response = await begin(f);
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, "STATE_CONFLICT");
    assertEquals((await registrationFacts(f)).attempts, 0);
  });
});

Deno.test("a valid state after registration records the second App for cleanup and stores none of its secrets", async () => {
  await withFixture(async (f) => {
    const first = await started(f);
    const second = await started(f);
    const winner = f.github.issueCode();
    assertEquals(
      (await callback(f, { code: winner.code, state: first.state })).headers
        .get("location"),
      settingsLocation("registered"),
    );
    const orphan = f.github.issueCode();
    const late = await callback(f, { code: orphan.code, state: second.state });
    assertEquals(
      late.headers.get("location"),
      settingsLocation("already_registered"),
    );
    assertEquals(f.github.conversionCalls().length, 2);
    const attempt = await f.pgDatabase.query<
      { outcome: string; external_app_id: string; slug: string }
    >(
      `select outcome, external_app_id::text, slug
       from bakery.integration_app_registration_attempts
       where state_hash = $1`,
      [await sha256Hex(second.state)],
    );
    assertEquals(attempt.rows[0], {
      outcome: "already_registered",
      external_app_id: String(orphan.app.id),
      slug: orphan.app.slug,
    });
    const facts = await registrationFacts(f);
    assertEquals(facts.registrations, 1);
    assertEquals(facts.installationSecrets, 3);
    assertEquals((await readRegistration(f)).appId, winner.app.id);
  });
});

Deno.test("a browser disconnect after the claim does not cancel the one-time exchange", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const { code, app } = f.github.issueCode();
    const disconnect = new AbortController();
    f.github.holdConversions(2);
    const pending = Promise.resolve(f.app.fetch(
      new Request(
        `${authTestOrigin}/v1/integration-auth/github/manifest-callback?${new URLSearchParams(
          { code, state: start.state },
        )}`,
        { headers: { cookie: f.adminCookie }, signal: disconnect.signal },
      ),
    )).catch(() => null);
    for (let i = 0; i < 500 && f.github.conversionCalls().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.github.conversionCalls().length, 1, "conversion started");
    disconnect.abort();
    // A second arrival releases the held conversion.
    await f.github.fetch("https://api.github.com/release-barrier");
    await pending;
    let registration = await readRegistration(f);
    for (let i = 0; i < 100 && registration.status !== "registered"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      registration = await readRegistration(f);
    }
    assertEquals(registration.status, "registered");
    assertEquals(registration.appId, app.id);
  });
});

/** The authorization URL's query as a plain object, in GitHub's parameter names. */
function authorizeQuery(url: string): Record<string, string> {
  const parsed = new URL(url);
  assertEquals(parsed.origin, "https://github.com");
  assertEquals(parsed.pathname, "/login/oauth/authorize");
  return Object.fromEntries(parsed.searchParams);
}

Deno.test("an Admin creates a GitHub auth attempt with an allowlisted authorization URL", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const calls = f.github.calls.length;
    const before = Date.now();
    const created = await createdAttempt(f);
    assert(/^[0-9a-f-]{36}$/.test(created.id));
    const query = authorizeQuery(created.authorizationUrl);
    assertEquals(Object.keys(query).sort(), [
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "state",
    ]);
    assertEquals(query.client_id, app.clientId);
    assertEquals(
      query.redirect_uri,
      `${authTestOrigin}/v1/integration-auth/github/callback`,
    );
    assertEquals(query.code_challenge_method, "S256");
    assert(/^[A-Za-z0-9_-]{43}$/.test(query.state), "32 random bytes");
    assert(/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge));
    const ttl = Date.parse(created.expiresAt) - before;
    assert(ttl > 890_000 && ttl <= 910_000, `expiry ${ttl}ms`);
    assertEquals(f.github.calls.length, calls, "create never calls GitHub");
    // The install page carries the same state, which GitHub passes on to the
    // Setup URL; nothing else.
    const install = new URL(created.installationUrl);
    assertEquals(install.origin, "https://github.com");
    assertEquals(install.pathname, `/apps/${app.slug}/installations/new`);
    assertEquals(Object.fromEntries(install.searchParams), {
      state: query.state,
    });

    const second = await createdAttempt(f);
    assertNotEquals(second.id, created.id);
    assertNotEquals(
      authorizeQuery(second.authorizationUrl).state,
      query.state,
    );
  });
});

Deno.test("an auth attempt stores only the state hash and the verifier as AES-GCM ciphertext", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const created = await createdAttempt(f, {
      body: { provider: "github", returnPath: "/settings/integrations" },
    });
    const query = authorizeQuery(created.authorizationUrl);
    const [row] = await attemptRows(f);
    assertEquals(row.id, created.id);
    assertEquals(row.organization_id, f.organizationId);
    assertEquals(row.initiating_principal_id, f.adminId);
    assertEquals(row.provider, "github");
    assertEquals(row.status, "pending");
    assertEquals(row.return_path, "/settings/integrations");
    assertEquals(row.state_hash, await sha256Hex(query.state));
    assertEquals(row.pkce_key_id, f.secretsKey.keyId);
    assertEquals(row.pkce_verifier_nonce.length, 12);
    const key = await loadSecretKey(f.secretsKey);
    const verifier = new TextDecoder().decode(
      await decryptAuthAttemptVerifier(key, {
        organizationId: f.organizationId,
        attemptId: row.id,
        stateHash: row.state_hash,
        keyId: row.pkce_key_id,
      }, {
        ciphertext: new Uint8Array(row.pkce_verifier_ciphertext),
        nonce: new Uint8Array(row.pkce_verifier_nonce),
      }),
    );
    assert(/^[A-Za-z0-9_-]{43}$/.test(verifier), "RFC 7636 verifier length");
    assertEquals(await pkceChallenge(verifier), query.code_challenge);
    const stored = JSON.stringify(
      row,
      (_key, value) =>
        value instanceof Uint8Array
          ? new TextDecoder("latin1").decode(value)
          : value,
    );
    assert(!stored.includes(query.state), "no plaintext state");
    assert(!stored.includes(verifier), "no plaintext verifier");
  });
});

Deno.test("a Developer or a non-member cannot create an auth attempt", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const developer = await createAttempt(f, { cookie: f.developerCookie });
    assertEquals(developer.status, 403, await developer.clone().text());
    await developer.body?.cancel();
    const foreign = await createAttempt(f, {
      organizationId: crypto.randomUUID(),
    });
    assertEquals(foreign.status, 404, await foreign.clone().text());
    await foreign.body?.cancel();
    assertEquals((await attemptRows(f)).length, 0);
  });
});

Deno.test("an unregistered installation refuses an auth attempt with provider_unregistered", async () => {
  await withFixture(async (f) => {
    const response = await createAttempt(f);
    assertEquals(response.status, 409, await response.clone().text());
    const problem = await response.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "provider_unregistered");
    assertEquals((await attemptRows(f)).length, 0);
  });
});

Deno.test("an auth attempt requires an Idempotency-Key, a Bakery return path and no unknown reconnect target", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const cases: [Parameters<typeof createAttempt>[1], number][] = [
      [{ key: null }, 428],
      [{ body: { provider: "gitlab" } }, 400],
      [{ body: {} }, 400],
      [{ body: { provider: "github", returnPath: "https://evil.test/" } }, 422],
      [{ body: { provider: "github", returnPath: "//evil.test/" } }, 422],
      [{ body: { provider: "github", returnPath: "/a\\b" } }, 422],
      [{
        body: {
          provider: "github",
          reconnectConnectionId: crypto.randomUUID(),
        },
      }, 404],
    ];
    for (const [options, status] of cases) {
      const response = await createAttempt(f, options);
      assertEquals(
        response.status,
        status,
        `${JSON.stringify(options)} -> ${await response.clone().text()}`,
      );
      await response.body?.cancel();
    }
    assertEquals((await attemptRows(f)).length, 0);
  });
});

/** Decrypts the stored verifier of an attempt row under its current state hash. */
async function storedVerifier(f: GitHubAppFixture, row: AttemptRow) {
  return new TextDecoder().decode(
    await decryptAuthAttemptVerifier(await loadSecretKey(f.secretsKey), {
      organizationId: row.organization_id,
      attemptId: row.id,
      stateHash: row.state_hash,
      keyId: row.pkce_key_id,
    }, {
      ciphertext: new Uint8Array(row.pkce_verifier_ciphertext),
      nonce: new Uint8Array(row.pkce_verifier_nonce),
    }),
  );
}

Deno.test("replaying the Idempotency-Key returns the same attempt with a rotated state", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const key = crypto.randomUUID();
    const first = await createdAttempt(f, { key });
    const [before] = await attemptRows(f);
    const replay = await createdAttempt(f, { key });
    assertEquals(replay.id, first.id);
    assertEquals(replay.expiresAt, first.expiresAt);
    const firstQuery = authorizeQuery(first.authorizationUrl);
    const replayQuery = authorizeQuery(replay.authorizationUrl);
    assertNotEquals(replayQuery.state, firstQuery.state);
    assertNotEquals(replayQuery.code_challenge, firstQuery.code_challenge);
    const rows = await attemptRows(f);
    assertEquals(rows.length, 1, "a replay creates no second attempt");
    const [after] = rows;
    assertEquals(after.version, before.version + 1);
    assertEquals(after.state_hash, await sha256Hex(replayQuery.state));
    assertEquals(
      await pkceChallenge(await storedVerifier(f, after)),
      replayQuery.code_challenge,
    );
    // The first state no longer names any attempt.
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_auth_attempts where state_hash = $1",
        [await sha256Hex(firstQuery.state)],
      ),
      0,
    );
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.audit_events where operation = 'integrationAuthAttempts.create' and resource_id = $1",
        [first.id],
      ),
      2,
      "the creation and the replay are each audited",
    );
  });
});

Deno.test("a different body under the same Idempotency-Key is refused with IDEMPOTENCY_PAYLOAD_MISMATCH", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const key = crypto.randomUUID();
    await createdAttempt(f, { key });
    const [before] = await attemptRows(f);
    const response = await createAttempt(f, {
      key,
      body: { provider: "github", returnPath: "/elsewhere" },
    });
    assertEquals(response.status, 422, await response.clone().text());
    assertEquals((await response.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const rows = await attemptRows(f);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].state_hash, before.state_hash);
    assertEquals(rows[0].version, before.version);
  });
});

Deno.test("an Idempotency-Key replay from another session or after expiry is not replayable", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const key = crypto.randomUUID();
    await createdAttempt(f, { key });
    const otherSession = await signIn(f, f.adminEmail, f.password);
    const elsewhere = await createAttempt(f, { key, cookie: otherSession });
    assertEquals(elsewhere.status, 409, await elsewhere.clone().text());
    assertEquals((await elsewhere.json()).reason, "attempt_not_replayable");
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second'`,
    );
    const expired = await createAttempt(f, { key });
    assertEquals(expired.status, 409, await expired.clone().text());
    assertEquals((await expired.json()).reason, "attempt_not_replayable");
    assertEquals((await attemptRows(f)).length, 1);
  });
});

const attemptFields = [
  "consumedAt",
  "createdAt",
  "expiresAt",
  "failureCode",
  "id",
  "initiatingPrincipalId",
  "organizationId",
  "provider",
  "reconnectConnectionId",
  "resultConnectionId",
  "returnPath",
  "status",
  "updatedAt",
  "version",
];

Deno.test("the initiating principal and an Admin read the attempt status without state or verifier", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    // The Developer starts an attempt while briefly an Admin, then is demoted.
    const setRole = (role: string) =>
      f.pgDatabase.query(
        `update bakery.organization_memberships set role = $3
          where organization_id = $1 and principal_id = $2`,
        [f.organizationId, f.developerId, role],
      );
    await setRole("admin");
    const created = await createdAttempt(f, {
      cookie: f.developerCookie,
      body: { provider: "github", returnPath: "/settings/integrations" },
    });
    await setRole("developer");
    const query = authorizeQuery(created.authorizationUrl);
    const [row] = await attemptRows(f);
    const verifier = await storedVerifier(f, row);
    for (const cookie of [f.developerCookie, f.adminCookie]) {
      const response = await readAttempt(f, created.id, cookie);
      assertEquals(response.status, 200, await response.clone().text());
      const text = await response.clone().text();
      const attempt = await response.json();
      assertEquals(Object.keys(attempt).sort(), attemptFields);
      assertEquals(attempt.id, created.id);
      assertEquals(attempt.organizationId, f.organizationId);
      assertEquals(attempt.initiatingPrincipalId, f.developerId);
      assertEquals(attempt.provider, "github");
      assertEquals(attempt.status, "pending");
      assertEquals(attempt.returnPath, "/settings/integrations");
      assertEquals(attempt.expiresAt, created.expiresAt);
      assertEquals(attempt.failureCode, null);
      for (const secret of [query.state, verifier, row.state_hash]) {
        assert(!text.includes(secret), "no state, verifier or hash");
      }
    }
    for (
      const [status, failureCode] of [
        ["completed", null],
        ["failed", "exchange_failed"],
      ] as const
    ) {
      await f.pgDatabase.query(
        `update bakery.integration_auth_attempts
            set status = $2, failure_code = $3 where id = $1`,
        [created.id, status, failureCode],
      );
      const response = await readAttempt(f, created.id);
      assertEquals(response.status, 200);
      const attempt = await response.json();
      assertEquals(attempt.status, status);
      assertEquals(attempt.failureCode, failureCode);
    }
  });
});

Deno.test("another Developer cannot read an attempt they did not start", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const created = await createdAttempt(f);
    const response = await readAttempt(f, created.id, f.developerCookie);
    assertEquals(response.status, 404, await response.clone().text());
    assertEquals((await response.json()).code, "RESOURCE_NOT_FOUND");
    const unknown = await readAttempt(f, crypto.randomUUID());
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
  });
});

Deno.test("a pending attempt past its expiry reads as failed with failureCode expired", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const created = await createdAttempt(f);
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second' where id = $1`,
      [created.id],
    );
    const response = await readAttempt(f, created.id);
    assertEquals(response.status, 200, await response.clone().text());
    const attempt = await response.json();
    assertEquals(attempt.status, "failed");
    assertEquals(attempt.failureCode, "expired");
    const [row] = await attemptRows(f);
    assertEquals(row.status, "pending", "expiry is derived, not written");
  });
});

Deno.test("removing a member removes the auth attempts they started", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    await createdAttempt(f, { cookie: f.developerCookie });
    await createdAttempt(f);
    await f.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const rows = await attemptRows(f);
    assertEquals(rows.map((row) => row.initiating_principal_id), [f.adminId]);
  });
});

/** Asserts a 303 to the connection setup page with this outcome; returns the connection id. */
async function assertOutcome(
  response: Response,
  outcome: string,
): Promise<string | null> {
  assertEquals(response.status, 303, await response.clone().text());
  const location = new URL(response.headers.get("location")!, authTestOrigin);
  assertEquals(location.pathname, "/settings/organization/integrations");
  assertEquals(location.searchParams.get("githubConnection"), outcome);
  assertEquals(response.headers.get("cache-control"), "no-store");
  return location.searchParams.get("connectionId");
}

/** The attempt row, as the callbacks leave it. */
async function attemptState(f: GitHubAppFixture, id: string) {
  const result = await f.pgDatabase.query<{
    status: string;
    failure_code: string | null;
    result_connection_id: string | null;
    setup_installation_id: string | null;
    verified_installation_ids: string[] | null;
    discovered_repositories: Record<string, unknown[]> | null;
  }>(
    `select status, failure_code, result_connection_id, setup_installation_id,
       verified_installation_ids, discovered_repositories
       from bakery.integration_auth_attempts where id = $1`,
    [id],
  );
  return result.rows[0];
}

/** The one pending connection a completed flow must have created. */
async function assertOnePendingConnection(
  f: GitHubAppFixture,
  attemptId: string,
  connectionId: string | null,
  installation: { id: number; account: { id: number; login: string } },
) {
  const connections = await connectionRows(f);
  assertEquals(connections.length, 1);
  const [connection] = connections;
  assertEquals(connection.id, connectionId);
  assertEquals(connection.status, "pending");
  assertEquals(connection.health, "unknown");
  assertEquals(connection.provider, "github");
  assertEquals(connection.external_authorization_id, String(installation.id));
  assertEquals(connection.external_account_id, String(installation.account.id));
  assertEquals(connection.label, installation.account.login);
  assertEquals(connection.created_by, f.adminId);
  const installations = await installationRows(f);
  assertEquals(installations.length, 1);
  assertEquals(installations[0].id, connection.installation_id);
  assertEquals(
    installations[0].external_authorization_id,
    String(installation.id),
  );
  const attempt = await attemptState(f, attemptId);
  assertEquals(attempt.status, "completed");
  assertEquals(attempt.result_connection_id, connection.id);
  assertEquals(attempt.verified_installation_ids, null, "ids are cleared");
  assertEquals(attempt.discovered_repositories, null, "repositories cleared");
}

Deno.test("setup then OAuth callback claims the attempt once and binds exactly one pending connection with a 303", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f);
    const [installation] = installations;
    const setup = await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    assertEquals(await assertOutcome(setup, "awaiting_authorization"), null);
    assertEquals(f.github.calls.length, 0, "a hint alone calls nothing");
    assertEquals((await attemptState(f, created.id)).status, "pending");
    const response = await githubCallback(f, { code, state });
    const connectionId = await assertOutcome(response, "pending");
    await assertOnePendingConnection(f, created.id, connectionId, installation);
    assertEquals(f.github.oauthCalls().length, 1, "the code is exchanged once");
  });
});

Deno.test("OAuth callback then setup claims the attempt once and binds exactly one pending connection with a 303", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 3,
    });
    const installation = installations[1];
    const first = await githubCallback(f, { code, state });
    assertEquals(await assertOutcome(first, "awaiting_installation"), null);
    const waiting = await attemptState(f, created.id);
    assertEquals(waiting.status, "exchanging");
    assertEquals(
      waiting.verified_installation_ids,
      installations.map((item) => String(item.id)),
    );
    assertEquals(await connectionRows(f), []);
    const setup = await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    const connectionId = await assertOutcome(setup, "pending");
    await assertOnePendingConnection(f, created.id, connectionId, installation);
    assertEquals(f.github.oauthCalls().length, 1);
  });
});

Deno.test("racing setup and OAuth callbacks bind exactly one connection", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    for (let round = 0; round < 3; round++) {
      const { created, state, code, installations } = await connectionFlow(
        f,
        { app },
      );
      const [setup, oauth] = await Promise.all([
        githubSetup(f, {
          installation_id: String(installations[0].id),
          setup_action: "install",
          state,
        }),
        githubCallback(f, { code, state }),
      ]);
      const outcomes = [setup, oauth].map((response) =>
        new URL(response.headers.get("location")!, authTestOrigin).searchParams
          .get("githubConnection")
      );
      assertEquals(
        outcomes.filter((outcome) => outcome === "pending").length,
        1,
        outcomes.join(","),
      );
      const attempt = await attemptState(f, created.id);
      assertEquals(attempt.status, "completed");
      const bound = (await connectionRows(f)).filter((row) =>
        row.external_authorization_id === String(installations[0].id)
      );
      assertEquals(bound.map((row) => row.id), [attempt.result_connection_id]);
    }
    assertEquals(f.github.oauthCalls().length, 1, "per round: calls reset");
  });
});

Deno.test("a hint found only on the last page of the user's installations binds", async () => {
  await withFixture(async (f) => {
    f.github.listing.pageSize = 2;
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 5,
    });
    const last = installations[4];
    await assertOutcome(
      await githubSetup(f, {
        installation_id: String(last.id),
        setup_action: "install",
        state,
      }),
      "awaiting_authorization",
    );
    const connectionId = await assertOutcome(
      await githubCallback(f, { code, state }),
      "pending",
    );
    await assertOnePendingConnection(f, created.id, connectionId, last);
    const pages = f.github.calls.filter((call) =>
      call.url.includes("/user/installations?")
    ).map((call) => new URL(call.url).searchParams.get("page"));
    assertEquals(pages, ["1", "2", "3"]);
  });
});

Deno.test("a spoofed installation hint absent from every page binds nothing and fails the attempt", async () => {
  await withFixture(async (f) => {
    f.github.listing.pageSize = 2;
    const { created, state, code, app } = await connectionFlow(f, {
      installations: 3,
    });
    // A real installation of the same App that this user cannot access.
    const foreign = f.github.addInstallation(app);
    for (const order of ["setup-first", "callback-first"] as const) {
      const flow = order === "setup-first"
        ? { created, state, code }
        : await (async () => {
          const next = await connectionFlow(f, { app, installations: 3 });
          return { created: next.created, state: next.state, code: next.code };
        })();
      const setup = () =>
        githubSetup(f, {
          installation_id: String(foreign.id),
          setup_action: "install",
          state: flow.state,
        });
      const oauth = () =>
        githubCallback(f, { code: flow.code, state: flow.state });
      let last: Response;
      if (order === "setup-first") {
        await assertOutcome(await setup(), "awaiting_authorization");
        last = await oauth();
      } else {
        await assertOutcome(await oauth(), "awaiting_installation");
        last = await setup();
      }
      await assertOutcome(last, "installation_unverified");
      const attempt = await attemptState(f, flow.created.id);
      assertEquals(attempt.status, "failed");
      assertEquals(attempt.failure_code, "installation_unverified");
      assertEquals(attempt.result_connection_id, null);
      assertEquals(await connectionRows(f), []);
      assertEquals(await installationRows(f), []);
      assert(
        !f.github.calls.some((call) =>
          call.url.includes("/app/installations/")
        ),
        "an unverified hint is never read with App authority",
      );
      const pages = f.github.calls.filter((call) =>
        call.url.includes("/user/installations?")
      ).length;
      assertEquals(pages, 2, "every page of the listing was read");
      f.github.calls.length = 0;
    }
  });
});

Deno.test("an installation of another App or a suspended installation binds nothing", async () => {
  await withFixture(async (f) => {
    const { app } = await connectionFlow(f);
    const other = f.github.addInstallation({ ...app, id: app.id + 1 });
    const suspended = f.github.addInstallation(app, {
      suspendedAt: "2026-10-26T12:00:00Z",
    });
    for (
      const [installation, outcome] of [
        [other, "installation_unverified"],
        [suspended, "installation_suspended"],
      ] as const
    ) {
      const created = await createdAttempt(f);
      const state = new URL(created.authorizationUrl).searchParams.get(
        "state",
      )!;
      const code = f.github.authorize({
        authorizationUrl: created.authorizationUrl,
        installationIds: [installation.id],
      });
      await githubSetup(f, {
        installation_id: String(installation.id),
        setup_action: "install",
        state,
      });
      await assertOutcome(await githubCallback(f, { code, state }), outcome);
      assertEquals((await attemptState(f, created.id)).failure_code, outcome);
    }
    assertEquals(await connectionRows(f), []);
    assertEquals(await installationRows(f), []);
  });
});

Deno.test("an Admin demoted or removed before the second callback completes binds no connection", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    // Demote first: the removal case deletes the membership for good.
    const promote = () =>
      f.pgDatabase.query(
        `update bakery.organization_memberships set role = 'admin'
          where organization_id = $1 and principal_id = $2`,
        [f.organizationId, f.developerId],
      );
    for (const change of ["demote", "remove"] as const) {
      await promote();
      const installation = f.github.addInstallation(app);
      const created = await createdAttempt(f, { cookie: f.developerCookie });
      const state = new URL(created.authorizationUrl).searchParams.get(
        "state",
      )!;
      const code = f.github.authorize({
        authorizationUrl: created.authorizationUrl,
        installationIds: [installation.id],
      });
      await assertOutcome(
        await githubSetup(f, {
          installation_id: String(installation.id),
          setup_action: "install",
          state,
        }, f.developerCookie),
        "awaiting_authorization",
      );
      if (change === "demote") {
        await f.pgDatabase.query(
          `update bakery.organization_memberships set role = 'developer'
            where organization_id = $1 and principal_id = $2`,
          [f.organizationId, f.developerId],
        );
        await assertOutcome(
          await githubCallback(f, { code, state }, f.developerCookie),
          "admin_required",
        );
        const attempt = await attemptState(f, created.id);
        assertEquals(attempt.status, "failed");
        assertEquals(attempt.failure_code, "admin_required");
      } else {
        await f.pgDatabase.query(
          `delete from bakery.organization_memberships
            where organization_id = $1 and principal_id = $2`,
          [f.organizationId, f.developerId],
        );
        // The membership foreign key removed the attempt with the member.
        await assertOutcome(
          await githubCallback(f, { code, state }, f.developerCookie),
          "state_rejected",
        );
        assertEquals(await attemptState(f, created.id), undefined);
      }
      assertEquals(await connectionRows(f), []);
    }
  });
});

Deno.test("a lost exchange response fails the attempt and only a fresh authorization connects", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations, app } = await connectionFlow(
      f,
    );
    f.github.failures.exchange = "lost";
    await assertOutcome(
      await githubCallback(f, { code, state }),
      "exchange_failed",
    );
    const failed = await attemptState(f, created.id);
    assertEquals(failed.status, "failed");
    assertEquals(failed.failure_code, "exchange_failed");
    const retryCode = f.github.authorize({
      authorizationUrl: created.authorizationUrl,
      installationIds: [installations[0].id],
    });
    await assertOutcome(
      await githubCallback(f, { code: retryCode, state }),
      "state_rejected",
    );
    assertEquals(f.github.oauthCalls().length, 1, "the retry never exchanges");
    await assertOutcome(
      await githubSetup(f, {
        installation_id: String(installations[0].id),
        setup_action: "install",
        state,
      }),
      "state_rejected",
    );
    assertEquals(await connectionRows(f), []);
    const fresh = await connectionFlow(f, { app });
    await githubSetup(f, {
      installation_id: String(installations[0].id),
      setup_action: "install",
      state: fresh.state,
    });
    const freshCode = f.github.authorize({
      authorizationUrl: fresh.created.authorizationUrl,
      installationIds: [installations[0].id],
    });
    const connectionId = await assertOutcome(
      await githubCallback(f, { code: freshCode, state: fresh.state }),
      "pending",
    );
    assert(connectionId);
  });
});

Deno.test("a denied authorization, a refused code or a failed listing fails the attempt", async () => {
  await withFixture(async (f) => {
    const { app } = await connectionFlow(f);
    const cases = [
      {
        outcome: "authorization_denied",
        query: (state: string) => ({
          error: "access_denied",
          error_description: "The user has denied your application access.",
          state,
        }),
      },
      {
        outcome: "exchange_failed",
        query: (state: string) => ({ code: "oauth-unknown-code", state }),
      },
      {
        outcome: "installation_listing_failed",
        listing: true,
        query: (state: string, code: string) => ({ code, state }),
      },
    ];
    for (const item of cases) {
      const flow = await connectionFlow(f, { app });
      f.github.failures.listing = item.listing === true;
      const response = await githubCallback(
        f,
        item.query(flow.state, flow.code),
      );
      f.github.failures.listing = false;
      await assertOutcome(response, item.outcome);
      const attempt = await attemptState(f, flow.created.id);
      assertEquals(attempt.status, "failed");
      assertEquals(attempt.failure_code, item.outcome);
      if (item.outcome === "authorization_denied") {
        assertEquals(f.github.calls.length, 0);
      }
    }
    assertEquals(await connectionRows(f), []);
  });
});

Deno.test("a second attempt for an installation the organization already connected fails already_connected", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f);
    const [installation] = first.installations;
    await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state: first.state,
    });
    const connectionId = await assertOutcome(
      await githubCallback(f, { code: first.code, state: first.state }),
      "pending",
    );
    const created = await createdAttempt(f);
    const state = new URL(created.authorizationUrl).searchParams.get("state")!;
    const code = f.github.authorize({
      authorizationUrl: created.authorizationUrl,
      installationIds: [installation.id],
    });
    await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "update",
      state,
    });
    await assertOutcome(
      await githubCallback(f, { code, state }),
      "already_connected",
    );
    const connections = await connectionRows(f);
    assertEquals(connections.map((row) => row.id), [connectionId]);
    assertEquals((await installationRows(f)).length, 1);
  });
});

Deno.test("setup without an installation id records nothing and the redirect honours the return path", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f, {
      attempt: {
        body: {
          provider: "github",
          returnPath: "/settings/integrations?tab=github",
        },
      },
    });
    const requested = await githubSetup(f, { setup_action: "request", state });
    await assertOutcome(requested, "installation_requested");
    const untouched = await attemptState(f, created.id);
    assertEquals(untouched.status, "pending");
    assertEquals(untouched.setup_installation_id, null);
    await githubSetup(f, {
      installation_id: String(installations[0].id),
      setup_action: "install",
      state,
    });
    const response = await githubCallback(f, { code, state });
    assertEquals(response.status, 303);
    const location = new URL(response.headers.get("location")!, authTestOrigin);
    assertEquals(location.pathname, "/settings/integrations");
    assertEquals(location.searchParams.get("tab"), "github");
    assertEquals(location.searchParams.get("githubConnection"), "pending");
    assertEquals(
      location.searchParams.get("connectionId"),
      (await connectionRows(f))[0].id,
    );
  });
});

Deno.test("integrationConnections.get returns the pending connection to members and hides it elsewhere", async () => {
  await withFixture(async (f) => {
    const { state, code, installations, created } = await connectionFlow(f);
    const [installation] = installations;
    await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    const connectionId = (await assertOutcome(
      await githubCallback(f, { code, state }),
      "pending",
    ))!;
    for (const cookie of [f.adminCookie, f.developerCookie]) {
      const response = await readConnection(f, connectionId, cookie);
      assertEquals(response.status, 200, await response.clone().text());
      const connection = await response.json();
      assertEquals(Object.keys(connection).sort(), [
        "config",
        "createdAt",
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
      assertEquals(connection.id, connectionId);
      assertEquals(connection.provider, "github");
      assertEquals(connection.status, "pending");
      assertEquals(connection.label, installation.account.login);
      assertEquals(
        connection.externalAccountId,
        String(installation.account.id),
      );
      assertEquals(connection.grantedScopes, installation.permissions);
      assertEquals(connection.config, {});
      assertEquals(connection.secretId, null);
      assertEquals(connection.lastCheckedAt, null);
      assertEquals(connection.version, 1);
    }
    const attempt = await readAttempt(f, created.id);
    const body = await attempt.json();
    assertEquals(body.status, "completed");
    assertEquals(body.resultConnectionId, connectionId);
    const unknown = await readConnection(f, crypto.randomUUID());
    assertEquals(unknown.status, 404);
    assertEquals((await unknown.json()).code, "RESOURCE_NOT_FOUND");
    const malformed = await readConnection(f, "not-a-uuid");
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();
    // Health folds into the client status; archived connections disappear.
    for (
      const [status, health, expected] of [
        ["enabled", "healthy", "enabled"],
        ["enabled", "auth_required", "degraded"],
        ["disabled", "degraded", "disabled"],
        ["revoked", "unknown", "revoked"],
      ] as const
    ) {
      await f.pgDatabase.query(
        "update bakery.integration_connections set status = $2, health = $3 where id = $1",
        [connectionId, status, health],
      );
      const response = await readConnection(f, connectionId);
      assertEquals((await response.json()).status, expected);
    }
    await f.pgDatabase.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [connectionId],
    );
    const archived = await readConnection(f, connectionId);
    assertEquals(archived.status, 404);
    await archived.body?.cancel();
  });
});

Deno.test("a browser disconnect during the setup-side installation read still binds", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f);
    await assertOutcome(
      await githubCallback(f, { code, state }),
      "awaiting_installation",
    );
    f.github.calls.length = 0;
    const disconnect = new AbortController();
    f.github.holdConversions(2);
    const pending = Promise.resolve(f.app.fetch(
      new Request(
        `${authTestOrigin}/v1/integration-auth/github/setup?${new URLSearchParams(
          {
            installation_id: String(installations[0].id),
            setup_action: "install",
            state,
          },
        )}`,
        { headers: { cookie: f.adminCookie }, signal: disconnect.signal },
      ),
    )).catch(() => null);
    for (let i = 0; i < 500 && f.github.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.github.calls.length, 1, "installation read started");
    disconnect.abort();
    await f.github.fetch("https://api.github.com/release-barrier");
    await pending;
    let attempt = await attemptState(f, created.id);
    for (let i = 0; i < 100 && attempt.status === "exchanging"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      attempt = await attemptState(f, created.id);
    }
    assertEquals(attempt.status, "completed");
    assertEquals((await connectionRows(f)).length, 1);
  });
});

Deno.test("an attempt whose setup redirect never arrives reads as expired once it lapses", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f);
    await assertOutcome(
      await githubCallback(f, { code, state }),
      "awaiting_installation",
    );
    const live = await (await readAttempt(f, created.id)).json();
    assertEquals(live.status, "exchanging");
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second' where id = $1`,
      [created.id],
    );
    const lapsed = await (await readAttempt(f, created.id)).json();
    assertEquals(lapsed.status, "failed");
    assertEquals(lapsed.failureCode, "expired");
    await assertOutcome(
      await githubSetup(f, {
        installation_id: String(installations[0].id),
        setup_action: "install",
        state,
      }),
      "state_rejected",
    );
    assertEquals(await connectionRows(f), []);
  });
});

Deno.test("a demotion held open across the binding commits first and binds nothing", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    await f.pgDatabase.query(
      `update bakery.organization_memberships set role = 'admin'
        where organization_id = $1 and principal_id = $2`,
      [f.organizationId, f.developerId],
    );
    const { created, state, code, installations } = await connectionFlow(f, {
      app,
      attempt: { cookie: f.developerCookie },
    });
    await assertOutcome(
      await githubSetup(f, {
        installation_id: String(installations[0].id),
        setup_action: "install",
        state,
      }, f.developerCookie),
      "awaiting_authorization",
    );
    // Another transaction demotes the Admin and holds the row lock.
    const demoter = await f.pgDatabase.connect();
    try {
      await demoter.query("begin");
      await demoter.query(
        `update bakery.organization_memberships set role = 'developer'
          where organization_id = $1 and principal_id = $2`,
        [f.organizationId, f.developerId],
      );
      const pending = githubCallback(f, { code, state }, f.developerCookie);
      // The bind waits on the share lock until the demotion commits.
      let attempt = await attemptState(f, created.id);
      for (
        let i = 0;
        i < 200 && attempt.verified_installation_ids === null;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        attempt = await attemptState(f, created.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      assertEquals(await connectionRows(f), [], "the bind is still waiting");
      await demoter.query("commit");
      await assertOutcome(await pending, "admin_required");
    } finally {
      demoter.release();
    }
    const attempt = await attemptState(f, created.id);
    assertEquals(attempt.status, "failed");
    assertEquals(attempt.failure_code, "admin_required");
    assertEquals(await connectionRows(f), []);
  });
});

Deno.test("an exchanging attempt stuck mid-exchange reads as expired once it lapses", async () => {
  await withFixture(async (f) => {
    const { created } = await connectionFlow(f);
    // As if the process died after the claim and before any outcome.
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set status = 'exchanging', consumed_at = now(),
              expires_at = now() - interval '1 second'
        where id = $1`,
      [created.id],
    );
    const lapsed = await (await readAttempt(f, created.id)).json();
    assertEquals(lapsed.status, "failed");
    assertEquals(lapsed.failureCode, "expired");
  });
});

Deno.test("a callback whose exchange outlives the attempt settles it expired and binds nothing", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f);
    await githubSetup(f, {
      installation_id: String(installations[0].id),
      setup_action: "install",
      state,
    });
    f.github.calls.length = 0;
    f.github.holdConversions(2);
    const pending = githubCallback(f, { code, state });
    for (let i = 0; i < 500 && f.github.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.github.oauthCalls().length, 1, "exchange in flight");
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second' where id = $1`,
      [created.id],
    );
    await f.github.fetch("https://api.github.com/release-barrier");
    await assertOutcome(await pending, "expired");
    const attempt = await attemptState(f, created.id);
    assertEquals(attempt.status, "failed");
    assertEquals(attempt.failure_code, "expired");
    assertEquals(await connectionRows(f), []);
    const read = await (await readAttempt(f, created.id)).json();
    assertEquals([read.status, read.failureCode], ["failed", "expired"]);
  });
});

Deno.test("a failure settled after the attempt expired is stored and redirected as expired", async () => {
  await withFixture(async (f) => {
    const { created, state, code } = await connectionFlow(f);
    f.github.holdConversions(2);
    const pending = githubCallback(f, { code, state });
    for (let i = 0; i < 500 && f.github.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.github.oauthCalls().length, 1, "exchange in flight");
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second' where id = $1`,
      [created.id],
    );
    f.github.failures.exchange = "lost";
    await f.github.fetch("https://api.github.com/release-barrier");
    await assertOutcome(await pending, "expired");
    const attempt = await attemptState(f, created.id);
    assertEquals([attempt.status, attempt.failure_code], ["failed", "expired"]);
    const read = await (await readAttempt(f, created.id)).json();
    assertEquals([read.status, read.failureCode], ["failed", "expired"]);
  });
});

/** The resources a completed setup must have recorded: administered only. */
async function assertAdministeredResources(
  f: GitHubAppFixture,
  connectionId: string,
  installation: FakeInstallation,
) {
  const connection = (await connectionRows(f)).find((row) =>
    row.id === connectionId
  )!;
  const administered = installation.repositories
    .filter((repository) => repository.permissions?.admin === true)
    .sort((a, b) => a.id - b.id);
  assert(administered.length > 0, "the fixture mixes in admin repositories");
  assert(
    administered.length < installation.repositories.length,
    "the fixture mixes in non-admin repositories",
  );
  const rows = await resourceRows(f, connectionId);
  assertEquals(
    rows.map((row) => ({
      organization: row.organization_id,
      installation: row.installation_id,
      kind: row.kind,
      externalId: row.external_id,
      displayName: row.display_name,
      safeUrl: row.safe_url,
      selected: row.selected,
      available: row.available,
      enabled: row.enabled,
      snapshot: row.capability_snapshot,
      generation: row.last_discovery_generation,
      archivedAt: row.archived_at,
    })),
    administered.map((repository) => ({
      organization: f.organizationId,
      installation: connection.installation_id,
      kind: "repository",
      externalId: String(repository.id),
      displayName: `${installation.account.login}/${repository.name}`,
      safeUrl:
        `https://github.com/${installation.account.login}/${repository.name}`,
      selected: false,
      available: true,
      enabled: false,
      snapshot: { private: repository.private, archived: repository.archived },
      generation: 1,
      archivedAt: null,
    })),
  );
}

function repositoryCalls(f: GitHubAppFixture) {
  return f.github.calls.filter((call) => call.url.includes("/repositories?"));
}

Deno.test("setup then OAuth callback records every administered repository across all pages and nothing else", async () => {
  await withFixture(async (f) => {
    f.github.repositoryListing.pageSize = 4;
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 2,
      repositories: () => fakeRepositories(11),
    });
    const installation = installations[0];
    await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    const connectionId = await assertOutcome(
      await githubCallback(f, { code, state }),
      "pending",
    );
    await assertOnePendingConnection(f, created.id, connectionId, installation);
    await assertAdministeredResources(f, connectionId!, installation);
    // The setup hint was known: only its three pages were read.
    assertEquals(
      repositoryCalls(f).map((call) => new URL(call.url).pathname),
      Array(3).fill(`/user/installations/${installation.id}/repositories`),
    );
    assertEquals(
      repositoryCalls(f).map((call) =>
        new URL(call.url).searchParams.get("page")
      ),
      ["1", "2", "3"],
    );
  });
});

Deno.test("OAuth callback then setup records only the named installation's administered repositories", async () => {
  await withFixture(async (f) => {
    f.github.repositoryListing.pageSize = 3;
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 3,
      repositories: () => fakeRepositories(8, ["read", "admin", null]),
    });
    const installation = installations[2];
    assertEquals(
      await assertOutcome(
        await githubCallback(f, { code, state }),
        "awaiting_installation",
      ),
      null,
    );
    // Setup has not named one yet, so every verified installation is scanned
    // while the token exists; nothing else stores the token.
    const waiting = await attemptState(f, created.id);
    assertEquals(
      Object.keys(waiting.discovered_repositories ?? {}).sort(),
      installations.map((item) => String(item.id)).sort(),
    );
    assertEquals(
      await count(f, "select count(*) from bakery.integration_resources"),
      0,
    );
    const connectionId = await assertOutcome(
      await githubSetup(f, {
        installation_id: String(installation.id),
        setup_action: "install",
        state,
      }),
      "pending",
    );
    await assertOnePendingConnection(f, created.id, connectionId, installation);
    await assertAdministeredResources(f, connectionId!, installation);
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_resources where connection_id <> $1",
        [connectionId],
      ),
      0,
    );
  });
});

Deno.test("an installation whose user administers no repository binds with no resources", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f, {
      repositories: () =>
        fakeRepositories(5, ["write", "read", "maintain", null]),
    });
    await githubSetup(f, {
      installation_id: String(installations[0].id),
      setup_action: "install",
      state,
    });
    const connectionId = await assertOutcome(
      await githubCallback(f, { code, state }),
      "pending",
    );
    await assertOnePendingConnection(
      f,
      created.id,
      connectionId,
      installations[0],
    );
    assertEquals(await resourceRows(f, connectionId!), []);
  });
});

Deno.test("a failed repository scan fails the attempt with repository_listing_failed and binds nothing", async () => {
  await withFixture(async (f) => {
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 2,
      repositories: () => fakeRepositories(4),
    });
    f.github.failures.repositories.add(installations[0].id);
    assertEquals(
      await assertOutcome(
        await githubCallback(f, { code, state }),
        "awaiting_installation",
      ),
      null,
    );
    const waiting = await attemptState(f, created.id);
    assertEquals(
      Object.keys(waiting.discovered_repositories ?? {}),
      [String(installations[1].id)],
      "a failed scan leaves no key",
    );
    assertEquals(
      await assertOutcome(
        await githubSetup(f, {
          installation_id: String(installations[0].id),
          setup_action: "install",
          state,
        }),
        "repository_listing_failed",
      ),
      null,
    );
    const failed = await attemptState(f, created.id);
    assertEquals(failed.status, "failed");
    assertEquals(failed.failure_code, "repository_listing_failed");
    assertEquals(
      f.github.calls.filter((call) => call.url.includes("/app/installations/")),
      [],
      "a missing scan fails before the App-JWT installation read",
    );
    assertEquals(failed.discovered_repositories, null);
    assertEquals(await connectionRows(f), []);
    assertEquals(await installationRows(f), []);
    assertEquals(
      await count(f, "select count(*) from bakery.integration_resources"),
      0,
    );
  });
});

Deno.test("a repository listing longer than the page cap is never recorded in part", async () => {
  await withFixture(async (f) => {
    f.github.repositoryListing.pageSize = 1;
    const { created, state, code, installations } = await connectionFlow(f, {
      repositories: () => fakeRepositories(MAX_REPOSITORY_PAGES + 1),
    });
    await githubSetup(f, {
      installation_id: String(installations[0].id),
      setup_action: "install",
      state,
    });
    assertEquals(
      await assertOutcome(
        await githubCallback(f, { code, state }),
        "repository_listing_failed",
      ),
      null,
    );
    assertEquals(repositoryCalls(f).length, MAX_REPOSITORY_PAGES);
    assertEquals((await attemptState(f, created.id)).status, "failed");
    assertEquals(
      f.github.calls.filter((call) => call.url.includes("/app/installations/")),
      [],
    );
    assertEquals(await connectionRows(f), []);
    assertEquals(
      await count(f, "select count(*) from bakery.integration_resources"),
      0,
    );
  });
});

async function listJson(
  f: GitHubAppFixture,
  path: string,
  cookie = f.adminCookie,
) {
  const response = await call(f, "GET", path, cookie, {
    headers: { "Bakery-Organization-Id": f.organizationId },
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    items: Record<string, unknown>[];
    nextCursor: string | null;
  };
}

/** Follows nextCursor from `path` to the end; returns every item in order. */
async function walk(
  f: GitHubAppFixture,
  path: string,
  cookie = f.adminCookie,
): Promise<{ items: Record<string, unknown>[]; pages: number }> {
  const items: Record<string, unknown>[] = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page = await listJson(
      f,
      cursor === null
        ? path
        : `${path}${separator}cursor=${encodeURIComponent(cursor)}`,
      cookie,
    );
    pages += 1;
    items.push(...page.items);
    if (page.nextCursor !== null) {
      assert(new TextEncoder().encode(page.nextCursor).length <= 512);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { items, pages };
}

Deno.test("integrationResources.list pages only the connection's resources to members, with filters", async () => {
  await withFixture(async (f) => {
    f.github.repositoryListing.pageSize = 4;
    const { state, code, installations } = await connectionFlow(f, {
      installations: 2,
      repositories: () => fakeRepositories(16),
    });
    const installation = installations[0];
    await githubSetup(f, {
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    const connectionId = (await assertOutcome(
      await githubCallback(f, { code, state }),
      "pending",
    ))!;
    const rows = await resourceRows(f, connectionId);
    assert(rows.length > 3, "enough administered repositories to page");
    const path = `${connectionsPath}/${connectionId}/resources`;
    for (const cookie of [f.adminCookie, f.developerCookie]) {
      for (
        const query of [
          "?limit=2",
          "?limit=2&kind=repository&selected=false&available=true",
        ]
      ) {
        const { items, pages } = await walk(f, `${path}${query}`, cookie);
        assert(pages > 1, "more than one page");
        assertEquals(
          items.map((item) => item.id).sort(),
          rows.map((row) => row.id).sort(),
        );
        assertEquals(new Set(items.map((item) => item.id)).size, items.length);
      }
    }
    const [first] = (await listJson(f, `${path}?limit=1`)).items;
    const row = rows.find((candidate) => candidate.id === first.id)!;
    assertEquals(Object.keys(first).sort(), [
      "archivedAt",
      "available",
      "capabilitySnapshot",
      "connectionId",
      "createdAt",
      "displayName",
      "enabled",
      "externalId",
      "id",
      "installationId",
      "kind",
      "lastDiscoveryGeneration",
      "organizationId",
      "safeUrl",
      "selected",
      "updatedAt",
      "version",
    ]);
    assertEquals(first.organizationId, f.organizationId);
    assertEquals(first.connectionId, connectionId);
    assertEquals(first.installationId, row.installation_id);
    assertEquals(first.externalId, row.external_id);
    assertEquals(first.displayName, row.display_name);
    assertEquals(first.safeUrl, row.safe_url);
    assertEquals(first.kind, "repository");
    assertEquals(first.selected, false);
    assertEquals(first.available, true);
    assertEquals(first.enabled, false);
    assertEquals(first.capabilitySnapshot, row.capability_snapshot);
    assertEquals(first.lastDiscoveryGeneration, 1);
    assertEquals(first.archivedAt, null);
    assertEquals(first.version, 1);
    // Filters narrow the page; nothing is selected or unavailable yet.
    assertEquals((await listJson(f, `${path}?selected=true`)).items, []);
    assertEquals((await listJson(f, `${path}?available=false`)).items, []);
    assertEquals((await listJson(f, `${path}?kind=team`)).items, []);
    await f.pgDatabase.query(
      "update bakery.integration_resources set selected = true where id = $1",
      [row.id],
    );
    assertEquals(
      (await listJson(f, `${path}?selected=true`)).items.map((item) => item.id),
      [row.id],
    );
    // An archived resource leaves the list.
    await f.pgDatabase.query(
      "update bakery.integration_resources set archived_at = now() where id = $1",
      [row.id],
    );
    assertEquals(
      (await walk(f, `${path}?limit=100`)).items.length,
      rows.length - 1,
    );
    // Unknown, malformed and archived connections.
    const unknown = await call(
      f,
      "GET",
      `${connectionsPath}/${crypto.randomUUID()}/resources`,
      f.adminCookie,
      { headers: { "Bakery-Organization-Id": f.organizationId } },
    );
    assertEquals(unknown.status, 404);
    assertEquals((await unknown.json()).code, "RESOURCE_NOT_FOUND");
    const malformed = await call(
      f,
      "GET",
      `${connectionsPath}/not-a-uuid/resources`,
      f.adminCookie,
      { headers: { "Bakery-Organization-Id": f.organizationId } },
    );
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();
    for (const query of ["?limit=0", "?limit=101", "?page=2", "?offset=5"]) {
      const response = await call(f, "GET", `${path}${query}`, f.adminCookie, {
        headers: { "Bakery-Organization-Id": f.organizationId },
      });
      assertEquals(response.status, 400, query);
      await response.body?.cancel();
    }
    await f.pgDatabase.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [connectionId],
    );
    const archived = await call(f, "GET", path, f.adminCookie, {
      headers: { "Bakery-Organization-Id": f.organizationId },
    });
    assertEquals(archived.status, 404);
    await archived.body?.cancel();
  });
});

Deno.test("integrationConnections.list pages the organization's live connections to members", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const bound: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { state, code, installations } = await connectionFlow(f, { app });
      await githubSetup(f, {
        installation_id: String(installations[0].id),
        setup_action: "install",
        state,
      });
      bound.push(
        (await assertOutcome(
          await githubCallback(f, { code, state }),
          "pending",
        ))!,
      );
    }
    for (const cookie of [f.adminCookie, f.developerCookie]) {
      const { items, pages } = await walk(
        f,
        `${connectionsPath}?limit=2`,
        cookie,
      );
      assertEquals(pages, 2);
      assertEquals(items.map((item) => item.id), [...bound].reverse());
      for (const item of items) {
        assertEquals(item.status, "pending");
        assertEquals(item.provider, "github");
      }
    }
    const one = await readConnection(f, bound[0]);
    const listed = (await walk(f, connectionsPath)).items.find((item) =>
      item.id === bound[0]
    );
    assertEquals(listed, await one.json());
    await f.pgDatabase.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [bound[1]],
    );
    assertEquals(
      (await walk(f, connectionsPath)).items.map((item) => item.id),
      [bound[2], bound[0]],
    );
  });
});

Deno.test("the per-callback page budget drops installations it cannot finish, and only those", async () => {
  await withFixture(async (f) => {
    f.github.repositoryListing.pageSize = 1;
    // Callback first, so all three installations are scanned in order: the
    // first outruns its own cap, the second completes, the third is cut off
    // when the callback's budget is spent.
    const sizes = [MAX_REPOSITORY_PAGES + 10, 40, 20];
    assert(
      MAX_REPOSITORY_PAGES + 40 < MAX_DISCOVERY_PAGES &&
        MAX_REPOSITORY_PAGES + 60 > MAX_DISCOVERY_PAGES,
    );
    const { created, state, code, installations } = await connectionFlow(f, {
      installations: 3,
      repositories: (index) =>
        fakeRepositories(sizes[index], ["admin", "read"]),
    });
    await assertOutcome(
      await githubCallback(f, { code, state }),
      "awaiting_installation",
    );
    assertEquals(repositoryCalls(f).length, MAX_DISCOVERY_PAGES);
    const waiting = await attemptState(f, created.id);
    assertEquals(
      Object.keys(waiting.discovered_repositories ?? {}),
      [String(installations[1].id)],
    );
    const connectionId = await assertOutcome(
      await githubSetup(f, {
        installation_id: String(installations[1].id),
        setup_action: "install",
        state,
      }),
      "pending",
    );
    await assertAdministeredResources(f, connectionId!, installations[1]);
  });
});

Deno.test("integrationConnections.create refuses GitHub with STATE_CONFLICT and binds no posted installation", async () => {
  await withFixture(async (f) => {
    const { installations } = await connectionFlow(f);
    const before = await connectionSnapshot(f);
    const body = (providerId: string) => ({
      providerId,
      name: "GitHub",
      settings: { installationId: String(installations[0].id) },
    });
    const github = await postConnection(f, body(GITHUB_PROVIDER_ID));
    assertEquals(github.status, 409, await github.clone().text());
    const problem = await github.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "auth_attempt_required");
    // No other provider is registered: any other id is unknown.
    const other = await postConnection(f, body(crypto.randomUUID()));
    assertEquals(other.status, 404);
    assertEquals((await other.json()).code, "RESOURCE_NOT_FOUND");
    const developer = await postConnection(f, body(GITHUB_PROVIDER_ID), {
      cookie: f.developerCookie,
    });
    assertEquals(developer.status, 403);
    await developer.body?.cancel();
    const keyless = await postConnection(f, body(GITHUB_PROVIDER_ID), {
      key: null,
    });
    assertEquals(keyless.status, 428);
    await keyless.body?.cancel();
    assertEquals(await connectionRows(f), []);
    assertEquals(await connectionSnapshot(f), before);
  });
});

/** A reconnect attempt body for `connectionId`. */
const reconnect = (connectionId: string) => ({
  body: { provider: "github", reconnectConnectionId: connectionId },
});

/** A connection row's identity and authorization columns. */
async function connectionIdentity(f: GitHubAppFixture, id: string) {
  const result = await f.pgDatabase.query<{
    installation_id: string;
    external_authorization_id: string;
    external_account_id: string;
    authorization_revision: number;
    status: string;
    granted_permissions: Record<string, string>;
    version: number;
  }>(
    `select installation_id, external_authorization_id, external_account_id,
       authorization_revision, status, granted_permissions, version
       from bakery.integration_connections where id = $1`,
    [id],
  );
  return result.rows[0];
}

Deno.test("a reconnect for the same installation and account keeps the connection and refreshes its authorization revision", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f, {
      repositories: () => fakeRepositories(2, ["admin"]),
    });
    const bound = await completeFlow(f, first);
    assertEquals(bound.outcome, "pending");
    const connectionId = bound.connectionId!;
    const before = await connectionIdentity(f, connectionId);
    const resourcesBefore = await resourceRows(f, connectionId);
    // The provider revoked it; the Admin reconnects with fresh permissions.
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'revoked' where id = $1",
      [connectionId],
    );
    first.installations[0].permissions = {
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    };
    const again = await connectionFlow(f, {
      app: first.app,
      existing: first.installations,
      attempt: reconnect(connectionId),
    });
    const attempt = (await attemptRows(f)).find((row) =>
      row.id === again.created.id
    )!;
    assertEquals(attempt.reconnect_connection_id, connectionId);
    const refreshed = await completeFlow(f, again);
    assertEquals(refreshed, { outcome: "refreshed", connectionId });
    const connections = await connectionRows(f);
    assertEquals(connections.map((row) => row.id), [connectionId]);
    const after = await connectionIdentity(f, connectionId);
    assertEquals(after.installation_id, before.installation_id);
    assertEquals(
      after.external_authorization_id,
      before.external_authorization_id,
    );
    assertEquals(after.external_account_id, before.external_account_id);
    assertEquals(after.authorization_revision, 2);
    assertEquals(after.status, "pending");
    assertEquals(after.granted_permissions, first.installations[0].permissions);
    assertEquals(await resourceRows(f, connectionId), resourcesBefore);
    const completed = await attemptState(f, again.created.id);
    assertEquals(completed.status, "completed");
    assertEquals(completed.result_connection_id, connectionId);
  });
});

Deno.test("a same-account reinstall reconnect moves the connection and its resources to the new installation", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f, {
      repositories: () => fakeRepositories(3, ["admin"]),
    });
    const connectionId = (await completeFlow(f, first)).connectionId!;
    const before = await connectionIdentity(f, connectionId);
    // The account uninstalled and reinstalled the App: a new installation id.
    const reinstalled = f.github.addInstallation(first.app, {
      account: { ...first.installations[0].account },
    });
    const again = await connectionFlow(f, {
      app: first.app,
      existing: [reinstalled],
      attempt: reconnect(connectionId),
    });
    assertEquals(await completeFlow(f, again), {
      outcome: "refreshed",
      connectionId,
    });
    const after = await connectionIdentity(f, connectionId);
    assertNotEquals(after.installation_id, before.installation_id);
    assertEquals(after.external_authorization_id, String(reinstalled.id));
    assertEquals(after.external_account_id, before.external_account_id);
    assertEquals(after.authorization_revision, 2);
    assertEquals((await connectionRows(f)).length, 1);
    const installations = await installationRows(f);
    assertEquals(installations.length, 2, "the old installation row stays");
    const resources = await resourceRows(f, connectionId);
    assertEquals(resources.length, 3);
    for (const resource of resources) {
      assertEquals(resource.installation_id, after.installation_id);
    }
  });
});

Deno.test("a reconnect for a different account creates a new pending connection and leaves the original unchanged", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f);
    const original = (await completeFlow(f, first)).connectionId!;
    const before = await connectionText(f, original);
    const again = await connectionFlow(f, {
      app: first.app,
      attempt: reconnect(original),
    });
    assertNotEquals(
      again.installations[0].account.id,
      first.installations[0].account.id,
    );
    const bound = await completeFlow(f, again);
    assertEquals(bound.outcome, "pending");
    assertNotEquals(bound.connectionId, original);
    assertEquals(await connectionText(f, original), before);
    const connections = await connectionRows(f);
    assertEquals(connections.map((row) => row.id), [
      original,
      bound.connectionId,
    ]);
    const created = connections[1];
    assertEquals(created.status, "pending");
    assertEquals(
      created.external_account_id,
      String(again.installations[0].account.id),
    );
    const attempt = await attemptState(f, again.created.id);
    assertEquals(attempt.result_connection_id, bound.connectionId);
  });
});

Deno.test("a reconnect whose target was archived before the bind fails reconnect_unavailable and binds nothing", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f);
    const original = (await completeFlow(f, first)).connectionId!;
    const again = await connectionFlow(f, {
      app: first.app,
      existing: first.installations,
      attempt: reconnect(original),
    });
    await f.pgDatabase.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [original],
    );
    const before = await connectionText(f, original);
    assertEquals(await completeFlow(f, again), {
      outcome: "reconnect_unavailable",
      connectionId: null,
    });
    assertEquals(await connectionText(f, original), before);
    assertEquals((await connectionRows(f)).length, 1);
    const attempt = await attemptState(f, again.created.id);
    assertEquals(attempt.status, "failed");
    assertEquals(attempt.failure_code, "reconnect_unavailable");
    // An archived target is also refused when a new attempt names it.
    const refused = await createAttempt(f, reconnect(original));
    assertEquals(refused.status, 404);
    assertEquals((await refused.json()).code, "RESOURCE_NOT_FOUND");
  });
});

Deno.test("a same-account reinstall reconnect fails already_connected when another connection holds the new installation", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f);
    const original = (await completeFlow(f, first)).connectionId!;
    const reinstalled = f.github.addInstallation(first.app, {
      account: { ...first.installations[0].account },
    });
    // The new installation is first connected on its own.
    const separate = await connectionFlow(f, {
      app: first.app,
      existing: [reinstalled],
    });
    const holder = (await completeFlow(f, separate)).connectionId!;
    const before = await connectionText(f, original);
    const again = await connectionFlow(f, {
      app: first.app,
      existing: [reinstalled],
      attempt: reconnect(original),
    });
    assertEquals(await completeFlow(f, again), {
      outcome: "already_connected",
      connectionId: null,
    });
    assertEquals(await connectionText(f, original), before);
    assertEquals((await connectionRows(f)).map((row) => row.id), [
      original,
      holder,
    ]);
    assertEquals((await attemptState(f, again.created.id)).status, "failed");
  });
});

/** The stored state of one connection and its resources. */
async function connectionState(f: GitHubAppFixture, connectionId: string) {
  const connection = (await f.pgDatabase.query<{
    label: string;
    status: string;
    health: string;
    version: number;
  }>(
    `select label, status, health, version
       from bakery.integration_connections where id = $1`,
    [connectionId],
  )).rows[0];
  const resources = await resourceRows(f, connectionId);
  return { ...connection, resources };
}

async function problem(response: Response, status: number, code: string) {
  const body = await response.text();
  assertEquals(response.status, status, body);
  const parsed = JSON.parse(body);
  assertEquals(parsed.code, code, body);
  return parsed as { code: string; reason?: string };
}

Deno.test("an Admin selects an available repository with a matching If-Match after a live narrowed recheck", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources, installation } = await pendingConnection(
      f,
    );
    const [target] = resources;
    assertEquals(await connectionVersion(f, connectionId), 1);
    const response = await patchResource(f, connectionId, target.id, {
      selected: true,
    });
    const body = await response.text();
    assertEquals(response.status, 200, body);
    const resource = JSON.parse(body);
    assertEquals(resource.id, target.id);
    assertEquals(resource.selected, true);
    assertEquals(resource.version, 2);
    assertEquals(resource.enabled, false, "selection does not enable it");
    const state = await connectionState(f, connectionId);
    assertEquals(state.version, 2, "the connection version increments");
    assertEquals(state.status, "pending");
    assertEquals(
      state.resources.filter((row) => row.selected).map((row) => row.id),
      [target.id],
    );
    // One live recheck by stable ids: the installation read, then one
    // metadata-only token narrowed to this repository, revoked at once and
    // never stored.
    assertEquals(f.github.calls.map((call) => call.method), [
      "GET",
      "POST",
      "DELETE",
    ]);
    assertEquals(f.github.tokenRequests.at(-1), {
      installationId: installation.id,
      repositoryIds: [Number(target.external_id)],
      permissions: { metadata: "read" },
    });
    const token = f.github.issuedTokens.at(-1)!;
    assertEquals(f.github.revokedTokens.at(-1), token);
    assert(!body.includes(token), "the probe token never reaches the client");
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.idempotency_records
          where response_body like '%' || $1 || '%'`,
        [token],
      ),
      0,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationResources.update' and resource_id = $1
            and organization_id = $2`,
        [target.id, f.organizationId],
      ),
      1,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.domain_events
          where organization_id = $1 and event_type = $2
            and aggregate_id = $3 and aggregate_version = 2`,
        [f.organizationId, "integration.resources_changed", target.id],
      ),
      1,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.domain_events
          where organization_id = $1 and event_type = $2
            and aggregate_id = $3 and aggregate_version = 2`,
        [f.organizationId, "integrationConnections.updated", connectionId],
      ),
      1,
    );
  });
});

Deno.test("an Admin deselects a repository without any GitHub call", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [target] = resources;
    await (await patchResource(f, connectionId, target.id, { selected: true }))
      .body?.cancel();
    f.github.calls.length = 0;
    const response = await patchResource(f, connectionId, target.id, {
      selected: false,
    });
    const body = await response.text();
    assertEquals(response.status, 200, body);
    assertEquals(JSON.parse(body).selected, false);
    assertEquals(f.github.calls.length, 0, "removing authority needs none");
    const state = await connectionState(f, connectionId);
    assertEquals(state.version, 3);
    assertEquals(state.resources.filter((row) => row.selected), []);
  });
});

Deno.test("enabling a connection with a selected repository sets it enabled and keeps its health", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    await (await patchResource(f, connectionId, resources[0].id, {
      selected: true,
    })).body?.cancel();
    const before = await connectionState(f, connectionId);
    assertEquals(before.health, "unknown");
    const response = await patchConnection(f, connectionId, { enabled: true });
    const body = await response.text();
    assertEquals(response.status, 200, body);
    const connection = JSON.parse(body);
    assertEquals(connection.id, connectionId);
    assertEquals(connection.status, "enabled");
    assertEquals(connection.version, before.version + 1);
    const after = await connectionState(f, connectionId);
    assertEquals(after.status, "enabled");
    assertEquals(after.health, before.health, "health is unchanged");
    assertEquals(after.version, before.version + 1);
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationConnections.update' and resource_id = $1`,
        [connectionId],
      ),
      1,
    );
    // Reads agree with the write.
    const read = await readConnection(f, connectionId);
    assertEquals((await read.json()).status, "enabled");
  });
});

Deno.test("enabling a connection with no selected repository is 409 STATE_CONFLICT and keeps its status", async () => {
  await withFixture(async (f) => {
    const { connectionId } = await pendingConnection(f);
    const before = await connectionSnapshot(f);
    const refused = await problem(
      await patchConnection(f, connectionId, { enabled: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(refused.reason, "no_selected_resource");
    assertEquals(await connectionSnapshot(f), before, "nothing changed");
    assertEquals((await connectionState(f, connectionId)).status, "pending");
  });
});

Deno.test("a stale If-Match is 412 PRECONDITION_FAILED on both edits and changes nothing", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    await (await patchResource(f, connectionId, resources[0].id, {
      selected: true,
    })).body?.cancel();
    f.github.calls.length = 0;
    const before = await connectionSnapshot(f);
    for (const stale of [versionTag(1), versionTag(7)]) {
      await problem(
        await patchResource(f, connectionId, resources[1].id, {
          selected: true,
        }, { ifMatch: stale }),
        412,
        "PRECONDITION_FAILED",
      );
      await problem(
        await patchConnection(f, connectionId, { enabled: true }, {
          ifMatch: stale,
        }),
        412,
        "PRECONDITION_FAILED",
      );
      await problem(
        await patchConnection(f, connectionId, { name: "Renamed" }, {
          ifMatch: stale,
        }),
        412,
        "PRECONDITION_FAILED",
      );
    }
    assertEquals(await connectionSnapshot(f), before, "nothing changed");
    assertEquals(f.github.calls.length, 0, "a stale edit asks GitHub nothing");
  });
});

Deno.test("disabling keeps selections, a label edit renames, and an enabled connection keeps one selection", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [first, second] = resources;
    for (const resource of [first, second]) {
      await (await patchResource(f, connectionId, resource.id, {
        selected: true,
      })).body?.cancel();
    }
    await (await patchConnection(f, connectionId, { enabled: true })).body
      ?.cancel();
    // The last selection of an enabled connection stays until it is disabled.
    await (await patchResource(f, connectionId, first.id, { selected: false }))
      .body?.cancel();
    const before = await connectionSnapshot(f);
    const last = await problem(
      await patchResource(f, connectionId, second.id, { selected: false }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(last.reason, "no_selected_resource");
    assertEquals(await connectionSnapshot(f), before);
    const disabled = await patchConnection(f, connectionId, {
      enabled: false,
      name: "  Team repositories  ",
    });
    const body = await disabled.text();
    assertEquals(disabled.status, 200, body);
    assertEquals(JSON.parse(body).status, "disabled");
    assertEquals(JSON.parse(body).label, "Team repositories");
    const state = await connectionState(f, connectionId);
    assertEquals(state.status, "disabled");
    assertEquals(state.label, "Team repositories");
    assertEquals(
      state.resources.filter((row) => row.selected).map((row) => row.id),
      [second.id],
      "disabling keeps the selection",
    );
    // A disabled connection may drop its last selection, and re-enabling
    // then needs a new one.
    await (await patchResource(f, connectionId, second.id, { selected: false }))
      .body?.cancel();
    await problem(
      await patchConnection(f, connectionId, { enabled: true }),
      409,
      "STATE_CONFLICT",
    );
    const renamed = await patchConnection(f, connectionId, { name: "Ops" });
    assertEquals(renamed.status, 200, await renamed.clone().text());
    assertEquals((await renamed.json()).status, "disabled");
  });
});

Deno.test("edits refuse unsupported or empty input, and missing headers, before any write", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [target] = resources;
    const before = await connectionSnapshot(f);
    for (
      const body of [{}, { settings: {} }, { name: "   " }, {
        name: "x",
        settings: { a: 1 },
      }]
    ) {
      await problem(
        await patchConnection(f, connectionId, body),
        422,
        "UNPROCESSABLE",
      );
    }
    for (
      const body of [{}, { enabled: true }, { displayName: "Renamed" }, {
        selected: true,
        enabled: true,
      }]
    ) {
      await problem(
        await patchResource(f, connectionId, target.id, body),
        422,
        "UNPROCESSABLE",
      );
    }
    for (const options of [{ ifMatch: null }, { key: null }]) {
      await problem(
        await patchConnection(f, connectionId, { enabled: false }, options),
        428,
        "PRECONDITION_REQUIRED",
      );
      await problem(
        await patchResource(
          f,
          connectionId,
          target.id,
          { selected: true },
          options,
        ),
        428,
        "PRECONDITION_REQUIRED",
      );
    }
    for (const ifMatch of ["1", 'W/"1"', '"0"', "*"]) {
      const response = await patchResource(f, connectionId, target.id, {
        selected: true,
      }, { ifMatch });
      assert(
        response.status === 412 || response.status === 428,
        `${ifMatch} ${response.status}`,
      );
      await response.body?.cancel();
    }
    assertEquals(await connectionSnapshot(f), before);
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("a replayed edit returns the stored response without a second GitHub call or write", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [target, other] = resources;
    const key = crypto.randomUUID();
    const ifMatch = versionTag(1);
    const first = await patchResource(f, connectionId, target.id, {
      selected: true,
    }, { key, ifMatch });
    const firstBody = await first.text();
    assertEquals(first.status, 200, firstBody);
    const calls = f.github.calls.length;
    const before = await connectionSnapshot(f);
    const replay = await patchResource(f, connectionId, target.id, {
      selected: true,
    }, { key, ifMatch });
    assertEquals(replay.status, 200);
    assertEquals(replay.headers.get("idempotent-replayed"), "true");
    assertEquals(await replay.text(), firstBody);
    assertEquals(f.github.calls.length, calls, "a replay asks GitHub nothing");
    assertEquals(await connectionSnapshot(f), before);
    // The same key with another body is a payload mismatch.
    await problem(
      await patchResource(f, connectionId, other.id, { selected: true }, {
        key,
        ifMatch,
      }),
      422,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    assertEquals(await connectionSnapshot(f), before);
  });
});

Deno.test("selection is refused when the live recheck or the stored state says the repository is unavailable", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources, installation } = await pendingConnection(
      f,
    );
    const [removed, unavailable, kept] = resources;
    const before = await connectionSnapshot(f);
    // The installation no longer covers the repository.
    installation.repositories = installation.repositories.filter((repository) =>
      String(repository.id) !== removed.external_id
    );
    const gone = await problem(
      await patchResource(f, connectionId, removed.id, { selected: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(gone.reason, "resource_unavailable");
    // A resource the last discovery no longer found is refused before GitHub.
    await f.pgDatabase.query(
      "update bakery.integration_resources set available = false where id = $1",
      [unavailable.id],
    );
    const snapshot = await connectionSnapshot(f);
    f.github.calls.length = 0;
    const stale = await problem(
      await patchResource(f, connectionId, unavailable.id, { selected: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(stale.reason, "resource_unavailable");
    assertEquals(f.github.calls.length, 0);
    assertEquals(await connectionSnapshot(f), snapshot);
    // GitHub reports the installation suspended.
    installation.suspendedAt = "2026-10-27T12:00:00Z";
    await problem(
      await patchResource(f, connectionId, kept.id, { selected: true }),
      409,
      "STATE_CONFLICT",
    );
    installation.suspendedAt = null;
    // A provider failure is 503 and changes nothing.
    f.github.failures.tokens.add(installation.id);
    await problem(
      await patchResource(f, connectionId, kept.id, { selected: true }),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
    f.github.failures.tokens.delete(installation.id);
    assertEquals(await connectionSnapshot(f), snapshot);
    assert(before !== snapshot, "only the direct availability update changed");
    // A locally suspended installation refuses selecting and enabling.
    await f.pgDatabase.query(
      `update bakery.integration_installations set status = 'suspended'
        where id = (select installation_id from bakery.integration_connections
          where id = $1)`,
      [connectionId],
    );
    f.github.calls.length = 0;
    const local = await problem(
      await patchResource(f, connectionId, kept.id, { selected: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(local.reason, "installation_unavailable");
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("edits of an unknown, archived or revoked connection or an unknown resource change nothing", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const before = await connectionSnapshot(f);
    await problem(
      await patchConnection(f, crypto.randomUUID(), { enabled: false }, {
        ifMatch: versionTag(1),
      }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await problem(
      await patchResource(f, connectionId, crypto.randomUUID(), {
        selected: true,
      }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await f.pgDatabase.query(
      "update bakery.integration_resources set archived_at = now() where id = $1",
      [resources[0].id],
    );
    await problem(
      await patchResource(f, connectionId, resources[0].id, {
        selected: true,
      }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await f.pgDatabase.query(
      "update bakery.integration_resources set archived_at = null where id = $1",
      [resources[0].id],
    );
    assertEquals(await connectionSnapshot(f), before);
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'revoked' where id = $1",
      [connectionId],
    );
    const revoked = await problem(
      await patchConnection(f, connectionId, { name: "x" }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(revoked.reason, "connection_revoked");
    await f.pgDatabase.query(
      "update bakery.integration_connections set archived_at = now() where id = $1",
      [connectionId],
    );
    await problem(
      await patchConnection(f, connectionId, { name: "x" }),
      404,
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("a pending connection cannot be disabled, and enabling needs an available selection and an active installation", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [first, second] = resources;
    let before = await connectionSnapshot(f);
    // pending -> enabled <-> disabled.
    const pending = await problem(
      await patchConnection(f, connectionId, { enabled: false }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(pending.reason, "connection_pending");
    assertEquals(await connectionSnapshot(f), before);
    // A selection the last complete discovery no longer found does not count.
    await (await patchResource(f, connectionId, first.id, { selected: true }))
      .body?.cancel();
    await f.pgDatabase.query(
      "update bakery.integration_resources set available = false where id = $1",
      [first.id],
    );
    before = await connectionSnapshot(f);
    const unavailable = await problem(
      await patchConnection(f, connectionId, { enabled: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(unavailable.reason, "no_selected_resource");
    assertEquals(await connectionSnapshot(f), before);
    // A suspended installation refuses enabling even with a usable selection.
    await (await patchResource(f, connectionId, second.id, { selected: true }))
      .body?.cancel();
    await f.pgDatabase.query(
      `update bakery.integration_installations set status = 'suspended'
        where id = (select installation_id from bakery.integration_connections
          where id = $1)`,
      [connectionId],
    );
    before = await connectionSnapshot(f);
    f.github.calls.length = 0;
    const suspended = await problem(
      await patchConnection(f, connectionId, { enabled: true }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(suspended.reason, "installation_unavailable");
    assertEquals(await connectionSnapshot(f), before);
    assertEquals(f.github.calls.length, 0, "enabling never asks GitHub");
    assertEquals((await connectionState(f, connectionId)).status, "pending");
  });
});

Deno.test("a connection edit committed during the live recheck makes the selection 412 and writes nothing", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [target] = resources;
    // Another Admin request renames the connection while GitHub is asked.
    let raced = false;
    f.github.hooks.beforeResponse = async (request) => {
      if (raced || !request.url.endsWith("/access_tokens")) return;
      raced = true;
      const renamed = await patchConnection(f, connectionId, { name: "Raced" });
      assertEquals(renamed.status, 200, await renamed.clone().text());
      await renamed.body?.cancel();
    };
    const before = await connectionState(f, connectionId);
    try {
      const response = await patchResource(f, connectionId, target.id, {
        selected: true,
      }, { ifMatch: versionTag(before.version) });
      await problem(response, 412, "PRECONDITION_FAILED");
    } finally {
      f.github.hooks.beforeResponse = null;
    }
    assert(raced, "the rename ran during the recheck");
    const after = await connectionState(f, connectionId);
    assertEquals(after.version, before.version + 1, "only the rename wrote");
    assertEquals(after.label, "Raced");
    assertEquals(after.resources, before.resources, "no selection written");
    assertEquals(
      f.github.revokedTokens.length,
      f.github.issuedTokens.filter((token) => token.startsWith("ghs_")).length,
      "the probe token is revoked even when the write loses",
    );
  });
});

Deno.test("a rate-limited recheck is 503 DEPENDENCY_UNAVAILABLE, not an unavailable repository", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources, installation } = await pendingConnection(
      f,
    );
    const before = await connectionSnapshot(f);
    f.github.failures.rateLimited.add(installation.id);
    await problem(
      await patchResource(f, connectionId, resources[0].id, {
        selected: true,
      }),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
    assertEquals(await connectionSnapshot(f), before);
  });
});

Deno.test("an edit carrying the version from before a reconnect is 412, and the refreshed version selects", async () => {
  await withFixture(async (f) => {
    const first = await connectionFlow(f, {
      repositories: () => fakeRepositories(2, ["admin"]),
    });
    const bound = await completeFlow(f, first);
    assertEquals(bound.outcome, "pending");
    const connectionId = bound.connectionId!;
    const [target] = await resourceRows(f, connectionId);
    const stale = await connectionVersion(f, connectionId);
    // The provider revoked it; the Admin reconnects the same account.
    await f.pgDatabase.query(
      "update bakery.integration_connections set status = 'revoked' where id = $1",
      [connectionId],
    );
    const again = await connectionFlow(f, {
      app: first.app,
      existing: first.installations,
      attempt: reconnect(connectionId),
    });
    assertEquals((await completeFlow(f, again)).outcome, "refreshed");
    const refreshed = await connectionVersion(f, connectionId);
    assert(refreshed > stale, "the reconnect moved the connection version");
    f.github.calls.length = 0;
    const before = await connectionSnapshot(f);
    await problem(
      await patchResource(f, connectionId, target.id, { selected: true }, {
        ifMatch: versionTag(stale),
      }),
      412,
      "PRECONDITION_FAILED",
    );
    await problem(
      await patchConnection(f, connectionId, { name: "Stale" }, {
        ifMatch: versionTag(stale),
      }),
      412,
      "PRECONDITION_FAILED",
    );
    assertEquals(await connectionSnapshot(f), before, "nothing changed");
    assertEquals(f.github.calls.length, 0, "a stale edit asks GitHub nothing");
    const selected = await patchResource(f, connectionId, target.id, {
      selected: true,
    }, { ifMatch: versionTag(refreshed) });
    assertEquals(selected.status, 200, await selected.clone().text());
    assertEquals((await selected.json()).selected, true);
    assertEquals(await connectionVersion(f, connectionId), refreshed + 1);
  });
});

/**
 * Two organizations' pending connections to one shared installation, each
 * holding its own resource row for every repository the installation
 * covers. `pair(i)` is the two rows for repository i.
 */
async function sharedInstallation(f: GitHubAppFixture) {
  const first = await pendingConnection(f);
  const secondId = await secondOrganization(f);
  const second = await pendingConnection(f, {
    app: first.app,
    existing: first.installation,
    attempt: { organizationId: secondId },
  });
  assertEquals(second.resources.length, first.resources.length);
  const pair = (index: number) => {
    const own = first.resources[index];
    const other = second.resources.find((row) =>
      row.external_id === own.external_id
    )!;
    assertEquals(own.installation_id, other.installation_id);
    return { first: own, second: other };
  };
  return { first, second, secondId, pair };
}

/** Live selected rows for one installation repository, across organizations. */
async function selectedHolders(f: GitHubAppFixture, externalId: string) {
  const result = await f.pgDatabase.query<{ organization_id: string }>(
    `select organization_id from bakery.integration_resources
      where external_id = $1 and selected and archived_at is null
      order by organization_id`,
    [externalId],
  );
  return result.rows.map((row) => row.organization_id);
}

Deno.test("two organizations racing to select one repository: exactly one request is accepted", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId, pair } = await sharedInstallation(f);
    const target = pair(0);
    const perOrganization = 3;
    // Every request passes the probe and reaches GitHub before any of them
    // writes, so only the database can pick the winner.
    let arrived = 0;
    let release = () => {};
    const together = new Promise<void>((resolve) => release = resolve);
    f.github.hooks.beforeResponse = async (request) => {
      if (!request.url.endsWith("/access_tokens")) return;
      arrived += 1;
      if (arrived === perOrganization * 2) release();
      await together;
    };
    const firstVersion = await connectionVersion(f, first.connectionId);
    const secondVersion = await connectionVersion(f, second.connectionId);
    let responses: { organizationId: string; status: number; body: string }[];
    try {
      responses = await Promise.all([
        ...Array.from({ length: perOrganization }, () => ({
          organizationId: f.organizationId,
          connectionId: first.connectionId,
          resourceId: target.first.id,
          version: firstVersion,
        })),
        ...Array.from({ length: perOrganization }, () => ({
          organizationId: secondId,
          connectionId: second.connectionId,
          resourceId: target.second.id,
          version: secondVersion,
        })),
      ].map(async (request) => {
        const response = await patchResource(
          f,
          request.connectionId,
          request.resourceId,
          { selected: true },
          {
            organizationId: request.organizationId,
            ifMatch: versionTag(request.version),
          },
        );
        return {
          organizationId: request.organizationId,
          status: response.status,
          body: await response.text(),
        };
      }));
    } finally {
      f.github.hooks.beforeResponse = null;
    }
    assertEquals(arrived, perOrganization * 2, "all reached GitHub together");
    const accepted = responses.filter((response) => response.status === 200);
    assertEquals(accepted.length, 1, JSON.stringify(responses));
    const winner = accepted[0].organizationId;
    const winning = winner === f.organizationId
      ? { connectionId: first.connectionId, resourceId: target.first.id }
      : { connectionId: second.connectionId, resourceId: target.second.id };
    for (const response of responses) {
      if (response === accepted[0]) continue;
      const parsed = JSON.parse(response.body);
      if (response.organizationId === winner) {
        // Lost to its own organization's write on the connection version.
        assertEquals(response.status, 412, response.body);
        assertEquals(parsed.code, "PRECONDITION_FAILED");
        continue;
      }
      // Lost to the other organization: the repository is unavailable, and
      // nothing names who holds it.
      assertEquals(response.status, 409, response.body);
      assertEquals(parsed.code, "STATE_CONFLICT");
      assertEquals(parsed.reason, "resource_unavailable");
      for (
        const hidden of [winner, winning.connectionId, winning.resourceId]
      ) {
        assert(!response.body.includes(hidden), "names the winner");
      }
    }
    assertEquals(await selectedHolders(f, target.first.external_id), [winner]);
    // The losing organization wrote nothing: no version, audit or event.
    const loser = winner === f.organizationId
      ? {
        organizationId: secondId,
        connection: second,
        resource: target.second,
      }
      : {
        organizationId: f.organizationId,
        connection: first,
        resource: target.first,
      };
    assertEquals(
      await connectionVersion(f, loser.connection.connectionId),
      winner === f.organizationId ? secondVersion : firstVersion,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.audit_events
          where operation = 'integrationResources.update'
            and organization_id = $1`,
        [loser.organizationId],
      ),
      0,
    );
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.domain_events
          where organization_id = $1 and aggregate_id = any($2::uuid[])`,
        [loser.organizationId, [
          loser.resource.id,
          loser.connection.connectionId,
        ]],
      ),
      0,
    );
  });
});

Deno.test("a repository another organization selected is refused before GitHub, and deselecting or archiving releases it", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId, pair } = await sharedInstallation(f);
    const target = pair(0);
    const selectSecond = () =>
      patchResource(f, second.connectionId, target.second.id, {
        selected: true,
      }, { organizationId: secondId });
    const taken = await patchResource(f, first.connectionId, target.first.id, {
      selected: true,
    });
    assertEquals(taken.status, 200, await taken.text());
    const before = await connectionState(f, second.connectionId);
    f.github.calls.length = 0;
    const refused = await problem(await selectSecond(), 409, "STATE_CONFLICT");
    assertEquals(refused.reason, "resource_unavailable");
    assertEquals(f.github.calls.length, 0, "refused in the probe");
    assertEquals(await connectionState(f, second.connectionId), before);
    // Another repository of the same installation stays selectable.
    const other = pair(1);
    const free = await patchResource(f, second.connectionId, other.second.id, {
      selected: true,
    }, { organizationId: secondId });
    assertEquals(free.status, 200, await free.text());
    // Deselecting releases the repository for the other organization.
    const released = await patchResource(
      f,
      first.connectionId,
      target.first.id,
      { selected: false },
    );
    assertEquals(released.status, 200, await released.text());
    const now = await selectSecond();
    assertEquals(now.status, 200, await now.text());
    assertEquals(await selectedHolders(f, target.first.external_id), [
      secondId,
    ]);
    // An archived selection no longer reserves the repository either.
    await f.pgDatabase.query(
      "update bakery.integration_resources set archived_at = now() where id = $1",
      [other.second.id],
    );
    const reclaimed = await patchResource(
      f,
      first.connectionId,
      other.first.id,
      { selected: true },
    );
    assertEquals(reclaimed.status, 200, await reclaimed.text());
  });
});

Deno.test("a disabled connection keeps its selected repositories reserved against other organizations", async () => {
  await withFixture(async (f) => {
    const { first, second, secondId, pair } = await sharedInstallation(f);
    const target = pair(0);
    for (
      const response of [
        await patchResource(f, first.connectionId, target.first.id, {
          selected: true,
        }),
        await patchConnection(f, first.connectionId, { enabled: true }),
        await patchConnection(f, first.connectionId, { enabled: false }),
      ]
    ) {
      assertEquals(response.status, 200, await response.text());
    }
    assertEquals(
      (await connectionState(f, first.connectionId)).status,
      "disabled",
    );
    const refused = await problem(
      await patchResource(f, second.connectionId, target.second.id, {
        selected: true,
      }, { organizationId: secondId }),
      409,
      "STATE_CONFLICT",
    );
    assertEquals(refused.reason, "resource_unavailable");
    assertEquals(await selectedHolders(f, target.first.external_id), [
      f.organizationId,
    ]);
    // Re-enabling needs no new selection: the reservation was kept.
    const enabled = await patchConnection(f, first.connectionId, {
      enabled: true,
    });
    assertEquals(enabled.status, 200, await enabled.text());
  });
});

Deno.test("a same-account reinstall reconnect fails reconnect_unavailable when another organization holds one of its selections there", async () => {
  await withFixture(async (f) => {
    const first = await pendingConnection(f);
    const [target] = first.resources;
    const selected = await patchResource(
      f,
      first.connectionId,
      target.id,
      { selected: true },
    );
    assertEquals(selected.status, 200, await selected.text());
    // The account reinstalls the App; the new installation covers the same
    // repositories, and a second organization connects it and selects one.
    const reinstalled = f.github.addInstallation(first.app, {
      account: { ...first.installation.account },
      repositories: first.installation.repositories,
    });
    const secondId = await secondOrganization(f);
    const holder = await pendingConnection(f, {
      app: first.app,
      existing: reinstalled,
      attempt: { organizationId: secondId },
    });
    const held = holder.resources.find((row) =>
      row.external_id === target.external_id
    )!;
    const taken = await patchResource(f, holder.connectionId, held.id, {
      selected: true,
    }, { organizationId: secondId });
    assertEquals(taken.status, 200, await taken.text());
    const before = await connectionText(f, first.connectionId);
    const resourcesBefore = await resourceRows(f, first.connectionId);
    const again = await connectionFlow(f, {
      app: first.app,
      existing: [reinstalled],
      attempt: reconnect(first.connectionId),
    });
    assertEquals(await completeFlow(f, again), {
      outcome: "reconnect_unavailable",
      connectionId: null,
    });
    assertEquals(await connectionText(f, first.connectionId), before);
    assertEquals(await resourceRows(f, first.connectionId), resourcesBefore);
    assertEquals((await attemptState(f, again.created.id)).status, "failed");
    // Each organization keeps its selection on its own installation.
    assertEquals(
      (await selectedHolders(f, target.external_id)).sort(),
      [f.organizationId, secondId].sort(),
    );
  });
});

/** One effect of a connection's resource, as an executor would leave it. */
async function seedConnectionEffect(
  f: GitHubAppFixture,
  connectionId: string,
  resourceId: string,
  status: "confirmed" | "failed" | "uncertain",
): Promise<string> {
  const id = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.external_effects (
       id, organization_id, operation, action_version, target,
       integration_connection_id, integration_resource_id,
       integration_install_id, requesting_principal_id, actor_ref,
       idempotency_key, request_digest, external_account_id,
       external_resource_id, adapter_version, authorization_revision, status,
       safe_arguments
     )
     select $1, connection.organization_id, 'github.issue.comment.create', 1,
       'resource:' || resource.id, connection.id, resource.id, 'inst-1', $4,
       $4, $5, repeat('a', 64), connection.external_account_id,
       resource.external_id, 'github@2026-03-10',
       connection.authorization_revision, $6, '{"body":"secret-ish"}'::jsonb
       from bakery.integration_connections connection
       join bakery.integration_resources resource
         on resource.connection_id = connection.id
      where connection.id = $2 and resource.id = $3`,
    [id, connectionId, resourceId, f.adminId, `activity-${id}`, status],
  );
  return id;
}

Deno.test("a connection's recent activity lists its effects with their outcome, unknown included, and nothing internal (#68)", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const [resource] = resources;
    const confirmed = await seedConnectionEffect(
      f,
      connectionId,
      resource.id,
      "confirmed",
    );
    const unknown = await seedConnectionEffect(
      f,
      connectionId,
      resource.id,
      "uncertain",
    );
    const path = `${connectionsPath}/${connectionId}/effects`;
    const headers = { "Bakery-Organization-Id": f.organizationId };

    const all = await call(f, "GET", path, f.developerCookie, { headers });
    const body = await all.text();
    assertEquals(all.status, 200, body);
    const page = JSON.parse(body);
    assertEquals(
      page.items.map((item: { id: string }) => item.id).sort(),
      [confirmed, unknown].sort(),
    );
    assert(!body.includes("secret-ish"), "arguments stay internal");

    const uncertain = await call(
      f,
      "GET",
      `${path}?status=uncertain`,
      f.developerCookie,
      { headers },
    );
    assertEquals(uncertain.status, 200, await uncertain.clone().text());
    const filtered = await uncertain.json();
    assertEquals(filtered.items.map((item: { id: string }) => item.id), [
      unknown,
    ]);
    assertEquals(filtered.items[0].status, "uncertain");

    const one = await call(
      f,
      "GET",
      `${path}/${unknown}`,
      f.developerCookie,
      { headers },
    );
    assertEquals(one.status, 200, await one.clone().text());
    const effect = await one.json();
    assertEquals(effect.id, unknown);
    assertEquals(effect.integrationConnectionId, connectionId);

    // Another organization sees neither the list nor the effect.
    const otherOrganization = await secondOrganization(f);
    const foreignHeaders = { "Bakery-Organization-Id": otherOrganization };
    const foreignList = await call(f, "GET", path, f.adminCookie, {
      headers: foreignHeaders,
    });
    assertEquals(foreignList.status, 404, await foreignList.clone().text());
    const foreignOne = await call(
      f,
      "GET",
      `${path}/${unknown}`,
      f.adminCookie,
      {
        headers: foreignHeaders,
      },
    );
    assertEquals(foreignOne.status, 404, await foreignOne.clone().text());
  });
});
