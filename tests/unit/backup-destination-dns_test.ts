import { assert, assertEquals } from "@std/assert";
import {
  checkDestinationHost,
  createPinnedLookup,
  type HostResolver,
  HostUnresolvable,
} from "../../apps/server/src/modules/backups/dns.ts";
import { resolveBackupDestination } from "../../apps/server/src/modules/backups/s3.ts";

/**
 * #80 S1b: the destination's host is resolved and held to the address policy
 * with an injected resolver (no real DNS), including at the socket: the address
 * validated is the address dialled.
 */

const prod = { host: "backups.example.test", loopbackAllowed: false };

function resolverOf(
  answers: Record<string, readonly string[] | "unresolvable">,
): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = ((hostname: string) => {
    calls.push(hostname);
    const answer = answers[hostname];
    if (answer === undefined || answer === "unresolvable") {
      return Promise.reject(new HostUnresolvable());
    }
    return Promise.resolve(answer);
  }) as HostResolver & { calls: string[] };
  resolve.calls = calls;
  return resolve;
}

Deno.test("a name is allowed when every address it resolves to is allowed", async () => {
  const resolve = resolverOf({
    "backups.example.test": ["93.184.216.34", "2606:2800:220:1::1"],
  });
  const check = await checkDestinationHost(prod, resolve);
  assertEquals(check, {
    ok: true,
    addresses: ["93.184.216.34", "2606:2800:220:1::1"],
  });
  assertEquals(resolve.calls, ["backups.example.test"]);
});

Deno.test("a name that resolves to any refused address is refused, mixed answers included", async () => {
  for (
    const answer of [
      ["10.0.0.5"],
      ["93.184.216.34", "10.0.0.5"],
      ["10.0.0.5", "93.184.216.34"],
      ["169.254.169.254"],
      ["fd00:ec2::254"],
      ["::ffff:192.168.1.1"],
      ["100.64.0.9"],
      ["198.18.0.1"],
      ["127.0.0.1"],
      ["::1"],
      ["0.0.0.0"],
      ["224.0.0.251"],
    ]
  ) {
    const check = await checkDestinationHost(
      prod,
      resolverOf({ "backups.example.test": answer }),
    );
    assertEquals(
      check,
      { ok: false, refusal: "destination_private_address" },
      answer.join(","),
    );
  }
});

Deno.test("a name that cannot be resolved is unresolvable, not private", async () => {
  assertEquals(
    await checkDestinationHost(prod, resolverOf({})),
    { ok: false, refusal: "destination_unresolvable" },
  );
  assertEquals(
    await checkDestinationHost(
      prod,
      resolverOf({ "backups.example.test": [] }),
    ),
    { ok: false, refusal: "destination_private_address" },
  );
});

Deno.test("an IP literal needs no lookup and is held to the same policy", async () => {
  const resolve = resolverOf({});
  assertEquals(
    await checkDestinationHost({
      host: "93.184.216.34",
      loopbackAllowed: false,
    }, resolve),
    { ok: true, addresses: ["93.184.216.34"] },
  );
  for (
    const host of [
      "10.0.0.5",
      "169.254.169.254",
      "::1",
      "fd00:ec2::254",
      "::ffff:10.0.0.1",
    ]
  ) {
    assertEquals(
      await checkDestinationHost({ host, loopbackAllowed: false }, resolve),
      { ok: false, refusal: "destination_private_address" },
      host,
    );
  }
  // Loopback passes only for a vetted test fixture.
  assertEquals(
    (await checkDestinationHost(
      { host: "127.0.0.1", loopbackAllowed: true },
      resolve,
    )).ok,
    true,
  );
  assertEquals(
    (await checkDestinationHost(
      { host: "127.0.0.1", loopbackAllowed: false },
      resolve,
    )).ok,
    false,
  );
  assertEquals(resolve.calls, []);
});

Deno.test("localhost names are loopback without asking DNS", async () => {
  const resolve = resolverOf({});
  for (const host of ["localhost", "LOCALHOST", "db.localhost"]) {
    assertEquals(
      await checkDestinationHost({ host, loopbackAllowed: false }, resolve),
      { ok: false, refusal: "destination_private_address" },
      host,
    );
    assertEquals(
      (await checkDestinationHost({ host, loopbackAllowed: true }, resolve)).ok,
      true,
      host,
    );
  }
  assertEquals(resolve.calls, []);
});

Deno.test("the endpoint shape no longer decides addresses: that is the host check's job", () => {
  const base = {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "bakery-backups",
    prefix: "",
  };
  const production = { allowLoopbackEndpoint: false };
  assertEquals(resolveBackupDestination(base, production), {
    ...base,
    host: "s3.example.com",
    loopbackAllowed: false,
  });
  // An IP literal is a well-formed endpoint; its address is judged by the host check.
  assertEquals(
    resolveBackupDestination(
      { ...base, endpoint: "https://10.0.0.5" },
      production,
    )
      .host,
    "10.0.0.5",
  );
  assertEquals(
    resolveBackupDestination({ ...base, endpoint: "https://[::1]" }, production)
      .host,
    "::1",
  );
  // Only an http loopback fixture on a test host, in a test environment, is a loopback fixture.
  const fixture = resolveBackupDestination(
    { ...base, endpoint: "http://127.0.0.1:9000" },
    { allowLoopbackEndpoint: true },
  );
  assertEquals([fixture.host, fixture.loopbackAllowed], ["127.0.0.1", true]);
  assertEquals(
    resolveBackupDestination(
      { ...base, endpoint: "https://127.0.0.1" },
      { allowLoopbackEndpoint: true },
    ).loopbackAllowed,
    false,
  );
});

Deno.test("the pinned lookup resolves at the moment of connecting and hands out only validated addresses", async () => {
  const resolve = resolverOf({ "backups.example.test": ["93.184.216.34"] });
  const lookup = createPinnedLookup(prod, resolve);
  const call = (options: { all?: boolean } | undefined) =>
    new Promise<unknown[]>((done) =>
      lookup(
        "backups.example.test",
        options,
        (...args: unknown[]) => done(args),
      )
    );
  // The "all" form (what Node's connect uses) and the single form.
  assertEquals(await call({ all: true }), [
    null,
    [{ address: "93.184.216.34", family: 4 }],
  ]);
  assertEquals(await call(undefined), [null, "93.184.216.34", 4]);
  // Each connection asks again: a changed answer is seen at once.
  const answers = { "backups.example.test": ["10.0.0.5"] as readonly string[] };
  const moving = createPinnedLookup(
    prod,
    (host) => Promise.resolve(answers[host as keyof typeof answers]),
  );
  const refused = await new Promise<unknown[]>((done) =>
    moving(
      "backups.example.test",
      { all: true },
      (...args: unknown[]) => done(args),
    )
  );
  const error = refused[0] as { code?: string; message?: string };
  assertEquals(error.code, "BACKUP_DESTINATION_REFUSED");
  assert(String(error.message).includes("destination_private_address"));
  // An IPv6 answer is handed out with its family.
  const v6 = createPinnedLookup(
    prod,
    () => Promise.resolve(["2606:2800:220:1::1"]),
  );
  assertEquals(
    await new Promise<unknown[]>((done) =>
      v6("backups.example.test", { all: true }, (...a: unknown[]) => done(a))
    ),
    [null, [{ address: "2606:2800:220:1::1", family: 6 }]],
  );
});
