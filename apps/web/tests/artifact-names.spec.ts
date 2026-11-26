import { expect, test } from "@playwright/test";
import {
  ARTIFACT,
  CONTENT,
  json,
  openComments,
  PATH,
  ROOT,
  stubArtifactPage,
  TASK_ID,
  version,
} from "./helpers/artifact-page-fixture.ts";
import { MOCK_PRINCIPAL_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const NAMED = {
  current: { ...version(CONTENT), authorName: "Dana Okafor" },
  roots: [{ ...ROOT, authorName: "Lee Park" }],
};

test("the artifact page names the publisher, the commenter and the task", async ({ page }) => {
  await stubArtifactPage(page, NAMED);
  await page.route(
    (url) => url.pathname === `/v1/artifacts/${ARTIFACT.id}`,
    (route) =>
      route.fulfill(
        json({ ...ARTIFACT, taskTitle: "Write the release notes" }),
      ),
  );
  await page.goto(PATH);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(view).toContainText("Published by Dana Okafor");
  await expect(view).not.toContainText(MOCK_PRINCIPAL_ID);
  await openComments(page);
  await expect(page.getByText("Lee Park", { exact: true })).toBeVisible();
  await expect(page.getByText(MOCK_PRINCIPAL_ID)).toHaveCount(0);
  await still(page, "artifact-names-comments");
  await page.goto(PATH);
  await page.getByTestId("artifact-retrieval-details-toggle").click();
  await expect(page.getByTestId("artifact-retrieval-provenance"))
    .toContainText("Dana Okafor");
  await expect(
    page.getByText("Task Write the release notes / Step", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText(`Task ${TASK_ID}`)).toHaveCount(0);
  await still(page, "artifact-names-details");
});

test("a reader who may not see the task gets no task line and no ids", async ({ page }) => {
  await stubArtifactPage(page);
  await page.goto(PATH);
  const view = page.getByTestId("artifact-retrieval-page");
  await expect(view).toContainText("Published by Someone");
  await page.getByTestId("artifact-retrieval-details-toggle").click();
  await expect(page.getByText(/^Step /)).toBeVisible();
  await expect(page.getByText(`Task ${TASK_ID}`)).toHaveCount(0);
  await expect(page.getByText(MOCK_PRINCIPAL_ID)).toHaveCount(0);
  await still(page, "artifact-names-no-task");
});
