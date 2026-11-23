import { assertEquals } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createToolCallStepRunner,
  toolCallEffectKey,
} from "../../apps/server/src/modules/tool-call/tool-call-step.ts";
import { composeEngineStepRunners } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import type { EngineStepRequest } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";

// #435 slice 1: the tool.call step runner over native integration connections.

const CONNECTION = "00000000-0000-4000-8000-0000000000c1";
const RESOURCE = "00000000-0000-4000-8000-0000000000e1";

function request(input: unknown, action = "tool.call"): EngineStepRequest {
  return {
    organizationId: "00000000-0000-4000-8000-0000000000a1",
    runId: "00000000-0000-4000-8000-0000000000b1",
    taskId: "00000000-0000-4000-8000-0000000000b2",
    repositoryId: null,
    requestedBy: "00000000-0000-4000-8000-0000000000d1",
    traceId: "trace-1",
    stepKey: "notify",
    iteration: 0,
    action,
    input,
  };
}

const validInput = {
  connectionId: CONNECTION,
  tool: "chat.post",
  toolVersion: 1,
  resourceId: RESOURCE,
  arguments: { text: "done" },
};

// A runner whose connection lookup is faked; the gate itself is exercised by the
// integration lane. These cases never reach it: each is refused before a send.
function runner(kind: "integration" | "mcp" | null) {
  return createToolCallStepRunner({
    database: {} as never,
    registry: { integrations: [] } as never,
    providerRequests: {} as never,
    snapshots: {
      load: () => Promise.reject(new StandardError({ code: "INTERNAL" })),
    } as never,
    connectionKind: () => Promise.resolve(kind),
  });
}

Deno.test("the runner owns tool.call and nothing else", async () => {
  const tool = runner("integration");
  assertEquals(tool.handles("tool.call"), true);
  assertEquals(tool.handles("delivery.deploy"), false);
  const result = await tool.run(request(validInput, "delivery.deploy"));
  assertEquals(result.kind, "failed");
});

Deno.test("a step input that is not the contract fails before any lookup", async () => {
  for (
    const input of [
      {},
      { ...validInput, connectionId: "nope" },
      { ...validInput, extra: true },
      { tool: "chat.post", arguments: {} },
    ]
  ) {
    assertEquals(await runner("integration").run(request(input)), {
      kind: "failed",
      code: "TOOL_CALL_INPUT_INVALID",
      message: "The step input does not match the tool call contract.",
    });
  }
});

Deno.test("a connection of another organization or none is not found", async () => {
  const result = await runner(null).run(request(validInput));
  assertEquals(
    result.kind === "failed" && result.code,
    "TOOL_CALL_CONNECTION_NOT_FOUND",
  );
});

Deno.test("an MCP connection is refused by name, never sent through the integration door", async () => {
  const result = await runner("mcp").run(request(validInput));
  assertEquals(
    result.kind === "failed" && result.code,
    "TOOL_CALL_MCP_UNAVAILABLE",
  );
});

Deno.test("an integration call without a pinned version and resource is refused", async () => {
  const { toolVersion: _version, ...noVersion } = validInput;
  const { resourceId: _resource, ...noResource } = validInput;
  for (const input of [noVersion, noResource]) {
    const result = await runner("integration").run(request(input));
    assertEquals(
      result.kind === "failed" && result.code,
      "TOOL_CALL_INPUT_INVALID",
    );
  }
});

Deno.test("an action the registry does not know is refused with its arguments untouched", async () => {
  // The registry holds no integrations, so the gate answers unknown action and
  // the step fails with a fixed code; nothing was sent.
  const result = await runner("integration").run(request(validInput));
  assertEquals(
    result.kind === "failed" && result.code,
    "TOOL_CALL_ARGUMENTS_REFUSED",
  );
});

Deno.test("the step key is the one effect key of the step", () => {
  const key = toolCallEffectKey(request(validInput));
  assertEquals(key, "00000000-0000-4000-8000-0000000000b1:notify:0");
  // A later iteration of the same step is a new send.
  assertEquals(
    toolCallEffectKey({ ...request(validInput), iteration: 1 }),
    "00000000-0000-4000-8000-0000000000b1:notify:1",
  );
});

Deno.test("composed runners hand each action to its owner", async () => {
  const seen: string[] = [];
  const own = (action: string) => ({
    handles: (candidate: string) => candidate === action,
    run: (step: EngineStepRequest) => {
      seen.push(`${action}:${step.action}`);
      return Promise.resolve({ kind: "pending" as const });
    },
  });
  const composed = composeEngineStepRunners([own("a"), own("b")]);
  assertEquals(composed.handles("a") && composed.handles("b"), true);
  assertEquals(composed.handles("c"), false);
  await composed.run(request({}, "b"));
  assertEquals(seen, ["b:b"]);
  const orphan = await composed.run(request({}, "c"));
  assertEquals(
    orphan.kind === "failed" && orphan.code,
    "ENGINE_STEP_UNAVAILABLE",
  );
});
