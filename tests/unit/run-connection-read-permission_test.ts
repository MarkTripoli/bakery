import { assertEquals, assertThrows } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { authorizeConnectionReads } from "../../apps/server/src/modules/work/run-command.ts";

function contextOf(
  authority: Record<string, unknown> | undefined,
): ActionContext {
  return { authority } as unknown as ActionContext;
}

function actor(
  role: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organizationId: crypto.randomUUID(),
    subject: { principalId: crypto.randomUUID(), principalType: "human" },
    role,
    capabilities: [],
    ...extra,
  };
}

function refusal(context: ActionContext): string {
  const error = assertThrows(() => authorizeConnectionReads(context));
  if (!(error instanceof StandardError)) throw error;
  return error.code;
}

Deno.test("a run reads a connection only for a caller who may read connections", () => {
  authorizeConnectionReads(contextOf(actor("developer")));
  assertEquals(
    refusal(contextOf(actor("developer", { tokenScopes: ["run:write"] }))),
    "INSUFFICIENT_SCOPE",
  );
  assertEquals(
    refusal(contextOf(actor("guest", {
      customRole: { id: crypto.randomUUID(), permissions: ["run:write"] },
    }))) !== "",
    true,
  );
  assertEquals(refusal(contextOf(undefined)), "AUTH_FORBIDDEN");
});
