import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { callerMayMerge } from "../../apps/server/src/modules/delivery/postgres.ts";

/**
 * #57: `mayMerge` is the server's fact about the caller, not a guess the page
 * makes from a role. It is true only for a caller whose organization authority
 * holds `pullRequest:merge`, and false for everyone else, including a caller
 * with no organization authority at all.
 */

function contextOf(authority: unknown): ActionContext {
  return {
    request: new Request("http://test/v1/pull-requests"),
    params: {},
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    ...(authority === undefined ? {} : { authority }),
  } as unknown as ActionContext;
}

function member(role: string) {
  return {
    subject: {
      principalId: crypto.randomUUID(),
      principalType: "human",
      displayName: "Pat",
    },
    organizationId: crypto.randomUUID(),
    role,
    capabilities: [],
  };
}

Deno.test("a caller with no authority may not merge", () => {
  assertEquals(callerMayMerge(contextOf(undefined)), false);
});

Deno.test("a caller whose authority names no organization may not merge", () => {
  assertEquals(
    callerMayMerge(contextOf({
      subject: { principalId: crypto.randomUUID() },
    })),
    false,
  );
});

Deno.test("a role without pullRequest:merge may not merge", () => {
  for (const role of ["viewer", "guest"]) {
    assertEquals(callerMayMerge(contextOf(member(role))), false, role);
  }
});

Deno.test("a role with pullRequest:merge may merge", () => {
  assertEquals(callerMayMerge(contextOf(member("admin"))), true);
});
