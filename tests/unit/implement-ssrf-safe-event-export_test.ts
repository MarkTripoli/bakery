import { assertEquals } from "@std/assert";
import {
  checkDestinationUrl,
  checkRedirect,
  checkResolvedAddresses,
  isPrivateAddress,
  MAX_REDIRECTS,
  parseIpv4,
} from "../../apps/server/src/modules/integrations/destination-safety.ts";
import { classifyReplay } from "../../apps/server/src/modules/integrations/event-export-dispatch.ts";

/**
 * Slice 4 of issue #21, AC3: SSRF is blocked, and a repeated delivery inside the
 * signature window is not sent twice.
 *
 * The rebinding case is the reason the address check takes resolved addresses
 * rather than a hostname: the interesting failure is a host whose answer changes
 * between registration and dispatch, and a URL-shaped check cannot see that at
 * all.
 */

Deno.test("only https destinations are accepted", () => {
  assertEquals(
    checkDestinationUrl("https://receiver.example.test", "/events"),
    {
      ok: true,
    },
  );
  for (
    const origin of [
      "http://receiver.example.test",
      "file:///etc/passwd",
      "gopher://receiver.example.test",
      "ftp://receiver.example.test",
    ]
  ) {
    assertEquals(checkDestinationUrl(origin, "/events"), {
      ok: false,
      reason: "not_https",
    });
  }
});

Deno.test("a destination URL cannot carry credentials, a fragment or a stray port", () => {
  assertEquals(
    checkDestinationUrl("https://user:pass@receiver.example.test", "/events"),
    { ok: false, reason: "unsafe_url_shape" },
  );
  assertEquals(
    checkDestinationUrl("https://receiver.example.test", "/events#fragment"),
    { ok: false, reason: "unsafe_url_shape" },
  );
  // An arbitrary port turns every export into a port scanner whose results are
  // reported back through delivery status.
  assertEquals(
    checkDestinationUrl("https://receiver.example.test:8080", "/events"),
    { ok: false, reason: "unsafe_url_shape" },
  );
  // The default port is the same endpoint, so it is allowed.
  assertEquals(
    checkDestinationUrl("https://receiver.example.test:443", "/events"),
    { ok: true },
  );
});

Deno.test("private, loopback, link-local and metadata addresses are refused", () => {
  const refused = [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    // IPv4 reachable through IPv6 forms: a prefix-only check misses these.
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ];
  for (const address of refused) {
    assertEquals(
      checkResolvedAddresses([address]),
      { ok: false, reason: "resolves_to_private_address" },
      `${address} must be refused`,
    );
  }

  // A public address is accepted, or none of the above proves anything.
  assertEquals(checkResolvedAddresses(["93.184.216.34"]).ok, true);
  assertEquals(checkResolvedAddresses(["2606:2800:220:1::1"]), { ok: true });
});

Deno.test("one private address among several is enough to refuse", () => {
  // A host that returns both a public and a private answer is the rebinding
  // shape: connecting to whichever one the client picks first is the attack.
  assertEquals(
    checkResolvedAddresses(["93.184.216.34", "127.0.0.1"]),
    { ok: false, reason: "resolves_to_private_address" },
  );
});

Deno.test("a host that resolves to nothing is refused, not assumed safe", () => {
  assertEquals(checkResolvedAddresses([]), { ok: false, reason: "unresolved" });
});

Deno.test("non-canonical IPv4 spellings are refused rather than interpreted", () => {
  // These all reach loopback through getaddrinfo on some platforms. Interpreting
  // them is how a check and a resolver come to disagree about the address.
  for (const address of ["2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.1"]) {
    assertEquals(parseIpv4(address), null, `${address} must not parse as IPv4`);
    // Not recognised as an IP literal, so it is treated as a hostname: the
    // resolver call is what must catch it, which is why resolution happens at
    // dispatch and the result is judged here.
    assertEquals(isPrivateAddress(address), false);
  }
  assertEquals(parseIpv4("127.0.0.1"), [127, 0, 0, 1]);
  assertEquals(parseIpv4("256.0.0.1"), null);
  assertEquals(parseIpv4("1.2.3"), null);
});

Deno.test("redirects are not followed by default and cannot leave the endpoint", () => {
  // Zero hops: the cheapest way to move a delivery to an unapproved endpoint is
  // a redirect, so none are followed.
  assertEquals(MAX_REDIRECTS, 0);
  assertEquals(
    checkRedirect({
      registeredOrigin: "https://receiver.example.test",
      registeredPath: "/events",
      target: "https://receiver.example.test/events/2",
      redirectsFollowed: 1,
    }),
    { ok: false, reason: "redirect_not_allowed" },
  );

  // Even within the allowance, a redirect off the origin or out of the path is
  // refused, so an approved endpoint cannot become a different one.
  assertEquals(
    checkRedirect({
      registeredOrigin: "https://receiver.example.test",
      registeredPath: "/events",
      target: "https://elsewhere.example.test/events",
      redirectsFollowed: 0,
    }),
    { ok: false, reason: "redirect_not_allowed" },
  );
  assertEquals(
    checkRedirect({
      registeredOrigin: "https://receiver.example.test",
      registeredPath: "/events",
      target: "https://receiver.example.test/admin",
      redirectsFollowed: 0,
    }),
    { ok: false, reason: "redirect_not_allowed" },
  );
});

Deno.test("a repeated delivery inside the window is acknowledged, not re-sent", () => {
  // The signature is still fresh and still valid, so only the ledger can tell a
  // replay from a first attempt.
  assertEquals(classifyReplay(null, "digest-1"), { kind: "new" });
  assertEquals(
    classifyReplay(
      { deliveryId: "d-1", payloadDigest: "digest-1" },
      "digest-1",
    ),
    { kind: "duplicate", deliveryId: "d-1" },
  );
});

Deno.test("a reused delivery identity with different bytes is a conflict, not a retry", () => {
  // Sending it would deliver content under an identity the receiver has already
  // seen; acknowledging it would hide a bug or an attack. It is neither.
  assertEquals(
    classifyReplay(
      { deliveryId: "d-1", payloadDigest: "digest-1" },
      "digest-2",
    ),
    { kind: "conflict", deliveryId: "d-1" },
  );
});

Deno.test("an ipv4 address embedded in ipv6 is judged as that ipv4 address", () => {
  // QA found this: only the dotted form of the mapping was recognised, so the
  // hex form of the same address was judged public. `::ffff:7f00:1` is 127.0.0.1
  // and `::ffff:a9fe:a9fe` is 169.254.169.254, the cloud metadata endpoint.
  for (
    const address of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "::127.0.0.1",
      "[::1]",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.1",
    ]
  ) {
    assertEquals(isPrivateAddress(address), true, address);
  }

  // The same address written as a public IPv4 stays public, so the rule is the
  // embedded address and not "any mapped address".
  assertEquals(isPrivateAddress("::ffff:5db8:d822"), false);
  assertEquals(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

Deno.test("6to4 and NAT64 addresses are unwrapped, not waved through", () => {
  // 2002::/16 carries a full IPv4 address in bytes 2..6, and 64:ff9b::/96 in the
  // last four bytes. Refusing them wholesale would be safe but wrong; unwrapping
  // applies the same rule that catches the metadata endpoint elsewhere.
  assertEquals(isPrivateAddress("2002:7f00:1::"), true);
  assertEquals(isPrivateAddress("2002:a9fe:a9fe::"), true);
  assertEquals(isPrivateAddress("64:ff9b::7f00:1"), true);
  assertEquals(isPrivateAddress("2002:5db8:d822::"), false);
});

Deno.test("a resolved ipv6 loopback is refused by the address check", () => {
  assertEquals(checkResolvedAddresses(["::ffff:7f00:1"]), {
    ok: false,
    reason: "resolves_to_private_address",
  });
  assertEquals(checkResolvedAddresses(["::1"]), {
    ok: false,
    reason: "resolves_to_private_address",
  });
});

Deno.test("the two ranges qa found are refused, and the neighbours are not", () => {
  // Site-local (fec0::/10) is deprecated but still routable inside a site, and
  // Teredo tunnels IPv6 over an embedded IPv4 endpoint.
  assertEquals(isPrivateAddress("fec0::1"), true);
  assertEquals(isPrivateAddress("2001:0:4136:e378::1"), true);
  // But not all of 2001::/16, which contains globally routed space.
  assertEquals(isPrivateAddress("2001:4860:4860::8888"), false);
});

Deno.test("a resolved answer that is not an ip literal is refused", () => {
  // The transport is told to connect to these exact strings; an answer the judge
  // did not read as an address is not an address it judged.
  assertEquals(checkResolvedAddresses(["receiver.example.test"]), {
    ok: false,
    reason: "resolves_to_private_address",
  });
  // A zone-qualified literal parses once the zone is stripped, so it is refused
  // for being link-local rather than for being unreadable - and the reason a
  // caller sees is the same either way, which is what matters.
  assertEquals(checkResolvedAddresses(["fe80::1%eth0"]), {
    ok: false,
    reason: "resolves_to_private_address",
  });
  // The public case still passes, so the zeros above are the rule and not a
  // check that refuses everything.
  assertEquals(checkResolvedAddresses(["93.184.216.34"]).ok, true);
});

Deno.test("the SIIT and local-use NAT64 prefixes are refused as ranges", () => {
  // The reviewer's two named ranges. Both are translation mechanisms that carry
  // an IPv4 address, not destinations, so they are refused as prefixes rather
  // than unwrapped: an unwrapped 0.0.0.0 would be refused anyway, but the prefix
  // itself is what says "this is not a place to deliver an event".
  assertEquals(isPrivateAddress("64:ff9b:1::1"), true);
  assertEquals(isPrivateAddress("::ffff:0:0:0"), true);
});

Deno.test("refusing those prefixes does not refuse a real public destination", () => {
  // The rule is the prefix, not the family. A well-known NAT64 prefix embedding a
  // public address, and an IPv4-mapped public address, both stay public - so the
  // two refusals above are the ranges and not a blanket ban on translation.
  assertEquals(isPrivateAddress("64:ff9b::5db8:d822"), false);
  assertEquals(isPrivateAddress("::ffff:5db8:d822"), false);
  // And the well-known NAT64 prefix is still judged by what it embeds, which is
  // the property that actually stops the metadata endpoint.
  assertEquals(isPrivateAddress("64:ff9b::a9fe:a9fe"), true);
});
