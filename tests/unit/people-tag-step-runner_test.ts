import { assertEquals } from "@std/assert";
import {
  createPeopleTagStepRunner,
  PEOPLE_TAG_PACING,
} from "../../apps/server/src/modules/work/people-tag-step.ts";
import { composeEngineStepRunners } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import type {
  EngineStepRequest,
  EngineStepRunner,
} from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const unreachable = {} as PgDatabase;

const request = (input: Record<string, unknown>): EngineStepRequest => ({
  organizationId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  repositoryId: null,
  requestedBy: crypto.randomUUID(),
  traceId: "trace",
  stepKey: "notify",
  iteration: 0,
  action: "people.tag",
  input,
});

Deno.test("a tag step input is refused before anything is read", async () => {
  const runner = createPeopleTagStepRunner({ database: unreachable });
  const person = crypto.randomUUID();
  for (
    const input of [
      { intent: "fyi" },
      { intent: "fyi", recipientId: person, recipientRunRole: "starter" },
      { intent: "fyi", recipientId: person, wait: true },
      { intent: "approve", recipientId: person },
      { intent: "fyi", recipientRunRole: "seat_owner" },
    ]
  ) {
    const result = await runner.run(request(input));
    assertEquals(
      result.kind === "failed" ? result.code : result.kind,
      "TAG_INPUT_INVALID",
      JSON.stringify(input),
    );
  }
});

Deno.test("a tag step waits up to a day past its request's seven days plus the longest wait before asking next, looked at each minute", () => {
  const runner = createPeopleTagStepRunner({ database: unreachable });
  assertEquals(runner.handles("people.tag"), true);
  assertEquals(runner.handles("coordination.split"), false);
  assertEquals(PEOPLE_TAG_PACING, {
    retryMs: 60_000,
    waitLimitMs: 8 * 86_400_000 + 72 * 3_600_000,
  });
  const other: EngineStepRunner = {
    handles: (action) => action === "tool.call",
    run: () => Promise.resolve({ kind: "pending" }),
  };
  const composed = composeEngineStepRunners([other, runner]);
  assertEquals(composed.pacing?.("people.tag"), PEOPLE_TAG_PACING);
  assertEquals(composed.pacing?.("tool.call"), undefined);
  assertEquals(composed.pacing?.("delivery.deploy"), undefined);
});
