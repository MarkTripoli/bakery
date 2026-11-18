/**
 * Where an event export may be sent (issue #21, AC3).
 *
 * AC3 is "DNS rebinding / redirect / private address / uncertain receiver ack
 * => SSRF blocked". The threat is not a malicious *destination* - an
 * organization registers its own endpoint - it is a destination that resolves
 * somewhere the organization never intended, or that changes where it resolves
 * between the check and the connection.
 *
 * That shapes the design. A single "is this URL safe" check at registration time
 * is worthless against rebinding, because the answer can change a second later.
 * So the address is judged at dispatch, from the addresses actually resolved for
 * that attempt, and the caller is expected to connect to *those* addresses
 * rather than re-resolving. This module decides; it never resolves or connects,
 * so it cannot be the thing that re-resolves.
 */

/** Why a destination was refused. Every value is safe to store and to show. */
export type DestinationRefusal =
  /** Not an https URL, or not a URL at all. */
  | "not_https"
  /** Carries credentials, a fragment, or a port that is not the default. */
  | "unsafe_url_shape"
  /** The host is an IP literal in a range that is not publicly routable. */
  | "private_address"
  /** A resolved address is in a range that is not publicly routable. */
  | "resolves_to_private_address"
  /** The host resolved to nothing, so there is nothing safe to connect to. */
  | "unresolved"
  /** A redirect left the registered origin or path. */
  | "redirect_not_allowed";

export type DestinationDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DestinationRefusal };

const allow: DestinationDecision = { ok: true };
const refuse = (reason: DestinationRefusal): DestinationDecision => ({
  ok: false,
  reason,
});

/** Longest redirect chain followed before the delivery is refused. */
export const MAX_REDIRECTS = 0;

/**
 * Parses a dotted-quad IPv4 literal to its four octets, or null.
 *
 * Only plain decimal is accepted. The alternative forms a resolver may accept -
 * `0x7f.1`, `2130706433`, `0177.0.0.1`, `127.1` - are refused rather than
 * interpreted, because interpreting them is how a check and a resolver come to
 * disagree about which address is meant.
 */
export function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** True when an IPv4 literal is not publicly routable. */
export function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // documentation
  if (a === 203 && b === 0) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * True when an IPv6 literal is not publicly routable.
 *
 * IPv4-mapped and 6to4 addresses are unwrapped and judged as IPv4, because
 * `::ffff:127.0.0.1` reaches loopback and a check that only looked at the IPv6
 * prefix would let it through.
 */
export function isPrivateIpv6(value: string): boolean {
  const parsed = parseIpv6(value);
  // An address that does not parse is treated as private: refusing an export is
  // recoverable, reaching an address the judge could not read is not.
  if (parsed === null) return true;

  // ::ffff:0:0/96 and ::/96 embed an IPv4 address. Checking only the dotted
  // decimal form of the mapping missed the hex form entirely: `::ffff:7f00:1` is
  // 127.0.0.1 and `::ffff:a9fe:a9fe` is 169.254.169.254 - the cloud metadata
  // endpoint - and both were judged public. The IPv4 rules only mean anything
  // here if the address is read as bytes first.
  if (isAllZero(parsed, 0, 10) && parsed[10] === 0xff && parsed[11] === 0xff) {
    return isPrivateIpv4([parsed[12]!, parsed[13]!, parsed[14]!, parsed[15]!]);
  }
  if (isAllZero(parsed, 0, 12)) {
    return isPrivateIpv4([parsed[12]!, parsed[13]!, parsed[14]!, parsed[15]!]);
  }

  // :: and ::1 are the unspecified and loopback addresses.
  if (isAllZero(parsed, 0, 16)) return true;
  if (isAllZero(parsed, 0, 15) && parsed[15] === 1) return true;

  // fe80::/10 link-local, fec0::/10 site-local (deprecated but still routable
  // inside a site), fc00::/7 unique-local, ff00::/8 multicast.
  if (parsed[0] === 0xfe && (parsed[1]! & 0xc0) === 0x80) return true;
  if (parsed[0] === 0xfe && (parsed[1]! & 0xc0) === 0xc0) return true;
  if ((parsed[0]! & 0xfe) === 0xfc) return true;
  if (parsed[0] === 0xff) return true;

  // 64:ff9b::/96 NAT64, 2001:db8::/32 documentation, 2002::/16 6to4. A 6to4
  // address carries a full IPv4 address in bytes 2..6, so it is unwrapped rather
  // than refused wholesale: the same rule that catches the metadata endpoint
  // through the mapping catches it here.
  if (
    parsed[0] === 0x00 && parsed[1] === 0x64 && parsed[2] === 0xff &&
    parsed[3] === 0x9b
  ) {
    return isPrivateIpv4([parsed[12]!, parsed[13]!, parsed[14]!, parsed[15]!]);
  }
  if (
    parsed[0] === 0x20 && parsed[1] === 0x01 && parsed[2] === 0x0d &&
    parsed[3] === 0xb8
  ) {
    return true;
  }
  if (parsed[0] === 0x20 && parsed[1] === 0x02) {
    return isPrivateIpv4([parsed[2]!, parsed[3]!, parsed[4]!, parsed[5]!]);
  }
  // 2001::/32 is Teredo, which tunnels IPv6 over an embedded IPv4 endpoint and
  // is not a destination an export should reach. 2001:0::/32 specifically, not
  // all of 2001::/16, which contains globally routed space.
  if (
    parsed[0] === 0x20 && parsed[1] === 0x01 && parsed[2] === 0x00 &&
    parsed[3] === 0x00
  ) {
    return true;
  }

  return false;
}

function isAllZero(
  bytes: readonly number[],
  from: number,
  to: number,
): boolean {
  for (let index = from; index < to; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * Parses an IPv6 literal to its sixteen bytes, or null.
 *
 * Written out rather than delegated because the whole point of this module is
 * to judge the address that will actually be dialled: a parser that disagrees
 * with the operating system's is an address the judge never sees. Handles the
 * `::` compression, a trailing embedded IPv4 in dotted form, and zone ids.
 */
export function parseIpv6(value: string): number[] | null {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!address.includes(":")) return null;

  // A dotted IPv4 tail is rewritten as two hex groups so there is one path.
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail !== null) {
    const octets = parseIpv4(tail[1]!);
    if (octets === null) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, tail.index)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]!);
  const tailGroups = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (head === null || tailGroups === null) return null;

  const missing = 8 - head.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array.from({ length: Math.max(missing, 0) }, () => 0),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/** True when `address` is an IP literal in a range that is not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets !== null) return isPrivateIpv4(octets);
  if (address.includes(":")) return isPrivateIpv6(address);
  // Not an IP literal at all: the caller must have resolved it first.
  return false;
}

/**
 * Judges a registered destination's URL shape, before any resolution.
 *
 * The port is restricted to the default because a destination is a webhook
 * endpoint, and allowing arbitrary ports turns every export into a port scanner
 * that reports its results through delivery status.
 */
export function checkDestinationUrl(
  origin: string,
  path: string,
): DestinationDecision {
  let url: URL;
  try {
    url = new URL(`${origin}${path}`);
  } catch {
    return refuse("not_https");
  }
  if (url.protocol !== "https:") return refuse("not_https");
  if (url.username !== "" || url.password !== "") {
    return refuse("unsafe_url_shape");
  }
  if (url.hash !== "") return refuse("unsafe_url_shape");
  if (url.port !== "" && url.port !== "443") return refuse("unsafe_url_shape");
  return allow;
}

/**
 * Judges the addresses actually resolved for this attempt.
 *
 * This is the rebinding defence: the caller resolves once, passes the result
 * here, and connects to these addresses. A host that resolved publicly at
 * registration and privately now is refused here, at dispatch, which is the only
 * moment the answer is still true.
 */
export function checkResolvedAddresses(
  addresses: readonly string[],
): DestinationDecision {
  if (addresses.length === 0) return refuse("unresolved");
  for (const address of addresses) {
    // An answer that is not an IP literal is refused rather than waved through:
    // the transport is told to connect to these exact strings, and a name is an
    // address this judge never actually read.
    if (parseIpv4(address) === null && parseIpv6(address) === null) {
      return refuse("resolves_to_private_address");
    }
    if (isPrivateAddress(address)) return refuse("resolves_to_private_address");
  }
  return allow;
}

/**
 * Judges a redirect target against the registered destination.
 *
 * Redirects are not followed at all by default (`MAX_REDIRECTS` is 0), because a
 * redirect is the cheapest way to move a delivery from an approved endpoint to
 * an unapproved one. When a caller does allow them, the target must stay on the
 * same origin and under the same path, so it cannot leave the approved endpoint
 * even within the same host.
 */
export function checkRedirect(input: {
  readonly registeredOrigin: string;
  readonly registeredPath: string;
  readonly target: string;
  readonly redirectsFollowed: number;
}): DestinationDecision {
  if (input.redirectsFollowed > MAX_REDIRECTS) {
    return refuse("redirect_not_allowed");
  }
  let target: URL;
  try {
    target = new URL(input.target);
  } catch {
    return refuse("redirect_not_allowed");
  }
  if (target.origin !== input.registeredOrigin) {
    return refuse("redirect_not_allowed");
  }
  if (!target.pathname.startsWith(input.registeredPath)) {
    return refuse("redirect_not_allowed");
  }
  return allow;
}
