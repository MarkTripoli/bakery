/**
 * Which network addresses an off-site backup destination may resolve to.
 *
 * The destination is an address an administrator typed, and the server (and
 * later the host runner) dials it, so a name that points inside the network, at
 * the machine itself or at a cloud metadata service would turn "send a test"
 * into a request the administrator should not be able to make. This file is the
 * one pure rule for that, for names (after resolution) and for literal IPs.
 *
 * Everything here is table-driven and has no I/O: the resolver lives in
 * `dns.ts`, the callers in `settings-actions.ts` and `s3.ts`.
 */

export type AddressVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AddressRefusal };

/** Stable words for why an address is refused; they never leave the server as UI text. */
export type AddressRefusal =
  | "unparseable"
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link_local"
  | "metadata"
  | "benchmarking"
  | "documentation"
  | "multicast"
  | "reserved"
  | "unique_local"
  | "ipv4_compatible";

export type AddressOptions = {
  /**
   * Loopback is allowed ONLY in a test environment and only for the loopback
   * fixture the caller already vetted (an http endpoint on a test host).
   */
  readonly allowLoopback: boolean;
};

const refused = (reason: AddressRefusal): AddressVerdict => ({
  allowed: false,
  reason,
});
const ALLOWED: AddressVerdict = { allowed: true };

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

/** Dotted quad of four decimal octets without leading zeros, as a 32-bit number. */
export function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Leading zeros are ambiguous (octal in some stacks): refuse the form.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

type V4Rule = {
  readonly base: string;
  readonly bits: number;
  readonly reason: AddressRefusal;
};

/** First match wins, so the cloud metadata address is named before link-local. */
const V4_REFUSED: readonly V4Rule[] = [
  { base: "169.254.169.254", bits: 32, reason: "metadata" },
  { base: "0.0.0.0", bits: 8, reason: "unspecified" },
  { base: "10.0.0.0", bits: 8, reason: "private" },
  { base: "100.64.0.0", bits: 10, reason: "cgnat" },
  { base: "127.0.0.0", bits: 8, reason: "loopback" },
  { base: "169.254.0.0", bits: 16, reason: "link_local" },
  { base: "172.16.0.0", bits: 12, reason: "private" },
  { base: "192.0.0.0", bits: 24, reason: "reserved" },
  { base: "192.0.2.0", bits: 24, reason: "documentation" },
  { base: "192.168.0.0", bits: 16, reason: "private" },
  { base: "198.18.0.0", bits: 15, reason: "benchmarking" },
  { base: "198.51.100.0", bits: 24, reason: "documentation" },
  { base: "203.0.113.0", bits: 24, reason: "documentation" },
  { base: "224.0.0.0", bits: 4, reason: "multicast" },
  // 240/4 is reserved and holds the limited broadcast address 255.255.255.255.
  { base: "240.0.0.0", bits: 4, reason: "reserved" },
];

function inV4(value: number, base: string, bits: number): boolean {
  const start = parseIPv4(base)!;
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
}

export function classifyIPv4(
  value: number,
  options: AddressOptions,
): AddressVerdict {
  for (const rule of V4_REFUSED) {
    if (inV4(value, rule.base, rule.bits)) {
      if (rule.reason === "loopback" && options.allowLoopback) return ALLOWED;
      return refused(rule.reason);
    }
  }
  return ALLOWED;
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/**
 * An IPv6 address as a 128-bit number. Accepts the compressed form (`::`), an
 * embedded dotted IPv4 tail (`::ffff:10.0.0.1`) and any hex case; refuses a
 * zone id (`fe80::1%eth0`), brackets and anything malformed.
 */
export function parseIPv6(text: string): bigint | null {
  if (text.includes("%") || text.includes("[") || text.includes("]")) {
    return null;
  }
  let head = text;
  let v4Tail: number | null = null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4Tail = parseIPv4(tail);
    if (v4Tail === null) return null;
    // Replace the dotted tail by two hextets for the common parser.
    head = `${text.slice(0, lastColon + 1)}${
      Math.floor(v4Tail / 65536).toString(16)
    }:${(v4Tail % 65536).toString(16)}`;
  }
  const doubles = head.split("::");
  if (doubles.length > 2) return null;
  const toGroups = (part: string): string[] | null =>
    part === "" ? [] : part.split(":");
  const left = toGroups(doubles[0]);
  const right = doubles.length === 2 ? toGroups(doubles[1]) : [];
  if (left === null || right === null) return null;
  const groups = doubles.length === 2
    ? (() => {
      const missing = 8 - left.length - right.length;
      // `::` stands for at least one group of zeros.
      return missing < 1
        ? null
        : [...left, ...Array<string>(missing).fill("0"), ...right];
    })()
    : left;
  if (groups === null || groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!HEXTET.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return value;
}

const MASK_128 = (1n << 128n) - 1n;
function prefix6(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return ((value & MASK_128) >> shift) === (base >> shift);
}
const v6 = (text: string): bigint => parseIPv6(text)!;

const METADATA_V6 = v6("fd00:ec2::254");

export function classifyIPv6(
  value: bigint,
  options: AddressOptions,
): AddressVerdict {
  if (value === 0n) return refused("unspecified");
  if (value === 1n) {
    return options.allowLoopback ? ALLOWED : refused("loopback");
  }
  if (value === METADATA_V6) return refused("metadata");
  // ::ffff:a.b.c.d is IPv4-mapped: judged as the IPv4 address it carries.
  if (prefix6(value, v6("::ffff:0:0"), 96)) {
    return classifyIPv4(Number(value & 0xffffffffn), options);
  }
  // ::a.b.c.d is IPv4-compatible (deprecated, never routed): refused outright,
  // and so is the whole ::/96 block, since no real service lives there.
  if (prefix6(value, 0n, 96)) return refused("ipv4_compatible");
  // 64:ff9b::/96 is NAT64: judged as the IPv4 address it carries.
  if (prefix6(value, v6("64:ff9b::"), 96)) {
    return classifyIPv4(Number(value & 0xffffffffn), options);
  }
  // 2002::/16 is 6to4: the IPv4 address sits in bits 16 to 48.
  if (prefix6(value, v6("2002::"), 16)) {
    return classifyIPv4(Number((value >> 80n) & 0xffffffffn), options);
  }
  if (prefix6(value, v6("fc00::"), 7)) return refused("unique_local");
  if (prefix6(value, v6("fe80::"), 10)) return refused("link_local");
  if (prefix6(value, v6("ff00::"), 8)) return refused("multicast");
  // 100::/64 is the discard-only block; 2001:db8::/32 is documentation.
  if (prefix6(value, v6("100::"), 64)) return refused("reserved");
  if (prefix6(value, v6("2001:db8::"), 32)) return refused("documentation");
  return ALLOWED;
}

/* ------------------------------------------------------------------ */
/* One entry point                                                     */
/* ------------------------------------------------------------------ */

/** True when `text` is an IP literal (v4 or v6) rather than a name. */
export function isIpLiteral(text: string): boolean {
  return parseIPv4(text) !== null || parseIPv6(text) !== null;
}

/**
 * Judges one address in its textual form, IPv4 or IPv6. An address that does
 * not parse is refused: a resolver answer or a typed literal that cannot be read
 * is never dialled.
 */
export function classifyAddress(
  address: string,
  options: AddressOptions,
): AddressVerdict {
  const v4 = parseIPv4(address);
  if (v4 !== null) return classifyIPv4(v4, options);
  const v6value = parseIPv6(address);
  if (v6value !== null) return classifyIPv6(v6value, options);
  return refused("unparseable");
}

/**
 * Judges the whole answer for one name: every address must be allowed, and an
 * empty answer is not an answer. A name that resolves to a mix of allowed and
 * refused addresses is refused, so a split answer cannot hide one bad address
 * among good ones.
 */
export function classifyAddresses(
  addresses: readonly string[],
  options: AddressOptions,
): AddressVerdict {
  if (addresses.length === 0) return refused("unparseable");
  for (const address of addresses) {
    const verdict = classifyAddress(address, options);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}
