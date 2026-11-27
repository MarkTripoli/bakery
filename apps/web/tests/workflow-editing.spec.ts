import { expect, type Page, test } from "@playwright/test";
import { definition, libraryFixture, uuid } from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const WORKFLOW = definition(10, "Release train", { activeVersionId: null });
const EDIT = `/library/workflows/${WORKFLOW.id}/edit`;
const STEPS = [
  { id: "research", uses: "rpi.research" },
  { id: "implement", uses: "harness.implement" },
  { id: "review", uses: "review.independent" },
];

async function editor(
  page: Page,
  steps: readonly { id: string; uses: string }[] = STEPS,
) {
  const seen = await libraryFixture(page, {
    workflows: [{ ...WORKFLOW }],
    versions: [{
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      status: "draft",
      steps: [...steps],
    }],
  });
  await page.goto(EDIT);
  await expect(page.locator(`[data-card='${steps[0]!.id}']`)).toBeVisible();
  const saved = () => {
    const sent = seen.draftSaves.at(-1)?.body as {
      definition?: { steps?: { id: string }[] };
    } | undefined;
    return sent?.definition?.steps?.map((step) => step.id);
  };
  return { seen, saved };
}

const block = (page: Page, id: string) =>
  page.locator(`[data-card='${id}']`).getByRole("button").first();
const status = (page: Page) =>
  page.getByRole("status").filter({
    hasText: /^(Saved|Saving…|Not saved)$/,
  });

test("Alt with an arrow moves a block, Delete removes it, and undo and redo follow", async ({ page }) => {
  const { saved } = await editor(page);
  await block(page, "implement").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(saved).toEqual(["implement", "research", "review"]);
  await expect(block(page, "implement")).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(saved).toEqual(["research", "implement", "review"]);
  await expect(block(page, "implement")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(page.getByText("Implement deleted")).toBeVisible();
  await expect(block(page, "review")).toBeFocused();
  const toast = (await page.locator('[data-ui-component="toast"]')
    .boundingBox())!;
  expect(toast.y).toBeGreaterThanOrEqual(0);
  expect(toast.y + toast.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await expect.poll(saved).toEqual(["research", "review"]);
  await page.keyboard.press("Control+z");
  await expect.poll(saved).toEqual(["research", "implement", "review"]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(saved).toEqual(["research", "review"]);
});

test("on a phone a floating message never hides the last step's +", async ({ page }) => {
  test.skip(page.viewportSize()!.width > 743, "the phone list is what scrolls");
  await editor(
    page,
    Array.from({ length: 8 }, (_, index) => ({
      id: `research_${index}`,
      uses: "rpi.research",
    })),
  );
  await block(page, "research_0").focus();
  await page.keyboard.press("Delete");
  const message = page.locator('[data-ui-component="toast"]');
  await expect(message).toBeVisible();
  const lastAdd = page.locator("[data-connector]").last();
  await expect.poll(async () => {
    await page.mouse.wheel(0, 4000);
    const add = (await lastAdd.boundingBox())!;
    const shown = (await message.boundingBox())!;
    return add.y + add.height <= shown.y;
  }).toBe(true);
  await still(page, "editor-toast-room");
});

test("the keys leave a step written in code alone", async ({ page }) => {
  const { seen } = await editor(page, [
    { id: "research", uses: "rpi.research" },
    { id: "brief", uses: "task.brief" },
    { id: "implement", uses: "harness.implement" },
  ]);
  await block(page, "brief").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1500);
  expect(seen.draftSaves).toHaveLength(0);
  await expect(page.locator("[data-card]:not([data-card='start'])"))
    .toHaveCount(3);
  await expect(page.locator('[data-ui-component="toast"]')).toHaveCount(0);
});

test("a save sends the authored text with its comment and the new order", async ({ page }) => {
  const { seen, saved } = await editor(page);
  await block(page, "implement").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(saved).toEqual(["implement", "research", "review"]);
  await expect(block(page, "implement")).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => seen.draftSaves.length).toBe(2);
  for (const save of seen.draftSaves) {
    const text = (save.body as { sourceYaml?: string }).sourceYaml ?? "";
    expect(text).toContain(`# version 1 of ${WORKFLOW.id}`);
  }
  const first = (seen.draftSaves[0].body as { sourceYaml: string }).sourceYaml;
  expect(first.indexOf("id: implement")).toBeLessThan(
    first.indexOf("id: research"),
  );
});

test("a draft someone else changed says so and Reload reads theirs", async ({ page }) => {
  await editor(page);
  let refused = 0;
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+\/versions\/[^/]+$/.test(url.pathname),
    (route) => {
      refused += 1;
      return route.fulfill({
        status: 412,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "PRECONDITION_FAILED",
          detail: "PRECONDITION_FAILED",
          status: 412,
          code: "PRECONDITION_FAILED",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    },
  );
  await block(page, "implement").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByText(
    "Someone else changed this draft. Reload to see their changes.",
  )).toBeVisible();
  await expect(status(page)).toHaveText("Not saved");
  await still(page, "editor-conflict");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Reload to see their changes, then publish."))
    .toBeVisible();
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("[data-card='implement']")).toBeVisible();
  await expect(status(page)).toHaveText("Saved");
  await expect(page.getByText("Someone else changed this draft."))
    .toHaveCount(0);
  await expect(page.getByText("Implement deleted")).toHaveCount(0);
  expect(refused).toBe(1);
});

test("a new message takes the place of the one before it", async ({ page, context }) => {
  await editor(page);
  const messages = page.locator('[data-ui-component="toast"]');
  await context.setOffline(true);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(messages).toHaveText(
    /You are offline\. Publish when you are back/,
  );
  await block(page, "implement").focus();
  await page.keyboard.press("Delete");
  await expect(messages).toHaveCount(1);
  await expect(messages).toContainText("Implement deleted");
  await still(page, "editor-one-message");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(messages).toHaveCount(1);
  await expect(messages).toHaveText(
    /You are offline\. Publish when you are back/,
  );
});

test("typing after a delete takes the Undo offer away and keeps the words", async ({ page }) => {
  const { seen, saved } = await editor(page, [
    ...STEPS,
    { id: "ask", uses: "human.approval" },
  ]);
  const offer = page.getByRole("button", { name: "Undo", exact: true });
  await block(page, "research").focus();
  await page.keyboard.press("Delete");
  await expect(offer).toBeVisible();
  await block(page, "ask").click();
  const question = page.getByRole("textbox", { name: /What you are asking/ });
  await question.pressSequentially("Ship it today?");
  await expect(offer).toHaveCount(0);
  await expect(question).toHaveValue("Ship it today?");
  await expect.poll(() => JSON.stringify(seen.draftSaves.at(-1)?.body))
    .toContain("Ship it today?");
  expect(saved()).toEqual(["implement", "review", "ask"]);
  await still(page, "editor-undo-offer-gone");
});

test("an undo by key also takes the Undo offer away", async ({ page }) => {
  const { saved } = await editor(page);
  await block(page, "implement").focus();
  await page.keyboard.press("Delete");
  const offer = page.getByRole("button", { name: "Undo", exact: true });
  await expect(offer).toBeVisible();
  await expect.poll(saved).toEqual(["research", "review"]);
  await page.keyboard.press("Control+z");
  await expect(offer).toHaveCount(0);
  await expect.poll(saved).toEqual(["research", "implement", "review"]);
});

test("offline, the change is kept and saved when the connection returns", async ({ page, context }) => {
  const { seen, saved } = await editor(page);
  await context.setOffline(true);
  await block(page, "implement").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByText(
    "You are offline. Changes are kept on this page and saved when you are back.",
  )).toBeVisible();
  await expect(status(page)).toHaveText("Not saved");
  await still(page, "editor-offline");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("You are offline. Publish when you are back."))
    .toBeVisible();
  await page.waitForTimeout(1500);
  expect(seen.draftSaves).toHaveLength(0);
  await context.setOffline(false);
  await expect.poll(saved).toEqual(["research", "review"]);
  await expect(status(page)).toHaveText("Saved");
});
