import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { DEFINITION_PUBLISH_REQUIRES_GRANT } from "../../apps/server/src/modules/auth/application/definition-publish-grants.ts";
import { publishSkillDraft } from "../../apps/server/src/modules/catalog/routes.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

// Issue #74 slice B: publishing a skill's draft is publishing a version, so an
// agent needs the publish grant (O52, #421) and a person does not. The routes
// that serve it take a session, not an access token, so the agent's context is
// built here and the handler is driven directly. Each case stops at the missing
// publication proof: a refusal before it means the grant was checked first, and
// reaching it means the grant let the agent through.

type Query = { sql: string; values: readonly unknown[] };

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002";
const SKILL_ID = "00000000-0000-4000-8000-000000000003";
const TOKEN_ID = "00000000-0000-4000-8000-000000000004";

function context(grantRows: number, actor: "agent" | "person") {
  const queries: Query[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      return Promise.resolve({
        rows: Array.from({ length: grantRows }, () => ({ "?column?": 1 })),
        rowCount: grantRows,
      });
    },
  } as unknown as PgTransactionClient;
  return {
    queries,
    context: {
      transaction,
      authority: {
        organizationId: ORGANIZATION_ID,
        subject: { principalId: PRINCIPAL_ID },
      },
      principal: { principalType: actor === "agent" ? "service" : "human" },
      accessToken: actor === "agent" ? { id: TOKEN_ID } : undefined,
      params: { id: SKILL_ID },
    } as never,
  };
}

Deno.test("an agent without a grant cannot publish a skill's draft", async () => {
  const { context: ctx, queries } = context(0, "agent");
  const error: StandardError = await assertRejects(
    () => publishSkillDraft(ctx),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
  assertEquals(
    (error.params as { reason?: string }).reason,
    DEFINITION_PUBLISH_REQUIRES_GRANT,
  );
  assertEquals(queries.length, 1);
  assertEquals(queries[0].values, [
    ORGANIZATION_ID,
    "skill",
    SKILL_ID,
    TOKEN_ID,
  ]);
});

Deno.test("an agent with a grant on the skill gets past the check", async () => {
  const { context: ctx, queries } = context(1, "agent");
  await assertRejects(
    () => publishSkillDraft(ctx),
    Error,
    "SKILL_DRAFT_PUBLISH_PROOF_MISSING",
  );
  assertEquals(queries.length, 1);
  assertEquals(queries[0].values, [
    ORGANIZATION_ID,
    "skill",
    SKILL_ID,
    TOKEN_ID,
  ]);
});

Deno.test("a person publishes a skill's draft without any grant lookup", async () => {
  const { context: ctx, queries } = context(0, "person");
  await assertRejects(
    () => publishSkillDraft(ctx),
    Error,
    "SKILL_DRAFT_PUBLISH_PROOF_MISSING",
  );
  assertEquals(queries.length, 0);
});
