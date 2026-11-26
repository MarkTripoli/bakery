import { expect, type Page, test } from "@playwright/test";
import { definition, libraryFixture, uuid } from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const WORKFLOW = definition(10, "Our review loop", { activeVersionId: null });
const EDIT = `/library/workflows/${WORKFLOW.id}/edit`;
const BRIEF = { id: "brief", uses: "task.brief" };
const BUILD = {
  id: "implement",
  uses: "harness.implement",
  needs: ["brief"],
};
const REPAIR = {
  id: "repair",
  needs: ["flow"],
  repeat: {
    max: 2,
    steps: [{ id: "repair_review", uses: "review.independent" }],
  },
};

async function editor(page: Page) {
  const seen = await libraryFixture(page, {
    workflows: [{ ...WORKFLOW }],
    versions: [{
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      status: "draft",
      steps: [{ id: "flow", steps: [BRIEF, BUILD] }, REPAIR],
    }],
  });
  await page.route(
    (url) => url.pathname.endsWith("/memberships"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      }),
  );
  await page.goto(EDIT);
  await expect(page.locator("[data-card='implement']")).toBeVisible();
  return () => {
    const saved = seen.draftSaves.at(-1)?.body.definition as {
      steps?: { steps?: { id: string }[] }[];
    } | undefined;
    return saved?.steps;
  };
}

const inside = (steps: ReturnType<Awaited<ReturnType<typeof editor>>>) =>
  steps?.[0]?.steps?.map((step) => step.id);

test.describe("workflow editor: steps inside a group", () => {
  test("a step is added, moved and removed inside the group, and the loop is left alone", async ({ page }) => {
    const saved = await editor(page);
    await expect(page.getByRole("button", { name: /Add a step after/ }))
      .toHaveCount(3);
    await page.locator("[data-connector='implement']")
      .getByRole("button").click();
    await page.getByTestId("step-picker")
      .locator("[data-pick-step='human.approval']").click();
    await expect.poll(() => inside(saved())).toEqual([
      "brief",
      "implement",
      "human_approval",
    ]);
    expect(saved()?.[1]).toEqual(REPAIR);
    await page.getByRole("button", { name: "Move up" }).click();
    await expect.poll(() => inside(saved())).toEqual([
      "brief",
      "human_approval",
      "implement",
    ]);
    await still(page, "grouped-added");
    await page.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => inside(saved())).toEqual(["brief", "implement"]);
    expect(saved()?.[1]).toEqual(REPAIR);
  });

  test("a step inside the loop block is read, not rewritten", async ({ page }) => {
    await editor(page);
    await page.locator("[data-card='repair_review']").click();
    await expect(page.getByRole("button", { name: "Move up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
