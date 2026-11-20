import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import {
  type AddressOptions,
  classifyAddresses,
  isIpLiteral,
} from "./address-policy.ts";

/**
 * Resolving an off-site destination's name and holding it to the address
 * policy in `address-policy.ts`. The resolver is injectable so tests never
 * touch real DNS and can change its answer between a save and a later read.
 */

/** Every A and AAAA address of a name. Throws when it has none. */
export type HostResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

export class HostUnresolvable extends Error {
  constructor() {
    super("BACKUP_DESTINATION_UNRESOLVABLE");
  }
}

/** How long one resolution may take. */
const RESOLVE_TIMEOUT_MS = 5000;

/**
 * The production resolver: A and AAAA records through the system resolver.
 * Either record type may be absent; no address of either type is unresolvable.
 */
export const resolveHostAddresses: HostResolver = async (hostname, signal) => {
  const abort = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)])
    : AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const settled = await Promise.allSettled([
    Deno.resolveDns(hostname, "A", { signal: abort }),
    Deno.resolveDns(hostname, "AAAA", { signal: abort }),
  ]);
  const addresses = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (addresses.length === 0) throw new HostUnresolvable();
  return addresses;
};

/** `localhost` and any `*.localhost` name. */
export function isLocalhostName(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

/** What the destination's host is held to, derived once from the destination. */
export type DestinationHost = {
  /** Host name or IP literal, without the brackets of an IPv6 literal. */
  readonly host: string;
  /**
   * True only for a loopback fixture in a test environment: the one case where
   * a loopback address is allowed.
   */
  readonly loopbackAllowed: boolean;
};

export type AddressRefusalWord =
  | "destination_private_address"
  | "destination_unresolvable";

export type DestinationAddressCheck =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly refusal: AddressRefusalWord };

/**
 * Resolves the destination's host (a literal IP needs no lookup) and holds
 * every address to the policy. A failed resolution is "unresolvable"; any
 * refused address, even among allowed ones, is "private address".
 */
export async function checkDestinationHost(
  destination: DestinationHost,
  resolve: HostResolver,
  signal?: AbortSignal,
): Promise<DestinationAddressCheck> {
  const options: AddressOptions = {
    allowLoopback: destination.loopbackAllowed,
  };
  let addresses: readonly string[];
  if (isIpLiteral(destination.host)) {
    addresses = [destination.host];
  } else if (isLocalhostName(destination.host)) {
    // `localhost` and `*.localhost` are loopback by definition; judging them so
    // gives the right answer without asking DNS, which may not know them.
    addresses = ["127.0.0.1"];
  } else {
    try {
      addresses = await resolve(destination.host, signal);
    } catch {
      return { ok: false, refusal: "destination_unresolvable" };
    }
  }
  const verdict = classifyAddresses(addresses, options);
  return verdict.allowed
    ? { ok: true, addresses }
    : { ok: false, refusal: "destination_private_address" };
}

/** The error a pinned lookup raises when a name now resolves to a refused address. */
export class DestinationRefusedAtConnect extends Error {
  readonly code = "BACKUP_DESTINATION_REFUSED";
  constructor(readonly refusal: AddressRefusalWord) {
    super(`BACKUP_DESTINATION_REFUSED ${refusal}`);
  }
}

type LookupCallback = (...args: unknown[]) => void;
type LookupOptions = { all?: boolean; family?: number } | undefined;

/**
 * A `lookup` for a Node HTTP(S) agent that decides which address a socket is
 * opened to. It resolves the name at the moment of connecting, holds the whole
 * answer to the policy, and hands the socket only those validated addresses, so
 * the address checked is the address dialled: there is no gap between the check
 * and the connection for a rebinding name to slip through. Deno honours this
 * `lookup` for the real connection (verified for http and https; TLS still
 * verifies the original host name).
 */
export function createPinnedLookup(
  destination: DestinationHost,
  resolve: HostResolver,
) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => {
    void (async () => {
      // The agent only ever dials the destination's own host.
      const check = await checkDestinationHost(
        { ...destination, host: hostname },
        resolve,
      );
      if (!check.ok) {
        callback(new DestinationRefusedAtConnect(check.refusal));
        return;
      }
      const entries = check.addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
      if (options?.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    })();
  };
}

/** HTTP and HTTPS agents whose sockets can only reach validated addresses. */
export function createPinnedAgents(
  destination: DestinationHost,
  resolve: HostResolver,
) {
  const lookup = createPinnedLookup(
    destination,
    resolve,
  ) as unknown as LookupFunction;
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  };
}
