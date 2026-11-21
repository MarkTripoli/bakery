import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

/** The answer to "may Bakery send telemetry to this address?". */
export type AddressVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Resolves a host name to every address it points at. */
export type HostResolver = (host: string) => Promise<readonly string[]>;

/** Decides whether an address is acceptable. Injected so a test can allow loopback. */
export type AddressPolicy = (address: string) => Promise<AddressVerdict>;

const nodeResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((
    part,
  ) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? octets
    : undefined;
}

function isNonPublicIpv4([a, b, c]: readonly number[]): boolean {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

/** The sixteen bytes of an IPv6 literal, or undefined when it is not one. */
function ipv6Bytes(literal: string): number[] | undefined {
  // A zone ("%eth0") never changes where the address points.
  const address = literal.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(address) || !address.includes(":")) {
    return undefined;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (text: string): number[] | undefined => {
    if (text === "") return [];
    const out: number[] = [];
    const pieces = text.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = ipv4Octets(piece);
        if (!v4) return undefined;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [
    ...head,
    ...new Array<number>(Math.max(missing, 0)).fill(0),
    ...tail,
  ];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/**
 * Whether an IP literal is one an outside service must never be sent to. IPv6
 * is read as bytes, so every spelling of an IPv4 address inside it is checked as
 * that IPv4 address: mapped (::ffff:a.b.c.d or ::ffff:7f00:1), compatible
 * (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 */
export function isNonPublicIp(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets) return isNonPublicIpv4(octets);
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true; // not an address we can reason about
  const zeroUpTo = (end: number) => bytes.slice(0, end).every((b) => b === 0);
  // ::/96 holds the unspecified address, loopback and IPv4-compatible forms.
  if (zeroUpTo(12)) return true;
  // ::ffff:0:0/96, IPv4-mapped.
  if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isNonPublicIpv4(bytes.slice(12));
  }
  // 64:ff9b::/96, NAT64 well-known prefix.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff &&
    bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0)
  ) return isNonPublicIpv4(bytes.slice(12));
  // 64:ff9b:1::/48, local-use NAT64.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff &&
    bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01
  ) return true;
  // 2002::/16, 6to4: the IPv4 address sits in bytes 2 to 5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isNonPublicIpv4(bytes.slice(2, 6));
  }
  // 2001::/32 Teredo, 2001:db8::/32 documentation, 100::/64 discard.
  if (
    bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) return true;
  if (
    bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) return true;
  if (
    bytes[0] === 0x01 && bytes[1] === 0x00 &&
    bytes.slice(2, 8).every((b) => b === 0)
  ) return true;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (bytes[0] & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff;
}

/**
 * The address rules every outbound destination follows: https only, no
 * credentials in the address, and no host that is or resolves to a private,
 * loopback, link-local or otherwise non-public address.
 *
 * A name is resolved here and every address it points at is checked. A name that
 * answers differently when the request is made is not caught by this check, which
 * is why the senders also refuse redirects and cap how long they wait.
 */
export function createPublicHttpsPolicy(
  resolve: HostResolver = nodeResolver,
): AddressPolicy {
  return async (address) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return { ok: false, reason: "The address is not a valid URL." };
    }
    if (url.protocol !== "https:") {
      return { ok: false, reason: "The address must start with https://." };
    }
    if (url.username !== "" || url.password !== "") {
      return {
        ok: false,
        reason: "The address must not contain a user name or password.",
      };
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.toLowerCase() === "localhost" || host.endsWith(".localhost")) {
      return { ok: false, reason: "The address points at this machine." };
    }
    let addresses: readonly string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await resolve(host);
      } catch {
        return { ok: false, reason: "The address could not be looked up." };
      }
    }
    if (addresses.length === 0 || addresses.some(isNonPublicIp)) {
      return {
        ok: false,
        reason: "The address points at a private or local network.",
      };
    }
    return { ok: true };
  };
}

/** The error code of a connection refused because its address is not public. */
export const ADDRESS_REFUSED = "ADDRESS_REFUSED";

/** What a person reads when a name points at a private or local network. */
export const ADDRESS_REFUSED_REASON =
  "The address points at a private or local network.";

/**
 * A `lookup` for `node:https` that refuses a non-public address at connect time.
 *
 * `createPublicHttpsPolicy` resolves a name and then the request resolves it
 * again, so a name with a short TTL can answer a public address to the check and
 * a private one to the connection (DNS rebinding). This function is what the
 * connection asks, so the address it returns is the address that is dialled: the
 * check and the connect are one step. TLS still verifies the original host name.
 *
 * Every address in the answer must be public; a mixed answer is refused whole.
 */
export function createGuardedLookup(
  resolve: HostResolver = nodeResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    const fail = (error: Error) => callback(error, "", 0);
    resolve(hostname).then((addresses) => {
      if (addresses.length === 0 || addresses.some(isNonPublicIp)) {
        fail(
          Object.assign(new Error(ADDRESS_REFUSED_REASON), {
            code: ADDRESS_REFUSED,
          }),
        );
        return;
      }
      const entries = addresses.map((address) => ({
        address,
        family: isIP(address) === 6 ? 6 : 4,
      }));
      if (options.all === true) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    }, (error) => fail(error instanceof Error ? error : new Error("dns")));
  };
}

/** A policy that accepts anything. For tests that run a receiver on loopback. */
export const allowAnyAddress: AddressPolicy = () =>
  Promise.resolve({ ok: true });
