import { resolve4, resolve6 } from "node:dns/promises";

/**
 * Resolves a destination host for one export attempt (#21).
 *
 * `node:dns/promises`, not `Deno.resolveDns`: the repository is moving to Node
 * (#139), and a new Deno-only API is a migration debt taken on for no reason.
 *
 * Both record types are required: a host with only an A record would otherwise be
 * judged on half its answers, and a private AAAA address is still a private
 * address. A missing record of one type is a normal answer, not a failure.
 */
export async function resolveHostAddresses(
  host: string,
): Promise<readonly string[]> {
  const answers = await Promise.all([
    resolveQuietly(resolve4, host),
    resolveQuietly(resolve6, host),
  ]);
  return answers.flat();
}

async function resolveQuietly(
  resolve: (host: string) => Promise<readonly string[]>,
  host: string,
): Promise<readonly string[]> {
  try {
    return await resolve(host);
  } catch {
    // No record of this type: the other type may still resolve, and an entirely
    // empty result is judged as unresolved by the address check.
    return [];
  }
}
