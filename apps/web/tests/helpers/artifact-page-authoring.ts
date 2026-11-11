import { expect, test } from "@playwright/test";
import {
  COMMENT_ID,
  CONTENT,
  json,
  openComments,
  PATH,
  problem,
  ROOT,
  stubArtifactPage,
  VERSION_ID,
} from "./artifact-page-fixture.ts";

test("new text comments anchor a verified line to the selected immutable revision", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/comments`,
    (route) =>
      route.fulfill(json({
        ...ROOT,
        artifactVersionId: VERSION_ID,
        body: "Review this verified line",
      })),
  );
  await page.goto(PATH);
  await openComments(page);
  await page.getByRole("checkbox", {
    name: "Anchor to this revision",
    exact: true,
  }).check();
  await page.locator("#artifact-anchor-location").fill("1");
  await page.getByLabel("Comment", { exact: true }).fill(
    "Review this verified line",
  );
  const created = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes("/comments")
  );
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  const request = await created;
  expect(new URL(request.url()).pathname).toBe(
    `/v1/artifact-versions/${VERSION_ID}/comments`,
  );
  expect(request.postDataJSON()).toEqual({
    body: "Review this verified line",
    anchor: { kind: "text", startLine: 1, endLine: 1, quote: CONTENT.trim() },
  });
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("");
});

test("comment body editing sends If-Match and preserves its draft after a conflict", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    `**/v1/artifact-comments/${COMMENT_ID}`,
    (route) => route.fulfill(problem(412, "PRECONDITION_FAILED")),
  );
  await page.goto(PATH);
  await openComments(page);
  const thread = page.locator(`#comment-${COMMENT_ID}`);
  await thread.getByRole("button", { name: "Edit comment", exact: true })
    .click();
  const editor = page.locator(`#artifact-comment-edit-${COMMENT_ID}`);
  await editor.fill("Keep this edited feedback");
  const patched = page.waitForRequest((request) =>
    request.method() === "PATCH"
  );
  await thread.getByRole("button", { name: "Save comment", exact: true })
    .click();
  const request = await patched;
  expect(request.headers()["if-match"]).toBe('"v3"');
  expect(request.postDataJSON()).toEqual({ body: "Keep this edited feedback" });
  await expect(thread.getByText(/This discussion changed/)).toBeVisible();
  await thread.getByRole("button", { name: "Reload comments", exact: true })
    .click();
  await expect(editor).toHaveValue("Keep this edited feedback");
});
