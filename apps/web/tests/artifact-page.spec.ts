import { expect, test } from "@playwright/test";
import "./helpers/artifact-page-pins.ts";
import "./helpers/artifact-page-storage.ts";
import "./helpers/artifact-page-navigation.ts";
import "./helpers/artifact-page-conflicts.ts";
import "./helpers/artifact-page-accessibility.ts";
import "./helpers/artifact-page-authoring.ts";
import "./helpers/artifact-page-live-state.ts";
import "./helpers/artifact-page-bounded-preview.ts";
import "./helpers/artifact-page-preview-handoff.ts";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  CONTENT,
  CONVERSATION_ID,
  json,
  MESSAGE,
  OLD_CONTENT,
  OLD_VERSION_ID,
  openComments,
  PATH,
  problem,
  ROOT,
  stubArtifactPage,
  version,
  VERSION_ID,
} from "./helpers/artifact-page-fixture.ts";

test.afterEach(async ({ page }, testInfo) => {
  await page.screenshot({
    path: testInfo.outputPath("final.png"),
    // A single-line megabyte body renders thousands of screens tall, past the
    // browser's screenshot limit; those cases keep the viewport capture.
    fullPage: !testInfo.annotations.some((item) => item.type === "tall-page"),
  });
});

test("deep links verify the selected immutable version and switching updates the URL", async ({ page }) => {
  await stubArtifactPage(page);
  await page.goto(`${PATH}?version=${OLD_VERSION_ID}`);
  await expect(page.getByTestId("artifact-version-1")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(OLD_CONTENT.trim());
  await page.getByTestId("artifact-retrieval-details-toggle")
    .click();
  await page.getByTestId("artifact-version-2").click();
  await expect(page).toHaveURL(new RegExp(`version=${VERSION_ID}`));
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());
  await page.reload();
  await expect(page.getByTestId("artifact-version-2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("preview refuses bytes whose digest disagrees with the advertised version", async ({ page }) => {
  await stubArtifactPage(page, { content: "Corrupted current bytes!!\n" });
  await page.goto(PATH);
  await expect(
    page.getByText("Content could not be verified. Preview is unavailable."),
  ).toBeVisible();
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toHaveCount(0);
  await expect(page.getByText("Corrupted current bytes!!", { exact: true }))
    .toHaveCount(0);
});

test("HTML stays download-only and is not fetched automatically", async ({ page }) => {
  const html = '<script>document.body.dataset.compromised="yes"</script>';
  await stubArtifactPage(page, {
    current: version(html, "text/html"),
    content: html,
  });
  const contentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/content")) contentRequests.push(request.url());
  });
  await page.goto(PATH);
  await expect(page.getByText(/This media type is download-only/))
    .toBeVisible();
  await expect(page.getByTestId("artifact-retrieval-download")).toBeEnabled();
  expect(contentRequests).toEqual([]);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-compromised",
    "yes",
  );
});

test("hostile Markdown renders inert text without executable HTML or links", async ({ page }) => {
  const markdown =
    '# Hostile preview\n<script>document.body.dataset.compromised="yes"</script>\n<img src=x onerror="document.body.dataset.compromised=\'yes\'">\n[run](javascript:alert(1))';
  await stubArtifactPage(page, {
    current: version(markdown, "text/markdown"),
    content: markdown,
  });
  await page.goto(PATH);
  const viewer = page.locator('[data-ui-component="artifactViewer"]');
  await expect(viewer).toContainText("Hostile preview");
  await expect(viewer.locator("script, img, a[href^='javascript:']"))
    .toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-compromised",
    "yes",
  );
});

test("expired bytes retain provenance and discussion behind a tombstone", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    "**/v1/artifact-versions/**/content",
    (route) => route.fulfill(problem(410, "ARTIFACT_CONTENT_EXPIRED")),
  );
  await page.goto(PATH);
  await expect(page.getByText("Content expired", { exact: true }))
    .toBeVisible();
  await expect(page.getByTestId("artifact-retrieval-provenance")).toContainText(
    version(CONTENT).sha256,
  );
  await openComments(page);
  await expect(page.getByText(ROOT.body ?? "", { exact: true })).toBeVisible();
  await expect(
    page.locator(
      '[data-ui-component="artifactViewer"]:not([data-variant="unsupported"])',
    ),
  )
    .toHaveCount(0);
});

test("cross-version threads preserve original reply scope and show deleted comments", async ({ page }) => {
  const deletedId = "00000000-0000-4000-8000-000000000108";
  await stubArtifactPage(page, {
    roots: [ROOT, {
      ...ROOT,
      id: deletedId,
      body: null,
      deletedAt: ROOT.createdAt,
    }],
  });
  await page.route(
    `**/v1/artifact-versions/${OLD_VERSION_ID}/comments**`,
    (route) =>
      route.fulfill(
        json({ ...ROOT, rootId: ROOT.id, body: "Reply on original" }),
      ),
  );
  const listing = page.waitForRequest((request) =>
    request.url().includes(`/artifacts/${ARTIFACT_ID}/comments`)
  );
  await page.goto(PATH);
  await openComments(page);
  expect(new URL((await listing).url()).searchParams.get("viewVersionId")).toBe(
    VERSION_ID,
  );
  const thread = page.locator(`#comment-${COMMENT_ID}`);
  await expect(thread.locator('[data-ui-component="artifactDiscussion"]'))
    .toHaveAttribute("data-state", "outdated");
  await expect(thread.getByRole("link", { name: "Open original revision" }))
    .toHaveAttribute(
      "href",
      `${PATH}?version=${OLD_VERSION_ID}&comment=${COMMENT_ID}`,
    );
  const deleted = page.locator(`#comment-${deletedId}`);
  await expect(deleted.getByText("Comment deleted", { exact: true }))
    .toBeVisible();
  await expect(deleted.getByRole("checkbox")).toHaveCount(0);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByLabel("Comment", { exact: true }).fill("Reply on original");
  const reply = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes("/comments")
  );
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  const request = await reply;
  expect(new URL(request.url()).pathname).toBe(
    `/v1/artifact-versions/${OLD_VERSION_ID}/comments`,
  );
  expect(request.postDataJSON()).toEqual({
    body: "Reply on original",
    rootId: COMMENT_ID,
  });
  expect(request.headers()["idempotency-key"]).toBeTruthy();
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("");
});

test("resolve sends If-Match and a 412 preserves the draft for reload", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    `**/v1/artifact-comments/${COMMENT_ID}`,
    (route) => route.fulfill(problem(412, "PRECONDITION_FAILED")),
  );
  await page.goto(PATH);
  await openComments(page);
  await page.getByLabel("Comment", { exact: true }).fill(
    "Keep my unfinished feedback",
  );
  const patch = page.waitForRequest((request) => request.method() === "PATCH");
  await page.locator(`#comment-${COMMENT_ID}`).getByRole("button", {
    name: "Resolve",
    exact: true,
  }).click();
  const request = await patch;
  expect(request.headers()["if-match"]).toBe('"v3"');
  expect(request.postDataJSON()).toEqual({ resolved: true });
  await expect(page.getByText(/This discussion changed/)).toBeVisible();
  await page.getByRole("button", { name: "Reload comments" }).click();
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue(
    "Keep my unfinished feedback",
  );
  await expect(
    page.locator(`#comment-${COMMENT_ID}`).getByRole("button", {
      name: "Resolve",
      exact: true,
    }),
  ).toBeVisible();
});

test("selected comments become version-bound agent requests without resolving threads", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    `**/v1/conversations/${CONVERSATION_ID}/messages`,
    (route) => route.fulfill(json(MESSAGE)),
  );
  await page.goto(PATH);
  await openComments(page);
  await page.getByRole("checkbox", { name: "Include comment in agent request" })
    .check();
  await page.getByRole("button", { name: "Send to agent", exact: true })
    .click();
  await page.getByLabel("Agent request", { exact: true }).fill(
    "Apply this feedback",
  );
  const message = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes("/messages")
  );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const request = await message;
  expect(request.postDataJSON()).toEqual({
    body: "Apply this feedback",
    intent: "agent_request",
    commentRefs: [{ commentId: COMMENT_ID, expectedVersion: 3 }],
    clientMessageId: request.headers()["idempotency-key"],
  });
  await expect(page.getByText("Request queued. Comments remain open."))
    .toBeVisible();
  await expect(
    page.locator(`#comment-${COMMENT_ID}`).getByRole("button", {
      name: "Resolve",
      exact: true,
    }),
  ).toBeVisible();
});

test("forbidden artifact hides preview and comments", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    `**/v1/artifacts/${ARTIFACT_ID}`,
    (route) => route.fulfill(problem(403, "AUTH_FORBIDDEN")),
  );
  await page.goto(PATH);
  await expect(page.getByTestId("artifact-retrieval-forbidden")).toBeVisible();
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toHaveCount(0);
  await expect(page.getByLabel("Comment", { exact: true })).toHaveCount(0);
  await expect(page.getByText(ROOT.body ?? "", { exact: true })).toHaveCount(0);
});
