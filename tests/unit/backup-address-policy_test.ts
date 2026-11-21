import { assertEquals } from "@std/assert";
import {
  type AddressRefusal,
  classifyAddress,
  classifyAddresses,
  isIpLiteral,
  parseIPv4,
  parseIPv6,
} from "../../apps/server/src/modules/backups/address-policy.ts";

/**
 * #80 S1b: which addresses an off-site backup destination may resolve to. Pure
 * and exhaustive on purpose: this table is the whole rule, so each refused range
 * is tested at its edges and in every IPv6 form that can hide an IPv4 address.
 */

const production = { allowLoopback: false };
const test = { allowLoopback: true };

type Row = readonly [address: string, expected: AddressRefusal | "allowed"];

function check(rows: readonly Row[], options = production) {
  for (const [address, expected] of rows) {
    const verdict = classifyAddress(address, options);
    const got = verdict.allowed ? "allowed" : verdict.reason;
    assertEquals(got, expected, address);
  }
}

Deno.test("IPv4: every refused range is refused at both edges and public neighbours are allowed", () => {
  check([
    // this network / unspecified
    ["0.0.0.0", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["1.0.0.0", "allowed"],
    // private 10/8
    ["9.255.255.255", "allowed"],
    ["10.0.0.0", "private"],
    ["10.255.255.255", "private"],
    ["11.0.0.0", "allowed"],
    // CGNAT 100.64/10
    ["100.63.255.255", "allowed"],
    ["100.64.0.0", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["100.128.0.0", "allowed"],
    // loopback 127/8
    ["126.255.255.255", "allowed"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["128.0.0.0", "allowed"],
    // link-local 169.254/16 and the cloud metadata address inside it
    ["169.253.255.255", "allowed"],
    ["169.254.0.0", "link_local"],
    ["169.254.169.253", "link_local"],
    ["169.254.169.254", "metadata"],
    ["169.254.255.255", "link_local"],
    ["169.255.0.0", "allowed"],
    // private 172.16/12
    ["172.15.255.255", "allowed"],
    ["172.16.0.0", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.0", "allowed"],
    // IETF protocol assignments and documentation blocks
    ["192.0.0.0", "reserved"],
    ["192.0.0.255", "reserved"],
    ["192.0.1.0", "allowed"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    // private 192.168/16
    ["192.167.255.255", "allowed"],
    ["192.168.0.0", "private"],
    ["192.168.255.255", "private"],
    ["192.169.0.0", "allowed"],
    // benchmarking 198.18/15
    ["198.17.255.255", "allowed"],
    ["198.18.0.0", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.20.0.0", "allowed"],
    // multicast 224/4 and reserved 240/4 (with the limited broadcast)
    ["223.255.255.255", "allowed"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.0", "reserved"],
    ["255.255.255.255", "reserved"],
    // ordinary public addresses
    ["8.8.8.8", "allowed"],
    ["93.184.216.34", "allowed"],
    ["1.1.1.1", "allowed"],
  ]);
});

Deno.test("IPv4 literals that are not plain dotted decimal are refused, never guessed at", () => {
  check([
    ["", "unparseable"],
    ["1.2.3", "unparseable"],
    ["1.2.3.4.5", "unparseable"],
    ["256.1.1.1", "unparseable"],
    ["1.2.3.-4", "unparseable"],
    // leading zeros are octal in some stacks: ambiguous, so refused
    ["010.0.0.1", "unparseable"],
    ["08.8.8.8", "unparseable"],
    // hex, decimal-integer and short forms are not what a resolver returns
    ["0x7f.0.0.1", "unparseable"],
    ["2130706433", "unparseable"],
    ["127.1", "unparseable"],
    ["example.com", "unparseable"],
  ]);
  assertEquals(parseIPv4("0.0.0.0"), 0);
  assertEquals(parseIPv4("255.255.255.255"), 4294967295);
});

Deno.test("IPv6: unspecified, loopback, link-local, unique-local, multicast and documentation", () => {
  check([
    ["::", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback"],
    // link-local fe80::/10
    ["fe80::1", "link_local"],
    ["FE80::ABCD", "link_local"],
    ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "link_local"],
    ["fec0::1", "allowed"],
    // unique-local fc00::/7 (fc00:: and fd00::), and the cloud metadata address
    ["fc00::1", "unique_local"],
    ["fd12:3456:789a::1", "unique_local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique_local"],
    ["fd00:ec2::254", "metadata"],
    ["FD00:EC2:0:0:0:0:0:254", "metadata"],
    ["fb00::1", "allowed"],
    ["fe00::1", "allowed"],
    // multicast ff00::/8
    ["ff02::1", "multicast"],
    ["ff00::", "multicast"],
    ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "multicast"],
    // discard-only and documentation
    ["100::1", "reserved"],
    ["2001:db8::1", "documentation"],
    ["2001:db8:ffff::1", "documentation"],
    // ordinary global addresses
    ["2606:4700:4700::1111", "allowed"],
    ["2001:4860:4860::8888", "allowed"],
    ["2a00:1450:4001:81b::200e", "allowed"],
  ]);
});

Deno.test("IPv6 forms that carry an IPv4 address are judged as the IPv4 address they carry", () => {
  check([
    // IPv4-mapped ::ffff:0:0/96, dotted and hex tails, any case
    ["::ffff:10.0.0.1", "private"],
    ["::FFFF:10.0.0.1", "private"],
    ["::ffff:a00:1", "private"],
    ["0:0:0:0:0:ffff:10.0.0.1", "private"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:a9fe:a9fe", "metadata"],
    ["::ffff:100.64.0.1", "cgnat"],
    ["::ffff:198.18.0.1", "benchmarking"],
    ["::ffff:192.168.1.1", "private"],
    ["::ffff:172.16.0.1", "private"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:224.0.0.1", "multicast"],
    ["::ffff:8.8.8.8", "allowed"],
    ["::ffff:808:808", "allowed"],
    // IPv4-compatible ::/96: deprecated and never routed, refused whole
    ["::10.0.0.1", "ipv4_compatible"],
    ["::127.0.0.1", "ipv4_compatible"],
    ["::8.8.8.8", "ipv4_compatible"],
    ["::2", "ipv4_compatible"],
    // NAT64 64:ff9b::/96 carries an IPv4 address in its last 32 bits
    ["64:ff9b::10.0.0.1", "private"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::8.8.8.8", "allowed"],
    // 6to4 2002::/16 carries it in bits 16 to 48
    ["2002:0a00:0001::1", "private"],
    ["2002:7f00:0001::1", "loopback"],
    ["2002:a9fe:a9fe::1", "metadata"],
    ["2002:0808:0808::1", "allowed"],
  ]);
});

Deno.test("IPv6 text that is malformed or carries a zone is refused", () => {
  check([
    [":::", "unparseable"],
    ["1::2::3", "unparseable"],
    ["1:2:3:4:5:6:7", "unparseable"],
    ["1:2:3:4:5:6:7:8:9", "unparseable"],
    ["12345::1", "unparseable"],
    ["g::1", "unparseable"],
    ["::1%eth0", "unparseable"],
    ["fe80::1%lo", "unparseable"],
    ["[::1]", "unparseable"],
    ["::ffff:10.0.0", "unparseable"],
    ["::ffff:999.0.0.1", "unparseable"],
    ["1:2:3:4:5:6:7:", "unparseable"],
    [":1:2:3:4:5:6:7", "unparseable"],
  ]);
  assertEquals(parseIPv6("::"), 0n);
  assertEquals(parseIPv6("::1"), 1n);
  assertEquals(
    parseIPv6("1:2:3:4:5:6:7:8"),
    0x00010002000300040005000600070008n,
  );
  // Compressed and expanded spell the same number.
  assertEquals(parseIPv6("2001:db8::1"), parseIPv6("2001:0db8:0:0:0:0:0:1"));
});

Deno.test("loopback is allowed only when the caller says it is a test fixture, and nothing else is", () => {
  check([
    ["127.0.0.1", "allowed"],
    ["127.9.9.9", "allowed"],
    ["::1", "allowed"],
    ["::ffff:127.0.0.1", "allowed"],
    ["64:ff9b::7f00:1", "allowed"],
    // Every other refused range stays refused in a test environment.
    ["10.0.0.1", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "metadata"],
    ["100.64.0.1", "cgnat"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["fd00:ec2::254", "metadata"],
    ["fe80::1", "link_local"],
    ["::ffff:10.0.0.1", "private"],
    ["::10.0.0.1", "ipv4_compatible"],
    ["224.0.0.1", "multicast"],
  ], test);
  check([
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
  ], production);
});

Deno.test("a name that resolves to a mix of allowed and refused addresses is refused", () => {
  const verdict = (addresses: string[], options = production) => {
    const result = classifyAddresses(addresses, options);
    return result.allowed ? "allowed" : result.reason;
  };
  assertEquals(verdict(["93.184.216.34"]), "allowed");
  assertEquals(verdict(["93.184.216.34", "2606:2800:220:1::1"]), "allowed");
  // One refused address anywhere in the answer refuses the whole name, in
  // either order and across families.
  assertEquals(verdict(["93.184.216.34", "10.0.0.5"]), "private");
  assertEquals(verdict(["10.0.0.5", "93.184.216.34"]), "private");
  assertEquals(verdict(["93.184.216.34", "fd00:ec2::254"]), "metadata");
  assertEquals(verdict(["2606:2800:220:1::1", "::ffff:127.0.0.1"]), "loopback");
  assertEquals(verdict(["93.184.216.34", "127.0.0.1"], test), "allowed");
  // An empty answer, or one with an unreadable entry, is not an answer.
  assertEquals(verdict([]), "unparseable");
  assertEquals(verdict(["93.184.216.34", "not-an-ip"]), "unparseable");
});

Deno.test("IP literals are told from names", () => {
  for (const literal of ["1.2.3.4", "::1", "2001:db8::1", "::ffff:1.2.3.4"]) {
    assertEquals(isIpLiteral(literal), true, literal);
  }
  for (
    const name of ["example.com", "s3.us-east-1.amazonaws.com", "localhost", ""]
  ) assertEquals(isIpLiteral(name), false, name);
});
