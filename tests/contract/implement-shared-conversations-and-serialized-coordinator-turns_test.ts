import { assert, assertEquals } from "@std/assert";
import type { ZodType } from "zod";
import {
  ConversationImplementedAction,
  conversationImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  CoordinatorEffectSchema,
  CoordinatorFailureSchema,
  CoordinatorNoopEffectSchema,
  CoordinatorPlanRevisionEffectSchema,
  CoordinatorQuestionEffectSchema,
  CoordinatorReplyEffectSchema,
  CoordinatorScriptSchema,
  createUnavailableCoordinatorExecutor,
} from "../../apps/server/src/modules/conversation/coordinator.ts";

const catalog = JSON.parse(
  await Deno.readTextFile("docs/technical-design/api-catalog.json"),
) as { actions: Array<Record<string, unknown>> };

Deno.test("every implemented conversation action is a catalog action with permission and organization context", () => {
  assertEquals(conversationImplementedActions.length, 13);
  for (const name of Object.values(ConversationImplementedAction)) {
    const entry = catalog.actions.find((action) => action.action === name);
    assert(entry, `${name} missing from the catalog`);
    assert(typeof entry.permission === "string", `${name} has no permission`);
    assertEquals(entry.organizationContext, "required_authenticated_context");
  }
});

Deno.test("coordinator effect schemas carry meaningful descriptions", () => {
  const schemas: ZodType[] = [
    CoordinatorEffectSchema,
    CoordinatorReplyEffectSchema,
    CoordinatorQuestionEffectSchema,
    CoordinatorPlanRevisionEffectSchema,
    CoordinatorNoopEffectSchema,
    CoordinatorFailureSchema,
    CoordinatorScriptSchema,
  ];
  for (const schema of schemas) {
    assert((schema.description ?? "").trim().length >= 10);
  }
  assert(
    CoordinatorReplyEffectSchema.safeParse({ type: "reply", body: "hi" })
      .success,
  );
  assert(
    !CoordinatorReplyEffectSchema.safeParse({ type: "reply", body: "" })
      .success,
  );
  assert(!CoordinatorEffectSchema.safeParse({ type: "decide" }).success);
});

Deno.test("conversation turn contract exposes the closed lifecycle", async () => {
  const schemas = JSON.parse(
    await Deno.readTextFile("docs/technical-design/transport-schemas.json"),
  ) as { outputs: { ConversationTurn: { fieldTypes: { status: string } } } };
  assertEquals(
    schemas.outputs.ConversationTurn.fieldTypes.status,
    "enum(queued|active|cancel_requested|completed|failed|canceled)",
  );
});

Deno.test("the production executor never fabricates output", async () => {
  const result = await createUnavailableCoordinatorExecutor().execute(
    {} as never,
    new AbortController().signal,
  );
  assertEquals(result.status, "failed");
  assert(
    result.status === "failed" && result.code === "coordinator_unavailable",
  );
});
