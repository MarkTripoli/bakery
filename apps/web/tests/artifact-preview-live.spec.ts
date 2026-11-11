import { env } from "node:process";
import { contractSchemas } from "@bakery/contracts/contracts";
import { expect, type Page, test, type TestInfo } from "@playwright/test";
import { setArtifactLocale } from "./helpers/artifact-live-preferences.ts";

const enabled = env.BAKERY_REAL_API === "1" &&
  !!env.BAKERY_ARTIFACT_EMAIL?.trim() &&
  !!env.BAKERY_ARTIFACT_PREVIEW_ORIGIN?.trim();
function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing live preview fixture variable ${name}`);
  return value;
}

/** Signs the page in as the seeded admin and opens the HTML preview artifact. */
async function openPreviewArtifact(page: Page, testInfo: TestInfo) {
  const organizationId = required("BAKERY_ARTIFACT_ORGANIZATION_ID");
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  const sessionCookie = required("BAKERY_ARTIFACT_SESSION_COOKIE");
  const separator = sessionCookie.indexOf("=");
  expect(separator).toBeGreaterThan(0);
  await page.context().addCookies([{
    name: sessionCookie.slice(0, separator),
    value: sessionCookie.slice(separator + 1),
    url: origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  await setArtifactLocale(page, organizationId, origin, "en");
  await page.addInitScript(({ organizationId }) => {
    localStorage.setItem("bakery.organization.lastSelected.v1", organizationId);
  }, { organizationId });
  const path = `/tasks/${required("BAKERY_PREVIEW_TASK_ID")}/artifacts/${
    required("BAKERY_PREVIEW_ARTIFACT_ID")
  }`;
  await page.goto(path);
  return { origin, path };
}

test.describe("live artifact preview", () => {
  test.skip(
    !enabled,
    "requires an isolated real artifact fixture with a preview origin",
  );
  test.describe.configure({ mode: "serial" });

  test(
    "opens an isolated preview, proves its opaque origin, then closes it",
    async ({ page }, testInfo) => {
      const previewOrigin = new URL(required("BAKERY_ARTIFACT_PREVIEW_ORIGIN"))
        .origin;
      const heading = required("BAKERY_PREVIEW_HEADING");
      const { origin } = await openPreviewArtifact(page, testInfo);
      expect(new URL(previewOrigin).hostname).not.toBe(
        new URL(origin).hostname,
      );
      await expect(page.locator('[data-ui-component="artifactViewer"]'))
        .toBeVisible();

      // The create response carries the one-use grant; it is never cached.
      const created = page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(
          `/v1/artifact-versions/${
            required("BAKERY_PREVIEW_VERSION_ID")
          }/preview-grants`,
        )
      );
      await page.getByTestId("artifact-preview-prepare").click();
      const createdResponse = await created;
      expect(createdResponse.status()).toBe(201);
      expect(createdResponse.headers()["cache-control"]).toBe("no-store");
      const grant = contractSchemas.ArtifactPreviewGrant.parse(
        await createdResponse.json(),
      );
      expect(grant.exchangeUrl).toBe(
        `${previewOrigin}/artifact-preview/exchange`,
      );

      // A real form POST in a new browsing context, submitted by the user.
      const form = page.getByTestId("artifact-preview-form");
      await expect(form).toHaveAttribute("method", "post");
      await expect(form).toHaveAttribute("target", "_blank");
      await expect(form).toHaveAttribute("action", grant.exchangeUrl);
      await expect(page.getByRole("timer")).toContainText("expires in");
      const [popup] = await Promise.all([
        page.context().waitForEvent("page"),
        page.getByTestId("artifact-preview-open").click(),
      ]);
      await popup.waitForLoadState("domcontentloaded");
      await expect(popup.locator("h1")).toHaveText(heading);

      // The preview lives on the other origin and carries no Bakery state.
      expect(new URL(popup.url()).origin).toBe(previewOrigin);
      expect(new URL(popup.url()).origin).not.toBe(origin);
      expect(popup.url()).not.toContain(grant.grant);
      expect(new URL(popup.url()).search).toBe("");
      // Opaque origin: no cookie, storage or script access, and the inline
      // script did not run (it would have renamed the document).
      expect(await popup.evaluate(() => globalThis.origin)).toBe("null");
      expect(
        await popup.evaluate(() => {
          try {
            return document.cookie;
          } catch (error) {
            return (error as Error).name;
          }
        }),
      ).toBe("SecurityError");
      expect(
        await popup.evaluate(() => {
          try {
            localStorage.getItem("probe");
            return "readable";
          } catch (error) {
            return (error as Error).name;
          }
        }),
      ).toBe("SecurityError");
      expect(await popup.title()).toBe("isolated preview");
      const all = await popup.context().cookies();
      const jar = all.filter((cookie) =>
        cookie.domain === new URL(previewOrigin).hostname
      );
      expect(jar.map((cookie) => cookie.name)).toEqual([
        "bakery_artifact_preview",
      ]);
      expect(jar[0].httpOnly).toBe(true);
      expect(jar[0].path).toMatch(/^\/artifact-preview\/view\/[0-9a-f-]{36}$/);
      expect(jar[0].sameSite).toBe("Lax");

      // The page dropped the secret and offers the canonical revision link.
      await expect(page.getByTestId("artifact-preview-form")).toHaveCount(0);
      await expect(page.getByTestId("artifact-preview-revision-link"))
        .toHaveAttribute("href", grant.revisionPath);
      expect(await page.content()).not.toContain(grant.grant);

      // Closing revokes the grant and its session; a reload says so.
      const revoked = page.waitForResponse((response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/v1/artifact-preview-grants/${grant.grantId}`)
      );
      await page.getByTestId("artifact-preview-close").click();
      expect((await revoked).status()).toBe(204);
      await expect(page.getByText("Preview closed.", { exact: true }))
        .toBeVisible();
      const reloaded = await popup.reload();
      expect(reloaded?.status()).toBe(410);
      await expect(popup.getByRole("heading", { name: "Preview closed" }))
        .toBeVisible();
      await popup.close();
    },
  );

  test(
    "a second grant opens a second preview beside the first",
    async ({ page }, testInfo) => {
      const previewOrigin = new URL(required("BAKERY_ARTIFACT_PREVIEW_ORIGIN"))
        .origin;
      await openPreviewArtifact(page, testInfo);
      const open = async () => {
        await page.getByTestId("artifact-preview-prepare").click();
        const [popup] = await Promise.all([
          page.context().waitForEvent("page"),
          page.getByTestId("artifact-preview-open").click(),
        ]);
        await popup.waitForLoadState("domcontentloaded");
        return popup;
      };
      const first = await open();
      await expect(page.getByTestId("artifact-preview-prepare")).toBeVisible();
      const second = await open();
      expect(first.url()).not.toBe(second.url());
      expect(new URL(first.url()).origin).toBe(previewOrigin);
      // Per-view cookie paths: reloading the first still renders after the second.
      const reloaded = await first.reload();
      expect(reloaded?.status()).toBe(200);
      await expect(first.locator("h1")).toHaveText(
        required("BAKERY_PREVIEW_HEADING"),
      );
      const names = (await first.context().cookies())
        .filter((cookie) => cookie.domain === new URL(previewOrigin).hostname)
        .map((cookie) => cookie.path);
      expect(new Set(names).size).toBe(2);
      await first.close();
      await second.close();
    },
  );
});
