import { env } from "node:process";
import { contractSchemas } from "@bakery/contracts/contracts";
import { expect, type Page, test, type TestInfo } from "@playwright/test";
import { openComments } from "./helpers/artifact-page-fixture.ts";
import { setArtifactLocale } from "./helpers/artifact-live-preferences.ts";
import { requestUntilAccepted } from "./helpers/api-retry.ts";

const enabled = env.BAKERY_REAL_API === "1" &&
  !!env.BAKERY_ARTIFACT_EMAIL?.trim();
function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing live artifact fixture variable ${name}`);
  return value;
}

type Session = Readonly<{
  organizationId: string;
  taskId: string;
  artifactId: string;
  path: string;
  origin: string;
}>;

/** Signs the page in as the seeded admin and pins its locale and organization. */
async function openSession(
  page: Page,
  testInfo: TestInfo,
): Promise<Session> {
  const email = required("BAKERY_ARTIFACT_EMAIL");
  const organizationId = required("BAKERY_ARTIFACT_ORGANIZATION_ID");
  const taskId = required("BAKERY_ARTIFACT_TASK_ID");
  const artifactId = required("BAKERY_ARTIFACT_ID");
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  const sessionCookie = env.BAKERY_ARTIFACT_SESSION_COOKIE;
  if (sessionCookie) {
    const separator = sessionCookie.indexOf("=");
    expect(separator).toBeGreaterThan(0);
    await page.context().addCookies([{
      name: sessionCookie.slice(0, separator),
      value: sessionCookie.slice(separator + 1),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    }]);
  } else {
    const login = await requestUntilAccepted(() =>
      page.request.post("/api/auth/sign-in/email", {
        headers: { Origin: origin },
        data: { email, password: required("BAKERY_ARTIFACT_PASSWORD") },
      })
    );
    expect(login.ok()).toBe(true);
  }
  await setArtifactLocale(page, organizationId, origin, "en");
  await page.addInitScript(({ organizationId }) => {
    localStorage.setItem("bakery.organization.lastSelected.v1", organizationId);
  }, { organizationId });
  return {
    organizationId,
    taskId,
    artifactId,
    path: `/tasks/${taskId}/artifacts/${artifactId}`,
    origin,
  };
}

/**
 * Reads the organization's storage usage through the API. After a pin the page
 * refetches its storage query and cancels the fetch in flight when it does,
 * and a late `response.json()` on an intercepted page response once found no
 * body on the mobile project (CI run 41316449298). Whether that response had
 * been cancelled was not observed, so no body is read from a page response.
 */
async function readStorage(page: Page, session: Session) {
  const response = await page.request.get("/v1/artifact-storage", {
    headers: {
      "Bakery-Organization-Id": session.organizationId,
      Origin: session.origin,
    },
  });
  expect(response.status()).toBe(200);
  return contractSchemas.ArtifactStorage.parse(await response.json());
}

test.describe("live artifact review", () => {
  test.skip(!enabled, "requires an isolated real artifact fixture");
  // Every case signs the same principal in and sets its account-wide locale.
  test.describe.configure({ mode: "serial" });
  test(
    "persists comments, resolution, and Admin pins through real APIs",
    async ({ page }, testInfo) => {
      const session = await openSession(page, testInfo);
      const { artifactId, path } = session;
      const storage = page.waitForResponse((response) =>
        response.url().endsWith("/v1/artifact-storage")
      );
      await page.goto(path);
      await expect(page.locator('[data-ui-component="artifactViewer"]'))
        .toBeVisible();
      expect((await storage).status()).toBe(200);
      const usage = await readStorage(page, session);
      expect(usage.state).toBe("unmonitored");
      expect(usage.retainedBytes).toBeGreaterThan(0);
      expect(usage.pinnedBytes).toBe(0);

      const pin = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/v1/artifacts/${artifactId}`)
      );
      const pinnedStorage = page.waitForResponse((response) =>
        response.url().endsWith("/v1/artifact-storage")
      );
      await page.getByRole("button", { name: "Pin artifact", exact: true })
        .click();
      expect((await pin).status()).toBe(200);
      expect((await pinnedStorage).status()).toBe(200);
      const pinnedUsage = await readStorage(page, session);
      expect(pinnedUsage.pinnedBytes).toBeGreaterThan(0);
      await expect(
        page.getByRole("button", { name: "Unpin artifact", exact: true }),
      ).toBeEnabled();
      await page.reload();
      await page.getByRole("button", { name: "Unpin artifact", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Unpin artifact" });
      await expect(dialog).toContainText(
        "Unpinning allows expired versions to be collected",
      );
      const unpin = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/v1/artifacts/${artifactId}`)
      );
      await dialog.getByRole("button", { name: "Unpin artifact", exact: true })
        .click();
      expect((await unpin).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Pin artifact", exact: true }),
      ).toBeEnabled();

      await openComments(page);
      const body =
        `Live ${testInfo.project.name} review ${crypto.randomUUID()}`;
      await page.getByLabel("Comment", { exact: true }).fill(body);
      const create = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().includes("/comments")
      );
      await page.getByRole("button", { name: "Post comment", exact: true })
        .click();
      expect((await create).ok()).toBe(true);
      const thread = page.locator('[id^="comment-"]').filter({ hasText: body });
      await expect(thread).toBeVisible();
      const resolve = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().includes("/artifact-comments/")
      );
      await thread.getByRole("button", { name: "Resolve", exact: true })
        .click();
      expect((await resolve).status()).toBe(200);
      await expect(thread.getByRole("button", { name: "Reopen", exact: true }))
        .toBeVisible();
      await page.reload();
      await openComments(page);
      await expect(thread.getByRole("button", { name: "Reopen", exact: true }))
        .toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("live-review.png"),
        fullPage: true,
      });
    },
  );
  test(
    "switches revisions, keeps the stale notice honest and honours ?version= deep links",
    async ({ page }, testInfo) => {
      const { taskId } = await openSession(page, testInfo);
      const artifactId = required("BAKERY_REVIEW_ARTIFACT_ID");
      const version1 = required("BAKERY_REVIEW_VERSION1_ID");
      const version2 = required("BAKERY_REVIEW_VERSION2_ID");
      const text1 = required("BAKERY_REVIEW_VERSION1_TEXT");
      const text2 = required("BAKERY_REVIEW_VERSION2_TEXT");
      const path = `/tasks/${taskId}/artifacts/${artifactId}`;
      const viewer = page.locator('[data-ui-component="artifactViewer"]');
      const stale = page.getByText("A newer revision is available", {
        exact: true,
      });
      await page.goto(path);
      await expect(viewer).toContainText(text2);
      await expect(stale).toHaveCount(0);

      await page.getByTestId("artifact-retrieval-details-toggle").click();
      await page.getByTestId("artifact-version-1").click();
      await expect(page).toHaveURL(new RegExp(`version=${version1}`));
      await expect(viewer).toContainText(text1);
      await expect(viewer).not.toContainText(text2);
      await expect(stale).toBeVisible();
      await expect(page.getByTestId("artifact-retrieval-open-newest"))
        .toHaveText("Open revision 2");

      await page.reload();
      await expect(viewer).toContainText(text1);
      await expect(stale).toBeVisible();

      await page.getByTestId("artifact-retrieval-open-newest").click();
      await expect(page).toHaveURL(new RegExp(`version=${version2}`));
      await expect(viewer).toContainText(text2);
      await expect(stale).toHaveCount(0);

      // A fresh navigation straight to the older revision verifies its bytes.
      await page.goto(`${path}?version=${version1}`);
      await expect(viewer).toContainText(text1);
      await page.goto(`${path}?version=${version2}`);
      await expect(viewer).toContainText(text2);
    },
  );

  test(
    "binds a comment to its own revision through reply, edit, a 412 conflict and resolve",
    async ({ page }, testInfo) => {
      const session = await openSession(page, testInfo);
      const artifactId = required("BAKERY_REVIEW_ARTIFACT_ID");
      const version1 = required("BAKERY_REVIEW_VERSION1_ID");
      const text1 = required("BAKERY_REVIEW_VERSION1_TEXT");
      const path = `/tasks/${session.taskId}/artifacts/${artifactId}`;
      const unique = crypto.randomUUID();
      const body = `Revision one note ${testInfo.project.name} ${unique}`;
      const edited = `${body} (edited)`;

      // Author the root on revision one.
      await page.goto(`${path}?version=${version1}`);
      await expect(page.locator('[data-ui-component="artifactViewer"]'))
        .toContainText(text1);
      await openComments(page);
      await page.getByLabel("Comment", { exact: true }).fill(body);
      const create = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/artifact-versions/${version1}/comments`)
      );
      await page.getByRole("button", { name: "Post comment", exact: true })
        .click();
      expect((await create).ok()).toBe(true);
      const thread = page.locator('[id^="comment-"]').filter({
        hasText: body,
      });
      await expect(thread).toBeVisible();
      const rootId = (await thread.getAttribute("id"))!.slice(
        "comment-".length,
      );

      // The newest revision shows the same root as outdated and links back to
      // the immutable revision it was written on.
      await page.goto(path);
      await openComments(page);
      const outdated = page.locator(`#comment-${rootId}`);
      await expect(outdated).toBeVisible();
      await outdated.getByRole("link", { name: "Open original revision" })
        .click();
      await expect(page).toHaveURL(new RegExp(`version=${version1}`));
      await expect(page).toHaveURL(new RegExp(`comment=${rootId}`));
      await expect(page.locator(`#comment-${rootId}`)).toBeFocused();
      await expect(page.locator('[data-ui-component="artifactViewer"]'))
        .toContainText(text1);

      // A direct ?comment= deep link lands on the same revision and comment.
      await page.goto(`${path}?version=${version1}&comment=${rootId}`);
      await expect(page.locator(`#comment-${rootId}`)).toBeFocused();

      // Edit sends If-Match for the version the editor read.
      const root = page.locator(`#comment-${rootId}`);
      await root.getByRole("button", { name: "Edit comment" }).click();
      await root.getByLabel("Edit comment text").fill(edited);
      const patch = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/v1/artifact-comments/${rootId}`)
      );
      await root.getByRole("button", { name: "Save comment" }).click();
      const saved = await patch;
      expect(saved.status()).toBe(200);
      expect(saved.request().headers()["if-match"]).toMatch(/^"v\d+"$/);
      const savedBody = await saved.json();
      expect(savedBody.body).toBe(edited);
      await expect(root).toContainText(edited);
      expect(savedBody.artifactVersionId).toBe(version1);

      // A second writer edits the same comment. The live event refreshes the
      // page's copy, so the stale validator is replayed explicitly below.
      const headers = {
        "Bakery-Organization-Id": session.organizationId,
        Origin: session.origin,
      };
      const staleEtag = saved.request().headers()["if-match"];
      const outOfBand = await page.request.patch(
        `/v1/artifact-comments/${rootId}`,
        {
          headers: {
            ...headers,
            "If-Match": staleEtag.replace(/\d+/, String(savedBody.version)),
            "Idempotency-Key": crypto.randomUUID(),
          },
          data: { body: `${body} (edited elsewhere)` },
        },
      );
      expect(outOfBand.status()).toBe(200);
      // The server event reaches the open page with no reload or click: the
      // comment shows the other writer's text.
      await expect(root).toContainText(`${body} (edited elsewhere)`, {
        timeout: 20_000,
      });
      // The precondition is real on the wire: the validator just used is refused.
      const refused = await page.request.patch(
        `/v1/artifact-comments/${rootId}`,
        {
          headers: {
            ...headers,
            "If-Match": `"v${savedBody.version}"`,
            "Idempotency-Key": crypto.randomUUID(),
          },
          data: { body: "must not be stored" },
        },
      );
      expect(refused.status()).toBe(412);
      await page.route(
        `**/v1/artifact-comments/${rootId}`,
        (route) =>
          route.continue({
            headers: { ...route.request().headers(), "if-match": staleEtag },
          }),
        { times: 1 },
      );

      await root.getByRole("button", { name: "Edit comment" }).click();
      await root.getByLabel("Edit comment text").fill(`${body} (conflict)`);
      const conflict = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/v1/artifact-comments/${rootId}`)
      );
      await root.getByRole("button", { name: "Save comment" }).click();
      expect((await conflict).status()).toBe(412);
      await expect(root.getByText(/This discussion changed/)).toBeVisible();
      await root.getByRole("button", { name: "Reload comments" }).click();
      await expect(root).toContainText(`${body} (edited elsewhere)`);
      await expect(root).not.toContainText("must not be stored");

      // Reply stays on the root's own revision.
      await root.getByRole("button", { name: "Reply", exact: true }).click();
      const replyBody = `Reply ${unique}`;
      await page.getByLabel("Comment", { exact: true }).fill(replyBody);
      const reply = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/artifact-versions/${version1}/comments`)
      );
      await page.getByRole("button", { name: "Send reply", exact: true })
        .click();
      expect((await reply).ok()).toBe(true);
      // Replies page separately from their root; open them if still folded.
      const folded = root.getByRole("button", { name: "Load replies" });
      await expect(folded.or(root.getByText(replyBody))).toBeVisible();
      if (await folded.isVisible()) await folded.click();
      await expect(root.getByText(replyBody)).toBeVisible();

      // Resolve survives a reload.
      const resolve = page.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/v1/artifact-comments/${rootId}`)
      );
      await root.getByRole("button", { name: "Resolve", exact: true }).click();
      const resolved = await resolve;
      expect(resolved.status()).toBe(200);
      expect(resolved.request().headers()["if-match"]).toMatch(/^"v\d+"$/);
      await expect(root.getByRole("button", { name: "Reopen", exact: true }))
        .toBeVisible();
      await page.reload();
      await openComments(page);
      await expect(
        page.locator(`#comment-${rootId}`).getByRole("button", {
          name: "Reopen",
          exact: true,
        }),
      ).toBeVisible();
    },
  );

  test(
    "sends a selected comment to the agent as an explicit, non-resolving request",
    async ({ page }, testInfo) => {
      const session = await openSession(page, testInfo);
      const artifactId = required("BAKERY_REVIEW_ARTIFACT_ID");
      const path = `/tasks/${session.taskId}/artifacts/${artifactId}`;
      const body =
        `Please revise ${testInfo.project.name} ${crypto.randomUUID()}`;
      await page.goto(path);
      await openComments(page);
      await page.getByLabel("Comment", { exact: true }).fill(body);
      const create = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().includes("/comments")
      );
      await page.getByRole("button", { name: "Post comment", exact: true })
        .click();
      expect((await create).ok()).toBe(true);
      const thread = page.locator('[id^="comment-"]').filter({
        hasText: body,
      });
      await expect(thread).toBeVisible();
      await thread.getByRole("checkbox", {
        name: "Include comment in agent request",
      }).check();
      await page.getByRole("button", { name: "Send to agent", exact: true })
        .click();
      const request = `Apply the review note ${crypto.randomUUID()}`;
      await page.getByLabel("Agent request", { exact: true }).fill(request);
      const message = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().includes("/messages")
      );
      await page.getByRole("button", { name: "Send request", exact: true })
        .click();
      const sent = await message;
      expect(sent.ok()).toBe(true);
      const persisted = await sent.json();
      expect(persisted.intent).toBe("agent_request");
      expect(persisted.body).toBe(request);
      expect(persisted.commentContext).not.toBeNull();
      await expect(page.getByText("Request queued. Comments remain open."))
        .toBeVisible();
      // Sending asks the agent; it never resolves the thread.
      await expect(
        thread.getByRole("button", { name: "Resolve", exact: true }),
      ).toBeVisible();
    },
  );

  test(
    "shows the expired state for a version whose bytes retention purged",
    async ({ page }, testInfo) => {
      await openSession(page, testInfo);
      const taskId = required("BAKERY_EXPIRED_TASK_ID");
      const artifactId = required("BAKERY_EXPIRED_ARTIFACT_ID");
      const expired = page.waitForResponse((response) =>
        response.url().includes("/artifact-versions/") &&
        response.url().endsWith("/content")
      );
      await page.goto(`/tasks/${taskId}/artifacts/${artifactId}`);
      expect((await expired).status()).toBe(410);
      await expect(page.getByText("Content expired", { exact: true }))
        .toBeVisible();
      await expect(page.getByTestId("artifact-retrieval-provenance"))
        .toContainText(required("BAKERY_EXPIRED_SHA256"));
      await expect(
        page.locator(
          '[data-ui-component="artifactViewer"]:not([data-variant="unsupported"])',
        ),
      ).toHaveCount(0);
      // Version identity and discussion stay reachable behind the tombstone.
      await openComments(page);
    },
  );

  test(
    "denies a Guest without artifact permission and leaks no artifact data",
    async ({ browser, page }, testInfo) => {
      const session = await openSession(page, testInfo);
      const origin = session.origin;
      const context = await browser.newContext({
        baseURL: origin,
        viewport: page.viewportSize() ?? undefined,
      });
      try {
        const cookie = required("BAKERY_DENIED_SESSION_COOKIE");
        const separator = cookie.indexOf("=");
        await context.addCookies([{
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: origin,
          httpOnly: true,
          sameSite: "Lax",
        }]);
        const denied = await context.newPage();
        await denied.addInitScript(({ organizationId }) => {
          localStorage.setItem(
            "bakery.organization.lastSelected.v1",
            organizationId,
          );
        }, { organizationId: session.organizationId });
        const artifactId = required("BAKERY_REVIEW_ARTIFACT_ID");
        const api = await denied.request.get(`/v1/artifacts/${artifactId}`, {
          headers: { "Bakery-Organization-Id": session.organizationId },
        });
        // The server hides the artifact's existence from a principal without
        // permission; a 403 would be equally closed.
        expect([403, 404]).toContain(api.status());
        const content = await denied.request.get(
          `/v1/artifact-versions/${
            required("BAKERY_REVIEW_VERSION1_ID")
          }/content`,
          { headers: { "Bakery-Organization-Id": session.organizationId } },
        );
        expect([403, 404]).toContain(content.status());
        expect(await content.text()).not.toContain(
          required("BAKERY_REVIEW_VERSION1_TEXT"),
        );
        await denied.goto(
          `/tasks/${session.taskId}/artifacts/${artifactId}`,
        );
        await expect(
          denied.getByTestId(
            api.status() === 403
              ? "artifact-retrieval-forbidden"
              : "artifact-retrieval-unavailable",
          ),
        ).toBeVisible();
        await expect(denied.locator('[data-ui-component="artifactViewer"]'))
          .toHaveCount(0);
        await expect(denied.getByLabel("Comment", { exact: true }))
          .toHaveCount(0);
        await expect(
          denied.getByText(required("BAKERY_REVIEW_VERSION2_TEXT")),
        ).toHaveCount(0);
      } finally {
        await context.close();
      }
    },
  );
});
