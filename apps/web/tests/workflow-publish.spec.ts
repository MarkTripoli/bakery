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
  readonly publishedAlready?: boolean;
  readonly activations?: unknown[];
  readonly leftoverDraft?: unknown[];
  readonly refusedRewrites?: number;
  readonly nothingInUse?: boolean;
};

async function editor(page: Page, setup: Setup) {
  await libraryFixture(page, {
    workflows: [
      setup.nothingInUse
        ? definition(10, "Release train", { activeVersionId: null })
        : WORKFLOW,
    ],
    versions: [],
  });
  const server = {
    steps: setup.draftSteps,
    version: 1,
    status: setup.publishedAlready === true ? "published" : "draft",
  };
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
  const leftover = {
    steps: (setup.inUseSteps ?? IN_USE) as readonly unknown[],
    held: 1,
  };
  let refusals = setup.refusedRewrites ?? 0;
  if (setup.leftoverDraft !== undefined) {
    await page.route(
      (url) => url.pathname.endsWith(`/versions/${uuid(1003)}`),
      (route) => {
        const body = route.request().postDataJSON() as {
          definition: { steps: unknown[] };
        };
        setup.leftoverDraft?.push(body);
        if (refusals > 0) {
          refusals -= 1;
          return route.fulfill(json(conflict, 412));
        }
        leftover.steps = body.definition.steps;
        leftover.held += 1;
        return route.fulfill(
          json(version(uuid(1003), 3, "draft", leftover.steps, leftover.held)),
        );
      },
    );
  }
  await page.route(
    (url) => url.pathname === `/v1/workflows/${WORKFLOW.id}/versions`,
    (route) =>
      route.fulfill(json({
        items: [
          ...(setup.leftoverDraft === undefined ? [] : [
            version(uuid(1003), 3, "draft", leftover.steps, leftover.held),
          ]),
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
    (route) => {
      setup.activations?.push(route.request().postDataJSON());
      if (setup.leftoverDraft !== undefined) return route.fallback();
      return route.fulfill(json(conflict, setup.activateStatus ?? 412));
    },
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

  test("an earlier published version nobody used is not called the first", async ({ page }) => {
    await editor(page, {
      draftSteps: [{ id: "brief", uses: "task.brief" }],
      nothingInUse: true,
    });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const summary = page.getByTestId("publish-changes");
    await expect(summary).toContainText("Nothing is in use yet");
    await expect(summary).not.toContainText("This is the first version.");
  });

  test("a draft that matches the version in use has nothing to publish", async ({ page }) => {
    await editor(page, { draftSteps: IN_USE });
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("No changes to publish");
    await still(page, "publish-header-unchanged");
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
    await expect(dialog).not.toContainText("is already published");
    await still(page, "publish-not-used");
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("Version 2 published, not in use");
  });
  test("a newer published version not in use can still be used on a fresh visit", async ({ page }) => {
    const activations: unknown[] = [];
    await editor(page, {
      draftSteps: [IN_USE[0], repeat(5)],
      publishedAlready: true,
      activations,
    });
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("Version 2 published, not in use");
    await still(page, "publish-header-newer");
    const dialog = await openPublish(page);
    await expect(dialog.getByRole("heading", { name: "Use version 2" }))
      .toBeVisible();
    await expect(dialog).toContainText("Repeat: at most 5 tries, was 3");
    await expect(dialog.getByRole("button", { name: "Publish only" }))
      .toHaveCount(0);
    await still(page, "publish-newer-dialog");
    await dialog.getByRole("button", { name: "Use this version" }).click();
    await expect.poll(() => activations.length).toBe(1);
    expect(activations[0]).toMatchObject({ versionId: uuid(1002) });
  });

  test("using the newer version does not leave an undone draft behind", async ({ page }) => {
    const rewrites: unknown[] = [];
    await editor(page, {
      draftSteps: [IN_USE[0], repeat(5)],
      publishedAlready: true,
      leftoverDraft: rewrites,
    });
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("Version 2 published, not in use");
    const dialog = await openPublish(page);
    await dialog.getByRole("button", { name: "Use this version" }).click();
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("No changes to publish");
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({
      definition: { steps: [IN_USE[0], repeat(5)] },
    });
  });

  test("using it from the workflow page does not leave the draft behind", async ({ page }) => {
    const rewrites: unknown[] = [];
    await editor(page, {
      draftSteps: [IN_USE[0], repeat(5)],
      publishedAlready: true,
      leftoverDraft: rewrites,
    });
    await page.goto(`/library/workflows/${WORKFLOW.id}`);
    await page.getByRole("button", { name: "Use this version" }).first()
      .click();
    await page.getByRole("button", { name: "Use version 2" }).click();
    await expect.poll(() => rewrites.length).toBe(1);
    expect(rewrites[0]).toMatchObject({
      definition: { steps: [IN_USE[0], repeat(5)] },
    });
  });

  test("a draft that could not be updated is said, and can be tried again", async ({ page }) => {
    const rewrites: unknown[] = [];
    await editor(page, {
      draftSteps: [IN_USE[0], repeat(5)],
      publishedAlready: true,
      leftoverDraft: rewrites,
      refusedRewrites: 1,
    });
    const dialog = await openPublish(page);
    await dialog.getByRole("button", { name: "Use this version" }).click();
    const notice = page.getByRole("alert").filter({
      hasText: "Version 2 is in use. Your unchanged draft could not be updated",
    });
    await expect(notice).toBeVisible();
    await still(page, "publish-draft-kept");
    await notice.getByRole("button", { name: "Try updating the draft again" })
      .click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("editor-problems"))
      .toHaveText("No changes to publish");
  });

  test("trying again never overwrites an edit made since the failure", async ({ page }) => {
    const ask = (prompt: string) => ({
      id: "ask",
      uses: "human.approval",
      with: { prompt },
    });
    const rewrites: unknown[] = [];
    await editor(page, {
      inUseSteps: [ask("Ship it?")],
      draftSteps: [ask("Ship it to everyone?")],
      publishedAlready: true,
      leftoverDraft: rewrites,
      refusedRewrites: 1,
    });
    const dialog = await openPublish(page);
    await dialog.getByRole("button", { name: "Use this version" }).click();
    const retry = page.getByRole("button", {
      name: "Try updating the draft again",
    });
    await expect(retry).toBeVisible();
    await page.locator("[data-card='ask']").click();
    const prompt = page.getByRole("textbox", { name: /What you are asking/ });
    await prompt.fill("A question typed since.");
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect.poll(() => JSON.stringify(rewrites.at(-1)))
      .toContain("A question typed since.");
    await page.waitForTimeout(1500);
    expect(
      rewrites.filter((body) => JSON.stringify(body).includes("everyone")),
    ).toHaveLength(1);
    await expect(prompt).toHaveValue("A question typed since.");
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
