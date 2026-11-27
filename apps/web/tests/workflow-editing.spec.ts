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

async function editor(page: Page) {
  const seen = await libraryFixture(page, {
    workflows: [{ ...WORKFLOW }],
    versions: [{
      id: uuid(1001),
      workflowId: WORKFLOW.id,
      revision: 1,
      status: "draft",
      steps: STEPS,
    }],
  });
  await page.goto(EDIT);
  await expect(page.locator("[data-card='implement']")).toBeVisible();
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
  await expect.poll(saved).toEqual(["research", "review"]);
  await page.keyboard.press("Control+z");
  await expect.poll(saved).toEqual(["research", "implement", "review"]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(saved).toEqual(["research", "review"]);
});

test("a save sends the authored text with its comment and the new order", async ({ page }) => {
  const { seen, saved } = await editor(page);
  await block(page, "implement").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(saved).toEqual(["implement", "research", "review"]);
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
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("[data-card='implement']")).toBeVisible();
  await expect(status(page)).toHaveText("Saved");
  await expect(page.getByText("Someone else changed this draft."))
    .toHaveCount(0);
  expect(refused).toBe(1);
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
  await page.waitForTimeout(1500);
  expect(seen.draftSaves).toHaveLength(0);
  await context.setOffline(false);
  await expect.poll(saved).toEqual(["research", "review"]);
  await expect(status(page)).toHaveText("Saved");
});
