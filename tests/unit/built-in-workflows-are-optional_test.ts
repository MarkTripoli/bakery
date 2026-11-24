import { assert, assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { WORKFLOW_PRESETS } from "../../packages/contracts/src/workflow-presets.ts";
import {
  createWorkflowPresetHandlers,
  presetOutput,
} from "../../apps/server/src/modules/work/workflow-presets.ts";

const CHOICE_WORDS = [
  "default",
  "required",
  "preselect",
  "selected",
  "recommend",
];
const BUDGET_KEY = "defaultBudgetLimitUsd";

const choiceKeys = (value: object) =>
  Object.keys(value).filter((key) =>
    key !== BUDGET_KEY &&
    CHOICE_WORDS.some((word) => key.toLowerCase().includes(word))
  );

Deno.test("no built-in workflow is marked default, required, selected or recommended: a person picks one or none", () => {
  assert(WORKFLOW_PRESETS.length > 0);
  for (const preset of WORKFLOW_PRESETS) {
    assertEquals(choiceKeys(preset), [], preset.id);
    assertEquals(choiceKeys(presetOutput(preset, [], null)), [], preset.id);
    assertEquals(choiceKeys(preset.spec), [], preset.id);
  }
});

Deno.test("the list answers an empty page when every built-in is removed", async () => {
  const handlers = createWorkflowPresetHandlers({ presets: [] });
  const context = {
    transaction: {},
    authority: { organizationId: "org", subject: { principalId: "person" } },
  } as unknown as ActionContext;
  assertEquals(await handlers.workflowPresetsList(context, {}), {
    items: [],
    nextCursor: null,
  });
});

Deno.test("the check catches a marker field when one is added, and ignores the budget key", () => {
  assertEquals(
    choiceKeys({
      id: "x",
      isDefault: true,
      preselected: true,
      requiredForAll: true,
      defaultBudgetLimitUsd: "1",
    }),
    ["isDefault", "preselected", "requiredForAll"],
  );
});
