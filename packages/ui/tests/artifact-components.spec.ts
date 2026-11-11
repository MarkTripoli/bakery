import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import {
  catalog,
  openRuntimeFixture,
  runtimeAssertions,
} from "./storybook-harness.ts";

const evidenceDir = resolve(
  import.meta.dirname,
  "../../../.omo/evidence/artifact-components",
);
const story = (name: string, level = "organisms") =>
  `/iframe.html?id=bakery-${level}-${name}--contract&viewMode=story`;

test("renders hostile Markdown as inert text and safe links", async ({ page }) => {
  await page.goto(story("artifactviewer"));
  const viewer = page.getByRole("region", { name: "Untrusted Markdown" });
  await expect(viewer.getByRole("heading", { name: "Safe heading" }))
    .toBeVisible();
  await expect(viewer.locator("script, img, iframe, object, embed"))
    .toHaveCount(0);
  await expect(viewer.locator('a[href^="javascript:"], a[href^="data:"]'))
    .toHaveCount(0);
  await expect(viewer.getByRole("link", { name: "Safe link" })).toHaveAttribute(
    "href",
    "https://example.test/docs",
  );
  await expect(viewer).toContainText("<script>");
  await expect(page.getByText("Must not render before verification"))
    .toHaveCount(0);
  await expect(page.getByText("Must not render after verification failure"))
    .toHaveCount(0);
  await expect(page.getByRole("img", { name: "Verified PNG fixture" }))
    .toHaveAttribute("src", /^blob:/);
  await viewer.screenshot({
    path: resolve(evidenceDir, "hostile-markdown.png"),
  });
});

test("selects immutable versions and excludes unavailable versions", async ({ page }) => {
  await page.goto(story("versionpicker", "molecules"));
  await page.getByRole("combobox", { name: "Version", exact: true })
    .selectOption("2");
  await expect(page.getByRole("status")).toHaveText("Selected revision 2");
  await expect(
    page.getByRole("option", { name: "Revision 1 · expired" }).first(),
  ).toHaveJSProperty("disabled", true);
  await page.getByRole("combobox", { name: "Version", exact: true }).press(
    "End",
  );
  await expect(page.getByRole("combobox", { name: "Version", exact: true }))
    .toHaveValue("2");
  await expect(page.getByRole("combobox", { name: "Unavailable versions" }))
    .toBeDisabled();
  await page.screenshot({ path: resolve(evidenceDir, "selected-version.png") });
});

test("preserves patch markers and the original final newline", async ({ page }) => {
  await page.goto(story("artifactviewer"));
  const patch = page.getByRole("region", { name: "Preview · Patch" });
  await expect(patch.locator("code")).toHaveJSProperty(
    "textContent",
    "--- a/evidence.ts\n+++ b/evidence.ts\n-volatile\n+durable",
  );
});

test("submits a reply and resolves the discussion", async ({ page }) => {
  await page.goto(story("commentrail"));
  await page.getByRole("textbox", { name: "Reply to discussion" }).fill(
    "Retain these verified bytes.",
  );
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Retain these verified bytes.")).toBeVisible();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator('[data-ui-component="artifactDiscussion"]'))
    .toHaveAttribute("data-state", "resolved");
  await page.screenshot({ path: resolve(evidenceDir, "resolved-reply.png") });
});

test("contains comment-sheet focus and returns it on Escape", async ({ page }) => {
  await page.goto(story("commentsheet"));
  const trigger = page.getByRole("button", { name: "Open comments" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Comments" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await dialog.screenshot({ path: resolve(evidenceDir, "comment-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("preserves send-dialog errors and cancels accessibly", async ({ page }) => {
  await page.goto(story("sendtoagentdialog"));
  const trigger = page.getByRole("button", {
    name: "Send to agent",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Send to agent",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Show failed submission" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Instruction could not be sent.",
  );
  await expect(dialog.getByRole("textbox", { name: "Instruction" }))
    .toHaveValue("Keep this revision pinned for the audit.");
  await dialog.screenshot({ path: resolve(evidenceDir, "agent-error.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

for (const width of [390, 1280]) {
  test(`contains artifact layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(story("artifactlayout", "templates"));
    await expect(
      page.getByRole("heading", { name: "Implementation notes", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
    await page.screenshot({
      path: resolve(evidenceDir, `layout-${width}.png`),
      fullPage: true,
    });
  });
}

const artifactComponents = [
  "VersionPicker",
  "ArtifactViewer",
  "CommentRail",
  "CommentSheet",
  "ArtifactDiscussion",
  "ArtifactTombstone",
  "CapacityBanner",
  "SendToAgentDialog",
  "ArtifactLayout",
];
for (const name of artifactComponents) {
  test(`exposes the declared semantic contract for ${name}`, async ({ page }) => {
    const entry = catalog.entries.find((candidate) =>
      candidate.storyTitle.endsWith("/" + name)
    );
    if (!entry) throw new Error(`Missing catalog entry: ${name}`);
    const level = entry.storyTitle.split("/")[1]?.toLowerCase();
    const fixture = await openRuntimeFixture(
      page,
      `bakery-${level}-${name.toLowerCase()}--contract`,
      "desktop-light-fine",
      ["axe", "containment"],
    );
    await runtimeAssertions(page, fixture.runtimeCase, fixture.context, entry);
    await page.screenshot({
      path: resolve(evidenceDir, `contract-${name}.png`),
      fullPage: true,
    });
  });
}

for (const dismissal of ["button", "escape"] as const) {
  test(`keeps the comment sheet and draft when nested agent dialog closes by ${dismissal}`, async ({ page }) => {
    await page.goto(story("commentsheet"));
    await page.getByRole("button", { name: "Open comments" }).click();
    const sheet = page.getByRole("dialog", { name: "Comments", exact: true });
    await sheet.getByRole("textbox", { name: "Reply to discussion" }).fill(
      "Keep this draft.",
    );
    const trigger = sheet.getByRole("button", {
      name: "Send to agent",
      exact: true,
    });
    await trigger.click();
    const agent = page.getByRole("dialog", {
      name: "Send discussion to agent",
      exact: true,
    });
    await expect(agent).toBeVisible();
    if (dismissal === "button") {
      await agent.getByRole("button", { name: "Cancel agent request" }).click();
    } else await page.keyboard.press("Escape");
    await expect(agent).not.toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: "Reply to discussion" }))
      .toHaveValue("Keep this draft.");
    await expect(trigger).toBeFocused();
    await page.screenshot({
      path: resolve(evidenceDir, `nested-agent-${dismissal}.png`),
    });
  });
}
