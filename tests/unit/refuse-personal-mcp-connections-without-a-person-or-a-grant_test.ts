import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  invokeMcpTool,
  mcpInvocationDenial,
  type McpPinnedState,
} from "../../apps/server/src/modules/mcp/invoke.ts";
import { buildManifest } from "../../apps/server/src/modules/mcp/discovery.ts";
import { mcpManifestDigest } from "../../apps/server/src/modules/mcp/invoke.ts";

/**
 * Personal MCP connections in the invoke path (#434, O27): a personal connection
 * acts as its owner, so it is never used by a run no person started, and a run
 * someone else started needs the owner's grant to that workflow. Pure: the pinned
 * state is data, and a refusal never reaches the transport.
 */

const DIGEST = "a".repeat(64);
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const passing: McpPinnedState = {
  connectionStatus: "enabled",
  pinnedSnapshot: { id: "s1", digest: DIGEST, toolNames: ["search"] },
  currentSnapshot: { id: "s1", digest: DIGEST },
  grantLive: true,
  enabledCapabilities: ["search"],
  transport: "streamable_http",
  workerHostId: null,
  allowedOperations: ["search"],
  dispatchingHostEligible: true,
};
const personal = (useGrantLive: boolean): McpPinnedState => ({
  ...passing,
  personal: { ownerPrincipalId: OWNER, useGrantLive },
});

const call = (startedByPrincipalId?: string | null) => ({
  toolName: "search",
  pinnedDigest: DIGEST,
  hostId: "host-1",
  startedByPrincipalId,
});

Deno.test("an organization connection does not read who started the run", () => {
  for (const started of [undefined, null, "", OWNER, OTHER]) {
    assertEquals(mcpInvocationDenial(call(started), passing), null);
    assertEquals(
      mcpInvocationDenial(call(started), { ...passing, personal: null }),
      null,
    );
  }
});

Deno.test("a personal connection is refused for a run no person started", () => {
  for (const started of [undefined, null, ""]) {
    for (const grant of [true, false]) {
      assertEquals(
        mcpInvocationDenial(call(started), personal(grant))?.denial,
        "personal_unattended",
        `${String(started)} with grant ${grant}`,
      );
    }
  }
});

Deno.test("the owner runs their own personal connection; anyone else needs the owner's grant", () => {
  // The owner started it: no grant needed, whether or not one exists.
  assertEquals(mcpInvocationDenial(call(OWNER), personal(false)), null);
  assertEquals(mcpInvocationDenial(call(OWNER), personal(true)), null);
  // Someone else started it: only with the owner's live grant to this workflow.
  assertEquals(
    mcpInvocationDenial(call(OTHER), personal(false))?.denial,
    "personal_use_not_granted",
  );
  assertEquals(mcpInvocationDenial(call(OTHER), personal(true)), null);
});

Deno.test("a revoked connection outranks the personal rules, which outrank everything after them", () => {
  assertEquals(
    mcpInvocationDenial(call(null), {
      ...personal(false),
      connectionStatus: "revoked",
    })?.denial,
    "connection_revoked",
  );
  // Both a personal refusal and a revoked grant apply: the personal one is said.
  assertEquals(
    mcpInvocationDenial(call(OTHER), { ...personal(false), grantLive: false })
      ?.denial,
    "personal_use_not_granted",
  );
  // With the personal rules satisfied, the ordinary checks still apply.
  assertEquals(
    mcpInvocationDenial(call(OWNER), { ...personal(false), grantLive: false })
      ?.denial,
    "grant_revoked",
  );
  assertEquals(
    mcpInvocationDenial(call(OWNER), {
      ...personal(false),
      currentSnapshot: { id: "s2", digest: "b".repeat(64) },
    })?.denial,
    "schema_drift",
  );
});

function deps(state: McpPinnedState) {
  const loaded: unknown[] = [];
  const invoked: unknown[] = [];
  return {
    loaded,
    invoked,
    deps: {
      pinnedState: {
        load: (input: unknown) => {
          loaded.push(input);
          return Promise.resolve(state);
        },
      },
      transport: {
        invoke: (input: unknown) => {
          invoked.push(input);
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
}

const request = (started?: string | null) => ({
  connectionId: "33333333-3333-4333-8333-333333333333",
  toolName: "search",
  pinnedDigest: DIGEST,
  arguments: {},
  organizationId: "org",
  actorRef: "actor",
  hostId: "host-1",
  ...(started === undefined ? {} : { startedByPrincipalId: started }),
});

Deno.test("a refused personal call never reaches the transport, and a passing one says whom it acted for", async () => {
  const refused = deps(personal(false));
  const error = await assertRejects(
    () => invokeMcpTool(refused.deps, request(OTHER)),
    StandardError,
  );
  assertEquals(
    (error.params as { reason: string }).reason,
    "personal_use_not_granted",
  );
  assertEquals(refused.invoked, []);
  // The state read is told who started the run, so the grant is looked up for it.
  assertEquals(
    (refused.loaded[0] as { startedByPrincipalId: string })
      .startedByPrincipalId,
    OTHER,
  );

  // Nobody started it: the omission is a null, never a guess.
  const unattended = deps(personal(true));
  await assertRejects(
    () => invokeMcpTool(unattended.deps, request()),
    StandardError,
  );
  assertEquals(
    (unattended.loaded[0] as { startedByPrincipalId: unknown })
      .startedByPrincipalId,
    null,
  );
  assertEquals(unattended.invoked, []);

  const owned = deps(personal(false));
  const result = await invokeMcpTool(owned.deps, request(OWNER));
  assertEquals(result.actingForPrincipalId, OWNER);
  assertEquals(owned.invoked.length, 1);

  // An organization connection acts for no one in particular.
  const shared = deps(passing);
  assertEquals(
    (await invokeMcpTool(shared.deps, request())).actingForPrincipalId,
    null,
  );
});

Deno.test("the snapshot digest is the one a binding pins: shared, plain hex, and moved by every field it covers", async () => {
  const tool = (extra: Record<string, unknown> = {}) => ({
    name: "search",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...extra,
  });
  const built = await buildManifest([tool()], "2026-07-28");
  assert(/^[a-f0-9]{64}$/.test(built.digest));
  assertEquals(
    built.digest,
    await mcpManifestDigest({
      protocolVersion: "2026-07-28",
      tools: built.manifest.tools,
    }),
  );
  // The same digest as before for a tool with no output schema or annotations.
  assertEquals(
    built.digest,
    await mcpManifestDigest({ protocolVersion: "2026-07-28", tools: [tool()] }),
  );
  // And it moves with each thing a caller relies on.
  const changed = async (
    extra: Record<string, unknown>,
    version = "2026-07-28",
  ) => (await buildManifest([tool(extra)], version)).digest;
  assert(
    (await changed({ outputSchema: { type: "object" } })) !== built.digest,
  );
  assert(
    (await changed({ annotations: { readOnlyHint: true } })) !== built.digest,
  );
  assert((await changed({}, "2027-01-01")) !== built.digest);
  assert((await changed({ description: "other" })) !== built.digest);
});
