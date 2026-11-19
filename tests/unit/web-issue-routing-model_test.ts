import { assert, assertEquals } from "@std/assert";
import {
  isRulesDirty,
  isRulesSavable,
  MAX_RULES,
  problemsOf,
  refusalOf,
  type RepositoryFacts,
  rowsOf,
  type RuleRow,
  ruleSetOf,
} from "../../apps/web/src/pages/issues/routing-model.ts";

/**
 * #69 web, "Where the work goes": the list a person edits, what stops a Save,
 * and what is sent. Each design error sentence is one case here.
 */

const WEB = "0195f000-0000-7000-8000-000000000001";
const API = "0195f000-0000-7000-8000-000000000002";
const OLD = "0195f000-0000-7000-8000-000000000003";
const BARE = "0195f000-0000-7000-8000-000000000004";

const repositories = new Map<string, RepositoryFacts>([
  [WEB, { id: WEB, archived: false, role: "web" }],
  [API, { id: API, archived: false, role: "api" }],
  [OLD, { id: OLD, archived: true, role: "api" }],
  [BARE, { id: BARE, archived: false, role: null }],
]);

const row = (key: string, labelId: string, repositoryId: string): RuleRow => ({
  key,
  labelId,
  labelName: `label-${labelId}`,
  repositoryId,
});

Deno.test("saved rules become rows keyed by the rule", () => {
  const rows = rowsOf({
    ticketSourceId: WEB,
    policyRevision: 1,
    version: 2,
    rules: [{
      id: "r1",
      organizationId: "o",
      ticketSourceId: WEB,
      labelId: "10",
      labelName: "docs",
      repositoryId: API,
      role: "api",
      presetId: "fixed-coding",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  } as never);
  assertEquals(rows, [{
    key: "r1",
    labelId: "10",
    labelName: "docs",
    repositoryId: API,
  }]);
  assertEquals(rowsOf(undefined), []);
});

Deno.test("the same label to the same repository twice is a problem on the second row only", () => {
  const problems = problemsOf(
    [row("a", "10", API), row("b", "10", API), row("c", "10", WEB)],
    repositories,
  );
  assertEquals([...problems], [["b", "duplicate"]]);
});

Deno.test("an archived repository and one with no role are problems, an unchosen row is not", () => {
  const problems = problemsOf(
    [
      row("a", "10", OLD),
      row("b", "11", BARE),
      row("c", "", ""),
      row("d", "12", ""),
    ],
    repositories,
  );
  assertEquals([...problems], [["a", "archived"], ["b", "noRole"]]);
});

Deno.test("dirty means the pairs differ, whatever the order", () => {
  const saved = [row("a", "10", API), row("b", "11", WEB)];
  assertEquals(
    isRulesDirty([row("x", "11", WEB), row("y", "10", API)], saved),
    false,
  );
  assertEquals(isRulesDirty([row("x", "10", API)], saved), true);
  assertEquals(isRulesDirty([...saved, row("z", "", "")], saved), true);
  assertEquals(
    isRulesDirty([row("x", "10", API), row("y", "11", API)], saved),
    true,
  );
});

Deno.test("a list is savable only when complete, free of problems and within the limit", () => {
  assert(isRulesSavable([row("a", "10", API)], new Map()));
  assert(!isRulesSavable([row("a", "", API)], new Map()));
  assert(!isRulesSavable([row("a", "10", "")], new Map()));
  assert(!isRulesSavable([row("a", "10", API)], new Map([["a", "duplicate"]])));
  const many = Array.from(
    { length: MAX_RULES + 1 },
    (_, i) => row(String(i), String(i), API),
  );
  assert(!isRulesSavable(many, new Map()));
  assert(isRulesSavable(many.slice(0, MAX_RULES), new Map()));
});

Deno.test("the request carries the repository's own role and no row keys", () => {
  assertEquals(
    ruleSetOf([row("a", "10", API), row("b", "11", WEB)], repositories),
    {
      rules: [
        {
          labelId: "10",
          labelName: "label-10",
          repositoryId: API,
          role: "api",
        },
        {
          labelId: "11",
          labelName: "label-11",
          repositoryId: WEB,
          role: "web",
        },
      ],
    },
  );
});

Deno.test("a server refusal is read by its stable issue code", () => {
  assertEquals(refusalOf(["routing_rule_duplicate"]), "duplicate");
  assertEquals(
    refusalOf(["x", "routing_repository_unavailable"]),
    "unavailable",
  );
  assertEquals(refusalOf(["routing_role_unbound"]), "unbound");
  assertEquals(refusalOf(["something_else"]), null);
  assertEquals(refusalOf(undefined), null);
});
