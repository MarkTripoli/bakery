import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  const octets = parts.map((part) => Number(part));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? octets
    : undefined;
}

/** Whether an IP literal is one an outside service must never be sent to. */
export function isNonPublicIp(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped ? mapped[1] : address;
  const octets = ipv4Octets(candidate);
  if (octets) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === "::" || lower === "::1" || lower.startsWith("fc") ||
    lower.startsWith("fd") || /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff");
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

/** A policy that accepts anything. For tests that run a receiver on loopback. */
export const allowAnyAddress: AddressPolicy = () =>
  Promise.resolve({ ok: true });
