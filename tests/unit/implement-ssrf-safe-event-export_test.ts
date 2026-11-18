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
  assertEquals(checkResolvedAddresses(["93.184.216.34"]), { ok: true });
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
