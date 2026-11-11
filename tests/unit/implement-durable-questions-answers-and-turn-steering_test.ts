import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  adapterSupportsControl,
  adapterSupportsSteering,
  readAdapterCapabilities,
} from "../../apps/server/src/modules/execution/adapter-capabilities.ts";
import { evaluateRunControlCapabilities } from "../../apps/server/src/modules/execution/control.ts";
import {
  CoordinatorEffectSchema,
  createScriptedCoordinatorExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";
import { parseAdapterCapabilities } from "../../apps/worker/src/config.ts";

const attempt = {
  attemptStatus: "running",
  jobStatus: "running",
  fence: "3",
  currentFence: "3",
  workerSessionId: "session",
  hostSessionId: "session",
  leaseLive: true,
  sessionCurrent: true,
};

Deno.test("cancel is allowed with no advertised capabilities", () => {
  assertEquals(adapterSupportsControl("cancel", []), true);
  for (const action of ["pause", "resume", "interrupt"] as const) {
    assertEquals(adapterSupportsControl(action, []), false);
  }
});

Deno.test("pause and interrupt need steer or interrupt, resume needs follow_up or resume", () => {
  assertEquals(adapterSupportsControl("pause", ["steer"]), true);
  assertEquals(adapterSupportsControl("interrupt", ["interrupt"]), true);
  assertEquals(adapterSupportsControl("pause", ["follow_up"]), false);
  assertEquals(adapterSupportsControl("resume", ["follow_up"]), true);
  assertEquals(adapterSupportsControl("resume", ["resume"]), true);
  assertEquals(adapterSupportsControl("resume", ["steer", "stream"]), false);
});

Deno.test("steering modes map to the matching advertised capability", () => {
  assertEquals(adapterSupportsSteering("steer", ["steer"]), true);
  assertEquals(adapterSupportsSteering("follow_up", ["steer"]), false);
  assertEquals(adapterSupportsSteering("follow_up", ["follow_up"]), true);
});

Deno.test("stored adapter capabilities normalize defensively", () => {
  assertEquals(readAdapterCapabilities(null), []);
  assertEquals(readAdapterCapabilities({ steer: true }), []);
  assertEquals(readAdapterCapabilities(["steer", 7, "stream"]), [
    "steer",
    "stream",
  ]);
});

Deno.test("capability snapshot reports unsupported instead of allowed without the adapter", () => {
  const unsupported = evaluateRunControlCapabilities("run", "running", {
    ...attempt,
    adapterCapabilities: [],
  });
  assertEquals(
    unsupported.actions.map((a) => [a.action, a.canRequest, a.reason]),
    [
      ["pause", false, "unsupported"],
      ["resume", false, "unsupported"],
      ["cancel", true, "allowed"],
      ["interrupt", false, "unsupported"],
    ],
  );
  const steer = evaluateRunControlCapabilities("run", "running", {
    ...attempt,
    adapterCapabilities: ["steer"],
  });
  assertEquals(
    steer.actions.map((a) => [a.action, a.reason]),
    [
      ["pause", "allowed"],
      ["resume", "unsupported"],
      ["cancel", "allowed"],
      ["interrupt", "allowed"],
    ],
  );
  // Missing authority still reads as authority_unavailable, not unsupported.
  const fenced = evaluateRunControlCapabilities("run", "running", {
    ...attempt,
    leaseLive: false,
    adapterCapabilities: ["steer"],
  });
  assertEquals(fenced.actions[0].reason, "authority_unavailable");
});

Deno.test("worker adapter capabilities default empty and reject unknown names", () => {
  assertEquals(parseAdapterCapabilities(undefined), []);
  assertEquals(parseAdapterCapabilities("  "), []);
  assertEquals(parseAdapterCapabilities("steer, follow_up,steer"), [
    "steer",
    "follow_up",
  ]);
  assertThrows(
    () => parseAdapterCapabilities("steer,teleport"),
    Error,
    "BAKERY_WORKER_ADAPTER_CAPABILITIES_INVALID",
  );
});

Deno.test("question effect accepts options, audience and expiry and rejects unknown fields", () => {
  const parsed = CoordinatorEffectSchema.safeParse({
    type: "question",
    prompt: "Ship it?",
    options: [{ id: "yes", label: "Yes" }],
    allowFreeText: true,
    audience: { type: "principals", principalIds: [crypto.randomUUID()] },
    expiresInSeconds: 3600,
  });
  assertEquals(parsed.success, true);
  assertEquals(
    CoordinatorEffectSchema.safeParse({
      type: "question",
      prompt: "x",
      audience: { type: "principals", principalIds: [] },
    }).success,
    false,
  );
  assertEquals(
    CoordinatorEffectSchema.safeParse({
      type: "question",
      prompt: "x",
      surprise: 1,
    }).success,
    false,
  );
});

Deno.test("scripted coordinator returns question effects from a script file", async () => {
  const directory = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR") ?? undefined,
  });
  try {
    await Deno.writeTextFile(
      `${directory}/default.json`,
      JSON.stringify({
        effects: [{
          type: "question",
          prompt: "Which branch?",
          options: [{ id: "main", label: "main" }],
        }],
      }),
    );
    const result = await createScriptedCoordinatorExecutor(directory).execute(
      { turnId: "t", triggerMessageId: "m", conversationId: "c" } as never,
      new AbortController().signal,
    );
    assert(result.status === "completed");
    assertEquals(result.effects[0].type, "question");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
