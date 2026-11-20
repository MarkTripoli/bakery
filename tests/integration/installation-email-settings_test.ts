import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  call,
  openInstallationFixture,
  signIn,
} from "../helpers/installation-settings.ts";
import type {
  SmtpConnection,
  SmtpMessage,
  SmtpOutcome,
} from "../../apps/server/src/modules/work/smtp-client.ts";

/**
 * #458: installation email settings. Only an installation administrator reads
 * or changes them, the password is write-only and sealed, a save clears the
 * last test, and the test goes only to the signed-in administrator. Real routes
 * and real Postgres; the SMTP exchange itself is replaced by a recorder here
 * and covered against a fake server in the SMTP client unit test.
 */

const path = "/v1/installation/email";
const secret = "correct horse battery staple";

type Projection = {
  state: string;
  host: string | null;
  port: number | null;
  security: string | null;
  username: string | null;
  passwordStored: boolean;
  passwordSavedAt: string | null;
  fromAddress: string | null;
  fromName: string | null;
  lastTest: { outcome: string; address: string | null } | null;
  version: number;
};

function body(extra: Record<string, unknown> = {}) {
  return {
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    username: "bakery",
    fromAddress: "bakery@example.com",
    fromName: "Bakery",
    ...extra,
  };
}

async function open() {
  const directory = await Deno.makeTempDir({ prefix: "bakery-email-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const sent: { connection: SmtpConnection; message: SmtpMessage }[] = [];
  const state = { outcome: "delivered" as SmtpOutcome };
  const fixture = await openInstallationFixture(true, {
    secretsKey: { file, keyId: "email-fixture-key-v1" },
    emailSend: (connection, message) => {
      sent.push({ connection, message });
      return Promise.resolve(state.outcome);
    },
  });
  const clear = async () => {
    const secrets = await fixture.pgDatabase.query<{ secretId: string | null }>(
      'delete from bakery.installation_email_settings returning secret_id as "secretId"',
    );
    const ids = (await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.secrets where organization_id is null and provider = 'smtp'",
    )).rows.map((row) => row.id);
    void secrets;
    if (ids.length === 0) return;
    await fixture.pgDatabase.query(
      "update bakery.secrets set active_version_id = null where id = any($1::uuid[])",
      [ids],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.secret_versions where secret_id = any($1::uuid[])",
      [ids],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.secrets where id = any($1::uuid[])",
      [ids],
    );
  };
  await clear();
  const developerCookie = await signIn(
    fixture,
    fixture.developerEmail,
    fixture.password,
  );
  return {
    fixture,
    sent,
    state,
    developerCookie,
    clear,
    finish: async () => {
      try {
        await clear();
      } finally {
        try {
          await fixture.finish();
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    },
  };
}

type Opened = Awaited<ReturnType<typeof open>>;

const get = (o: Opened, cookie = o.fixture.adminCookie) =>
  call(o.fixture, "GET", path, cookie);

function put(
  o: Opened,
  payload: unknown,
  options: { version?: number; cookie?: string } = {},
) {
  return call(o.fixture, "PUT", path, options.cookie ?? o.fixture.adminCookie, {
    body: payload,
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
      ...(options.version === undefined
        ? {}
        : { "If-Match": `"v${options.version}"` }),
    },
  });
}

const testSend = (o: Opened, cookie = o.fixture.adminCookie) =>
  call(o.fixture, "POST", `${path}/test`, cookie, {
    body: {},
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });

/** The operation takes an empty object, like the other installation commands. */
function del(o: Opened, headers: Record<string, string>, cookie?: string) {
  return Promise.resolve(o.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "DELETE",
      body: "{}",
      headers: new Headers({
        cookie: cookie ?? o.fixture.adminCookie,
        origin: authTestOrigin,
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        ...headers,
      }),
    }),
  ));
}

const turnOff = (o: Opened, version: number, cookie?: string) =>
  del(o, { "If-Match": `"v${version}"` }, cookie);

async function projection(response: Response, status = 200) {
  const text = await response.text();
  assertEquals(response.status, status, text);
  assert(!text.includes(secret), "the password was returned");
  return JSON.parse(text) as Projection;
}

Deno.test("email is off until an installation administrator sets it up", async () => {
  const o = await open();
  try {
    const off = await projection(await get(o));
    assertEquals(off.state, "off");
    assertEquals(off.version, 0);
    assertEquals(off.passwordStored, false);
    assertEquals(off.host, null);

    // A developer, not an installation administrator, cannot see or change it.
    assertEquals((await get(o, o.developerCookie)).status, 403);
    assertEquals(
      (await put(o, body(), { cookie: o.developerCookie })).status,
      403,
    );
    assertEquals((await testSend(o, o.developerCookie)).status, 403);

    // First save: no If-Match, state not_tested.
    const saved = await projection(await put(o, body()));
    assertEquals(saved.state, "not_tested");
    assertEquals(saved.version, 1);
    assertEquals(saved.passwordStored, false);
  } finally {
    await o.finish();
  }
});

Deno.test("a save is validated and never returns or stores the password in the clear", async () => {
  const o = await open();
  try {
    for (
      const [field, value] of [
        ["host", "https://smtp.example.com"],
        ["host", "smtp.example.com/path"],
        ["fromAddress", "not an address"],
        ["fromName", "Bakery\r\nBcc: x@example.com"],
        ["security", "plain"],
      ] as const
    ) {
      assertEquals(
        (await put(o, body({ [field]: value }))).status,
        422,
        `${field}=${value}`,
      );
    }
    // A password needs an account name to authenticate with.
    assertEquals(
      (await put(o, body({ username: null, password: secret }))).status,
      422,
    );

    const saved = await projection(await put(o, body({ password: secret })));
    assertEquals(saved.passwordStored, true);
    assertNotEquals(saved.passwordSavedAt, null);
    const row = await o.fixture.pgDatabase.query<{ ciphertext: Uint8Array }>(
      `select version.ciphertext from bakery.secrets as s
         join bakery.secret_versions as version on version.secret_id = s.id
        where s.organization_id is null and s.provider = 'smtp'`,
    );
    assertEquals(row.rows.length, 1);
    const stored = new TextDecoder("latin1").decode(
      new Uint8Array(row.rows[0].ciphertext),
    );
    assert(!stored.includes(secret), "the password is stored in the clear");
    assertEquals((await projection(await get(o))).passwordStored, true);
  } finally {
    await o.finish();
  }
});

Deno.test("a save needs the current version and clears the last test", async () => {
  const o = await open();
  try {
    const first = await projection(await put(o, body({ password: secret })));
    // Omitting the password keeps the stored one.
    assertEquals((await put(o, body({ port: 465 }))).status, 428);
    assertEquals(
      (await put(o, body({ port: 465 }), { version: first.version + 5 }))
        .status,
      412,
    );
    assertEquals((await testSend(o)).status, 200);
    assertEquals((await projection(await get(o))).state, "working");

    const second = await projection(
      await put(o, body({ port: 465, security: "tls" }), {
        version: first.version,
      }),
    );
    assertEquals(second.version, first.version + 1);
    assertEquals(second.passwordStored, true);
    assertEquals(second.state, "not_tested");
    assertEquals(second.lastTest, null);
  } finally {
    await o.finish();
  }
});

Deno.test("the test email goes only to the administrator and reports a fixed outcome", async () => {
  const o = await open();
  try {
    // Nothing set up: no mail is sent and the answer says so.
    const none = await testSend(o);
    assertEquals(none.status, 200);
    assertEquals((await none.json()).outcome, "not_configured");
    assertEquals(o.sent.length, 0);

    await projection(await put(o, body({ password: secret })));
    const ok = await testSend(o);
    assertEquals(ok.status, 200);
    const result = await ok.json();
    assertEquals(result.outcome, "delivered");
    assertEquals(result.address, o.fixture.adminEmail);
    assertEquals(o.sent.length, 1);
    // The recipient is the signed-in administrator, never typed; the stored
    // password is opened for this one send.
    assertEquals(o.sent[0].message.to, o.fixture.adminEmail);
    assertEquals(o.sent[0].connection.password, secret);
    assertEquals(o.sent[0].connection.username, "bakery");
    assertEquals((await projection(await get(o))).state, "working");

    o.state.outcome = "auth_refused";
    const refused = await testSend(o);
    assertEquals((await refused.json()).outcome, "auth_refused");
    const after = await projection(await get(o));
    assertEquals(after.state, "not_working");
    assertEquals(after.lastTest?.outcome, "auth_refused");
  } finally {
    await o.finish();
  }
});

Deno.test("turning email off removes the password from use", async () => {
  const o = await open();
  try {
    const saved = await projection(await put(o, body({ password: secret })));
    const stale = await turnOff(o, saved.version + 3);
    assertEquals(stale.status, 412, await stale.text());
    assertEquals((await del(o, {})).status, 428);
    assertEquals((await turnOff(o, saved.version)).status, 204);
    assertEquals((await projection(await get(o))).state, "off");

    const revoked = await o.fixture.pgDatabase.query<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from bakery.secrets
        where organization_id is null and provider = 'smtp'`,
    );
    assertEquals(revoked.rows.map((row) => row.revoked), [true]);
    assertEquals(
      (await (await testSend(o)).json()).outcome,
      "not_configured",
    );
    assertEquals(o.sent.length, 0);
  } finally {
    await o.finish();
  }
});
