import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import {
  assertMayPublishDefinition,
  DEFINITION_KINDS,
  DEFINITION_PUBLISH_REQUIRES_GRANT,
  DEFINITION_PUBLISH_SURFACE,
} from "../../apps/server/src/modules/auth/application/definition-publish-grants.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

// Issue #421 section 1: one publish guard over every definition kind. The
// table below is the parity check: a kind added to DefinitionKind must name
// its publish operations, and each one is checked with the same guard.

type Query = { sql: string; values: readonly unknown[] };

function stubTransaction(grantRows: number) {
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
  return { transaction, queries };
}

const person = {
  principal: { principalType: "human" },
  accessToken: undefined,
};
const agent = {
  principal: { principalType: "service" },
  accessToken: { id: "11111111-1111-4111-8111-111111111111" },
};

Deno.test("every definition kind names catalog publish operations, and only workflows have drafts", () => {
  assertEquals(
    [...DEFINITION_KINDS].sort(),
    ["agent", "artifactKind", "skill", "workflow"],
  );
  const known = new Set(
    catalogActions.map((entry: { action: string }) => entry.action),
  );
  for (const kind of DEFINITION_KINDS) {
    const surface = DEFINITION_PUBLISH_SURFACE[kind];
    assertEquals(surface.operations.length > 0, true, kind);
    for (const operation of surface.operations) {
      assertEquals(known.has(operation), true, `${kind}: ${operation}`);
    }
    assertEquals(surface.drafts, kind === "workflow", kind);
  }
});

for (const kind of DEFINITION_KINDS) {
  Deno.test(`${kind}: a person publishes without a grant lookup`, async () => {
    const { transaction, queries } = stubTransaction(0);
    const attribution = await assertMayPublishDefinition(
      transaction,
      person as never,
      { organizationId: "org", principalId: "p", kind, definitionRef: "d" },
    );
    assertEquals(attribution.actorKind, "person");
    assertEquals(queries.length, 0);
  });

  Deno.test(`${kind}: an agent without a grant is refused`, async () => {
    const { transaction, queries } = stubTransaction(0);
    const error: StandardError = await assertRejects(
      () =>
        assertMayPublishDefinition(transaction, agent as never, {
          organizationId: "org",
          principalId: "p",
          kind,
          definitionRef: "d",
        }),
      StandardError,
    );
    assertEquals(error.code, "AUTH_FORBIDDEN");
    assertEquals(
      (error.params as { reason?: string }).reason,
      DEFINITION_PUBLISH_REQUIRES_GRANT,
    );
    assertEquals(queries.length, 1);
    assertEquals(queries[0].values, ["org", kind, "d", agent.accessToken.id]);
  });

  Deno.test(`${kind}: an agent with a grant publishes as an agent`, async () => {
    const { transaction } = stubTransaction(1);
    const attribution = await assertMayPublishDefinition(
      transaction,
      agent as never,
      { organizationId: "org", principalId: "p", kind, definitionRef: "d" },
    );
    assertEquals(attribution.actorKind, "agent");
    assertEquals(attribution.accessTokenId, agent.accessToken.id);
  });
}
