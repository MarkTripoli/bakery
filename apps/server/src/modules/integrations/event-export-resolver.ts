/**
 * Resolves a destination host for one export attempt (#21).
 *
 * Both record types are required: a host with only an A record would otherwise
 * be judged on half its answers, and a private AAAA address is a private address.
 * An empty answer is returned as-is rather than swallowed, so the dispatch path
 * refuses an unresolved host instead of dialling nothing.
 */
export async function resolveHostAddresses(
  host: string,
): Promise<readonly string[]> {
  const answers = await Promise.all([
    resolveQuietly(host, "A"),
    resolveQuietly(host, "AAAA"),
  ]);
  return answers.flat();
}

async function resolveQuietly(
  host: string,
  type: "A" | "AAAA",
): Promise<readonly string[]> {
  try {
    return await Deno.resolveDns(host, type);
  } catch {
    // No record of this type is a normal answer, not a failure: the other type
    // may still resolve, and an entirely empty result is judged as unresolved.
    return [];
  }
}
