import { expect, test } from "@playwright/test";
import {
  ARTIFACT_ID,
  COMMENT_ID,
  json,
  PATH,
  ROOT,
  stubArtifactPage,
  VERSION_ID,
} from "./artifact-page-fixture.ts";

test("comment deep links find later comment pages and open the mobile discussion", async ({ page }) => {
  await stubArtifactPage(page);
  const cursors: (string | null)[] = [];
  await page.route(`**/v1/artifacts/${ARTIFACT_ID}/comments**`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    return route.fulfill(json(
      cursor ? { items: [ROOT], nextCursor: null } : {
        items: [{
          ...ROOT,
          id: "00000000-0000-4000-8000-000000000108",
          body: "Earlier feedback",
        }],
        nextCursor: "next-comments-page",
      },
    ));
  });
  await page.goto(`${PATH}?version=${VERSION_ID}&comment=${COMMENT_ID}`);
  const comment = page.locator(`#comment-${COMMENT_ID}`);
  await expect(comment).toBeVisible();
  await expect(comment).toBeFocused();
  expect(cursors).toContain("next-comments-page");
  await expect(comment.getByText("Original revision feedback", { exact: true }))
    .toBeVisible();
});
