import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  authRequest,
  authTestOrigin,
  openAuthFixture,
} from "../helpers/auth.ts";

const random = crypto.getRandomValues(new Uint8Array(2));
// TEST-NET-2 (RFC 5737) with per-process random octets: distinct from the
// synthetic 10.x clients. trusted-proxy-rate-limit-keys_test.ts draws its
// spoofed address from the same range, so the two files could only share a key
// if they ran at the same time; the lane runs test files one after another.
const clientA = `198.51.100.${1 + (random[0] % 120)}`;
const clientB = `198.51.100.${130 + (random[1] % 120)}`;
const email = `retry-after-${crypto.randomUUID()}@example.test`;

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;

async function signIn(fixture: Fixture, address: string): Promise<Response> {
  const response = await fixture.app.fetch(
    authRequest("/api/auth/sign-in/email", {
      email,
      password: "wrong-password-not-used",
    }),
    { remoteAddr: { transport: "tcp", hostname: address, port: 5555 } },
  );
  await response.body?.cancel();
  return response;
}

async function clear(fixture: Fixture) {
  await fixture.pgDatabase.query(
    `delete from "rateLimit" where key like any($1::text[])`,
    [[clientA, clientB].map((address) => `${address}|%`)],
  );
}

Deno.test("sign-in throttle answers 429 with an integer X-Retry-After inside the window", async () => {
  const fixture = await openAuthFixture();
  try {
    await clear(fixture);
    // Built-in /sign-in* rule: 3 requests per 10 s per address.
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert(
        (await signIn(fixture, clientA)).status !== 429,
        `attempt ${attempt} must not be throttled`,
      );
    }
    const throttled = await signIn(fixture, clientA);
    assertEquals(throttled.status, 429);
    const retryAfter = throttled.headers.get("X-Retry-After");
    assert(retryAfter !== null, "X-Retry-After must be present");
    assertMatch(retryAfter, /^\d+$/);
    assert(
      Number(retryAfter) >= 1 && Number(retryAfter) <= 10,
      `X-Retry-After ${retryAfter} must be 1..10 seconds`,
    );
    assertEquals((await signIn(fixture, clientA)).status, 429);

    // A different address has its own bucket.
    assert((await signIn(fixture, clientB)).status !== 429);

    // Stored value unchanged: epoch milliseconds (double precision since 0013).
    const row = await fixture.pgDatabase.query<{ count: number; last: string }>(
      `select count, "lastRequest"::text as last from "rateLimit" where key like $1`,
      [`${clientA}|%`],
    );
    assertEquals(row.rows.length, 1);
    assertMatch(row.rows[0].last, /^\d{13}$/);
  } finally {
    await clear(fixture);
    await fixture.close();
  }
});

Deno.test("rateLimit.lastRequest is a number-returning column", async () => {
  const fixture = await openAuthFixture();
  try {
    const column = await fixture.pgDatabase.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'rateLimit'
         and column_name = 'lastRequest'`,
    );
    assertEquals(column.rows[0]?.data_type, "double precision");
  } finally {
    await fixture.close();
  }
});

Deno.test("an expired window resets and a live 60 s bucket survives the prune", async () => {
  const fixture = await openAuthFixture();
  try {
    await clear(fixture);
    const old = Date.now() - 11_000;
    const resetKey = `${clientA}|/sign-in/email`;
    const liveKey = `${clientB}|/request-password-reset`;
    await fixture.pgDatabase.query(
      `insert into "rateLimit" (key, count, "lastRequest") values ($1, 3, $3), ($2, 3, $3)`,
      [resetKey, liveKey, old],
    );
    // The 10 s sign-in window elapsed: allowed again, count restarts at 1.
    assert((await signIn(fixture, clientA)).status !== 429);
    const reset = await fixture.pgDatabase.query<{ count: number }>(
      `select count from "rateLimit" where key = $1`,
      [resetKey],
    );
    assertEquals(reset.rows[0].count, 1);
    // The 60 s password-reset bucket is only 11 s old: still stored, still full.
    const live = await fixture.pgDatabase.query<{ count: number }>(
      `select count from "rateLimit" where key = $1`,
      [liveKey],
    );
    assertEquals(live.rows[0]?.count, 3);
    const response = await fixture.app.fetch(
      authRequest("/api/auth/request-password-reset", {
        email,
        redirectTo: authTestOrigin,
      }),
      { remoteAddr: { transport: "tcp", hostname: clientB, port: 5555 } },
    );
    await response.body?.cancel();
    assertEquals(response.status, 429);
    const retryAfter = Number(response.headers.get("X-Retry-After"));
    assert(retryAfter >= 1 && retryAfter <= 60, `retry-after ${retryAfter}`);
  } finally {
    await clear(fixture);
    await fixture.close();
  }
});
