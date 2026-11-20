import { assert, assertEquals, assertNotEquals } from "@std/assert";

/**
 * A claim replay answers the first response again, except the session
 * credential: #660 revokes the first token and mints a fresh one for the
 * replay, because a token is returned once and the replay store never holds
 * one. So the bodies match with the credential removed, and when the first
 * response carried a credential the replay carries a different one.
 */
export function assertClaimReplay(replayRaw: Uint8Array, firstRaw: Uint8Array) {
  const decode = (raw: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  const { sessionCredential: replayed, ...replay } = decode(replayRaw);
  const { sessionCredential: first, ...original } = decode(firstRaw);
  assertEquals(replay, original);
  if (first === undefined) {
    assertEquals(replayed, undefined);
    return;
  }
  assert(typeof replayed === "string" && replayed.length > 0);
  assertNotEquals(replayed, first);
}
