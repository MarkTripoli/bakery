/**
 * #448 slice S5: an agent session never reverts a step's writes, its own or
 * another step's. The refusal comes before any read or write, so nothing is
 * reverted.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { revertRunStepWrites } from "../../apps/server/src/modules/execution/step-write-revert.ts";

Deno.test("an agent session calling runSteps.revertWrites is AUTH_FORBIDDEN and nothing is reverted", async () => {
  const queries: string[] = [];
  const context = {
    params: { id: crypto.randomUUID(), stepKey: "worker" },
    agentSession: { id: crypto.randomUUID() },
    transaction: {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    },
  } as unknown as ActionContext;
  const error = await assertRejects(
    () => revertRunStepWrites(context, {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(queries, []);
});
