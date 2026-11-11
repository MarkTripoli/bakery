import { expect, type Request, test } from "@playwright/test";
import {
  ARTIFACT,
  ARTIFACT_ID,
  COMMENT_ID,
  CONVERSATION_ID,
  json,
  MESSAGE,
  openComments,
  PATH,
  problem,
  ROOT,
  stubArtifactPage,
} from "./artifact-page-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./mock-session.ts";

test("stale agent requests preserve draft and require reselecting refreshed comment versions", async ({ page }) => {
  await stubArtifactPage(page);
  let revision = ROOT.version;
  await page.route(
    `**/v1/artifacts/${ARTIFACT_ID}/comments**`,
    (route) =>
      route.fulfill(json({
        items: [{ ...ROOT, version: revision }],
        nextCursor: null,
      })),
  );
  const requests: Request[] = [];
  await page.route(
    `**/v1/conversations/${CONVERSATION_ID}/messages`,
    (route) => {
      requests.push(route.request());
      if (requests.length === 1) {
        revision++;
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      return route.fulfill(json(MESSAGE));
    },
  );
  await page.goto(PATH);
  await openComments(page);
  const selected = page.getByRole("checkbox", {
    name: "Include comment in agent request",
  });
  await selected.check();
  await page.getByRole("button", { name: "Send to agent", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Send comments to agent" });
  await dialog.getByLabel("Agent request", { exact: true }).fill(
    "Preserve the agent draft",
  );
  await dialog.getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(dialog.getByText(/This discussion changed/)).toBeVisible();
  const refreshed = page.waitForResponse((response) =>
    response.url().includes(`/artifacts/${ARTIFACT_ID}/comments`)
  );
  await dialog.getByRole("button", { name: "Reload comments", exact: true })
    .click();
  await refreshed;
  await expect(dialog).toHaveCount(0);
  await expect(selected).not.toBeChecked();
  await selected.check();
  await page.getByRole("button", { name: "Send to agent", exact: true })
    .click();
  await expect(dialog.getByLabel("Agent request", { exact: true })).toHaveValue(
    "Preserve the agent draft",
  );
  await dialog.getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(page.getByText("Request queued. Comments remain open."))
    .toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]?.postDataJSON()).toMatchObject({
    commentRefs: [{ commentId: COMMENT_ID, expectedVersion: 3 }],
  });
  expect(requests[1]?.postDataJSON()).toMatchObject({
    body: "Preserve the agent draft",
    intent: "agent_request",
    commentRefs: [{ commentId: COMMENT_ID, expectedVersion: 4 }],
  });
  expect(requests[1]?.headers()["idempotency-key"]).not.toBe(
    requests[0]?.headers()["idempotency-key"],
  );
});

test("stale pin mutations reload the artifact before retrying with fresh If-Match", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "admin",
        capabilities: [],
      })),
  );
  let revision = 1;
  const requests: Request[] = [];
  await page.route(`**/v1/artifacts/${ARTIFACT_ID}`, (route) => {
    if (route.request().method() === "PATCH") {
      requests.push(route.request());
      revision++;
      if (requests.length === 1) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      return route.fulfill(json({
        id: ARTIFACT_ID,
        pinned: true,
        unpinEligible: false,
        pinnedAt: ARTIFACT.createdAt,
        pinnedBy: ROOT.authorId,
        version: revision,
      }));
    }
    return route.fulfill(json({ ...ARTIFACT, version: revision }));
  });
  await page.goto(PATH);
  await page.getByRole("button", { name: "Pin artifact", exact: true }).click();
  await expect(
    page.getByText("Pin could not be updated. Reload before retrying."),
  ).toBeVisible();
  const refreshed = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    response.url().endsWith(`/artifacts/${ARTIFACT_ID}`)
  );
  await page.getByRole("button", { name: "Reload artifact", exact: true })
    .click();
  await refreshed;
  await page.getByRole("button", { name: "Pin artifact", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]?.headers()["if-match"]).toBe('"v1"');
  expect(requests[1]?.headers()["if-match"]).toBe('"v2"');
  await expect(
    page.getByText("Pin could not be updated. Reload before retrying."),
  ).toHaveCount(0);
});
