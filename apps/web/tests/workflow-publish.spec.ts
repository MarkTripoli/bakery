import { expect, type Page, test } from "@playwright/test";
import { definition, libraryFixture, uuid } from "./helpers/library-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const WORKFLOW = definition(10, "Release train", {
  activeVersionId: uuid(1001),
});
const EDIT = `/library/workflows/${WORKFLOW.id}/edit`;
const repeat = (max: number) => ({
  id: "again",
  repeat: { max, steps: [{ id: "fix", uses: "harness.implement" }] },
});
const IN_USE = [{ id: "brief", uses: "task.brief" }, repeat(3)];

const json = (body: unknown, status = 200) => ({
  status,
  contentType: status < 400 ? "application/json" : "application/problem+json",
  body: JSON.stringify(body),
});
const conflict = {
  type: "about:blank",
  title: "x",
  status: 412,
  code: "PRECONDITION_FAILED",
};

type Setup = {
  readonly draftSteps: readonly unknown[];
  readonly publishStatus?: number;
  readonly activateStatus?: number;
  readonly inUseSteps?: readonly unknown[];
};

async function editor(page: Page, setup: Setup) {
  await libraryFixture(page, { workflows: [WORKFLOW], versions: [] });
  const server = { steps: setup.draftSteps, version: 1, status: "draft" };
  const version = (
    id: string,
    revision: number,
    status: string,
    steps: unknown,
    held: number,
  ) => ({
    id,
    workflowId: WORKFLOW.id,
    revision,
    sourceYaml: "",
    normalizedSpec: { steps },
    digest: String(held).padStart(2, "0").repeat(32),
    status,
    createdBy: uuid(1),
    createdAt: "2026-02-02T10:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
    version: held,
    starts: [],
  });
  const draft = () =>
    version(uuid(1002), 2, server.status, server.steps, server.version);
  await page.route(
    (url) => url.pathname === `/v1/workflows/${WORKFLOW.id}/versions`,
    (route) =>
      route.fulfill(json({
        items: [
          draft(),
          version(
            uuid(1001),
            1,
            "published",
            setup.inUseSteps ?? IN_USE,
            1,
          ),
        ],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname.endsWith("/publish"),
    (route) => {
      if (setup.publishStatus === 412) {
        server.steps = [...IN_USE, { id: "check", uses: "review.independent" }];
        server.version += 1;
        return route.fulfill(json(conflict, 412));
      }
      server.status = "published";
      server.version = 2;
      return route.fulfill(json(draft()));
    },
  );
  await page.route(
    (url) => url.pathname.endsWith("/activations"),
    (route) => route.fulfill(json(conflict, setup.activateStatus ?? 412)),
  );
  await page.goto(EDIT);
  await expect(page.locator("[data-card='start']")).toBeVisible();
  return server;
}

const openPublish = async (page: Page) => {
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  return page.getByRole("alertdialog");
};

test.describe("workflow editor: what publishing changes", () => {
  test("a repeat number alone is a change that can be published", async ({ page }) => {
    await editor(page, { draftSteps: [IN_USE[0], repeat(5)] });
    const dialog = await openPublish(page);
    await expect(dialog).toContainText("Changes since version 1");
    await expect(dialog).toContainText("Repeat: at most 5 tries, was 3");
    await expect(dialog).not.toContainText("Changed:");
    await expect(dialog).toContainText("No problems found.");
    await expect(dialog.getByRole("button", { name: "Publish and use" }))
      .toBeVisible();
    await still(page, "publish-changed");
  });

  test("new and removed steps are named", async ({ page }) => {
    await editor(page, {
      draftSteps: [repeat(3), { id: "check", uses: "review.independent" }],
    });
    const dialog = await openPublish(page);
    await expect(dialog).toContainText("New: Review");
    await expect(dialog).toContainText("Removed: Write the task brief");
    await still(page, "publish-new-removed");
  });

  test("a draft that matches the version in use has nothing to publish", async ({ page }) => {
    await editor(page, { draftSteps: IN_USE });
    const dialog = await openPublish(page);
    await expect(dialog).toContainText("Nothing to publish");
  });

  test("a draft changed by someone else is read again and shown", async ({ page }) => {
    await editor(page, {
      draftSteps: [IN_USE[0], repeat(5)],
      publishStatus: 412,
    });
    const dialog = await openPublish(page);
    await dialog.getByRole("button", { name: "Publish only" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "This draft changed since you opened it.",
    );
    await expect(dialog).toContainText("New: Review");
    await expect(dialog).not.toContainText("at most 5 tries");
    await still(page, "publish-stale");
  });

  test("a version published but not put in use says so", async ({ page }) => {
    await editor(page, { draftSteps: [IN_USE[0], repeat(5)] });
    const dialog = await openPublish(page);
    await dialog.getByRole("button", { name: "Publish and use" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Version 2 was published but is not in use yet.",
    );
    await expect(dialog.getByRole("heading", { name: "Use version 2" }))
      .toBeVisible();
    await expect(dialog.getByRole("button", { name: "Use this version" }))
      .toBeVisible();
    await still(page, "publish-not-used");
  });
  test("a group removed around a step can still be published", async ({ page }) => {
    await editor(page, {
      inUseSteps: [{ id: "g", steps: [IN_USE[0]] }, repeat(3)],
      draftSteps: IN_USE,
    });
    const dialog = await openPublish(page);
    await expect(dialog).toContainText(
      "How steps are grouped or when they run changed.",
    );
    await expect(dialog.getByRole("button", { name: "Publish and use" }))
      .toBeVisible();
    await still(page, "publish-grouped");
  });

  test("a change to the first of two steps sharing an id is named", async ({ page }) => {
    const held = (group: string, name: string) => ({
      id: group,
      steps: [{ id: "brief", uses: "task.brief", name }],
    });
    await editor(page, {
      inUseSteps: [held("a", "Old brief"), held("b", "Second brief")],
      draftSteps: [held("a", "New brief"), held("b", "Second brief")],
    });
    const dialog = await openPublish(page);
    await expect(dialog).toContainText("Changed: New brief");
    await expect(dialog).not.toContainText("Second brief");
  });
});
