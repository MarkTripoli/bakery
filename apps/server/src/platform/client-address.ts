import {
  formatIpAddress,
  isTrustedProxyAddress,
  type ParsedIpAddress,
  parseIpAddress,
  type TrustedProxies,
} from "@bakery/config";

const FORWARDED_FOR_HEADER = "x-forwarded-for";
const MAX_FORWARDED_FOR_LENGTH = 4096;
const MAX_FORWARDED_FOR_ENTRIES = 64;

/**
 * Resolves the address that per-client limits key on.
 *
 * 1. `trusted` unset, or the socket peer is not in it: the peer.
 * 2. Peer trusted: parse `X-Forwarded-For` (every header line, comma split,
 *    trimmed). Absent, empty, oversized or containing any malformed entry:
 *    the peer, which fails closed onto the proxy's shared bucket.
 * 3. Walk the entries right to left; the first one outside `trusted` is the
 *    client. Entries left of it are client-controlled and ignored.
 * 4. Every entry trusted: the leftmost one.
 *
 * IPv4-mapped IPv6 addresses are treated as the IPv4 address they carry, and a
 * chosen entry is returned in canonical text form. Only the address changes;
 * the peer port is kept.
 */
export function resolveClientAddress(
  peer: Deno.NetAddr,
  headers: Headers,
  trusted: TrustedProxies | undefined,
): Deno.NetAddr {
  if (!trusted || trusted.length === 0) return peer;
  const peerAddress = parseIpAddress(peer.hostname);
  if (!peerAddress || !isTrustedProxyAddress(trusted, peerAddress)) return peer;
  const header = headers.get(FORWARDED_FOR_HEADER);
  if (header === null || header.trim() === "") return peer;
  if (header.length > MAX_FORWARDED_FOR_LENGTH) return peer;
  const parts = header.split(",");
  if (parts.length > MAX_FORWARDED_FOR_ENTRIES) return peer;
  const chain: ParsedIpAddress[] = [];
  for (const part of parts) {
    const parsed = parseIpAddress(part);
    if (!parsed) return peer;
    chain.push(parsed);
  }
  let client = chain[0];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyAddress(trusted, chain[index])) {
      client = chain[index];
      break;
    }
  }
  return { ...peer, hostname: formatIpAddress(client) };
}
