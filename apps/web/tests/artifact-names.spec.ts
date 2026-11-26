import { expect, type Page, test } from "@playwright/test";
import {
  ARTIFACT,
  CONTENT,
  json,
  OLD_CONTENT,
  OLD_VERSION_ID,
  openComments,
  PATH,
  ROOT,
  stubArtifactPage,
  TASK_ID,
  version,
  VERSION_ID,
} from "./helpers/artifact-page-fixture.ts";
import { MOCK_PRINCIPAL_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const RUN_STEP = "3f2a9c1e-0000-4000-8000-000000000777";
const NAMED = {
  current: {
    ...version(CONTENT),
    authorName: "Dana Okafor",
    runStepId: RUN_STEP,
  },
  roots: [{ ...ROOT, authorName: "Lee Park" }],
};

const titled = (page: Page, taskTitle: string | undefined) =>
  page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT.id}`,
    (route) => {
      const { taskTitle: _held, ...rest } = ARTIFACT;
      return route.fulfill(
        json(taskTitle === undefined ? rest : { ...rest, taskTitle }),
      );
    },
  );

const openTask = (page: Page) =>
  page.getByRole("button", { name: "Open task" });

test("the artifact page names the publisher, the commenter and the task", async ({ page }) => {
  await stubArtifactPage(page, NAMED);
  await titled(page, "Write the release notes");
  await page.goto(PATH);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(view).toContainText("Published by Dana Okafor · ");
  await expect(view).toContainText("Task Write the release notes");
  await expect(view).not.toContainText("Step ");
  await expect(view).not.toContainText(MOCK_PRINCIPAL_ID);
  await expect(openTask(page)).toBeVisible();
  await openComments(page);
  await expect(page.getByText("Lee Park", { exact: true })).toBeVisible();
  await expect(page.getByText("Outdated", { exact: true })).toHaveCount(1);
  await expect(page.getByText(ROOT.createdAt)).toHaveCount(0);
  await expect(page.getByText(/2026, \d{1,2}:\d{2}|2025, \d{1,2}:\d{2}/))
    .not.toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Send to agent", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(MOCK_PRINCIPAL_ID)).toHaveCount(0);
  await still(page, "artifact-names-comments");
  await page.goto(PATH);
  await page.getByTestId("artifact-retrieval-details-toggle").click();
  await expect(page.getByTestId("artifact-retrieval-provenance"))
    .toContainText("Dana Okafor");
  await expect(page.getByText("Task: Write the release notes")).toBeVisible();
  await expect(page.getByText(TASK_ID)).toHaveCount(0);
  await still(page, "artifact-names-details");
});

test("a reader who may not see the task gets no task line, no task actions and no ids", async ({ page }) => {
  await stubArtifactPage(page, { roots: NAMED.roots });
  await titled(page, undefined);
  await page.goto(PATH);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(view).toContainText("Published by Someone · ");
  await expect(view).not.toContainText("Step ");
  await expect(view).not.toContainText("Task ");
  await expect(openTask(page)).toHaveCount(0);
  await openComments(page);
  await expect(page.getByRole("textbox", { name: "Comment", exact: true }))
    .toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send to agent", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Include comment in agent request" }),
  ).toHaveCount(0);
  await expect(page.getByText(TASK_ID)).toHaveCount(0);
  await expect(page.getByText(MOCK_PRINCIPAL_ID)).toHaveCount(0);
  await still(page, "artifact-names-no-task");
});

test("a link to a version that does not exist says so once and points to the newest", async ({ page }) => {
  await stubArtifactPage(page);
  await page.goto(`${PATH}?version=00000000-0000-4000-8000-0000000009ff`);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(
    view.getByText(
      "This link names a version that this document does not have.",
    ),
  ).toBeVisible();
  await expect(view.getByText("Version not found")).toHaveCount(1);
  await expect(view.getByText("Show the newest version")).toHaveCount(1);
  await expect(view).not.toContainText("No published version yet");
  await expect(view).not.toContainText("Not available");
  await expect(view).not.toContainText("sha256");
  await expect(openTask(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Comments", exact: true }))
    .toHaveCount(0);
  await still(page, "artifact-names-unknown-version");
  await page.getByRole("button", { name: "Show the newest version" }).click();
  await expect(page).toHaveURL(new RegExp(`version=${VERSION_ID}`));
  await expect(view).toContainText("Published by Someone");
  await expect(view).not.toContainText("Version not found");
});

test("Evidence context leaves out the commits a version does not have", async ({ page }) => {
  await stubArtifactPage(page);
  await page.goto(PATH);
  const identity = page.getByTestId("artifact-retrieval-page")
    .locator('[data-ui-component="codeBlock"]').first();
  await expect(identity).toContainText(`sha256 ${version(CONTENT).sha256}`);
  await expect(identity).not.toContainText("base");
  await expect(identity).not.toContainText("head");
  await expect(identity).not.toContainText("Not available");
  await stubArtifactPage(page, {
    current: { ...version(CONTENT), subjectHeadSha: "5d138ac" },
  });
  await page.reload();
  await expect(identity).toContainText("head 5d138ac");
  await expect(identity).not.toContainText("base");
});

test("a link to an old version shows loading until its page arrives", async ({ page }) => {
  await stubArtifactPage(page);
  const old = {
    ...version(OLD_CONTENT),
    id: OLD_VERSION_ID,
    revision: 1,
  };
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let attempts = 0;
  await page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT.id}/versions`,
    async (route) => {
      if (!new URL(route.request().url()).searchParams.has("cursor")) {
        return route.fulfill(
          json({ items: [version(CONTENT)], nextCursor: "older" }),
        );
      }
      attempts += 1;
      await held;
      return route.fulfill(json({ items: [old], nextCursor: null }));
    },
  );
  await page.goto(`${PATH}?version=${OLD_VERSION_ID}`);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(view.getByText("Loading that version")).toBeVisible();
  await expect(view).not.toContainText("No published version yet");
  await expect(view).not.toContainText("Version not found");
  await still(page, "artifact-names-loading-version");
  expect(attempts).toBe(1);
  release();
  await expect(view).toContainText("Published by Someone");
  await expect(view.getByText("Loading that version")).toHaveCount(0);
});
