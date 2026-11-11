import { assertEquals } from "@std/assert";
import {
  decryptInstallationSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import { call } from "../helpers/installation-settings.ts";
import {
  callback,
  count,
  existingAppBody,
  type GitHubAppFixture,
  openGitHubAppFixture,
  put,
  readRegistration,
  registrationFacts,
  started,
} from "../helpers/github-app-registration.ts";

async function withFixture(run: (f: GitHubAppFixture) => Promise<void>) {
  const f = await openGitHubAppFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

/** Every stored version of the registration's secrets, decrypted, oldest first. */
async function secretVersions(f: GitHubAppFixture) {
  const rows = await f.pgDatabase.query<{
    kind: string;
    secret_id: string;
    revision: number;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    key_id: string;
    active: boolean;
  }>(
    `select kind, s.id as secret_id, v.revision, v.ciphertext, v.nonce,
       v.key_id, s.active_version_id = v.id as active
     from bakery.integration_app_registrations r
     cross join lateral (values ('clientSecret', r.client_secret_id),
       ('privateKey', r.private_key_secret_id),
       ('webhookSecret', r.webhook_secret_id)) as k(kind, secret_id)
     join bakery.secrets s on s.id = k.secret_id
     join bakery.secret_versions v on v.secret_id = s.id
     order by kind, v.revision`,
  );
  const key = await loadSecretKey(f.secretsKey);
  return await Promise.all(rows.rows.map(async (row) => ({
    kind: row.kind,
    revision: row.revision,
    active: row.active,
    value: new TextDecoder().decode(
      await decryptInstallationSecret(key, {
        secretId: row.secret_id,
        revision: row.revision,
        keyId: row.key_id,
      }, {
        ciphertext: new Uint8Array(row.ciphertext),
        nonce: new Uint8Array(row.nonce),
      }),
    ),
  })));
}

Deno.test("put registers an existing App only after GET /app confirms the App id with its key", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const response = await put(f, existingAppBody(app));
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json();
    assertEquals(f.github.appLookups().length, 1);
    assertEquals(f.github.verifiedJwts[0].payload.iss, String(app.id));
    assertEquals(body.status, "registered");
    assertEquals(body.appId, app.id);
    assertEquals(body.slug, app.slug);
    assertEquals(body.clientId, app.clientId);
    assertEquals(body.ownerLogin, app.ownerLogin);
    assertEquals(body.registeredByPrincipalId, f.adminId);
    assertEquals(body.clientSecretConfigured, true);
    assertEquals(body.privateKeyConfigured, true);
    assertEquals(body.webhookSecretConfigured, true);
    assertEquals(body.clientSecretRevision, 1);
    assertEquals(body.privateKeyRevision, 1);
    assertEquals(body.webhookSecretRevision, 1);
    assertEquals(body.version, 1);
    assertEquals(await readRegistration(f), body);
    assertEquals(
      (await secretVersions(f)).map(({ kind, revision, active, value }) => ({
        kind,
        revision,
        active,
        value,
      })),
      [
        {
          kind: "clientSecret",
          revision: 1,
          active: true,
          value: app.clientSecret,
        },
        { kind: "privateKey", revision: 1, active: true, value: app.pkcs1Pem },
        {
          kind: "webhookSecret",
          revision: 1,
          active: true,
          value: app.webhookSecret!,
        },
      ],
    );
  });
});

Deno.test("put accepts a PKCS#8 key and an App without a webhook secret", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp({ webhookSecret: null });
    const response = await put(
      f,
      existingAppBody(app, { privateKey: app.pkcs8Pem }),
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json();
    assertEquals(body.webhookSecretConfigured, false);
    assertEquals(body.webhookSecretRevision, null);
    assertEquals((await registrationFacts(f)).installationSecrets, 2);
  });
});

Deno.test("a key GitHub does not accept for the App id stores nothing and answers 422", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const other = await f.github.createExistingApp();
    const before = await registrationFacts(f);
    for (
      const body of [
        // Another App's key signs a JWT GitHub refuses for this App id.
        existingAppBody(app, { privateKey: other.pkcs1Pem }),
        // GitHub confirms the key but reports another client id.
        existingAppBody(app, { clientId: other.clientId }),
        // The App id GitHub does not know.
        existingAppBody(app, { appId: app.id + 50_000 }),
      ]
    ) {
      const response = await put(f, body);
      assertEquals(response.status, 422, await response.clone().text());
      const problem = await response.json();
      assertEquals(problem.code, "UNPROCESSABLE");
      assertEquals(problem.issues, [{
        path: ["appId"],
        code: "app_not_confirmed",
        message: "app not confirmed",
      }]);
    }
    assertEquals(f.github.appLookups().length, 3);
    assertEquals(await registrationFacts(f), before);
  });
});

Deno.test("a malformed private key answers 400 before any GitHub call", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const before = await registrationFacts(f);
    for (
      const privateKey of [
        "not a key",
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
        "-----BEGIN PRIVATE KEY-----\n%%%%\n-----END PRIVATE KEY-----\n",
        "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n",
      ]
    ) {
      const response = await put(f, existingAppBody(app, { privateKey }));
      assertEquals(response.status, 400, await response.clone().text());
      const problem = await response.json();
      assertEquals(problem.code, "MALFORMED_REQUEST");
      assertEquals(problem.issues[0].path, ["privateKey"]);
    }
    assertEquals(f.github.calls.length, 0);
    assertEquals(await registrationFacts(f), before);
  });
});

Deno.test("a malformed private key answers 400 before If-Match and App checks on a replacement", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const other = await f.github.createExistingApp();
    assertEquals((await put(f, existingAppBody(app))).status, 200);
    const lookups = f.github.appLookups().length;
    const before = await registrationFacts(f);
    const privateKey = "not a key";
    for (
      const [body, version] of [
        [existingAppBody(app, { privateKey }), undefined],
        [existingAppBody(app, { privateKey }), 7],
        [existingAppBody(other, { privateKey }), 1],
      ] as const
    ) {
      const response = await put(f, body, { version });
      assertEquals(response.status, 400, await response.clone().text());
      const problem = await response.json();
      assertEquals(problem.code, "MALFORMED_REQUEST");
      assertEquals(problem.issues[0].path, ["privateKey"]);
    }
    assertEquals(f.github.appLookups().length, lookups);
    assertEquals(await registrationFacts(f), before);
  });
});

Deno.test("GitHub unavailable answers 503 and stores nothing", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    f.github.failAppLookups(502);
    const response = await put(f, existingAppBody(app));
    assertEquals(response.status, 503, await response.clone().text());
    assertEquals((await response.json()).code, "DEPENDENCY_UNAVAILABLE");
    assertEquals((await registrationFacts(f)).registrations, 0);
    assertEquals((await registrationFacts(f)).installationSecrets, 0);
  });
});

Deno.test("a new registration needs a client secret and no If-Match", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const { clientSecret: _omitted, ...withoutSecret } = existingAppBody(app);
    const missing = await put(f, withoutSecret);
    assertEquals(missing.status, 400, await missing.clone().text());
    assertEquals((await missing.json()).issues[0].path, ["clientSecret"]);
    const conditional = await put(f, existingAppBody(app), { version: 1 });
    assertEquals(conditional.status, 412);
    await conditional.body?.cancel();
    assertEquals(f.github.calls.length, 0);
    assertEquals((await registrationFacts(f)).registrations, 0);
  });
});

Deno.test("replacing a secret writes the next revision, uses it and keeps the previous one", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const audited = () =>
      count(
        f,
        "select count(*) from bakery.audit_events where operation = 'integrationAppRegistrations.put'",
      );
    const auditedBefore = await audited();
    const created = await put(f, existingAppBody(app));
    assertEquals(created.status, 200, await created.clone().text());
    const replacement = {
      clientSecret: `client-secret-${crypto.randomUUID()}`,
      webhookSecret: `webhook-secret-${crypto.randomUUID()}`,
    };
    const replaced = await put(
      f,
      existingAppBody(app, replacement),
      { version: 1 },
    );
    assertEquals(replaced.status, 200, await replaced.clone().text());
    const body = await replaced.json();
    assertEquals(body.version, 2);
    assertEquals(body.clientSecretRevision, 2);
    assertEquals(body.privateKeyRevision, 2);
    assertEquals(body.webhookSecretRevision, 2);
    const versions = await secretVersions(f);
    const of = (kind: string) =>
      versions.filter((version) => version.kind === kind).map((
        { revision, active, value },
      ) => ({ revision, active, value }));
    assertEquals(of("clientSecret"), [
      { revision: 1, active: false, value: app.clientSecret },
      { revision: 2, active: true, value: replacement.clientSecret },
    ]);
    assertEquals(of("webhookSecret"), [
      { revision: 1, active: false, value: app.webhookSecret! },
      { revision: 2, active: true, value: replacement.webhookSecret },
    ]);
    // A later put that omits a secret keeps its active version.
    const { clientSecret: _kept, webhookSecret: _alsoKept, ...keyOnly } =
      existingAppBody(app);
    const later = await put(f, keyOnly, { version: 2 });
    assertEquals(later.status, 200, await later.clone().text());
    const latest = await later.json();
    assertEquals(latest.clientSecretRevision, 2);
    assertEquals(latest.webhookSecretRevision, 2);
    assertEquals(latest.privateKeyRevision, 3);
    const counters = await f.pgDatabase.query<{
      generation: number;
      version: number;
    }>(
      `select s.generation, s.version from bakery.integration_app_registrations r
       join bakery.secrets s on s.id = r.client_secret_id`,
    );
    assertEquals(counters.rows[0], { generation: 2, version: 2 });
    assertEquals(await audited() - auditedBefore, 3);
  });
});

Deno.test("a replacement needs the current If-Match and the same App, checked before GitHub", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const other = await f.github.createExistingApp();
    assertEquals((await put(f, existingAppBody(app))).status, 200);
    const lookups = f.github.appLookups().length;
    const before = await registrationFacts(f);
    const missing = await put(f, existingAppBody(app));
    assertEquals(missing.status, 428);
    await missing.body?.cancel();
    const stale = await put(f, existingAppBody(app), { version: 7 });
    assertEquals(stale.status, 412);
    await stale.body?.cancel();
    const switched = await put(f, existingAppBody(other), { version: 1 });
    assertEquals(switched.status, 409, await switched.clone().text());
    const problem = await switched.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "app_mismatch");
    assertEquals(f.github.appLookups().length, lookups);
    assertEquals(await registrationFacts(f), before);
    assertEquals((await readRegistration(f)).version, 1);
  });
});

Deno.test("put attaches a webhook secret to a manifest App registered without one", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const start = await started(f);
    const { code } = f.github.issueCode({
      id: app.id,
      slug: app.slug,
      clientId: app.clientId,
      webhookSecret: null,
    });
    assertEquals(
      (await callback(f, { code, state: start.state })).status,
      303,
    );
    const registered = await readRegistration(f);
    assertEquals(registered.webhookSecretConfigured, false);
    const webhookSecret = `webhook-secret-${crypto.randomUUID()}`;
    const response = await put(
      f,
      {
        appId: app.id,
        clientId: app.clientId,
        privateKey: app.pkcs1Pem,
        webhookSecret,
      },
      { version: registered.version as number },
    );
    assertEquals(response.status, 200, await response.clone().text());
    const body = await response.json();
    assertEquals(body.webhookSecretConfigured, true);
    assertEquals(body.webhookSecretRevision, 1);
    assertEquals(body.clientSecretRevision, 1);
    assertEquals(
      (await secretVersions(f)).find((version) =>
        version.kind === "webhookSecret"
      )?.value,
      webhookSecret,
    );
  });
});

Deno.test("two first registrations racing past the probe store one App and refuse the other", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    // Both GET /app lookups wait until both puts reach GitHub, so both pass
    // the probe before either stores.
    f.github.holdConversions(2);
    const responses = await Promise.all([
      put(f, existingAppBody(app)),
      put(f, existingAppBody(app)),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    assertEquals(statuses, [200, 409]);
    const refused = responses.find((response) => response.status === 409)!;
    const problem = await refused.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "provider_registered");
    await responses.find((response) => response.status === 200)!.body
      ?.cancel();
    assertEquals(f.github.appLookups().length, 2);
    const facts = await registrationFacts(f);
    assertEquals(facts.registrations, 1);
    assertEquals(facts.installationSecrets, 3);
    assertEquals(facts.installationSecretVersions, 3);
  });
});

Deno.test("a first registration that loses to one committed during its GitHub check answers 409 provider_registered", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    // The late put passes the probe and waits at GET /app while the other
    // put stores the App, so its locked re-read finds a committed row.
    const held = f.github.holdNextAppLookup();
    const late = put(f, existingAppBody(app));
    await held.inFlight;
    const first = await put(f, existingAppBody(app));
    assertEquals(first.status, 200, await first.clone().text());
    await first.body?.cancel();
    held.release();
    const refused = await late;
    assertEquals(refused.status, 409);
    const problem = await refused.json();
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "provider_registered");
    const facts = await registrationFacts(f);
    assertEquals(facts.registrations, 1);
    assertEquals(facts.installationSecretVersions, 3);
  });
});

Deno.test("a put retried with the same Idempotency-Key replays without calling GitHub", async () => {
  await withFixture(async (f) => {
    const app = await f.github.createExistingApp();
    const key = crypto.randomUUID();
    const first = await put(f, existingAppBody(app), { key });
    assertEquals(first.status, 200, await first.clone().text());
    const firstBody = await first.json();
    const retry = await put(f, existingAppBody(app), { key });
    assertEquals(retry.status, 200, await retry.clone().text());
    assertEquals(retry.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await retry.json(), firstBody);
    assertEquals(f.github.appLookups().length, 1);
    assertEquals((await registrationFacts(f)).installationSecretVersions, 3);
    const changed = await put(
      f,
      existingAppBody(app, { webhookSecret: "another" }),
      { key },
    );
    assertEquals(changed.status, 422);
    assertEquals((await changed.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const missingKey = await call(
      f,
      "PUT",
      "/v1/integration-app-registrations/github",
      f.adminCookie,
      { body: existingAppBody(app) },
    );
    assertEquals(missingKey.status, 428);
    await missingKey.body?.cancel();
  });
});
