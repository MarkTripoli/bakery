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

type Setup = {
  readonly steps?: readonly Record<string, unknown>[];
  readonly refusedAt?: string;
};

async function editor(page: Page, setup: Setup = {}) {
  const seen = await libraryFixture(page, {
    workflows: [{ ...WORKFLOW }],
    versions: [{
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      status: "draft",
      steps: [
        ...(setup.steps ?? [
          { id: "flow", steps: [BRIEF, BUILD] },
          REPAIR,
        ]),
      ],
    }],
  });
  if (setup.refusedAt !== undefined) {
    await page.route(
      (url) => url.pathname === "/v1/workflow-validations",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            valid: false,
            errors: [{
              path: setup.refusedAt,
              code: "input_field_missing",
              message: "A required input is missing.",
            }],
            warnings: [],
            normalizedDigest: null,
          }),
        }),
    );
  }
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

  test("only a step this page can finish is offered", async ({ page }) => {
    await editor(page);
    await page.locator("[data-connector='implement']")
      .getByRole("button").click();
    const picker = page.getByTestId("step-picker");
    await expect(picker.locator("[data-pick-step]")).toHaveCount(2);
    await expect(picker.locator("[data-pick-step='people.tag']"))
      .toBeVisible();
    await expect(picker).toContainText(
      "Other step types need settings this page cannot fill in yet.",
    );
    await still(page, "grouped-picker");
  });

  test("a step can be added before the first step of a later group", async ({ page }) => {
    const saved = await editor(page, {
      steps: [
        BRIEF,
        {
          id: "gate",
          branch: {
            when: "$input.gates == 'plan'",
            then: [{ id: "approve", uses: "human.approval" }],
            else: [],
          },
        },
        {
          id: "build",
          steps: [{ id: "implement", uses: "harness.implement" }],
        },
      ],
    });
    await page.getByRole("button", { name: "Add a step before Implement" })
      .click();
    await page.getByTestId("step-picker")
      .locator("[data-pick-step='human.approval']").click();
    await expect.poll(() => saved()?.[2]?.steps?.map((step) => step.id))
      .toEqual(["human_approval", "implement"]);
  });

  test("a problem inside a group is shown on its own step and stops publishing", async ({ page }) => {
    await editor(page, { refusedAt: "/steps/0/steps/1/with" });
    await expect(page.getByTestId("editor-problems")).toHaveText("1 problem");
    await expect(page.locator("[data-card='implement']"))
      .toContainText("Needs setup");
    await expect(page.locator("[data-card='brief']"))
      .not.toContainText("Needs setup");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Publish/ })).toHaveCount(
      0,
    );
    await still(page, "grouped-refused");
  });

  test("a step inside the loop block is read, not rewritten", async ({ page }) => {
    await editor(page);
    await page.locator("[data-card='repair_review']").click();
    await expect(page.getByRole("button", { name: "Move up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
