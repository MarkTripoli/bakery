import { z } from "zod";

/** One parsed trusted-proxy range. IPv4 networks hold a 32-bit value. */
export type TrustedProxyRange = {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
};

/** Parsed `BAKERY_TRUSTED_PROXY_CIDRS`: the peers allowed to supply a client chain. */
export type TrustedProxies = readonly TrustedProxyRange[];

export const MAX_TRUSTED_PROXY_ENTRIES = 32;

/** A parsed IP address: family plus its integer value. */
export type ParsedIpAddress = {
  readonly family: 4 | 6;
  readonly value: bigint;
};

const IPV4_PATTERN =
  /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;
const IPV4_MAPPED_PREFIX = 0xffffn << 32n;

function parseIpv4Value(text: string): bigint | undefined {
  if (!IPV4_PATTERN.test(text)) return undefined;
  let value = 0n;
  for (const part of text.split(".")) {
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseHextet(text: string): bigint | undefined {
  return /^[0-9a-f]{1,4}$/.test(text) ? BigInt(`0x${text}`) : undefined;
}

function parseIpv6Value(input: string): bigint | undefined {
  let text = input.toLowerCase();
  if (text.length === 0 || text.length > 45) return undefined;
  let tail: bigint[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return undefined;
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const embedded = parseIpv4Value(lastPart);
    if (embedded === undefined) return undefined;
    tail = [embedded >> 16n, embedded & 0xffffn];
    text = `${text.slice(0, lastColon + 1)}${tail[0].toString(16)}:${
      tail[1].toString(16)
    }`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parseGroup = (group: string): bigint[] | undefined => {
    if (group === "") return [];
    const out: bigint[] = [];
    for (const part of group.split(":")) {
      const hextet = parseHextet(part);
      if (hextet === undefined) return undefined;
      out.push(hextet);
    }
    return out;
  };
  const head = parseGroup(halves[0]);
  if (!head) return undefined;
  let groups: bigint[];
  if (halves.length === 2) {
    const rest = parseGroup(halves[1]);
    if (!rest) return undefined;
    // "::" must stand for at least one zero group.
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array<bigint>(missing).fill(0n), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
}

/**
 * Parses a literal IPv4 or IPv6 address. IPv4-mapped IPv6 addresses
 * (`::ffff:a.b.c.d`) are returned as the IPv4 address they carry. Returns
 * undefined for anything else, including ports, brackets and zone ids.
 */
export function parseIpAddress(text: string): ParsedIpAddress | undefined {
  const trimmed = text.trim();
  const v4 = parseIpv4Value(trimmed);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseIpv6Value(trimmed);
  if (v6 === undefined) return undefined;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

/** Canonical text for a parsed address: dotted IPv4 or RFC 5952 IPv6. */
export function formatIpAddress(address: ParsedIpAddress): string {
  if (address.family === 4) {
    return [24n, 16n, 8n, 0n]
      .map((shift) => String((address.value >> shift) & 0xffn))
      .join(".");
  }
  const groups = Array.from(
    { length: 8 },
    (_, index) => Number((address.value >> BigInt((7 - index) * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const text = (items: number[]) => items.map((n) => n.toString(16)).join(":");
  if (bestLength < 2) return text(groups);
  return `${text(groups.slice(0, bestStart))}::${
    text(groups.slice(bestStart + bestLength))
  }`;
}

function parseRange(entry: string): TrustedProxyRange | undefined {
  const slash = entry.indexOf("/");
  const addressText = slash === -1 ? entry : entry.slice(0, slash);
  // The literal family decides the prefix width: "::ffff:10.0.0.0/104" is a
  // 128-bit IPv6 range, not an IPv4 one.
  const literalIsV6 = addressText.includes(":");
  const parsed = literalIsV6
    ? (() => {
      const value = parseIpv6Value(addressText);
      return value === undefined ? undefined : { family: 6 as const, value };
    })()
    : (() => {
      const value = parseIpv4Value(addressText);
      return value === undefined ? undefined : { family: 4 as const, value };
    })();
  if (!parsed) return undefined;
  const width = parsed.family === 4 ? 32 : 128;
  let prefix = width;
  if (slash !== -1) {
    const prefixText = entry.slice(slash + 1);
    if (!/^(?:0|[1-9]\d{0,2})$/.test(prefixText)) return undefined;
    prefix = Number(prefixText);
    if (prefix > width) return undefined;
  }
  const hostBits = BigInt(width - prefix);
  return {
    family: parsed.family,
    network: (parsed.value >> hostBits) << hostBits,
    prefix,
  };
}

/**
 * Parses a comma-separated list of CIDR ranges or bare addresses. Throws
 * TRUSTED_PROXY_CIDRS_INVALID for an empty entry, a malformed entry, a bad
 * prefix length, or more than 32 entries.
 */
export function parseTrustedProxyCidrs(text: string): TrustedProxies {
  const entries = text.split(",").map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXY_ENTRIES) {
    throw new Error("TRUSTED_PROXY_CIDRS_INVALID");
  }
  return entries.map((entry) => {
    const range = parseRange(entry);
    if (!range) throw new Error("TRUSTED_PROXY_CIDRS_INVALID");
    return range;
  });
}

export const TrustedProxyCidrsSchema = z.string().max(2048).superRefine(
  (value, context) => {
    try {
      parseTrustedProxyCidrs(value);
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "Trusted proxies must be 1 to 32 comma-separated IPv4 or IPv6 addresses or CIDR ranges.",
      });
    }
  },
).describe(
  "Opt-in comma-separated list of 1 to 32 IPv4 or IPv6 addresses or CIDR ranges of reverse proxies whose X-Forwarded-For header the server trusts when keying per-client rate limits; unset trusts none.",
);

/**
 * Returns the parsed trusted proxies, or undefined when unset or blank.
 * Throws TRUSTED_PROXY_CIDRS_INVALID for a set but malformed value.
 */
export function readTrustedProxyCidrs(
  env: Record<string, string | undefined>,
): TrustedProxies | undefined {
  const raw = env.BAKERY_TRUSTED_PROXY_CIDRS;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!TrustedProxyCidrsSchema.safeParse(raw).success) {
    throw new Error("TRUSTED_PROXY_CIDRS_INVALID");
  }
  return parseTrustedProxyCidrs(raw);
}

/** True when the address lies inside any trusted range. */
export function isTrustedProxyAddress(
  trusted: TrustedProxies,
  address: ParsedIpAddress,
): boolean {
  // An IPv4 address also counts as its IPv4-mapped IPv6 form, so an IPv6
  // range that spans ::ffff:0:0/96 (such as "::/0") covers IPv4 peers too.
  const mapped = address.family === 4
    ? IPV4_MAPPED_PREFIX | address.value
    : undefined;
  return trusted.some((range) => {
    const candidate = range.family === address.family
      ? address.value
      : range.family === 6
      ? mapped
      : undefined;
    if (candidate === undefined) return false;
    const width = range.family === 4 ? 32 : 128;
    const hostBits = BigInt(width - range.prefix);
    return (candidate >> hostBits) << hostBits === range.network;
  });
}
