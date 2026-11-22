/**
 * #42 [B13.04] unit proofs: the predicates every skill reader shares. A personal
 * skill is visible to its owner alone, and authoring one is its owner's act;
 * these are the rules the integration, security and e2e files exercise through
 * the real app.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertMayAuthorSkill,
  SKILL_VISIBLE_TO,
} from "../../apps/server/src/modules/catalog/skill-scope-guard.ts";
import {
  LIBRARY_SOURCES,
  visibleToCaller,
} from "../../apps/server/src/modules/knowledge/file-search.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-0000000000aa";
const other = "00000000-0000-4000-8000-0000000000bb";

/** A transaction that answers the membership read with one role. */
function membership(role: string | null, status = "active") {
  const queries: unknown[][] = [];
  return {
    queries,
    transaction: {
      query: (sql: string, values: unknown[]) => {
        queries.push([sql, values]);
        return Promise.resolve({ rows: [{ role, status }] });
      },
    } as never,
  };
}

Deno.test("the shared skill read predicate passes shared scopes and only the caller's own personal skills", () => {
  assertEquals(
    SKILL_VISIBLE_TO("$3"),
    "(scope <> 'personal' or owner_principal_id = $3::uuid)",
  );
  // The parameter is placed as given, so each query binds its own position.
  assert(SKILL_VISIBLE_TO("$8").endsWith("= $8::uuid)"));
});

Deno.test("the library mirror and its search hide personal skills from everyone but their owner", () => {
  const skills = LIBRARY_SOURCES.find((source) => source.kind === "skill");
  assert(skills !== undefined);
  assertEquals(
    visibleToCaller(skills, () => "$2::uuid"),
    " and (x.scope <> 'personal' or x.owner_principal_id = $2::uuid)",
  );
  // Every other section has no owner, so it adds no condition.
  for (
    const source of LIBRARY_SOURCES.filter((item) => item.kind !== "skill")
  ) {
    assertEquals(visibleToCaller(source, () => "$2::uuid"), "");
  }
});

Deno.test("another member, even an Admin, cannot author a personal skill and learns nothing", async () => {
  const admin = membership("admin");
  const error = await assertRejects(() =>
    assertMayAuthorSkill(admin.transaction, organizationId, other, {
      scope: "personal",
      ownerPrincipalId: owner,
    })
  ) as { code?: string };
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
  // The refusal is decided before any role is read.
  assertEquals(admin.queries.length, 0);
  await assertMayAuthorSkill(admin.transaction, organizationId, owner, {
    scope: "personal",
    ownerPrincipalId: owner,
  });
});

Deno.test("a Bakery skill is read-only with a reason the page can name, and an organization skill needs an Admin", async () => {
  const admin = membership("admin");
  const global = await assertRejects(() =>
    assertMayAuthorSkill(admin.transaction, organizationId, owner, {
      scope: "global",
      ownerPrincipalId: null,
    })
  ) as { code?: string; params?: Record<string, unknown> };
  assertEquals(global.code, "AUTH_FORBIDDEN");
  assertEquals(global.params?.reason, "global_skill_is_read_only");

  const organization = {
    scope: "organization",
    ownerPrincipalId: null,
  } as const;
  await assertMayAuthorSkill(
    admin.transaction,
    organizationId,
    owner,
    organization,
  );
  for (
    const [role, status] of [["developer", "active"], ["admin", "removed"]]
  ) {
    const refused = await assertRejects(() =>
      assertMayAuthorSkill(
        membership(role, status).transaction,
        organizationId,
        owner,
        organization,
      )
    ) as { code?: string };
    assertEquals(refused.code, "AUTH_FORBIDDEN");
  }
});
