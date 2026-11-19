import { assertEquals } from "@std/assert";
import { isNonPublicAddress } from "../../apps/server/src/modules/execution/provider-egress.ts";

/**
 * The one rule for which addresses the server may call for a provider route.
 *
 * It runs at create time on a host written as an address, and at probe time on
 * every address a name resolves to, so the encodings an attacker would try to
 * smuggle a private address past a text check are the cases that matter.
 */

const refused = [
  // IPv4: every non-public block
  "0.0.0.0",
  "10.0.0.1",
  "10.255.255.255",
  "100.64.0.1",
  "100.127.255.255",
  "127.0.0.1",
  "127.255.255.254",
  "169.254.169.254", // cloud metadata
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.8",
  "192.0.2.1",
  "192.168.0.1",
  "198.18.0.1",
  "198.19.255.255",
  "198.51.100.7",
  "203.0.113.9",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6: loopback, unspecified, ranges
  "::",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  "fe80::1%eth0",
  "febf::1",
  "fec0::1",
  "ff02::1",
  "2001:db8::1",
  "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
  "100::1",
  // IPv4 carried inside IPv6, in every spelling
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "[::ffff:10.0.0.1]",
  "::ffff:a00:1",
  "::127.0.0.1",
  "64:ff9b::7f00:1",
  "64:ff9b::10.0.0.1",
  "2002:7f00:1::1", // 6to4 of 127.0.0.1
  "2002:a9fe:a9fe::1", // 6to4 of 169.254.169.254
  // Not parseable but shaped like an address: refused, never guessed
  "1.2.3",
  "1.2.3.4.5",
  "256.1.1.1",
  "::g",
  "1::2::3",
  "[::1",
];

const allowed = [
  "8.8.8.8",
  "1.1.1.1",
  "172.15.255.255",
  "172.32.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "192.0.1.1",
  "198.17.255.255",
  "198.20.0.1",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "[2606:4700::1]",
  "::ffff:8.8.8.8",
  "64:ff9b::808:808",
  "2002:808:808::1", // 6to4 of 8.8.8.8
  // Hostnames are not addresses: the resolver's answers are judged, not the name.
  "api.openai.example",
  "localhost",
];

Deno.test("every non-public address is refused, in every encoding", () => {
  for (const host of refused) {
    assertEquals(isNonPublicAddress(host), true, host);
  }
});

Deno.test("public addresses, and names that are not addresses, are not refused here", () => {
  for (const host of allowed) {
    assertEquals(isNonPublicAddress(host), false, host);
  }
});
