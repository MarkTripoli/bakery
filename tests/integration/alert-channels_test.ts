import { assert, assertEquals } from "@std/assert";
import { createHmac } from "node:crypto";
import { createPublicHttpsPolicy } from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

/**
 * Alert channels against a real database and a real HTTP receiver. No hosted
 * service is involved.
 *
 * What only this can show: the signing secret is shown once and sealed in the
 * database, a test send really reaches the receiver signed so that it verifies,
 * a refusing receiver reads as failing with its own answer, a replaced secret
 * stops the old one verifying, and the address rules and limits hold.
 */

type Body = Record<string, unknown>;
type Seen = { headers: Record<string, string>; body: string };
type Channel = {
  id: string;
  version: number;
  name: string;
  state: string;
  enabled: boolean;
  settings: { address: string };
  lastAnswerOk: boolean | null;
  lastAnswerReason: string | null;
};

function receiver(status: () => number) {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      // Only POSTs are the test's traffic. A host that probes new localhost ports
      // (mini1 does) sends empty requests that must not count as deliveries.
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      seen.push({
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return new Response("received", { status: status() });
    },
  );
  return {
    seen,
    address: `http://127.0.0.1:${server.addr.port}/alerts`,
    close: () => server.shutdown(),
  };
}

/** What a receiver does to check a message: HMAC-SHA256 of "<t>.<body>". */
function verifies(seen: Seen, secret: string): boolean {
  const parts = Object.fromEntries(
    (seen.headers["bakery-signature"] ?? "").split(",").map((part) =>
      part.split("=") as [string, string]
    ),
  );
  const expected = createHmac("sha256", secret)
    .update(`${parts.t}.${seen.body}`).digest("hex");
  return parts.v1 === expected;
}

Deno.test("an administrator manages signed webhook alert channels that really receive a message", async () => {
  const keyFile = await Deno.makeTempFile({ prefix: "bakery-alerts-key-" });
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const secretsKey = { file: keyFile, keyId: "alert-channels-v1" };
  let answer = 200;
  const hook = receiver(() => answer);
  const publicPolicy = createPublicHttpsPolicy();
  const dependencies = {
    secretsKey: secretsKey as typeof secretsKey | undefined,
    fetch,
    // The receiver runs on loopback; every other address follows the public rules.
    addressPolicy: (address: string) =>
      address.startsWith(hook.address)
        ? Promise.resolve({ ok: true as const })
        : publicPolicy(address),
  };
  const f = await openInstallationFixture(true, {
    secretsKey,
    alertChannels: dependencies,
  });
  const org = { "Bakery-Organization-Id": f.organizationId };
  const send = async (
    cookie: string,
    method: string,
    path: string,
    options: { body?: unknown; ifMatch?: string } = {},
  ) => {
    const headers: Record<string, string> = { ...org };
    if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    const response = await call(f, method, path, cookie, {
      body: options.body,
      headers,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) as Body : {},
    };
  };
  const list = async () => {
    const r = await send(
      f.adminCookie,
      "GET",
      "/v1/installation/alert-channels",
    );
    assertEquals(r.status, 200, r.text);
    return {
      text: r.text,
      channels: (r.json as { channels: Channel[] }).channels,
    };
  };
  const basePath = "/v1/installation/alert-channels";
  try {
    // Only an installation administrator sees or changes any of it.
    for (
      const [method, path, body] of [
        ["GET", basePath, undefined],
        ["POST", basePath, {
          kind: "webhook",
          name: "x",
          values: { address: hook.address },
        }],
      ] as const
    ) {
      const denied = await send(f.developerCookie!, method, path, { body });
      assertEquals(denied.status, 403, denied.text);
    }
    assertEquals((await list()).channels, []);

    // The address rules: https only, and nothing private or local.
    for (
      const address of [
        "http://example.test/hook",
        "https://127.0.0.1/hook",
        "https://localhost/hook",
        "https://user:pw@example.test/hook",
        "",
      ]
    ) {
      const refused = await send(f.adminCookie, "POST", basePath, {
        body: { kind: "webhook", name: "Refused", values: { address } },
      });
      assertEquals(refused.status, 422, `${address}: ${refused.text}`);
      assert(refused.text.includes('"address"'), refused.text);
    }
    const unknownSetting = await send(f.adminCookie, "POST", basePath, {
      body: {
        kind: "webhook",
        name: "Unknown",
        values: { address: hook.address, headerName: "x" },
      },
    });
    assertEquals(unknownSetting.status, 422, unknownSetting.text);
    assertEquals((await list()).channels, [], "nothing was created");

    // Create: the signing secret comes back once.
    const created = await send(f.adminCookie, "POST", basePath, {
      body: {
        kind: "webhook",
        name: "On call",
        values: { address: hook.address },
      },
    });
    assertEquals(created.status, 201, created.text);
    const issued = created.json as { channel: Channel; signingSecret: string };
    const secret = issued.signingSecret;
    assert(secret.startsWith("whsec_") && secret.length > 30);
    assertEquals(issued.channel.state, "not_tested_yet");
    assertEquals(issued.channel.settings, { address: hook.address });
    assert(!("signingSecret" in issued.channel));

    // It is never read back, and is sealed in the database.
    const afterCreate = await list();
    assertEquals(afterCreate.channels.length, 1);
    assert(!afterCreate.text.includes(secret), "the list returned the secret");
    const stored = await f.pgDatabase.query<{ ciphertext: Uint8Array }>(
      `select version.ciphertext from bakery.secret_versions version
         join bakery.alert_channels channel on channel.secret_id = version.secret_id
        where channel.id = $1`,
      [issued.channel.id],
    );
    assertEquals(stored.rows.length, 1);
    assert(
      !new TextDecoder("latin1").decode(stored.rows[0].ciphertext).includes(
        secret,
      ),
      "the secret is stored in the clear",
    );

    // A name already used (ignoring case) is refused.
    const clash = await send(f.adminCookie, "POST", basePath, {
      body: {
        kind: "webhook",
        name: "ON CALL",
        values: { address: hook.address },
      },
    });
    assertEquals(clash.status, 409, clash.text);

    // Test send: one signed message reaches the receiver, and the page can say Working.
    const tested = await send(
      f.adminCookie,
      "POST",
      `${basePath}/${issued.channel.id}/tests`,
    );
    assertEquals(tested.status, 200, tested.text);
    assertEquals([tested.json.ok, tested.json.status], [true, 200]);
    assertEquals(hook.seen.length, 1);
    assert(verifies(hook.seen[0], secret), "the message does not verify");
    assertEquals(JSON.parse(hook.seen[0].body).type, "alert.test");
    assert(hook.seen[0].headers["bakery-event-id"]?.length > 0);
    const working = (await list()).channels[0];
    assertEquals([working.state, working.lastAnswerOk], ["working", true]);
    assertEquals(
      working.version,
      issued.channel.version,
      "a test does not change the version a page holds",
    );

    // A receiver that refuses reads as failing, in plain words.
    answer = 500;
    const refusedTest = await send(
      f.adminCookie,
      "POST",
      `${basePath}/${issued.channel.id}/tests`,
    );
    assertEquals([refusedTest.json.ok, refusedTest.json.status], [false, 500]);
    assertEquals(
      refusedTest.json.reason,
      "The receiver did not accept the message.",
    );
    answer = 200;
    const failing = (await list()).channels[0];
    assertEquals(failing.state, "failing");

    // Update needs the version; a new address clears what it last answered.
    const noMatch = await send(
      f.adminCookie,
      "PATCH",
      `${basePath}/${issued.channel.id}`,
      {
        body: { name: "Pager" },
      },
    );
    assertEquals(noMatch.status, 428);
    const stale = await send(
      f.adminCookie,
      "PATCH",
      `${basePath}/${issued.channel.id}`,
      {
        body: { name: "Pager" },
        ifMatch: '"99"',
      },
    );
    assertEquals(stale.status, 412);
    const renamed = await send(
      f.adminCookie,
      "PATCH",
      `${basePath}/${issued.channel.id}`,
      {
        body: { name: "Pager", values: { address: `${hook.address}?b=1` } },
        ifMatch: `"${issued.channel.version}"`,
      },
    );
    assertEquals(renamed.status, 200, renamed.text);
    const afterRename = renamed.json as unknown as Channel;
    assertEquals(afterRename.version, issued.channel.version + 1);
    assertEquals(afterRename.state, "not_tested_yet");
    const turnedOff = await send(
      f.adminCookie,
      "PATCH",
      `${basePath}/${issued.channel.id}`,
      {
        body: { enabled: false },
        ifMatch: `"${afterRename.version}"`,
      },
    );
    assertEquals((turnedOff.json as unknown as Channel).state, "off");
    const turnedOn = await send(
      f.adminCookie,
      "PATCH",
      `${basePath}/${issued.channel.id}`,
      {
        body: { enabled: true },
        ifMatch: `"${(turnedOff.json as unknown as Channel).version}"`,
      },
    );
    assertEquals(turnedOn.status, 200, turnedOn.text);
    const current = turnedOn.json as unknown as Channel;

    // Replacing the secret: the new one verifies, the old one no longer does.
    const rotated = await send(
      f.adminCookie,
      "POST",
      `${basePath}/${issued.channel.id}/secret-rotations`,
      { ifMatch: `"${current.version}"` },
    );
    assertEquals(rotated.status, 200, rotated.text);
    const next = rotated.json as { channel: Channel; signingSecret: string };
    assert(next.signingSecret !== secret);
    assertEquals(next.channel.version, current.version + 1);
    const before = hook.seen.length;
    await send(f.adminCookie, "POST", `${basePath}/${issued.channel.id}/tests`);
    assertEquals(hook.seen.length, before + 1);
    assert(verifies(hook.seen[before], next.signingSecret));
    assert(
      !verifies(hook.seen[before], secret),
      "the old secret still verifies",
    );
    assert(!(await list()).text.includes(next.signingSecret));

    // At most 20 channels, even when creates race: four at once with room for
    // two must admit exactly two.
    const make = (name: string) =>
      send(f.adminCookie, "POST", basePath, {
        body: { kind: "webhook", name, values: { address: hook.address } },
      });
    for (let n = 0; n < 17; n += 1) {
      const more = await make(`Channel ${n}`);
      assertEquals(more.status, 201, more.text);
    }
    const raced = await Promise.all(
      ["Race A", "Race B", "Race C", "Race D"].map(make),
    );
    assertEquals(
      raced.map((r) => r.status).sort(),
      [201, 201, 409, 409],
      "concurrent creates went past the limit",
    );
    const overLimit = await send(f.adminCookie, "POST", basePath, {
      body: {
        kind: "webhook",
        name: "One too many",
        values: { address: hook.address },
      },
    });
    assertEquals(overLimit.status, 409, overLimit.text);

    // Removing a channel needs its version too.
    const gone = await send(
      f.adminCookie,
      "DELETE",
      `${basePath}/${issued.channel.id}`,
      {
        ifMatch: `"${next.channel.version}"`,
      },
    );
    assertEquals(gone.status, 204, gone.text);
    assertEquals((await list()).channels.length, 19);
    const again = await send(
      f.adminCookie,
      "DELETE",
      `${basePath}/${issued.channel.id}`,
      {
        ifMatch: `"${next.channel.version}"`,
      },
    );
    assertEquals(again.status, 404);

    // Without a secrets key a channel cannot be created, and nothing is left behind.
    const count = async () =>
      (await f.pgDatabase.query<{ count: string }>(
        "select count(*)::text as count from bakery.alert_channels",
      )).rows[0].count;
    const before19 = await count();
    dependencies.secretsKey = undefined;
    const noKey = await send(f.adminCookie, "POST", basePath, {
      body: {
        kind: "webhook",
        name: "No key",
        values: { address: hook.address },
      },
    });
    assertEquals(noKey.status, 409, noKey.text);
    assertEquals(await count(), before19);
  } finally {
    await hook.close();
    await f.close();
    await Deno.remove(keyFile);
  }
});
