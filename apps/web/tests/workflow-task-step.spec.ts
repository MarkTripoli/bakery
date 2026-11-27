import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import {
  lastCard,
  savedInput,
  type Step,
  stepEditor,
} from "./helpers/step-editor.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const TASK = "agent.freeform";
const WRITTEN = {
  prompt: "Summarise the open questions.",
  maxTurns: 20,
  timeout: "PT30M",
  maxCostUsd: 5,
  allowedTools: ["Read", "Glob", "Grep"],
};
const task = (input: Record<string, unknown>): Step => ({
  id: "ask_agent",
  uses: TASK,
  with: { ...WRITTEN, ...input },
});

test.describe("workflow editor: Custom agent task", () => {
  test("a new task asks for instructions and saves them with safe limits", async ({ page }) => {
    const server = await stepEditor(page);
    await page.getByRole("button", { name: /Add a step after/ }).last().click();
    const picker = page.getByTestId("step-picker");
    await expect(picker.locator(`[data-pick-step='${TASK}']`))
      .toContainText("An agent follows instructions written for this step.");
    await picker.locator(`[data-pick-step='${TASK}']`).click();
    await expect(
      page.getByText(
        "Write the instructions. The workflow cannot be published without them.",
      ).first(),
    ).toBeVisible();
    await expect(lastCard(page)).toContainText("Needs setup");
    await page.getByRole("textbox", { name: "Instructions" })
      .pressSequentially(WRITTEN.prompt);
    await expect(lastCard(page)).not.toContainText("Needs setup");
    await expect.poll(() => savedInput(server.saves.at(-1), TASK)).toEqual(
      WRITTEN,
    );
    await expect(page.getByRole("textbox", { name: "Turn limit" }))
      .toBeHidden();
    await still(page, "task-new");
  });

  test("limits and tools under Advanced are saved as shown, and a limit out of range is named", async ({ page }) => {
    const server = await stepEditor(page, { steps: [task({})] });
    await page.locator("[data-card='ask_agent']").click();
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByRole("combobox", { name: "Time limit" }).selectOption("60");
    const cost = page.getByRole("textbox", {
      name: "Spend limit (US dollars)",
    });
    await cost.fill("");
    await cost.pressSequentially("2.5x0");
    await expect(cost).toHaveValue("2.50");
    const turns = page.getByRole("textbox", { name: "Turn limit" });
    await turns.fill("200");
    await expect(page.getByText("Enter a whole number from 1 to 50.").first())
      .toBeVisible();
    await expect.poll(() => savedInput(server.saves.at(-1), TASK))
      .toMatchObject(
        { maxTurns: 200 },
      );
    await turns.fill("8");
    await page.getByRole("checkbox", { name: "Search inside files" }).uncheck();
    await expect.poll(() => savedInput(server.saves.at(-1), TASK)).toEqual({
      ...WRITTEN,
      timeout: "PT1H",
      maxCostUsd: 2.5,
      maxTurns: 8,
      allowedTools: ["Read", "Glob"],
    });
    await still(page, "task-advanced");
  });

  test("Show me opens Advanced on the field that needs fixing", async ({ page }) => {
    await stepEditor(page, { steps: [task({ maxCostUsd: 500 })] });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Show me" }).first().click();
    await expect(
      page.getByRole("textbox", { name: "Spend limit (US dollars)" }),
    ).toBeFocused();
  });

  test("a task written in a way the panel cannot show stays in code", async ({ page }) => {
    await stepEditor(page, { steps: [task({ allowedTools: ["Bash"] })] });
    await page.locator("[data-card='ask_agent']").click();
    await expect(page.getByTestId("task-fields")).toHaveCount(0);
    await expect(page.getByText("written in code").first()).toBeVisible();
  });
});
