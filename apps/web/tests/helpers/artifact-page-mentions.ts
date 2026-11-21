import { expect, type Page, test } from "@playwright/test";
import {
  openComments,
  PATH,
  ROOT,
  stubArtifactPage,
  TASK_ID,
  VERSION_ID,
} from "./artifact-page-fixture.ts";
import { still } from "./stills.ts";

/** Mentions in the document comment box (#73, UX revision 2). */
const ANA = "00000000-0000-4000-8000-0000000000a1";
const SAMIR = "00000000-0000-4000-8000-0000000000a3";
const people = [
  { principalId: ANA, displayName: "Ana Ruiz", hasAccess: true },
  { principalId: SAMIR, displayName: "Samir Okafor", hasAccess: false },
].map((person) => ({ ...person, gainsAccessOnSend: false }));

const commentBox = (page: Page) => page.getByLabel("Comment", { exact: true });

async function openWithPeople(page: Page) {
  const searches: string[] = [];
  await stubArtifactPage(page);
  await page.route(
    (url) =>
      url.pathname === `/v1/artifact-versions/${VERSION_ID}/mention-candidates`,
    (route) => {
      const url = new URL(route.request().url());
      const text = (url.searchParams.get("query") ?? "").toLowerCase();
      searches.push(text);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: people.filter((person) =>
            person.displayName.toLowerCase().includes(text)
          ),
          nextCursor: null,
        }),
      });
    },
  );
  await page.goto(PATH);
  await openComments(page);
  return searches;
}

test("typing @ in the comment box offers people to mention: a plain row, one muted row, and the footer that says a comment only notifies", async ({ page }) => {
  await openWithPeople(page);
  await commentBox(page).fill("@");
  const list = page.getByRole("listbox", { name: "People you can mention" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "Ana Ruiz", exact: true }))
    .toBeVisible();
  const blocked = list.getByRole("option", {
    name: "Samir Okafor, can't see this document",
  });
  await expect(blocked).toHaveAttribute("aria-disabled", "true");
  await expect(list.getByText("Can't see this document")).toBeVisible();
  // In a narrow picker the reason sits under the name, so the name keeps one line.
  const picker = await list.boundingBox();
  const name = blocked.getByText("Samir Okafor", { exact: true });
  const reason = blocked.getByText("Can't see this document");
  const nameBox = await name.boundingBox();
  const reasonBox = await reason.boundingBox();
  if (nameBox === null || reasonBox === null || picker === null) {
    throw new Error("no boxes");
  }
  expect(nameBox.height).toBeLessThan(26);
  if (picker.width <= 300) {
    expect(reasonBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
  }
  await expect(
    page.getByText(
      "A comment only notifies. It never gives anyone access to the document.",
    ),
  ).toBeVisible();
  // A comment never gives access, so no row offers it.
  await expect(page.getByText("No access yet")).toHaveCount(0);
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-picker");
});

test("choosing a person writes @Name, shows who will be notified, and the comment carries the mention", async ({ page }) => {
  const searches = await openWithPeople(page);
  const box = commentBox(page);
  await box.fill("Looks right @an");
  await expect.poll(() => searches).toContain("an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await expect(box).toHaveValue("Looks right @Ana Ruiz ");
  await expect(page.getByText("Will be notified")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove mention of Ana Ruiz" }),
  ).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/comments`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...ROOT, body: "Looks right @Ana Ruiz" }),
      }),
  );
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-ready");
  const created = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes("/comments")
  );
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  const request = await created;
  expect(request.postDataJSON()).toEqual({
    body: "Looks right @Ana Ruiz",
    mentions: [ANA],
  });
  await expect(box).toHaveValue("");
  await expect(page.getByText("Will be notified")).toHaveCount(0);
});

test("a refused mention writes nothing: the draft stays, the sentence names the person, Post waits until the mention is removed", async ({ page }) => {
  await openWithPeople(page);
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/comments`,
    (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/unprocessable",
          title: "UNPROCESSABLE",
          detail: "Stubbed UNPROCESSABLE.",
          status: 422,
          code: "UNPROCESSABLE",
          requestId: TASK_ID,
          traceId: TASK_ID,
          retryable: false,
          issues: [{
            path: "/mentions/0",
            code: "mention_no_thread_access",
            message: "mention no thread access",
          }],
        }),
      }),
  );
  const box = commentBox(page);
  await box.fill("Hi @an");
  await page.getByRole("option", { name: "Ana Ruiz", exact: true }).click();
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent." }))
    .toHaveText(
      "Not sent. Ana Ruiz can't see this document, so they can't be mentioned here. Remove the mention.",
    );
  await expect(box).toHaveValue("Hi @Ana Ruiz ");
  await expect(page.getByRole("button", { name: "Post comment", exact: true }))
    .toBeDisabled();
  await page.mouse.move(700, 100);
  await still(page, "comment-mentions-refused");
  await page.getByRole("button", { name: "Remove mention of Ana Ruiz" })
    .click();
  await expect(page.getByRole("button", { name: "Post comment", exact: true }))
    .toBeEnabled();
});
