/**
 * #31 unit lane: the pure label route resolver and its readiness outcome.
 */
import { assertEquals } from "@std/assert";
import {
  TICKET_CHECK_REASONS,
  TICKET_NON_SUSPENDING_REASONS,
  TICKET_ROUTE_BLOCK_REASONS,
} from "../../packages/contracts/src/ticket-admission.ts";
import {
  resolveTicketRoutes,
  type TicketRouteRule,
} from "../../apps/server/src/modules/work/ticket-routing.ts";

const SOURCE_REPO = "00000000-0000-4000-8000-000000000000";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function rule(
  labelId: string,
  repositoryId: string,
  role: string,
  extra: Partial<TicketRouteRule> = {},
): TicketRouteRule {
  return {
    id: `rule-${labelId}-${repositoryId.slice(-1)}`,
    labelId,
    labelName: labelId,
    alias: `${role}-alias`,
    repositoryId,
    role,
    presetId: "fixed-coding",
    version: 1,
    repositoryArchived: false,
    repositoryAccessible: true,
    ...extra,
  };
}

Deno.test("#31 unit: the union of matched rules, one target per repository, ordered by role", () => {
  const rules = [
    rule("frontend", B, "frontend"),
    rule("backend", A, "backend"),
    rule("api", A, "backend"),
    rule("docs", B, "frontend"),
  ];
  const route = resolveTicketRoutes(
    ["api", "backend", "frontend", "unrelated"],
    rules,
    SOURCE_REPO,
  );
  assertEquals(route, {
    kind: "routed",
    fallback: false,
    targets: [
      {
        repositoryId: A,
        role: "backend",
        ruleId: "rule-api-a",
        ruleVersion: 1,
        presetId: "fixed-coding",
        alias: "backend-alias",
      },
      {
        repositoryId: B,
        role: "frontend",
        ruleId: "rule-frontend-b",
        ruleVersion: 1,
        presetId: "fixed-coding",
        alias: "frontend-alias",
      },
    ],
  });
});

Deno.test("#31 unit: no rule, or no matching rule, falls back to the source repository", () => {
  const fallback = {
    repositoryId: SOURCE_REPO,
    role: "default",
    ruleId: null,
    ruleVersion: null,
    presetId: null,
    alias: null,
  };
  assertEquals(resolveTicketRoutes(["x"], [], SOURCE_REPO), {
    kind: "routed",
    targets: [fallback],
    fallback: false,
  });
  assertEquals(
    resolveTicketRoutes(["x"], [rule("backend", A, "backend")], SOURCE_REPO),
    { kind: "routed", targets: [fallback], fallback: true },
  );
  assertEquals(resolveTicketRoutes([], [], null), {
    kind: "routed",
    targets: [],
    fallback: false,
  });
});

Deno.test("#31 unit: deleted, inaccessible and ambiguous matches block with a named reason", () => {
  const labels = ["backend", "frontend"];
  assertEquals(
    resolveTicketRoutes(labels, [
      rule("backend", A, "backend"),
      rule("frontend", B, "frontend", { repositoryArchived: true }),
    ], SOURCE_REPO),
    {
      kind: "blocked",
      reason: "route_target_deleted",
      refs: ["label:frontend"],
    },
  );
  assertEquals(
    resolveTicketRoutes(labels, [
      rule("backend", A, "backend", { repositoryAccessible: false }),
      rule("frontend", B, "frontend"),
    ], SOURCE_REPO),
    {
      kind: "blocked",
      reason: "route_target_inaccessible",
      refs: ["label:backend"],
    },
  );
  assertEquals(
    resolveTicketRoutes(labels, [
      rule("backend", A, "backend"),
      rule("frontend", B, "backend"),
    ], SOURCE_REPO),
    { kind: "blocked", reason: "route_ambiguous", refs: ["role:backend"] },
  );
  assertEquals(
    resolveTicketRoutes(labels, [
      rule("backend", A, "backend"),
      rule("frontend", A, "frontend"),
    ], SOURCE_REPO),
    {
      kind: "blocked",
      reason: "route_ambiguous",
      refs: ["label:backend", "label:frontend"],
    },
  );
  // A blocked rule the ticket does not carry blocks nothing.
  assertEquals(
    resolveTicketRoutes(["backend"], [
      rule("backend", A, "backend"),
      rule("frontend", B, "frontend", { repositoryArchived: true }),
    ], SOURCE_REPO).kind,
    "routed",
  );
});

Deno.test("#31 unit: a read without label ids, or a target without a role binding, is never guessed", () => {
  const rules = [rule("backend", A, "backend")];
  assertEquals(resolveTicketRoutes(null, rules, SOURCE_REPO), {
    kind: "blocked",
    reason: "route_ambiguous",
    refs: ["labels:unidentified"],
  });
  assertEquals(resolveTicketRoutes(null, [], SOURCE_REPO).kind, "routed");
  assertEquals(
    resolveTicketRoutes(["backend"], [
      rule("backend", A, "backend", { alias: null }),
    ], SOURCE_REPO),
    {
      kind: "blocked",
      reason: "route_target_inaccessible",
      refs: ["label:backend"],
    },
  );
});

Deno.test("#31 unit: route reasons never suspend and belong to repository_ready", () => {
  for (const reason of TICKET_ROUTE_BLOCK_REASONS) {
    assertEquals(
      (TICKET_NON_SUSPENDING_REASONS as readonly string[]).includes(reason),
      true,
      reason,
    );
    assertEquals(
      TICKET_CHECK_REASONS.repository_ready.includes(reason),
      true,
      reason,
    );
  }
});
