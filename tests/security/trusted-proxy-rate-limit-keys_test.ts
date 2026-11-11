import { assert, assertEquals } from "@std/assert";
import { parseTrustedProxyCidrs } from "../../packages/config/src/env.ts";
import { mainRouter } from "../../apps/server/src/main.ts";
import { authRequest, openAuthFixture } from "../helpers/auth.ts";

const random = crypto.getRandomValues(new Uint8Array(3));
// TEST-NET-3 (RFC 5737) with per-process random octets: distinct from the
// synthetic 10.x clients and the 192.0.2.x literals other suites use.
const clientA = `203.0.113.${1 + (random[0] % 120)}`;
const clientB = `203.0.113.${130 + (random[1] % 120)}`;
const spoofed = `198.51.100.${1 + (random[2] % 250)}`;
const trustedPeer = `10.${200 + (random[0] % 50)}.${random[1]}.${
  1 + (random[2] % 250)
}`;
const untrustedPeer = `192.0.2.${1 + (random[2] % 250)}`;
const unknownEmail = `rate-key-probe-${crypto.randomUUID()}@example.test`;

// Keys are `<address>|<path>`. Matching on `<address>|` keeps 203.0.113.1 from
// also matching 203.0.113.130 (a bare prefix would).
const keyPattern = (address: string): string => `${address}|%`;
const addressOf = (key: string): string => key.split("|", 1)[0];

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;

function routerFor(fixture: Fixture, trustedProxies?: string) {
  const unrouted = {
    fetch: () => new Response("not used", { status: 500 }),
  };
  return mainRouter(
    { cleanup: unrouted, control: unrouted, app: fixture.app },
    trustedProxies
      ? { trustedProxies: parseTrustedProxyCidrs(trustedProxies) }
      : {},
  );
}

async function signIn(
  route: ReturnType<typeof routerFor>,
  peer: string,
  forwardedFor: string[],
): Promise<void> {
  const headers = new Headers();
  for (const line of forwardedFor) headers.append("x-forwarded-for", line);
  const response = await route(
    authRequest(
      "/api/auth/sign-in/email",
      { email: unknownEmail, password: "wrong-password-not-used" },
      { headers },
    ),
    { remoteAddr: { transport: "tcp", hostname: peer, port: 5555 } },
  );
  await response.body?.cancel();
  assert(
    response.status === 401 || response.status === 400 ||
      response.status === 403,
    `unexpected sign-in status ${response.status}`,
  );
}

async function keysFor(
  fixture: Fixture,
  addresses: string[],
): Promise<string[]> {
  const result = await fixture.pgDatabase.query<{ key: string }>(
    `select key from "rateLimit" where key like any($1::text[]) order by key`,
    [addresses.map(keyPattern)],
  );
  return result.rows.map((row) => row.key);
}

async function clearKeys(fixture: Fixture, addresses: string[]) {
  await fixture.pgDatabase.query(
    `delete from "rateLimit" where key like any($1::text[])`,
    [addresses.map(keyPattern)],
  );
}

const involved = [clientA, clientB, spoofed, trustedPeer, untrustedPeer];

Deno.test("a trusted proxy peer gives each forwarded client its own rate-limit key", async () => {
  const fixture = await openAuthFixture();
  try {
    await clearKeys(fixture, involved);
    const route = routerFor(fixture, "10.0.0.0/8");
    await signIn(route, trustedPeer, [clientA]);
    await signIn(route, trustedPeer, [clientB]);
    await signIn(route, trustedPeer, [clientB]);

    const keys = await keysFor(fixture, involved);
    assertEquals(keys.filter((key) => addressOf(key) === clientA).length, 1);
    assertEquals(keys.filter((key) => addressOf(key) === clientB).length, 1);
    assertEquals(
      keys.filter((key) => addressOf(key) === trustedPeer).length,
      0,
    );
    const counts = await fixture.pgDatabase.query<
      { key: string; count: number }
    >(
      `select key, count from "rateLimit" where key like any($1::text[])`,
      [[clientA, clientB].map(keyPattern)],
    );
    const byAddress = new Map(
      counts.rows.map((row) => [addressOf(row.key), row.count]),
    );
    assertEquals(byAddress.get(clientA), 1);
    assertEquals(byAddress.get(clientB), 2);
  } finally {
    await clearKeys(fixture, involved);
    await fixture.close();
  }
});

Deno.test("without the setting every request keys on the connection address", async () => {
  const fixture = await openAuthFixture();
  try {
    await clearKeys(fixture, involved);
    const route = routerFor(fixture);
    await signIn(route, trustedPeer, [clientA]);
    await signIn(route, trustedPeer, [clientB]);

    const keys = await keysFor(fixture, involved);
    assertEquals(keys.length, 1);
    assertEquals(addressOf(keys[0]), trustedPeer);
  } finally {
    await clearKeys(fixture, involved);
    await fixture.close();
  }
});

Deno.test("an untrusted peer cannot choose its key with X-Forwarded-For", async () => {
  const fixture = await openAuthFixture();
  try {
    await clearKeys(fixture, involved);
    const route = routerFor(fixture, "10.0.0.0/8");
    await signIn(route, untrustedPeer, [clientA]);
    await signIn(route, untrustedPeer, [clientB]);

    const keys = await keysFor(fixture, involved);
    assertEquals(keys.length, 1);
    assertEquals(addressOf(keys[0]), untrustedPeer);
  } finally {
    await clearKeys(fixture, involved);
    await fixture.close();
  }
});

Deno.test("a forged leftmost X-Forwarded-For entry does not change the key", async () => {
  const fixture = await openAuthFixture();
  try {
    await clearKeys(fixture, involved);
    const route = routerFor(fixture, "10.0.0.0/8");
    // The proxy appended the real client (clientA); the attacker supplied the
    // entries to its left, across two header lines.
    await signIn(route, trustedPeer, [spoofed, `${clientB}, ${clientA}`]);
    await signIn(route, trustedPeer, [`${clientB}, ${clientA}`]);

    const keys = await keysFor(fixture, involved);
    assertEquals(keys.length, 1);
    assertEquals(addressOf(keys[0]), clientA);
  } finally {
    await clearKeys(fixture, involved);
    await fixture.close();
  }
});

Deno.test("a malformed chain from a trusted peer fails closed onto the peer key", async () => {
  const fixture = await openAuthFixture();
  try {
    await clearKeys(fixture, involved);
    const route = routerFor(fixture, "10.0.0.0/8");
    await signIn(route, trustedPeer, [`${clientA}, not-an-address`]);

    const keys = await keysFor(fixture, involved);
    assertEquals(keys.length, 1);
    assertEquals(addressOf(keys[0]), trustedPeer);
  } finally {
    await clearKeys(fixture, involved);
    await fixture.close();
  }
});
