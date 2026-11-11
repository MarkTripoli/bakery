import { assertEquals, assertThrows } from "@std/assert";
import {
  formatIpAddress,
  parseIpAddress,
  parseTrustedProxyCidrs,
  readRuntimeConfig,
  readTrustedProxyCidrs,
  TrustedProxyCidrsSchema,
} from "../../packages/config/src/env.ts";
import { resolveClientAddress } from "../../apps/server/src/platform/client-address.ts";

function peer(hostname: string): Deno.NetAddr {
  return { transport: "tcp", hostname, port: 4242 };
}

function xff(...lines: string[]): Headers {
  const headers = new Headers();
  for (const line of lines) headers.append("x-forwarded-for", line);
  return headers;
}

const trusted = parseTrustedProxyCidrs("10.0.0.0/8, 192.168.1.7, fd00::/8");

Deno.test("an unset trusted list or an untrusted peer yields the peer and ignores the header", () => {
  const remote = peer("203.0.113.9");
  const spoof = xff("198.51.100.1");
  assertEquals(resolveClientAddress(remote, spoof, undefined), remote);
  assertEquals(resolveClientAddress(remote, spoof, []), remote);
  assertEquals(resolveClientAddress(remote, spoof, trusted), remote);
  const unparsable = peer("not-an-ip");
  assertEquals(resolveClientAddress(unparsable, spoof, trusted), unparsable);
});

Deno.test("a trusted peer with an absent or blank header yields the peer", () => {
  const proxy = peer("10.1.2.3");
  assertEquals(resolveClientAddress(proxy, new Headers(), trusted), proxy);
  assertEquals(resolveClientAddress(proxy, xff(""), trusted), proxy);
  assertEquals(resolveClientAddress(proxy, xff("   "), trusted), proxy);
});

Deno.test("a malformed entry anywhere in the chain yields the peer", () => {
  const proxy = peer("10.1.2.3");
  for (
    const line of [
      "garbage",
      "198.51.100.1, garbage",
      "garbage, 198.51.100.1",
      "198.51.100.1,,10.0.0.9",
      "198.51.100.1:8080",
      "[2001:db8::1]",
      "2001:db8::1%eth0",
      "198.51.100.256",
      "198.51.100.01",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8::1::2",
      `${"198.51.100.1, ".repeat(70)}198.51.100.1`,
    ]
  ) {
    assertEquals(resolveClientAddress(proxy, xff(line), trusted), proxy, line);
  }
});

Deno.test("the walk takes the first untrusted entry from the right and ignores spoofed entries left of it", () => {
  const proxy = peer("10.1.2.3");
  assertEquals(
    resolveClientAddress(proxy, xff("198.51.100.1"), trusted).hostname,
    "198.51.100.1",
  );
  // The attacker prepends 1.1.1.1; the edge appended the real client.
  assertEquals(
    resolveClientAddress(proxy, xff("1.1.1.1, 198.51.100.7"), trusted).hostname,
    "198.51.100.7",
  );
  // A trusted hop on the right is skipped, the untrusted one left of it wins.
  assertEquals(
    resolveClientAddress(
      proxy,
      xff("1.1.1.1, 198.51.100.7, 10.9.9.9, 192.168.1.7"),
      trusted,
    ).hostname,
    "198.51.100.7",
  );
  // The port of the peer is kept; only the address is replaced.
  assertEquals(
    resolveClientAddress(proxy, xff("198.51.100.1"), trusted).port,
    4242,
  );
});

Deno.test("a chain made only of trusted addresses resolves to the leftmost entry", () => {
  const proxy = peer("10.1.2.3");
  assertEquals(
    resolveClientAddress(proxy, xff("10.0.0.5, 10.0.0.6"), trusted).hostname,
    "10.0.0.5",
  );
  assertEquals(
    resolveClientAddress(proxy, xff("10.0.0.6, 192.168.1.7, 10.0.0.7"), trusted)
      .hostname,
    "10.0.0.6",
  );
});

Deno.test("multiple header lines are joined and walked as one chain", () => {
  const proxy = peer("10.1.2.3");
  assertEquals(
    resolveClientAddress(
      proxy,
      xff("1.1.1.1", "198.51.100.7, 10.0.0.9"),
      trusted,
    )
      .hostname,
    "198.51.100.7",
  );
  assertEquals(
    resolveClientAddress(proxy, xff("10.0.0.5", "10.0.0.6"), trusted).hostname,
    "10.0.0.5",
  );
  // A malformed second line poisons the whole chain.
  assertEquals(
    resolveClientAddress(proxy, xff("198.51.100.7", "nope"), trusted),
    proxy,
  );
});

Deno.test("IPv6 peers and clients resolve in canonical form", () => {
  const proxy = peer("fd00::1");
  assertEquals(
    resolveClientAddress(
      proxy,
      xff("2001:0DB8:0:0:0:0:0:0001, fd00::2"),
      trusted,
    ).hostname,
    "2001:db8::1",
  );
  assertEquals(
    resolveClientAddress(proxy, xff("fd00::5, fd00::6"), trusted).hostname,
    "fd00::5",
  );
  assertEquals(
    resolveClientAddress(peer("fe80::1"), xff("198.51.100.1"), trusted)
      .hostname,
    "fe80::1",
  );
});

Deno.test("IPv4-mapped IPv6 addresses are normalised for peers, entries and ranges", () => {
  // Mapped peer matches the IPv4 range.
  assertEquals(
    resolveClientAddress(peer("::ffff:10.1.2.3"), xff("198.51.100.1"), trusted)
      .hostname,
    "198.51.100.1",
  );
  // Hex form of the same mapped address.
  assertEquals(
    resolveClientAddress(peer("::ffff:a01:203"), xff("198.51.100.1"), trusted)
      .hostname,
    "198.51.100.1",
  );
  // Mapped entries come back as dotted IPv4, and mapped trusted hops are skipped.
  assertEquals(
    resolveClientAddress(
      peer("10.1.2.3"),
      xff("::ffff:198.51.100.7, ::ffff:10.0.0.9"),
      trusted,
    ).hostname,
    "198.51.100.7",
  );
  // A mapped-address CIDR trusts the IPv4 peer it denotes.
  const mappedRange = parseTrustedProxyCidrs("::ffff:10.0.0.0/104");
  assertEquals(
    resolveClientAddress(peer("10.4.4.4"), xff("198.51.100.1"), mappedRange)
      .hostname,
    "198.51.100.1",
  );
  assertEquals(
    resolveClientAddress(peer("11.4.4.4"), xff("198.51.100.1"), mappedRange)
      .hostname,
    "11.4.4.4",
  );
  // "::/0" trusts every address, IPv4 included.
  const everyone = parseTrustedProxyCidrs("::/0");
  assertEquals(
    resolveClientAddress(
      peer("203.0.113.1"),
      xff("10.0.0.5, 10.0.0.6"),
      everyone,
    )
      .hostname,
    "10.0.0.5",
  );
});

Deno.test("address parsing and formatting follow the canonical forms", () => {
  assertEquals(parseIpAddress("10.0.0.1")?.family, 4);
  assertEquals(parseIpAddress("::ffff:10.0.0.1"), parseIpAddress("10.0.0.1"));
  assertEquals(parseIpAddress("2001:db8::1")?.family, 6);
  assertEquals(parseIpAddress(""), undefined);
  assertEquals(parseIpAddress("1.2.3"), undefined);
  for (
    const [input, expected] of [
      ["::", "::"],
      ["::1", "::1"],
      ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
      ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
      ["1:0:0:2:0:0:0:3", "1:0:0:2::3"],
      ["64:ff9b::198.51.100.1", "64:ff9b::c633:6401"],
    ]
  ) {
    assertEquals(formatIpAddress(parseIpAddress(input)!), expected, input);
  }
});

Deno.test("trusted proxy parsing masks host bits and rejects junk, bad prefixes and long lists", () => {
  assertEquals(parseTrustedProxyCidrs("10.1.2.3/8"), [
    { family: 4, network: 10n << 24n, prefix: 8 },
  ]);
  assertEquals(parseTrustedProxyCidrs("192.168.1.7"), [
    {
      family: 4,
      network: (192n << 24n) | (168n << 16n) | (1n << 8n) | 7n,
      prefix: 32,
    },
  ]);
  for (
    const bad of [
      "",
      ",",
      "10.0.0.0/8,",
      "10.0.0.0/33",
      "10.0.0.0/-1",
      "10.0.0.0/08",
      "10.0.0.0/",
      "fd00::/129",
      "10.0.0.0/8/8",
      "example.com",
      "10.0.0",
      "::ffff:10.0.0.0/",
      "999.0.0.1",
      Array.from({ length: 33 }, (_, i) => `10.0.0.${i}`).join(","),
    ]
  ) {
    assertThrows(
      () => parseTrustedProxyCidrs(bad),
      Error,
      "TRUSTED_PROXY_CIDRS_INVALID",
      bad,
    );
    assertEquals(TrustedProxyCidrsSchema.safeParse(bad).success, false, bad);
  }
  const max = Array.from({ length: 32 }, (_, i) => `10.0.0.${i}`).join(",");
  assertEquals(parseTrustedProxyCidrs(max).length, 32);
  assertEquals(TrustedProxyCidrsSchema.safeParse(max).success, true);
  assertEquals(
    (TrustedProxyCidrsSchema.description ?? "").length > 40,
    true,
  );
});

Deno.test("runtime config exposes trusted proxies for the server only and flags invalid values", () => {
  const base = {
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: "postgres://u:p@db.test:5432/bakery",
    BAKERY_PUBLIC_BASE_URL: "http://localhost:8000",
    BETTER_AUTH_SECRET: "x".repeat(40),
  };
  assertEquals(readRuntimeConfig(base, "server").trustedProxies, undefined);
  assertEquals(
    readRuntimeConfig({ ...base, BAKERY_TRUSTED_PROXY_CIDRS: "  " }, "server")
      .trustedProxies,
    undefined,
  );
  const configured = readRuntimeConfig({
    ...base,
    BAKERY_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,fd00::/8",
  }, "server");
  assertEquals(configured.trustedProxies?.length, 2);
  assertEquals(
    configured.invalidConfig.includes("BAKERY_TRUSTED_PROXY_CIDRS"),
    false,
  );
  const invalid = readRuntimeConfig({
    ...base,
    BAKERY_TRUSTED_PROXY_CIDRS: "10.0.0.0/99",
  }, "server");
  assertEquals(invalid.trustedProxies, undefined);
  assertEquals(
    invalid.invalidConfig.includes("BAKERY_TRUSTED_PROXY_CIDRS"),
    true,
  );
  assertThrows(
    () => readTrustedProxyCidrs({ BAKERY_TRUSTED_PROXY_CIDRS: "junk" }),
    Error,
    "TRUSTED_PROXY_CIDRS_INVALID",
  );
  const worker = readRuntimeConfig({
    BAKERY_ENV: "test",
    DATABASE_URL: "postgres://u:p@db.test:5432/bakery",
    BAKERY_TRUSTED_PROXY_CIDRS: "junk",
  }, "worker");
  assertEquals(worker.trustedProxies, undefined);
  assertEquals(
    worker.invalidConfig.includes("BAKERY_TRUSTED_PROXY_CIDRS"),
    false,
  );
});
