import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  decryptAuthAttemptVerifier,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import {
  type AttemptCreated,
  attemptRows,
  begin,
  callback,
  connectionFlow,
  connectionLocation,
  connectionRows,
  connectionSnapshot,
  connectionsPath,
  connectionVersion,
  count,
  createdAttempt,
  existingAppBody,
  type GitHubAppFixture,
  githubCallback,
  githubSetup,
  oauthCallbackPath,
  openGitHubAppFixture,
  patchConnection,
  patchResource,
  pendingConnection,
  put,
  readAttempt,
  readRegistration,
  registerApp,
  registrationFacts,
  registrationPath,
  secondOrganization,
  settingsLocation,
  setupPath,
  started,
  versionTag,
} from "../helpers/github-app-registration.ts";
import { call, grant, signIn } from "../helpers/installation-settings.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import { mintToken } from "../helpers/access-tokens.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/** A refused callback: redirected as state_rejected, no GitHub call, nothing stored. */
async function assertRefused(
  f: GitHubAppFixture,
  response: Response,
  before: Awaited<ReturnType<typeof registrationFacts>>,
) {
  assertEquals(response.status, 303, await response.clone().text());
  assertEquals(
    response.headers.get("location"),
    settingsLocation("state_rejected"),
  );
  assertEquals(f.github.calls.length, 0, "refused callbacks never call GitHub");
  const after = await registrationFacts(f);
  assertEquals(after.registrations, 0);
  assertEquals(after.installationSecrets, 0);
  assertEquals(after.consumed, before.consumed);
}

Deno.test("an unknown state is refused without a GitHub call", async () => {
  await withFixture(async (f) => {
    await started(f);
    const before = await registrationFacts(f);
    const { code } = f.github.issueCode();
    const response = await callback(f, {
      code,
      state: "A".repeat(43),
    });
    await assertRefused(f, response, before);
  });
});

Deno.test("an expired state is refused without a GitHub call", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    await f.pgDatabase.query(
      `update bakery.integration_app_registration_attempts
       set expires_at = now() - interval '1 second'`,
    );
    const before = await registrationFacts(f);
    const { code } = f.github.issueCode();
    await assertRefused(
      f,
      await callback(f, { code, state: start.state }),
      before,
    );
  });
});

Deno.test("an already used state is refused without a GitHub call", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const first = await callback(f, {
      code: "never-issued",
      state: start.state,
    });
    assertEquals(
      first.headers.get("location"),
      settingsLocation("conversion_failed"),
    );
    assertEquals(f.github.calls.length, 1);
    f.github.calls.length = 0;
    const before = await registrationFacts(f);
    const { code } = f.github.issueCode();
    await assertRefused(
      f,
      await callback(f, { code, state: start.state }),
      before,
    );
  });
});

Deno.test("a state issued to another session of the same administrator is refused", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    const otherSession = await signIn(f, f.adminEmail, f.password);
    assert(otherSession !== f.adminCookie);
    const before = await registrationFacts(f);
    const { code } = f.github.issueCode();
    await assertRefused(
      f,
      await callback(f, { code, state: start.state }, otherSession),
      before,
    );
    // The issuing session can still complete it.
    const done = await callback(f, { code, state: start.state });
    assertEquals(done.headers.get("location"), settingsLocation("registered"));
  });
});

Deno.test("a state issued to another administrator is refused", async () => {
  await withFixture(async (f) => {
    const granted = await grant(f);
    assertEquals(granted.status, 201, await granted.clone().text());
    const start = await started(f);
    const before = await registrationFacts(f);
    const { code } = f.github.issueCode();
    await assertRefused(
      f,
      await callback(f, { code, state: start.state }, f.developerCookie!),
      before,
    );
  });
});

Deno.test("a malformed code is refused before the state is claimed", async () => {
  await withFixture(async (f) => {
    const start = await started(f);
    for (const code of ["..", ".", "a/b", "a?b"]) {
      const response = await callback(f, { code, state: start.state });
      assertEquals(response.status, 400, code);
      assertEquals((await response.json()).code, "MALFORMED_REQUEST");
    }
    const missing = await callback(f, { state: start.state });
    assert(missing.status === 400 || missing.status === 422);
    await missing.body?.cancel();
    assertEquals(f.github.calls.length, 0);
    assertEquals((await registrationFacts(f)).consumed, 0);
  });
});

Deno.test("non-administrators are refused begin, get and the callback and create no attempt", async () => {
  await withFixture(async (f) => {
    const developer = f.developerCookie!;
    const refusedBegin = await begin(f, developer);
    assertEquals(refusedBegin.status, 403);
    assertEquals((await refusedBegin.json()).code, "AUTH_FORBIDDEN");
    const refusedGet = await call(f, "GET", registrationPath, developer);
    assertEquals(refusedGet.status, 403);
    await refusedGet.body?.cancel();
    const start = await started(f);
    const { code } = f.github.issueCode();
    const refusedCallback = await callback(
      f,
      { code, state: start.state },
      developer,
    );
    assertEquals(refusedCallback.status, 403);
    await refusedCallback.body?.cancel();
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_app_registration_attempts where initiating_principal_id = $1",
        [f.developerId],
      ),
      0,
    );
    assertEquals((await registrationFacts(f)).consumed, 0);
    assertEquals(f.github.calls.length, 0);
    // Unauthenticated callers are refused before any authority check.
    for (
      const path of [
        "/v1/integration-app-registrations/github",
        "/v1/integration-app-registrations/github/manifest",
        "/v1/integration-auth/github/manifest-callback?code=a&state=b",
      ]
    ) {
      const anonymous = await f.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method: path.endsWith("manifest") ? "POST" : "GET",
          headers: path.endsWith("manifest")
            ? { origin: authTestOrigin, "content-type": "application/json" }
            : {},
          body: path.endsWith("manifest") ? "{}" : undefined,
        }),
      );
      assertEquals(anonymous.status, 401, path);
      await anonymous.body?.cancel();
    }
    assertEquals(
      await count(
        f,
        "select count(*) from bakery.integration_app_registration_attempts where initiating_principal_id <> $1",
        [f.adminId],
      ),
      0,
    );
  });
});

Deno.test("secrets never appear in responses, logs, audit rows or attempt rows", async () => {
  await withFixture(async (f) => {
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        captured.push(
          args.map((arg) => {
            try {
              return typeof arg === "string" ? arg : JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(" "),
        );
      };
    }
    let bodies = "";
    let secrets: string[] = [];
    try {
      const startResponse = await begin(f);
      bodies += await startResponse.clone().text();
      const start = await startResponse.json();
      const { code, app } = f.github.issueCode();
      secrets = [
        app.clientSecret,
        app.webhookSecret!,
        app.pem,
        app.pem.split("\n")[1],
        code,
      ];
      const done = await callback(f, { code, state: start.state });
      bodies += JSON.stringify([...done.headers.entries()]) +
        await done.text();
      bodies += JSON.stringify(await readRegistration(f));
      const replay = await callback(f, { code, state: start.state });
      bodies += JSON.stringify([...replay.headers.entries()]) +
        await replay.text();
      // The raw state belongs only in the begin response.
      secrets.push(start.state);
      bodies = bodies.replace(JSON.stringify(start.state), "");
      bodies = bodies.replaceAll(encodeURIComponent(start.state), "");
      bodies = bodies.replaceAll(start.state, "");
    } finally {
      methods.forEach((name, index) => console[name] = originals[index]);
    }
    const tables = await f.pgDatabase.query<{ text: string }>(
      `select (select coalesce(string_agg(a::text, ' '), '') from bakery.audit_events a)
         || (select coalesce(string_agg(t::text, ' '), '') from bakery.integration_app_registration_attempts t)
         || (select coalesce(string_agg(r::text, ' '), '') from bakery.integration_app_registrations r)
         || (select coalesce(string_agg(s::text, ' '), '') from bakery.secrets s)
         || (select coalesce(string_agg(d::text, ' '), '') from bakery.domain_events d)
         || (select coalesce(string_agg(i::text, ' '), '') from bakery.idempotency_records i)
         as text`,
    );
    for (const secret of secrets) {
      assert(!bodies.includes(secret), "a response carried a secret");
      assert(
        !captured.some((line) => line.includes(secret)),
        "a log line carried a secret",
      );
      assert(!tables.rows[0].text.includes(secret), "a table carried a secret");
      assertEquals(
        await count(
          f,
          `select count(*) from bakery.secret_versions
           where position(convert_to($1, 'UTF8') in ciphertext) > 0`,
          [secret],
        ),
        0,
        "a secret version holds plaintext",
      );
    }
    // The organization-scoped secret listing never sees installation secrets.
    const listed = await f.pgDatabase.query(
      `select 1 from bakery.secrets where organization_id = $1 and provider = 'github'`,
      [f.organizationId],
    );
    assertEquals(listed.rows.length, 0);
  });
});

Deno.test("begin and the callback refuse a live administrator access token", async () => {
  await withFixture(async (f) => {
    const token = (await mintToken(f, undefined, ["bakery:admin"])).secret;
    const viaToken = (path: string, method: string) =>
      f.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "Bakery-Organization-Id": f.organizationId,
            ...(method === "POST"
              ? { "content-type": "application/json" }
              : {}),
          },
          body: method === "POST" ? "{}" : undefined,
        }),
      );
    const refusedBegin = await viaToken(
      "/v1/integration-app-registrations/github/manifest",
      "POST",
    );
    // The browser-session mount refuses bearer tokens before any action runs.
    assertEquals(refusedBegin.status, 401, await refusedBegin.clone().text());
    assertEquals((await refusedBegin.json()).code, "AUTH_INVALID");
    const start = await started(f);
    const { code } = f.github.issueCode();
    const refusedCallback = await viaToken(
      `/v1/integration-auth/github/manifest-callback?${new URLSearchParams({
        code,
        state: start.state,
      })}`,
      "GET",
    );
    assertEquals(refusedCallback.status, 401);
    assertEquals((await refusedCallback.json()).code, "AUTH_INVALID");
    const facts = await registrationFacts(f);
    assertEquals(facts.attempts, 1);
    assertEquals(facts.consumed, 0);
    assertEquals(f.github.calls.length, 0);
  });
});

Deno.test("swallowed failures log one structured line without the code or state", async () => {
  await withFixture(async (f) => {
    const captured: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));
    try {
      const start = await started(f);
      const code = "neverissuedcode";
      const failed = await callback(f, { code, state: start.state });
      assertEquals(
        failed.headers.get("location"),
        settingsLocation("conversion_failed"),
      );
      const lines = captured.filter((line) =>
        line.includes("github_app_registration_failed")
      );
      assertEquals(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assertEquals(event.stage, "convert");
      assertEquals(event.outcome, "conversion_failed");
      assertEquals(event.code, "DEPENDENCY_UNAVAILABLE");
      assert(typeof event.requestId === "string" && event.requestId.length);
      assert(!lines[0].includes(code) && !lines[0].includes(start.state));

      // A failure recording the outcome is logged and never masks the redirect.
      captured.length = 0;
      const second = await started(f);
      await f.pgDatabase.query(
        "revoke update (outcome) on bakery.integration_app_registration_attempts from bakery_app",
      );
      try {
        const masked = await callback(f, {
          code: "neverissuedeither",
          state: second.state,
        });
        assertEquals(
          masked.headers.get("location"),
          settingsLocation("conversion_failed"),
        );
        assert(
          captured.some((line) => line.includes('"stage":"record_outcome"')),
          "the failed outcome write is logged",
        );
      } finally {
        await f.pgDatabase.query(
          "grant update (outcome) on bakery.integration_app_registration_attempts to bakery_app",
        );
      }
    } finally {
      console.warn = warn;
    }
  });
});

Deno.test("auth attempts never persist or log the state or the PKCE verifier", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(" "));
      };
    }
    const secrets: string[] = [];
    let created: AttemptCreated;
    try {
      const key = crypto.randomUUID();
      created = await createdAttempt(f, { key });
      const replay = await createdAttempt(f, { key });
      for (const url of [created.authorizationUrl, replay.authorizationUrl]) {
        secrets.push(new URL(url).searchParams.get("state")!);
      }
      // The install page carries the same state, so it is covered too.
      assertEquals(
        [created.installationUrl, replay.installationUrl].map((url) =>
          new URL(url).searchParams.get("state")
        ),
        secrets,
      );
      const read = await readAttempt(f, created.id);
      assertEquals(read.status, 200);
      const body = await read.text();
      for (const secret of secrets) assert(!body.includes(secret));
    } finally {
      methods.forEach((name, index) => console[name] = originals[index]);
    }
    const [row] = await attemptRows(f);
    const verifier = new TextDecoder().decode(
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
    secrets.push(verifier);
    const tables = await f.pgDatabase.query<{ text: string }>(
      `select (select coalesce(string_agg(a::text, ' '), '') from bakery.audit_events a)
         || (select coalesce(string_agg(t::text, ' '), '') from bakery.integration_auth_attempts t)
         || (select coalesce(string_agg(d::text, ' '), '') from bakery.domain_events d)
         || (select coalesce(string_agg(i::text, ' '), '') from bakery.idempotency_records i)
         as text`,
    );
    for (const secret of secrets) {
      assert(!tables.rows[0].text.includes(secret), "a table carried a secret");
      assert(
        !captured.some((line) => line.includes(secret)),
        "a log carried a secret",
      );
      assertEquals(
        await count(
          f,
          `select count(*) from bakery.integration_auth_attempts
            where position(convert_to($1, 'UTF8') in pkce_verifier_ciphertext) > 0`,
          [secret],
        ),
        0,
      );
    }
  });
});

Deno.test("an auth attempt verifier decrypts only under its own organization, attempt and state", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    await createdAttempt(f);
    const [row] = await attemptRows(f);
    const key = await loadSecretKey(f.secretsKey);
    const cipher = {
      ciphertext: new Uint8Array(row.pkce_verifier_ciphertext),
      nonce: new Uint8Array(row.pkce_verifier_nonce),
    };
    const binding = {
      organizationId: row.organization_id,
      attemptId: row.id,
      stateHash: row.state_hash,
      keyId: row.pkce_key_id,
    };
    await decryptAuthAttemptVerifier(key, binding, cipher);
    for (
      const other of [
        { ...binding, organizationId: crypto.randomUUID() },
        { ...binding, attemptId: crypto.randomUUID() },
        { ...binding, stateHash: "0".repeat(64) },
        { ...binding, keyId: "another-key-v1" },
      ]
    ) {
      await assertRejects(() => decryptAuthAttemptVerifier(key, other, cipher));
    }
  });
});

Deno.test("auth attempts refuse access tokens, cross-origin posts and other organizations", async () => {
  await withFixture(async (f) => {
    await registerApp(f);
    const token = (await mintToken(f, undefined, ["bakery:admin"])).secret;
    const viaToken = await f.app.fetch(
      new Request(`${authTestOrigin}/v1/integration-auth-attempts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "Bakery-Organization-Id": f.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "github" }),
      }),
    );
    // The browser-session mount refuses bearer tokens before any action runs.
    assertEquals(viaToken.status, 401, await viaToken.clone().text());
    assertEquals((await viaToken.json()).code, "AUTH_INVALID");
    // CSRF: a cross-site or Origin-less browser POST is refused.
    for (const origin of ["https://evil.example", null]) {
      const response = await f.app.fetch(
        new Request(`${authTestOrigin}/v1/integration-auth-attempts`, {
          method: "POST",
          headers: {
            cookie: f.adminCookie,
            "Bakery-Organization-Id": f.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
            "content-type": "application/json",
            ...(origin === null ? {} : { origin }),
          },
          body: JSON.stringify({ provider: "github" }),
        }),
      );
      assertEquals(
        response.status,
        403,
        `${origin} ${await response.clone().text()}`,
      );
      await response.body?.cancel();
    }
    assertEquals((await attemptRows(f)).length, 0);

    const created = await createdAttempt(f);
    // The Admin also administers a second organization: its context still
    // cannot see the first organization's attempt.
    const second = await call(f, "POST", "/v1/organizations", f.adminCookie, {
      body: {
        name: "Second",
        slug: `second-${crypto.randomUUID().slice(0, 8)}`,
      },
      headers: {
        "Bakery-Organization-Id": f.organizationId,
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
    assertEquals(second.status, 201, await second.clone().text());
    const secondId = (await second.json()).id as string;
    const foreign = await readAttempt(f, created.id, f.adminCookie, secondId);
    assertEquals(foreign.status, 404, await foreign.clone().text());
    assertEquals((await foreign.json()).code, "RESOURCE_NOT_FOUND");
    const unknownOrganization = await readAttempt(
      f,
      created.id,
      f.adminCookie,
      crypto.randomUUID(),
    );
    assertEquals(unknownOrganization.status, 404);
    await unknownOrganization.body?.cancel();
    const anonymous = await f.app.fetch(
      new Request(
        `${authTestOrigin}/v1/integration-auth-attempts/${created.id}`,
        {
          headers: { "Bakery-Organization-Id": f.organizationId },
        },
      ),
    );
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
  });
});

/** A refused GitHub connection callback: state_rejected, no GitHub call, no write. */
async function assertConnectionRefused(
  f: GitHubAppFixture,
  response: Response,
  before: string,
) {
  assertEquals(response.status, 303, await response.clone().text());
  assertEquals(
    response.headers.get("location"),
    connectionLocation("state_rejected"),
  );
  assertEquals(f.github.calls.length, 0, "a refused state calls nothing");
  assertEquals(await connectionSnapshot(f), before, "no stored record changed");
}

Deno.test("replayed consumed, expired or unknown states are refused and change no stored record", async () => {
  await withFixture(async (f) => {
    // Consumed: a completed attempt replayed through both callbacks.
    const done = await connectionFlow(f);
    const installationId = String(done.installations[0].id);
    await githubSetup(f, {
      installation_id: installationId,
      setup_action: "install",
      state: done.state,
    });
    const bound = await githubCallback(f, {
      code: done.code,
      state: done.state,
    });
    assertEquals(bound.status, 303);
    assert(bound.headers.get("location")!.includes("githubConnection=pending"));
    f.github.calls.length = 0;
    let before = await connectionSnapshot(f);
    const fresh = f.github.authorize({
      authorizationUrl: done.created.authorizationUrl,
      installationIds: [done.installations[0].id],
    });
    await assertConnectionRefused(
      f,
      await githubCallback(f, { code: fresh, state: done.state }),
      before,
    );
    await assertConnectionRefused(
      f,
      await githubSetup(f, {
        installation_id: installationId,
        setup_action: "update",
        state: done.state,
      }),
      before,
    );

    // Expired: an attempt past its lifetime, before either callback.
    const expired = await connectionFlow(f, { app: done.app });
    await f.pgDatabase.query(
      `update bakery.integration_auth_attempts
          set expires_at = now() - interval '1 second' where id = $1`,
      [expired.created.id],
    );
    before = await connectionSnapshot(f);
    await assertConnectionRefused(
      f,
      await githubCallback(f, { code: expired.code, state: expired.state }),
      before,
    );
    await assertConnectionRefused(
      f,
      await githubSetup(f, {
        installation_id: String(expired.installations[0].id),
        setup_action: "install",
        state: expired.state,
      }),
      before,
    );

    // Unknown: a well-formed state no attempt was issued with.
    const unknown = "u".repeat(43);
    await assertConnectionRefused(
      f,
      await githubCallback(f, { code: "oauth-unknown", state: unknown }),
      before,
    );
    await assertConnectionRefused(
      f,
      await githubSetup(f, {
        installation_id: installationId,
        setup_action: "install",
        state: unknown,
      }),
      before,
    );

    // A second setup hint for one attempt is a replay too.
    const hinted = await connectionFlow(f, { app: done.app });
    await githubSetup(f, {
      installation_id: String(hinted.installations[0].id),
      setup_action: "install",
      state: hinted.state,
    });
    before = await connectionSnapshot(f);
    await assertConnectionRefused(
      f,
      await githubSetup(f, {
        installation_id: installationId,
        setup_action: "install",
        state: hinted.state,
      }),
      before,
    );
  });
});

Deno.test("a state presented by another session or another member changes nothing", async () => {
  await withFixture(async (f) => {
    const flow = await connectionFlow(f);
    const otherSession = await signIn(f, f.adminEmail, f.password);
    assert(otherSession !== f.adminCookie);
    const before = await connectionSnapshot(f);
    const query = {
      installation_id: String(flow.installations[0].id),
      setup_action: "install",
      state: flow.state,
    };
    for (const cookie of [otherSession, f.developerCookie!]) {
      await assertConnectionRefused(
        f,
        await githubSetup(f, query, cookie),
        before,
      );
      await assertConnectionRefused(
        f,
        await githubCallback(f, { code: flow.code, state: flow.state }, cookie),
        before,
      );
    }
    // The issuing session still completes it.
    await githubSetup(f, query);
    const done = await githubCallback(f, {
      code: flow.code,
      state: flow.state,
    });
    assert(done.headers.get("location")!.includes("githubConnection=pending"));
  });
});

Deno.test("the callbacks refuse bearer tokens, anonymous requests and malformed input without a claim", async () => {
  await withFixture(async (f) => {
    const flow = await connectionFlow(f);
    const token = (await mintToken(f, undefined, ["bakery:admin"])).secret;
    const before = await connectionSnapshot(f);
    const setupQuery = new URLSearchParams({
      installation_id: String(flow.installations[0].id),
      state: flow.state,
    });
    const oauthQuery = new URLSearchParams({
      code: flow.code,
      state: flow.state,
    });
    for (
      const path of [
        `${setupPath}?${setupQuery}`,
        `${oauthCallbackPath}?${oauthQuery}`,
      ]
    ) {
      const viaToken = await f.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      assertEquals(viaToken.status, 401, await viaToken.clone().text());
      assertEquals((await viaToken.json()).code, "AUTH_INVALID");
      const anonymous = await f.app.fetch(
        new Request(`${authTestOrigin}${path}`),
      );
      assertEquals(anonymous.status, 401);
      await anonymous.body?.cancel();
    }
    for (
      const response of [
        await githubSetup(f, { installation_id: "12abc", state: flow.state }),
        await githubSetup(f, { installation_id: "0", state: flow.state }),
        await githubCallback(f, { code: "../evil", state: flow.state }),
        await githubCallback(f, { state: flow.state }),
        await githubCallback(f, { code: flow.code }),
      ]
    ) {
      assertEquals(response.status, 400, await response.clone().text());
      assertEquals((await response.json()).code, "MALFORMED_REQUEST");
    }
    assertEquals(f.github.calls.length, 0);
    assertEquals(await connectionSnapshot(f), before);
  });
});

/** Every row of every table in the bakery and public schemas, as text. */
async function everyStoredRow(f: GitHubAppFixture): Promise<string> {
  const tables = await f.pgDatabase.query<{ schema: string; name: string }>(
    `select table_schema as schema, table_name as name
       from information_schema.tables
      where table_schema in ('bakery', 'public') and table_type = 'BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const table of tables.rows) {
    const rows = await f.pgDatabase.query<{ text: string | null }>(
      `select string_agg(t::text, ' ') as text from "${table.schema}"."${table.name}" t`,
    );
    parts.push(rows.rows[0].text ?? "");
  }
  return parts.join(" ");
}

function hex(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("no GitHub user token is held in any table or log once setup completes or fails", async () => {
  await withFixture(async (f) => {
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(" "));
      };
    }
    const codes: string[] = [];
    const bodies: string[] = [];
    try {
      const keep = async (response: Response) => {
        bodies.push(
          `${response.headers.get("location")} ${await response.text()}`,
        );
      };
      // Completes, setup first, with administered and other repositories.
      const ok = await connectionFlow(f, {
        repositories: () => fakeRepositories(6),
      });
      codes.push(ok.code);
      await keep(
        await githubSetup(f, {
          installation_id: String(ok.installations[0].id),
          setup_action: "install",
          state: ok.state,
        }),
      );
      await keep(await githubCallback(f, { code: ok.code, state: ok.state }));
      // Completes, callback first, for another organization's view of nothing.
      const second = await connectionFlow(f, {
        app: ok.app,
        repositories: () => fakeRepositories(4),
      });
      codes.push(second.code);
      await keep(
        await githubCallback(f, { code: second.code, state: second.state }),
      );
      await keep(
        await githubSetup(f, {
          installation_id: String(second.installations[0].id),
          setup_action: "install",
          state: second.state,
        }),
      );
      // Fails after the token was issued: listing outage and spoofed hint.
      const outage = await connectionFlow(f, { app: ok.app });
      codes.push(outage.code);
      f.github.failures.listing = true;
      await keep(
        await githubCallback(f, { code: outage.code, state: outage.state }),
      );
      f.github.failures.listing = false;
      // Fails after the token was issued: repository listing outage.
      const scan = await connectionFlow(f, {
        app: ok.app,
        repositories: () => fakeRepositories(3),
      });
      codes.push(scan.code);
      f.github.failures.repositories.add(scan.installations[0].id);
      await keep(
        await githubSetup(f, {
          installation_id: String(scan.installations[0].id),
          setup_action: "install",
          state: scan.state,
        }),
      );
      await keep(
        await githubCallback(f, { code: scan.code, state: scan.state }),
      );
      const spoof = await connectionFlow(f, { app: ok.app });
      codes.push(spoof.code);
      await keep(
        await githubSetup(f, {
          installation_id: String(ok.installations[0].id),
          setup_action: "install",
          state: spoof.state,
        }),
      );
      await keep(
        await githubCallback(f, { code: spoof.code, state: spoof.state }),
      );
    } finally {
      methods.forEach((name, index) => console[name] = originals[index]);
    }
    assertEquals(
      f.github.issuedTokens.length,
      10,
      "five exchanges, two tokens each",
    );
    assertEquals((await connectionRows(f)).length, 2);
    assert(
      await count(f, "select count(*) from bakery.integration_resources") > 0,
      "resources were recorded with the token in hand",
    );
    assert(
      captured.some((line) => line.includes('"stage":"list_repositories"')),
      "the repository outage is logged, safely",
    );
    const stored = await everyStoredRow(f);
    for (const secret of [...f.github.issuedTokens, ...codes]) {
      assert(!stored.includes(secret), "a table carried a user token or code");
      assert(!stored.includes(hex(secret)), "a table carried one as bytes");
      assert(
        !captured.some((line) => line.includes(secret)),
        "a log carried a user token or code",
      );
      assert(!bodies.some((body) => body.includes(secret)), "a response did");
    }
    assert(
      captured.some((line) => line.includes("github_connection_failed")),
      "failures are still logged, safely",
    );
  });
});

/** Completes setup for one installation holding `repositories` repositories. */
async function boundConnection(
  f: GitHubAppFixture,
  options: Parameters<typeof connectionFlow>[1] & { organizationId?: string },
): Promise<string> {
  const flow = await connectionFlow(f, {
    ...options,
    attempt: { ...options.attempt, organizationId: options.organizationId },
  });
  await githubSetup(f, {
    installation_id: String(flow.installations[0].id),
    setup_action: "install",
    state: flow.state,
  });
  const response = await githubCallback(f, {
    code: flow.code,
    state: flow.state,
  });
  assertEquals(response.status, 303);
  const location = new URL(response.headers.get("location")!, authTestOrigin);
  assertEquals(location.searchParams.get("githubConnection"), "pending");
  return location.searchParams.get("connectionId")!;
}

function list(
  f: GitHubAppFixture,
  path: string,
  organizationId: string,
  cookie = f.adminCookie,
): Promise<Response> {
  return call(f, "GET", path, cookie, {
    headers: { "Bakery-Organization-Id": organizationId },
  });
}

async function problemCode(response: Response, status: number) {
  assertEquals(response.status, status, await response.clone().text());
  return (await response.json()).code;
}

Deno.test("connection and resource lists never cross organizations", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const secondId = await secondOrganization(f);
    const first = await boundConnection(f, {
      app,
      repositories: () => fakeRepositories(4, ["admin"]),
    });
    const second = await boundConnection(f, {
      app,
      organizationId: secondId,
      repositories: () => fakeRepositories(3, ["admin"]),
    });
    const firstPage = await (await list(f, connectionsPath, f.organizationId))
      .json();
    assertEquals(
      firstPage.items.map((item: { id: string }) => item.id),
      [first],
    );
    const secondPage = await (await list(f, connectionsPath, secondId)).json();
    assertEquals(
      secondPage.items.map((item: { id: string }) => item.id),
      [second],
    );
    // Another organization's connection id is not found, never listed.
    assertEquals(
      await problemCode(
        await list(
          f,
          `${connectionsPath}/${second}/resources`,
          f.organizationId,
        ),
        404,
      ),
      "RESOURCE_NOT_FOUND",
    );
    const own = await (await list(
      f,
      `${connectionsPath}/${first}/resources`,
      f.organizationId,
    )).json();
    assertEquals(own.items.length, 4);
    for (const item of own.items) {
      assertEquals(item.organizationId, f.organizationId);
      assertEquals(item.connectionId, first);
    }
    // A member of only the first organization cannot name the second: it is
    // not found to them, as for every organization-scoped read.
    for (
      const path of [connectionsPath, `${connectionsPath}/${second}/resources`]
    ) {
      assertEquals(
        await problemCode(
          await list(f, path, secondId, f.developerCookie),
          404,
        ),
        "RESOURCE_NOT_FOUND",
        path,
      );
    }
    // Anonymous and bearer callers are refused before any action runs.
    const anonymous = await f.app.fetch(
      new Request(`${authTestOrigin}${connectionsPath}`, {
        headers: { "Bakery-Organization-Id": f.organizationId },
      }),
    );
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
  });
});

Deno.test("a cursor replayed against another connection, other filters or another organization is 400 INVALID_CURSOR", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const secondId = await secondOrganization(f);
    const first = await boundConnection(f, {
      app,
      repositories: () => fakeRepositories(5, ["admin"]),
    });
    const sibling = await boundConnection(f, {
      app,
      repositories: () => fakeRepositories(5, ["admin"]),
    });
    const foreign = await boundConnection(f, {
      app,
      organizationId: secondId,
      repositories: () => fakeRepositories(5, ["admin"]),
    });
    const resources = (connection: string, query = "") =>
      `${connectionsPath}/${connection}/resources?limit=2${query}`;
    const page = await (await list(f, resources(first), f.organizationId))
      .json();
    assert(page.nextCursor, "a first page of five has a next cursor");
    assert(new TextEncoder().encode(page.nextCursor).length <= 512);
    const cursor = `&cursor=${encodeURIComponent(page.nextCursor)}`;
    // The same cursor continues its own list.
    const next = await list(f, resources(first, cursor), f.organizationId);
    assertEquals(next.status, 200, await next.clone().text());
    await next.body?.cancel();
    for (
      const [path, organizationId] of [
        [resources(sibling, cursor), f.organizationId],
        [resources(first, `${cursor}&selected=false`), f.organizationId],
        [resources(first, `${cursor}&kind=repository`), f.organizationId],
        [resources(foreign, cursor), secondId],
        // Even a connection the caller cannot see refuses the cursor first.
        [resources(foreign, cursor), f.organizationId],
        [`${connectionsPath}?limit=2${cursor}`, f.organizationId],
      ]
    ) {
      assertEquals(
        await problemCode(await list(f, path, organizationId), 400),
        "INVALID_CURSOR",
        path,
      );
    }
    // A connections cursor is bound to its organization too.
    const connectionPage = await (await list(
      f,
      `${connectionsPath}?limit=1`,
      f.organizationId,
    )).json();
    assert(connectionPage.nextCursor);
    const connectionCursor = encodeURIComponent(connectionPage.nextCursor);
    assertEquals(
      await problemCode(
        await list(
          f,
          `${connectionsPath}?limit=1&cursor=${connectionCursor}`,
          secondId,
        ),
        400,
      ),
      "INVALID_CURSOR",
    );
    assertEquals(
      await problemCode(
        await list(
          f,
          `${resources(first)}&cursor=${connectionCursor}`,
          f.organizationId,
        ),
        400,
      ),
      "INVALID_CURSOR",
    );
    // A tampered cursor is refused as well.
    const tampered = page.nextCursor.slice(0, -2) +
      (page.nextCursor.endsWith("AA") ? "BB" : "AA");
    assertEquals(
      await problemCode(
        await list(
          f,
          resources(first, `&cursor=${encodeURIComponent(tampered)}`),
          f.organizationId,
        ),
        400,
      ),
      "INVALID_CURSOR",
    );
  });
});

Deno.test("pasted credentials never appear in responses, problems, logs, audit or idempotency rows", async () => {
  await withFixture(async (f) => {
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        captured.push(
          args.map((arg) => {
            try {
              return typeof arg === "string" ? arg : JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(" "),
        );
      };
    }
    const app = await f.github.createExistingApp();
    const other = await f.github.createExistingApp();
    const replacement = `client-secret-${crypto.randomUUID()}`;
    const malformed =
      `-----BEGIN RSA PRIVATE KEY-----\nmalformed-${crypto.randomUUID()}\n-----END RSA PRIVATE KEY-----\n`;
    const secrets = [
      app.clientSecret,
      app.webhookSecret!,
      app.pkcs1Pem,
      app.pkcs1Pem.split("\n")[1],
      other.pkcs1Pem.split("\n")[1],
      replacement,
      malformed.split("\n")[1],
    ];
    let bodies = "";
    const record = async (response: Response) => {
      bodies += JSON.stringify([...response.headers.entries()]) +
        await response.text();
      return response.status;
    };
    try {
      // Malformed key, rejected key, wrong client id, unavailable GitHub.
      assertEquals(
        await record(
          await put(f, existingAppBody(app, { privateKey: malformed })),
        ),
        400,
      );
      assertEquals(
        await record(
          await put(f, existingAppBody(app, { privateKey: other.pkcs1Pem })),
        ),
        422,
      );
      f.github.failAppLookups(500);
      assertEquals(await record(await put(f, existingAppBody(app))), 503);
      f.github.failAppLookups(null);
      // Success, replay and replacement.
      const key = crypto.randomUUID();
      assertEquals(
        await record(await put(f, existingAppBody(app), { key })),
        200,
      );
      assertEquals(
        await record(await put(f, existingAppBody(app), { key })),
        200,
      );
      assertEquals(
        await record(
          await put(f, existingAppBody(app, { clientSecret: replacement }), {
            version: 1,
          }),
        ),
        200,
      );
      bodies += JSON.stringify(await readRegistration(f));
    } finally {
      methods.forEach((name, index) => console[name] = originals[index]);
    }
    const tables = await f.pgDatabase.query<{ text: string }>(
      `select (select coalesce(string_agg(a::text, ' '), '') from bakery.audit_events a)
         || (select coalesce(string_agg(r::text, ' '), '') from bakery.integration_app_registrations r)
         || (select coalesce(string_agg(s::text, ' '), '') from bakery.secrets s)
         || (select coalesce(string_agg(d::text, ' '), '') from bakery.domain_events d)
         || (select coalesce(string_agg(i::text, ' '), '') from bakery.idempotency_records i)
         as text`,
    );
    for (const secret of secrets) {
      assert(!bodies.includes(secret), "a response carried a secret");
      assert(
        !captured.some((line) => line.includes(secret)),
        "a log line carried a secret",
      );
      assert(!tables.rows[0].text.includes(secret), "a table carried a secret");
      assertEquals(
        await count(
          f,
          `select count(*) from bakery.secret_versions
           where position(convert_to($1, 'UTF8') in ciphertext) > 0`,
          [secret],
        ),
        0,
        "a secret version holds plaintext",
      );
    }
  });
});

Deno.test("non-administrators and access tokens are refused put before any GitHub call", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const before = await registrationFacts(f);
    const developer = await put(f, existingAppBody(app), {
      cookie: f.developerCookie!,
    });
    assertEquals(developer.status, 403);
    assertEquals((await developer.json()).code, "AUTH_FORBIDDEN");
    const token = (await mintToken(f, undefined, ["bakery:admin"])).secret;
    const viaToken = await f.app.fetch(
      new Request(`${authTestOrigin}${registrationPath}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "Bakery-Organization-Id": f.organizationId,
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(existingAppBody(app)),
      }),
    );
    assertEquals(viaToken.status, 401);
    await viaToken.body?.cancel();
    const anonymous = await f.app.fetch(
      new Request(`${authTestOrigin}${registrationPath}`, {
        method: "PUT",
        headers: {
          origin: authTestOrigin,
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(existingAppBody(app)),
      }),
    );
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
    // CSRF: a cross-site or Origin-less browser PUT is refused.
    for (const origin of ["https://evil.example", null]) {
      const crossOrigin = await f.app.fetch(
        new Request(`${authTestOrigin}${registrationPath}`, {
          method: "PUT",
          headers: {
            cookie: f.adminCookie,
            "Idempotency-Key": crypto.randomUUID(),
            "content-type": "application/json",
            ...(origin === null ? {} : { origin }),
          },
          body: JSON.stringify(existingAppBody(app)),
        }),
      );
      assertEquals(crossOrigin.status, 403, String(origin));
      await crossOrigin.body?.cancel();
    }
    assertEquals(f.github.calls.length, 0);
    assertEquals(await registrationFacts(f), before);
  });
});

Deno.test("a reconnect target in another organization is RESOURCE_NOT_FOUND and creates no attempt", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const secondId = await secondOrganization(f);
    const foreign = await boundConnection(f, { app, organizationId: secondId });
    const own = await boundConnection(f, { app });
    const attempts = async () =>
      (await f.pgDatabase.query<{ count: number }>(
        "select count(*)::int as count from bakery.integration_auth_attempts",
      )).rows[0].count;
    const before = await attempts();
    for (
      const [organizationId, target] of [
        [f.organizationId, foreign],
        [secondId, own],
        [f.organizationId, crypto.randomUUID()],
      ]
    ) {
      const response = await call(
        f,
        "POST",
        "/v1/integration-auth-attempts",
        f.adminCookie,
        {
          body: { provider: "github", reconnectConnectionId: target },
          headers: {
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
      assertEquals(
        await problemCode(response, 404),
        "RESOURCE_NOT_FOUND",
        `${organizationId} ${target}`,
      );
    }
    assertEquals(await attempts(), before, "no attempt was created");
    // A Developer is refused before the target is even looked up.
    const developer = await call(
      f,
      "POST",
      "/v1/integration-auth-attempts",
      f.developerCookie,
      {
        body: { provider: "github", reconnectConnectionId: own },
        headers: {
          "Bakery-Organization-Id": f.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(developer.status, 403);
    await developer.body?.cancel();
    assertEquals(await attempts(), before);
  });
});

Deno.test("the database refuses to point a connection at another account's installation or change its account", async () => {
  await withFixture(async (f) => {
    const app = await registerApp(f);
    const first = await boundConnection(f, { app });
    const secondId = await secondOrganization(f);
    await boundConnection(f, { app, organizationId: secondId });
    const installations = await f.pgDatabase.query<{
      id: string;
      external_authorization_id: string;
      external_account_id: string;
    }>(
      `select i.id, i.external_authorization_id, i.external_account_id
         from bakery.integration_installations i
         join bakery.integration_connections c on c.installation_id = i.id
        where c.organization_id = $1`,
      [secondId],
    );
    const other = installations.rows[0];
    const before = await f.pgDatabase.query<{ row: string }>(
      "select c::text as row from bakery.integration_connections c where id = $1",
      [first],
    );
    // The runtime role may move installation columns, but the composite key
    // pins them to an installation of the connection's own account.
    const moved = await assertRejects(() =>
      f.runtimePgDatabase.query(
        `update bakery.integration_connections
            set installation_id = $2, external_authorization_id = $3
          where id = $1`,
        [first, other.id, other.external_authorization_id],
      )
    );
    assertEquals(Reflect.get(moved as object, "code"), "23503");
    // The account itself has no update grant.
    const swapped = await assertRejects(() =>
      f.runtimePgDatabase.query(
        `update bakery.integration_connections
            set external_account_id = $2 where id = $1`,
        [first, other.external_account_id],
      )
    );
    assertEquals(Reflect.get(swapped as object, "code"), "42501");
    const after = await f.pgDatabase.query<{ row: string }>(
      "select c::text as row from bakery.integration_connections c where id = $1",
      [first],
    );
    assertEquals(after.rows[0].row, before.rows[0].row);
  });
});

/** A refused edit: the status and code, no GitHub call, nothing stored. */
async function assertEditRefused(
  f: GitHubAppFixture,
  response: Response,
  status: number,
  code: string,
  before: string,
) {
  const body = await response.text();
  assertEquals(response.status, status, body);
  assertEquals(JSON.parse(body).code, code, body);
  assertEquals(f.github.calls.length, 0, "a refused edit asks GitHub nothing");
  assertEquals(await connectionSnapshot(f), before, "nothing changed");
}

Deno.test("a Developer cannot select repositories or enable, disable or rename a connection", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const before = await connectionSnapshot(f);
    for (
      const response of [
        await patchResource(f, connectionId, resources[0].id, {
          selected: true,
        }, { cookie: f.developerCookie }),
        await patchConnection(f, connectionId, { enabled: true }, {
          cookie: f.developerCookie,
        }),
        await patchConnection(f, connectionId, { name: "Mine" }, {
          cookie: f.developerCookie,
        }),
      ]
    ) {
      await assertEditRefused(f, response, 403, "AUTH_FORBIDDEN", before);
    }
  });
});

Deno.test("another organization's connection and resource are 404 to an Admin of a different organization", async () => {
  await withFixture(async (f) => {
    const { app, connectionId, resources } = await pendingConnection(f);
    const secondId = await secondOrganization(f);
    const foreign = await pendingConnection(f, {
      app,
      attempt: { organizationId: secondId },
    });
    f.github.calls.length = 0;
    const before = await connectionSnapshot(f);
    // The first organization's connection through the second's context.
    await assertEditRefused(
      f,
      await patchConnection(f, connectionId, { enabled: false }, {
        organizationId: secondId,
      }),
      404,
      "RESOURCE_NOT_FOUND",
      before,
    );
    await assertEditRefused(
      f,
      await patchResource(f, connectionId, resources[0].id, {
        selected: true,
      }, { organizationId: secondId }),
      404,
      "RESOURCE_NOT_FOUND",
      before,
    );
    // The second organization's resource through the first's own connection
    // path: resources are bound to their connection and organization.
    await assertEditRefused(
      f,
      await patchResource(f, connectionId, foreign.resources[0].id, {
        selected: true,
      }),
      404,
      "RESOURCE_NOT_FOUND",
      before,
    );
    // A stale and a matching If-Match answer the same 404, so the version of
    // a hidden connection is never confirmed.
    for (const ifMatch of [versionTag(1), versionTag(9)]) {
      await assertEditRefused(
        f,
        await patchConnection(f, foreign.connectionId, { name: "x" }, {
          ifMatch,
        }),
        404,
        "RESOURCE_NOT_FOUND",
        before,
      );
    }
    // An organization the caller is not a member of.
    await assertEditRefused(
      f,
      await patchConnection(f, connectionId, { enabled: false }, {
        organizationId: crypto.randomUUID(),
      }),
      404,
      "RESOURCE_NOT_FOUND",
      before,
    );
  });
});

Deno.test("a stale If-Match changes nothing and asks GitHub nothing, even for a selectable repository", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const before = await connectionSnapshot(f);
    await assertEditRefused(
      f,
      await patchResource(f, connectionId, resources[0].id, {
        selected: true,
      }, { ifMatch: versionTag(2) }),
      412,
      "PRECONDITION_FAILED",
      before,
    );
  });
});

Deno.test("the narrowed recheck token never reaches a response, the audit trail, events or idempotency records", async () => {
  await withFixture(async (f) => {
    const { connectionId, resources } = await pendingConnection(f);
    const response = await patchResource(f, connectionId, resources[0].id, {
      selected: true,
    });
    const body = await response.text();
    assertEquals(response.status, 200, body);
    const tokens = f.github.issuedTokens.filter((token) =>
      token.startsWith("ghs_")
    );
    assertEquals(tokens.length, 1);
    assertEquals(f.github.revokedTokens, tokens, "revoked at once");
    for (const token of tokens) {
      assert(!body.includes(token));
      for (
        const table of [
          "bakery.audit_events",
          "bakery.domain_events",
          "bakery.idempotency_records",
          "bakery.integration_resources",
          "bakery.integration_connections",
          "bakery.integration_installations",
        ]
      ) {
        assertEquals(
          await count(
            f,
            `select count(*) from ${table} as t where t::text like '%' || $1 || '%'`,
            [token],
          ),
          0,
          table,
        );
      }
    }
  });
});

/** A refusal with its per-request identifiers blanked, and its header names. */
async function refusalShape(response: Response) {
  const body = await response.text();
  assertEquals(response.status, 409, body);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  for (const field of ["requestId", "traceId", "instance"]) {
    assert(field in parsed, field);
    parsed[field] = "<per-request>";
  }
  return {
    body,
    shape: JSON.stringify(parsed),
    headers: [...response.headers.keys()].filter((name) =>
      !["date", "x-request-id", "traceparent"].includes(name)
    ).sort(),
    contentType: response.headers.get("content-type"),
  };
}

Deno.test("a repository another organization holds is refused exactly like an unselectable one and names nobody", async () => {
  await withFixture(async (f) => {
    const first = await pendingConnection(f, {
      repositories: fakeRepositories(5, ["admin"]),
    });
    const secondId = await secondOrganization(f);
    const second = await pendingConnection(f, {
      app: first.app,
      existing: first.installation,
      attempt: { organizationId: secondId },
    });
    const own = (index: number) => first.resources[index];
    const theirs = (index: number) =>
      second.resources.find((row) =>
        row.external_id === own(index).external_id
      )!;
    const selectFirst = async (index: number) => {
      const response = await patchResource(
        f,
        first.connectionId,
        own(index).id,
        { selected: true },
      );
      assertEquals(response.status, 200, await response.text());
    };
    const selectSecond = (index: number) =>
      patchResource(f, second.connectionId, theirs(index).id, {
        selected: true,
      }, { organizationId: secondId });
    await selectFirst(0);
    await f.pgDatabase.query(
      "update bakery.integration_resources set available = false where id = $1",
      [theirs(1).id],
    );
    first.installation.repositories = first.installation.repositories.filter(
      (repository) => String(repository.id) !== own(2).external_id,
    );
    const captured: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) =>
        captured.push(args.map((arg) => String(arg)).join(" "));
    }
    let refusals: Record<string, Awaited<ReturnType<typeof refusalShape>>>;
    try {
      refusals = {
        // Held by the first organization before the second asks.
        held: await refusalShape(await selectSecond(0)),
        // The last complete discovery no longer found it.
        unavailable: await refusalShape(await selectSecond(1)),
        // GitHub says the installation no longer covers it.
        uncovered: await refusalShape(await selectSecond(2)),
      };
      // The first organization selects while the second is asking GitHub:
      // the partial unique index refuses the second's write.
      let raced = false;
      f.github.hooks.beforeResponse = async (request) => {
        if (raced || !request.url.endsWith("/access_tokens")) return;
        raced = true;
        await selectFirst(3);
      };
      try {
        refusals.raced = await refusalShape(await selectSecond(3));
      } finally {
        f.github.hooks.beforeResponse = null;
      }
      assert(raced, "the first organization selected during the recheck");
    } finally {
      methods.forEach((name, index) => console[name] = originals[index]);
    }
    const expected = refusals.unavailable;
    assertEquals(JSON.parse(expected.body).reason, "resource_unavailable");
    for (const [name, refusal] of Object.entries(refusals)) {
      assertEquals(refusal.shape, expected.shape, name);
      assertEquals(refusal.headers, expected.headers, name);
      assertEquals(refusal.contentType, expected.contentType, name);
    }
    // Nothing in a response or a log names the holder or how many hold it.
    const hidden = [
      f.organizationId,
      first.connectionId,
      ...first.resources.map((row) => row.id),
    ];
    for (const value of hidden) {
      for (const refusal of Object.values(refusals)) {
        assert(!refusal.body.includes(value), "a refusal names the holder");
      }
      assert(
        !captured.some((line) => line.includes(value)),
        "a log names the holder",
      );
    }
    assert(
      !captured.some((line) => line.includes("integration_resources_selected")),
      "the index name never reaches a log",
    );
    // The second organization's refusals wrote no audit row, event or
    // stored response anywhere, and its connection version is unchanged.
    assertEquals(await connectionVersion(f, second.connectionId), 1);
    for (
      const [table, column] of [
        ["bakery.audit_events", "resource_id"],
        ["bakery.domain_events", "aggregate_id"],
      ]
    ) {
      assertEquals(
        await count(
          f,
          `select count(*) from ${table}
            where ${column}::text = any($1::text[])`,
          [second.resources.map((row) => row.id)],
        ),
        0,
        table,
      );
    }
    assertEquals(
      await count(
        f,
        `select count(*) from bakery.idempotency_records
          where organization_id = $1 and response_body is not null`,
        [secondId],
      ),
      0,
    );
  });
});
