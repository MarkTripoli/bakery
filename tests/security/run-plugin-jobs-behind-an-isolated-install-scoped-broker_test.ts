import { assert, assertEquals } from "@std/assert";
import {
  BROKER_MAX_REMEMBERED_REQUESTS,
  BROKER_MAX_REQUEST_BYTES,
  BROKER_RATE_LIMIT,
  BROKER_RATE_WINDOW_MS,
  BROKER_TOKEN_MAX_TTL_MS,
  type BrokerOperation,
  createPluginBroker,
  type InstallAuthority,
  mintBrokerToken,
} from "../../apps/server/src/modules/catalog/plugin-broker.ts";

/**
 * Hostile callers of the plugin broker (#29, B14.02, AC2): spoofed messages,
 * reused bindings, revoked installs and runaway call rates. Each case names
 * the thing the broker must refuse and the effect that must not have run.
 */

const KEY = crypto.getRandomValues(new Uint8Array(32));
const EPOCH = "boot-1";
const ORG = "org-1";
const INSTALL = "install-1";

function setup(
  authority: () => InstallAuthority | null = () => ({
    status: "enabled",
    grants: ["state.read"],
  }),
) {
  let clock = 1_000_000;
  const ran: string[] = [];
  const read: BrokerOperation = {
    name: "state.read",
    run: (_claims, args) => {
      ran.push(String(args.key));
      return Promise.resolve({ value: `v-${args.key}` });
    },
  };
  const write: BrokerOperation = {
    name: "state.write",
    run: () => {
      ran.push("write");
      return Promise.resolve({});
    },
  };
  const broker = createPluginBroker({
    key: KEY,
    epoch: EPOCH,
    authority: { load: () => Promise.resolve(authority()) },
    operations: [read, write],
    now: () => clock,
  });
  const mint = (installId = INSTALL, ttlMs = 60_000) =>
    mintBrokerToken(KEY, {
      runEnvironment: "live",
      epoch: EPOCH,
      organizationId: ORG,
      installId,
      jobId: "job-1",
      now: clock,
      ttlMs,
    });
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      requestId: crypto.randomUUID(),
      sequence: 1,
      operation: "state.read",
      args: { key: "a" },
      ...over,
    });
  return {
    broker,
    mint,
    body,
    ran,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

Deno.test("a token the broker did not sign is refused, and nothing runs", async () => {
  const t = setup();
  const other = crypto.getRandomValues(new Uint8Array(32));
  const { token } = await mintBrokerToken(other, {
    runEnvironment: "live",
    epoch: EPOCH,
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    now: 1_000_000,
    ttlMs: 60_000,
  });
  const outcome = await t.broker.call({
    token,
    installId: INSTALL,
    body: t.body(),
  });
  assertEquals(outcome, { ok: false, denial: "token_invalid" });
  assertEquals(t.ran, []);
});

Deno.test("an edited token (a different install in the claims) is refused", async () => {
  const t = setup();
  const { token } = await t.mint();
  const [body, mac] = token.split(".") as [string, string];
  const claims = JSON.parse(
    atob(body.replaceAll("-", "+").replaceAll("_", "/")),
  );
  claims.installId = "install-2";
  const forged = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
  for (const candidate of [`${forged}.${mac}`, `${body}.`, "", "a.b.c", "x"]) {
    const outcome = await t.broker.call({
      token: candidate,
      installId: "install-2",
      body: t.body(),
    });
    assertEquals(outcome, { ok: false, denial: "token_invalid" });
  }
  assertEquals(t.ran, []);
});

Deno.test("a token for one install cannot act for another, whatever the caller says", async () => {
  const t = setup();
  const { token } = await t.mint("install-1");
  const outcome = await t.broker.call({
    token,
    installId: "install-2",
    body: t.body({ organizationId: "org-2", installId: "install-2" }),
  });
  assertEquals(outcome, { ok: false, denial: "install_mismatch" });
  assertEquals(t.ran, []);
});

Deno.test("an expired token is refused, and a token cannot outlive the cap", async () => {
  const t = setup();
  const { token } = await t.mint(INSTALL, 1_000);
  t.advance(1_000);
  assertEquals(
    await t.broker.call({ token, installId: INSTALL, body: t.body() }),
    { ok: false, denial: "token_expired" },
  );
  let refused = false;
  try {
    await t.mint(INSTALL, BROKER_TOKEN_MAX_TTL_MS + 1);
  } catch {
    refused = true;
  }
  assert(refused, "a token longer than the cap must not be issued");
  assertEquals(t.ran, []);
});

Deno.test("a replayed or reused sequence number is refused", async () => {
  const t = setup();
  const { token } = await t.mint();
  const call = (sequence: number) =>
    t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ sequence }),
    });
  assertEquals((await call(5)).ok, true);
  assertEquals(await call(5), { ok: false, denial: "sequence_replayed" });
  assertEquals(await call(3), { ok: false, denial: "sequence_replayed" });
  assertEquals((await call(6)).ok, true);
  assertEquals(t.ran.length, 2);
});

Deno.test("a repeated request id returns the recorded result and runs the effect once", async () => {
  const t = setup();
  const { token } = await t.mint();
  const requestId = "req-1";
  const first = await t.broker.call({
    token,
    installId: INSTALL,
    body: t.body({ requestId, sequence: 1 }),
  });
  const again = await t.broker.call({
    token,
    installId: INSTALL,
    body: t.body({ requestId, sequence: 2 }),
  });
  assertEquals(first, { ok: true, result: { value: "v-a" }, replayed: false });
  assertEquals(again, { ok: true, result: { value: "v-a" }, replayed: true });
  assertEquals(t.ran, ["a"]);
  // The same id may not be reused for a different operation.
  assertEquals(
    await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ requestId, sequence: 3, operation: "state.write" }),
    }),
    { ok: false, denial: "not_granted" },
  );
});

Deno.test("a request over the size cap, or not the typed shape, is refused unread", async () => {
  const t = setup();
  const { token } = await t.mint();
  const huge = t.body({ args: { key: "x".repeat(BROKER_MAX_REQUEST_BYTES) } });
  assertEquals(
    await t.broker.call({ token, installId: INSTALL, body: huge }),
    { ok: false, denial: "request_too_large" },
  );
  for (
    const bad of [
      "not json",
      "[]",
      "null",
      t.body({ sequence: 0 }),
      t.body({ sequence: 1.5 }),
      t.body({ requestId: "has space" }),
      t.body({ operation: "state..read" }),
      t.body({ operation: "../../etc/passwd" }),
      t.body({ args: [] }),
      t.body({ args: null }),
    ]
  ) {
    assertEquals(
      await t.broker.call({ token, installId: INSTALL, body: bad }),
      { ok: false, denial: "request_malformed" },
      bad,
    );
  }
  assertEquals(t.ran, []);
});

Deno.test("an operation the install is not granted, or the host does not offer, is refused", async () => {
  const t = setup();
  const { token } = await t.mint();
  assertEquals(
    await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ operation: "state.write" }),
    }),
    { ok: false, denial: "not_granted" },
  );
  // Granted by name but never registered: a shell, a socket, a database.
  const granted = setup(() => ({
    status: "enabled",
    grants: ["shell.exec", "db.query"],
  }));
  const second = await granted.mint();
  for (const operation of ["shell.exec", "db.query"]) {
    assertEquals(
      await granted.broker.call({
        token: second.token,
        installId: INSTALL,
        body: granted.body({ operation, sequence: 1 }),
      }),
      { ok: false, denial: "unknown_operation" },
    );
  }
  assertEquals(t.ran.concat(granted.ran), []);
});

Deno.test("turning the plugin off, removing a grant or uninstalling stops the very next call", async () => {
  let authority: InstallAuthority | null = {
    status: "enabled",
    grants: ["state.read"],
  };
  const t = setup(() => authority);
  const { token } = await t.mint();
  const call = (sequence: number) =>
    t.broker.call({ token, installId: INSTALL, body: t.body({ sequence }) });
  assertEquals((await call(1)).ok, true);

  authority = { status: "disabled", grants: ["state.read"] };
  assertEquals(await call(2), { ok: false, denial: "install_off" });

  authority = { status: "enabled", grants: [] };
  assertEquals(await call(3), { ok: false, denial: "not_granted" });

  authority = { status: "uninstalled", grants: ["state.read"] };
  assertEquals(await call(4), { ok: false, denial: "install_gone" });

  authority = null;
  assertEquals(await call(5), { ok: false, denial: "install_gone" });
  assertEquals(t.ran, ["a"]);
});

Deno.test("a revoked install cannot replay a recorded request either", async () => {
  let authority: InstallAuthority = {
    status: "enabled",
    grants: ["state.read"],
  };
  const t = setup(() => authority);
  const { token } = await t.mint();
  const requestId = "req-keep";
  await t.broker.call({
    token,
    installId: INSTALL,
    body: t.body({ requestId, sequence: 1 }),
  });
  authority = { status: "disabled", grants: [] };
  assertEquals(
    await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ requestId, sequence: 2 }),
    }),
    { ok: false, denial: "install_off" },
  );
});

Deno.test("a flood is cut off at the rate limit and recovers after the window", async () => {
  const t = setup();
  const { token } = await t.mint(INSTALL, BROKER_TOKEN_MAX_TTL_MS);
  let accepted = 0;
  for (let sequence = 1; sequence <= BROKER_RATE_LIMIT + 20; sequence++) {
    const outcome = await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ sequence }),
    });
    if (outcome.ok) accepted++;
    else assertEquals(outcome.denial, "rate_limited");
  }
  assertEquals(accepted, BROKER_RATE_LIMIT);
  t.advance(BROKER_RATE_WINDOW_MS);
  assertEquals(
    (await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ sequence: BROKER_RATE_LIMIT + 21 }),
    })).ok,
    true,
  );
});

Deno.test("the broker remembers a bounded number of request ids per token", async () => {
  const t = setup();
  const { token } = await t.mint(INSTALL, BROKER_TOKEN_MAX_TTL_MS);
  const total = BROKER_MAX_REMEMBERED_REQUESTS + 5;
  for (let sequence = 1; sequence <= total; sequence++) {
    t.advance(1_100);
    const outcome = await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ sequence, requestId: `req-${sequence}` }),
    });
    assertEquals(outcome.ok, true);
  }
  assertEquals(t.ran.length, total);
  // An id the broker has forgotten is still refused: its sequence is spent.
  assertEquals(
    await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ sequence: 1, requestId: "req-1" }),
    }),
    { ok: false, denial: "sequence_replayed" },
  );
});

function twoGranted() {
  return setup(() => ({
    status: "enabled",
    grants: ["state.read", "state.write"],
  }));
}

Deno.test("a request id cannot be reused for another operation, even when both are granted", async () => {
  const t = twoGranted();
  const { token } = await t.mint();
  const requestId = "req-bound";
  assertEquals(
    (await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ requestId, sequence: 1, operation: "state.read" }),
    })).ok,
    true,
  );
  assertEquals(
    await t.broker.call({
      token,
      installId: INSTALL,
      body: t.body({ requestId, sequence: 2, operation: "state.write" }),
    }),
    { ok: false, denial: "request_malformed" },
  );
  assertEquals(t.ran, ["a"]);
});

Deno.test("one request id runs its effect once even while the first call is still running", async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const broker = createPluginBroker({
    key: KEY,
    epoch: EPOCH,
    authority: {
      load: () =>
        Promise.resolve({ status: "enabled", grants: ["state.write"] }),
    },
    operations: [{
      name: "state.write",
      run: async () => {
        runs++;
        await gate;
        return { done: true };
      },
    }],
  });
  const { token } = await mintBrokerToken(KEY, {
    runEnvironment: "live",
    epoch: EPOCH,
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    now: Date.now(),
    ttlMs: 60_000,
  });
  const body = (sequence: number) =>
    JSON.stringify({
      requestId: "r1",
      sequence,
      operation: "state.write",
      args: {},
    });
  const first = broker.call({ token, installId: INSTALL, body: body(1) });
  // The second call starts only once the first effect is running; the broker
  // checks the token asynchronously, so starting both together races.
  for (let waited = 0; runs < 1; waited++) {
    assert(waited < 500, "the first effect never started");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const second = broker.call({ token, installId: INSTALL, body: body(2) });
  // Let the second call reach the running request before it is released.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  assertEquals(await first, {
    ok: true,
    result: { done: true },
    replayed: false,
  });
  assertEquals(await second, {
    ok: true,
    result: { done: true },
    replayed: true,
  });
  assertEquals(runs, 1);
});

Deno.test("an operation that throws gives the caller a typed denial and no raw error, and is not re-run", async () => {
  let runs = 0;
  const broker = createPluginBroker({
    key: KEY,
    epoch: EPOCH,
    authority: {
      load: () =>
        Promise.resolve({ status: "enabled", grants: ["state.write"] }),
    },
    operations: [{
      name: "state.write",
      run: () => {
        runs++;
        return Promise.reject(new Error("db password is hunter2"));
      },
    }],
  });
  const { token } = await mintBrokerToken(KEY, {
    runEnvironment: "live",
    epoch: EPOCH,
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    now: Date.now(),
    ttlMs: 60_000,
  });
  const ask = (sequence: number, requestId: string) =>
    broker.call({
      token,
      installId: INSTALL,
      body: JSON.stringify({
        requestId,
        sequence,
        operation: "state.write",
        args: {},
      }),
    });
  const first = await ask(1, "r1");
  assertEquals(first, { ok: false, denial: "operation_failed" });
  assert(!JSON.stringify(first).includes("hunter2"));
  // A retry under the same id does not run a half-done effect again.
  assertEquals(await ask(2, "r1"), { ok: false, denial: "operation_failed" });
  assertEquals(runs, 1);
  // A new id is a new request, and the broker is still usable.
  assertEquals(await ask(3, "r2"), { ok: false, denial: "operation_failed" });
  assertEquals(runs, 2);
});

Deno.test("a token from before a restart is refused, so a spent request cannot replay", async () => {
  let runs = 0;
  const build = (epoch: string) =>
    createPluginBroker({
      key: KEY,
      epoch,
      authority: {
        load: () =>
          Promise.resolve({ status: "enabled", grants: ["state.write"] }),
      },
      operations: [{
        name: "state.write",
        run: () => {
          runs++;
          return Promise.resolve({});
        },
      }],
    });
  const before = build("boot-1");
  const { token } = await mintBrokerToken(KEY, {
    runEnvironment: "live",
    epoch: "boot-1",
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    now: Date.now(),
    ttlMs: 60_000,
  });
  const body = JSON.stringify({
    requestId: "r1",
    sequence: 1,
    operation: "state.write",
    args: {},
  });
  assertEquals(
    (await before.call({ token, installId: INSTALL, body })).ok,
    true,
  );
  const after = build("boot-2");
  assertEquals(await after.call({ token, installId: INSTALL, body }), {
    ok: false,
    denial: "token_stale",
  });
  assertEquals(runs, 1);
});

Deno.test("a lease renewal keeps an attempt's replay and sequence state past the first expiry", async () => {
  let clock = 1_000_000;
  let ran = 0;
  const broker = createPluginBroker({
    key: KEY,
    epoch: EPOCH,
    authority: {
      load: () =>
        Promise.resolve({ status: "enabled", grants: ["state.write"] }),
    },
    operations: [{
      name: "state.write",
      run: () => {
        ran++;
        return Promise.resolve({ n: ran });
      },
    }],
    now: () => clock,
  });
  // The server builds these from the attempt; the token id is the attempt's.
  const claims = (expiresAt: number) => ({
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    tokenId: "attempt:a1:1",
    issuedAt: 0,
    expiresAt,
  });
  const body = (requestId: string, sequence: number) =>
    JSON.stringify({
      requestId,
      sequence,
      operation: "state.write",
      args: {},
    });
  const firstExpiry = clock + 60_000;
  for (let sequence = 1; sequence <= 5; sequence++) {
    const outcome = await broker.callAs({
      claims: claims(firstExpiry),
      body: body(`r${sequence}`, sequence),
    });
    assertEquals(outcome.ok, true);
  }
  assertEquals(ran, 5);

  // The lease is renewed, and the clock passes the first expiry.
  const renewedExpiry = firstExpiry + 60_000;
  clock = firstExpiry + 1_000;

  // A request id that already ran returns its recorded result; nothing reruns.
  const again = await broker.callAs({
    claims: claims(renewedExpiry),
    body: body("r1", 6),
  });
  assertEquals(again.ok && again.replayed, true);
  assertEquals(ran, 5);
  // An old sequence under a fresh request id is refused.
  assertEquals(
    await broker.callAs({
      claims: claims(renewedExpiry),
      body: body("fresh", 2),
    }),
    { ok: false, denial: "sequence_replayed" },
  );
  // A stale call that still carries the first expiry is refused, and does not
  // wipe the state the renewal kept alive.
  assertEquals(
    await broker.callAs({
      claims: claims(firstExpiry),
      body: body("stale", 7),
    }),
    { ok: false, denial: "token_expired" },
  );
  assertEquals(
    await broker.callAs({
      claims: claims(renewedExpiry),
      body: body("fresh2", 3),
    }),
    { ok: false, denial: "sequence_replayed" },
  );
  // A new, higher sequence still runs.
  assertEquals(
    (await broker.callAs({
      claims: claims(renewedExpiry),
      body: body("r6", 6),
    })).ok,
    true,
  );
  assertEquals(ran, 6);
});

Deno.test("state of an attempt that went quiet past its expiry is released when another attempt calls", async () => {
  let clock = 1_000_000;
  let ran = 0;
  const broker = createPluginBroker({
    key: KEY,
    epoch: EPOCH,
    authority: {
      load: () =>
        Promise.resolve({ status: "enabled", grants: ["state.write"] }),
    },
    operations: [{
      name: "state.write",
      run: () => {
        ran++;
        return Promise.resolve({});
      },
    }],
    now: () => clock,
  });
  const claims = (tokenId: string, expiresAt: number) => ({
    organizationId: ORG,
    installId: INSTALL,
    jobId: "job-1",
    tokenId,
    issuedAt: 0,
    expiresAt,
  });
  const call = (c: ReturnType<typeof claims>, sequence: number) =>
    broker.callAs({
      claims: c,
      body: JSON.stringify({
        requestId: `r${sequence}`,
        sequence,
        operation: "state.write",
        args: {},
      }),
    });
  assertEquals((await call(claims("attempt:a:1", clock + 10_000), 5)).ok, true);
  // The attempt goes quiet and its lease lapses; another attempt's call sweeps.
  clock += 100_000;
  assertEquals((await call(claims("attempt:b:1", clock + 10_000), 1)).ok, true);
  // The abandoned attempt's bookkeeping did not live forever: a fresh start
  // under a new lease is not held to its old sequence.
  assertEquals((await call(claims("attempt:a:1", clock + 10_000), 1)).ok, true);
  assertEquals(ran, 3);
});
