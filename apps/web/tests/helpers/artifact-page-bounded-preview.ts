import { expect, test } from "@playwright/test";
import { PATH, stubArtifactPage, version } from "./artifact-page-fixture.ts";

const MIB = 1_048_576;

function contentRequests(page: import("@playwright/test").Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/content")) urls.push(request.url());
  });
  return urls;
}

test("a 10 MiB text body is never fetched or rendered inline and downloads verified", async ({ page }) => {
  const body = "A".repeat(10 * MIB);
  const current = version(body);
  await stubArtifactPage(page, { current, content: body });
  const requests = contentRequests(page);
  await page.goto(PATH);
  await expect(page.getByText("Too large to preview", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(/text is over the 1 MiB inline preview limit/))
    .toBeVisible();
  await expect(page.locator('[data-ui-component="artifactViewer"] pre'))
    .toHaveCount(0);
  expect(requests).toEqual([]);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verified bytes" }).first()
    .click();
  expect((await download).suggestedFilename()).toMatch(/-r2\.bin$/);
  await expect(page.getByTestId("artifact-retrieval-download-verified"))
    .toContainText(current.sha256);
  expect(requests).toHaveLength(1);
});

test("a body that outgrows its advertised size is cancelled at the preview bound", async ({ page }) => {
  const honest = "small";
  const body = "B".repeat(2 * MIB);
  // The metadata lies: it advertises five bytes, the server streams 2 MiB.
  await stubArtifactPage(page, { current: version(honest), content: body });
  // Wait on the content response itself, then allow for the bounded read and
  // render under load; the default 5s covers neither on a busy host.
  const content = page.waitForResponse((response) =>
    response.url().includes("/content")
  );
  await page.goto(PATH);
  await content;
  await expect(page.getByText("Too large to preview", { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("BBBBBBBB")).toHaveCount(0);
  await expect(page.locator('[data-ui-component="artifactViewer"] pre'))
    .toHaveCount(0);
});

test(
  "a very long single line stays inside the viewer without page overflow",
  async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: "tall-page" });
    const line = "x".repeat(262_144);
    await stubArtifactPage(page, { current: version(line), content: line });
    await page.goto(PATH);
    const viewer = page.locator('[data-ui-component="artifactViewer"] pre');
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate((node) => node.textContent?.length)).toBe(
      262_144,
    );
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    const box = await viewer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  },
);

test("RTL text and bidi controls render as literal inert text inside the viewer", async ({ page }) => {
  const bidi = [
    "مرحبا بالعالم ‮evil‬ ⁦isolate⁩ ‏‎ end",
    "const access = ‮⁦ // admin only ⁩ ⁦",
    "<script>document.body.dataset.compromised='yes'</script>",
  ].join("\n");
  await stubArtifactPage(page, { current: version(bidi), content: bidi });
  await page.goto(PATH);
  const viewer = page.locator('[data-ui-component="artifactViewer"] pre');
  await expect(viewer).toBeVisible();
  // Every control character survives byte for byte; none is dropped or applied
  // to the surrounding page.
  expect(await viewer.evaluate((node) => node.textContent)).toBe(bidi);
  await expect(viewer.locator("script")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-compromised",
    "yes",
  );
  const heading = page.getByRole("heading", { level: 1 });
  const before = await heading.boundingBox();
  const viewerBox = await viewer.boundingBox();
  expect(before).not.toBeNull();
  expect(viewerBox).not.toBeNull();
  // The override cannot reorder or move the page chrome outside the viewer.
  expect(before!.y + before!.height).toBeLessThanOrEqual(viewerBox!.y);
});
