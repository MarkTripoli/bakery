import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";
import { DEMO_WEBM } from "./helpers/media-fixtures.ts";

/**
 * Real-API proof that a stored video plays in the files page (#445 slice D).
 *
 * One journey against a real server, real session and a real database: a WebM
 * file is stored through `PUT /v1/storage/files`, the files page opens it, and
 * the browser plays it from `/v1/storage/files/<id>/content?organizationId=`.
 * It proves the route authenticates a media element (which cannot send the
 * organization header), answers a Range request with 206 and a Content-Range,
 * decodes a real frame, and keeps playing when the player seeks.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const ADMIN_EMAIL = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase() ||
  "browser-admin@example.test";
const ADMIN_PASSWORD = process.env.BAKERY_REAL_PASSWORD ||
  "Browser-Admin-Passw0rd-1";

async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).toHaveURL("/");
}

test.describe("files video against the real API", () => {
  test.skip(!enabled, "needs the real API stack (BAKERY_REAL_API=1)");

  test("a stored video plays by Range from the real content route", async ({ page, baseURL }) => {
    await signIn(page);
    const origin = new URL(baseURL!).origin;
    const organizations = await page.request.get("/v1/organizations");
    expect(organizations.ok(), await organizations.text()).toBe(true);
    const listed = await organizations.json() as {
      items?: { id: string }[];
    };
    const organizationId = listed.items?.[0]?.id;
    expect(organizationId, "an organization to store the file in").toBeTruthy();

    const name = `real-demo-${Date.now()}.webm`;
    const stored = await page.request.put("/v1/storage/files", {
      headers: {
        "bakery-organization-id": organizationId!,
        origin,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      data: {
        path: `/shared/${name}`,
        mediaType: "video/webm",
        content: DEMO_WEBM.toString("base64"),
      },
    });
    expect(stored.ok(), await stored.text()).toBe(true);

    const contentResponses: {
      status: number;
      range: string | null;
      contentRange: string | null;
    }[] = [];
    page.on("response", (response) => {
      if (!/\/v1\/storage\/files\/[^/]+\/content/.test(response.url())) return;
      contentResponses.push({
        status: response.status(),
        range: response.request().headers()["range"] ?? null,
        contentRange: response.headers()["content-range"] ?? null,
      });
    });

    await page.goto("/files/shared");
    await page.getByRole("link", { name }).click();
    const player = page.locator("video");
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute(
      "src",
      new RegExp(
        `/v1/storage/files/[^/]+/content\\?organizationId=${organizationId}`,
      ),
    );
    // Nothing is read until play is pressed.
    expect(contentResponses).toHaveLength(0);

    await player.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      await video.play();
    });
    await expect.poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).readyState)
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).videoWidth)
    ).toBe(320);
    const ranged = contentResponses.filter((entry) => entry.range !== null);
    expect(ranged.length, JSON.stringify(contentResponses)).toBeGreaterThan(0);
    expect(
      ranged.every((entry) => entry.status === 206),
      JSON.stringify(ranged),
    )
      .toBe(true);
    expect(
      ranged.every((entry) =>
        /^bytes \d+-\d+\/\d+$/.test(entry.contentRange ?? "")
      ),
    )
      .toBe(true);

    // Seeking inside the loaded clip still plays, and no range is refused.
    await player.evaluate((element) => {
      (element as HTMLVideoElement).currentTime = 1.5;
    });
    await expect.poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).seeking)
    ).toBe(false);
    await expect.poll(() =>
      player.evaluate((element) => (element as HTMLVideoElement).currentTime)
    ).toBeGreaterThanOrEqual(1.5);
    expect(
      contentResponses.filter((entry) => entry.range !== null).every((entry) =>
        entry.status === 206
      ),
    ).toBe(true);
  });
});
