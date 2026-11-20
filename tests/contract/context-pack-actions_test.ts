import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  ContextPackImplementedAction,
  contextPackImplementedActions,
  implementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { ContextPackBuildSchema } from "../../apps/server/src/modules/knowledge/context-packs.ts";

// Issue #14, slice (b): one catalogued pack action. The catalogue is the single
// description of the transport surface, so the code that implements the action
// must agree with it exactly - a name in one and not the other is how a route
// ends up documented but unreachable, or reachable but undocumented.

const ACTION = "contextPacks.build";

Deno.test("the pack action is catalogued once, as a POST that reads artifact versions", () => {
  const matches = catalogActions.filter((entry) => entry.action === ACTION);
  assertEquals(matches.length, 1);
  const [entry] = matches;
  assertEquals(entry.method, "POST");
  assertEquals(entry.path, "/v1/context-packs");
  // A pack reads artifacts; it must not need a broader permission than the
  // read it performs, or building a pack would quietly widen what a caller can
  // reach.
  assertEquals(entry.permission, "artifactVersion:read");
  assertEquals(entry.input, "ContextPackBuild");
  assertEquals(entry.output, "ContextPack");
});

Deno.test("the pack action is declared implemented and its schemas exist", () => {
  assert(implementedActions.includes(ACTION));
  assertEquals(contextPackImplementedActions, [ACTION]);
  assertEquals(ContextPackImplementedAction.ContextPacksBuild, ACTION);
  assert(contractSchemas.ContextPackBuild !== undefined);
  assert(contractSchemas.ContextPack !== undefined);
});

Deno.test("the transport schema and the builder's own schema describe one shape", () => {
  const transport = contractSchemas.ContextPackBuild;
  const parsed = ContextPackBuildSchema.safeParse({
    envelope: {
      modelContextTokens: 200_000,
      counts: {},
      reserved: {
        output: 8_000,
        toolResults: 4_000,
        compaction: 4_000,
        safetyMargin: 2_000,
      },
    },
    candidates: [{ itemId: "one", kind: "text", text: "hello" }],
  });
  assertEquals(parsed.success, true);
  // The transport contract is what a client sees; the builder's schema is what
  // the server accepts. Both must accept the same document, or a documented
  // request would fail in the door.
  assertEquals(transport.safeParse(parsed.data).success, true);
});

Deno.test("the transport schema refuses a candidate the builder would refuse", () => {
  const transport = contractSchemas.ContextPackBuild;
  const withoutEnvelope = transport.safeParse({ candidates: [] });
  assertEquals(withoutEnvelope.success, false);
});
