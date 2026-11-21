import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

/**
 * Which addresses the server may call on behalf of a provider route.
 *
 * A route's endpoint is typed by an administrator and called by the server, so a
 * value that names the server's own network is a request to read it (SSRF). The
 * rule is one predicate, applied twice. The route command applies it to an
 * endpoint whose host is written as such an address (the first line). The probe
 * applies it again to every address a name *resolves* to, inside the connection's
 * own `lookup` (`guardedLookup` below), so the address that was checked is the
 * address that is dialled and a name cannot answer one thing to the check and
 * another to the connection (DNS rebinding).
 *
 * Non-public means anything a public provider can never have: unspecified,
 * loopback, private, shared (carrier-grade NAT), link-local (which includes the
 * cloud metadata address), multicast, reserved, documentation and unique-local
 * ranges, and IPv4 addresses carried inside IPv6 (mapped, translated).
 */

/** Dotted-quad text to four octets, or null when it is not one. */
function parseIpv4(text: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

function ipv4IsNonPublic([a, b, c]: [number, number, number, number]): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (RFC 6598)
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224; // multicast and reserved
}

/** An IPv6 address as eight 16-bit groups, or null when it is not valid. */
function parseIpv6(text: string): number[] | null {
  let bare = text.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = bare.indexOf("%");
  if (zone !== -1) bare = bare.slice(0, zone);
  if (!bare.includes(":")) return null;
  // A trailing dotted quad (::ffff:127.0.0.1) is two groups.
  const tail = bare.slice(bare.lastIndexOf(":") + 1);
  const quad = tail.includes(".") ? parseIpv4(tail) : null;
  if (tail.includes(".") && quad === null) return null;
  if (quad !== null) {
    const head = bare.slice(0, bare.lastIndexOf(":") + 1);
    bare = `${head}${((quad[0] << 8) | quad[1]).toString(16)}:${
      ((quad[2] << 8) | quad[3]).toString(16)
    }`;
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => part === "" ? [] : part.split(":");
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = [
    ...left,
    ...(halves.length === 2 ? Array(missing).fill("0") : []),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const parsed = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN
  );
  return parsed.some(Number.isNaN) ? null : parsed;
}

function ipv6IsNonPublic(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (hi: number, lo: number) =>
    ipv4IsNonPublic([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.every((group) => group === 0)) return true; // ::
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 &&
    g6 === 0 && g7 === 1
  ) return true; // ::1
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): judged as the IPv4.
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 &&
    (g5 === 0xffff || g5 === 0)
  ) return embedded(g6, g7);
  if (
    g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 &&
    g5 === 0
  ) return embedded(g6, g7); // 64:ff9b::/96 NAT64
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4 embeds an IPv4
  return (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g0 === 0x2001 && g1 === 0xdb8) || // documentation
    (g0 === 0x2001 && g1 === 0) || // Teredo
    g0 === 0x100; // discard-only
}

/**
 * Whether an address literal (IPv4, or IPv6 with or without brackets) is one the
 * server must not call. A string that is not an address at all is not judged here
 * and answers `false`: the caller decides what a hostname means.
 */
export function isNonPublicAddress(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4 !== null) return ipv4IsNonPublic(v4);
  const v6 = parseIpv6(host);
  if (v6 !== null) return ipv6IsNonPublic(v6);
  // Looks like an address (digits and dots, or colons) but does not parse:
  // refuse rather than guess, so an odd encoding is not a way around the rule.
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

// -- The connect-time guard -------------------------------------------------

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Resolves a name to every address it has; replaceable so a test needs no DNS. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

const resolveAll: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

/** Why a connection was refused, so a caller can tell a policy refusal from a network failure. */
export const EGRESS_REFUSED = "EGRESS_REFUSED";

function refusal(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: EGRESS_REFUSED });
}

/**
 * A `lookup` for `node:https` that refuses to connect to a non-public address.
 *
 * Checking the name before the request would leave a gap: a name can answer with
 * a public address to the check and a private one to the connection (DNS
 * rebinding). This function *is* what the connection asks, so the address it
 * returns is the address that is dialled: the check and the connect are one step.
 *
 * Every address in the answer must be public. A mixed answer is refused whole,
 * because the connection may use any of them and a name that offers a private one
 * is not a public provider.
 */
export function guardedLookup(resolver: Resolver = resolveAll): LookupFunction {
  return (hostname, options, callback) => {
    const wantsAll = options.all === true;
    // An error still has to hand the callback an address-shaped value.
    const fail = (error: Error) => callback(error, "", 0);
    resolver(hostname).then((addresses) => {
      if (addresses.length === 0) {
        fail(refusal("no address"));
        return;
      }
      if (addresses.some(({ address }) => isNonPublicAddress(address))) {
        fail(refusal("address is not public"));
        return;
      }
      if (wantsAll) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }, (error) => fail(error instanceof Error ? error : new Error("dns")));
  };
}

/**
 * Whether an endpoint's host is written as an address the server must not call.
 *
 * A connection to an address literal never consults `lookup`, so the guard above
 * cannot see it; this is the same rule applied to the URL itself.
 */
export function endpointHostIsRefused(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return true;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol !== "https:" || url.username !== "" ||
    url.password !== "" || (isIP(host) !== 0 && isNonPublicAddress(host));
}
