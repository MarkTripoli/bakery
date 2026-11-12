import { assertEquals } from "@std/assert";
import { checkerAvailability } from "../../apps/server/src/modules/repository-rules/effective.ts";

const bound = (
  ruleKey: string,
  checkBinding: string | null,
  mode = "require",
  enabled = true,
) => ({ ruleKey, enabled, mode, options: { checkBinding } });

Deno.test("checkers are configured when every bound warn/require rule names an active command", () => {
  assertEquals(
    checkerAvailability(
      [
        bound("code.noMagicValues", "lint"),
        bound("code.noTodo", "lint", "warn"),
      ],
      new Set(["lint", "test"]),
    ),
    { state: "configured", unavailableRuleKeys: [] },
  );
});

Deno.test("a missing or unbound checker is unavailable, never a pass", () => {
  assertEquals(
    checkerAvailability(
      [
        bound("code.noMagicValues", "lint"),
        bound("code.noTodo", null, "warn"),
        bound("code.other", "gone"),
      ],
      new Set(["lint"]),
    ),
    {
      state: "unavailable",
      unavailableRuleKeys: ["code.noTodo", "code.other"],
    },
  );
});

Deno.test("guide, disabled and unbindable rules need no checker", () => {
  assertEquals(
    checkerAvailability(
      [
        bound("code.noMagicValues", "lint", "guide"),
        bound("code.noTodo", "missing", "require", false),
        {
          ruleKey: "commits.semantic",
          enabled: true,
          mode: "require",
          options: {},
        },
      ],
      new Set(),
    ),
    { state: "not_required", unavailableRuleKeys: [] },
  );
});
