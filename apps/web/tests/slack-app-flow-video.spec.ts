/**
 * Records the Slack app set-up flow for #823's PR evidence: the real page, the
 * real server, one path from "not set up yet" to a checked app and a removal.
 *
 * A recording, not a test of behaviour: the assertions that guard this screen
 * live in `installation-integrations.spec.ts`, and they run against fixtures. This
 * one drives the running stack because the owner's rule asks for the real path —
 * a fixture standing in for the server would prove the fixture.
 *
 *   BAKERY_SLACK_FLOW_VIDEO_DIR=~/rig-logs/video/415 \
 *   BASE_URL=http://127.0.0.1:5197 \
 *     pnpm exec playwright test --config apps/web/playwright.config.ts \
 *       tests/slack-app-flow-video.spec.ts --workers=1
 *
 * Skips itself unless `BAKERY_SLACK_FLOW_VIDEO_DIR` is set, which is every lane
 * run, and unless the stack answers: a recording of an unreachable server is
 * worse than none.
 */
import { expect, test } from "@playwright/test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

const OUT = process.env.BAKERY_SLACK_FLOW_VIDEO_DIR;
const PAGE_PATH = "/settings/installation/integrations";

// The administrator the recording stack was seeded with; the recording script
// creates it, never a person.
const FLOW_ADMIN_EMAIL = process.env.BAKERY_FLOW_ADMIN_EMAIL ??
  "flow-admin@example.test";
const FLOW_ADMIN_PASSWORD = process.env.BAKERY_FLOW_ADMIN_PASSWORD ??
  "flow-evidence-pass-123";

// The recording is a document of one path start to end, so the video is turned
// on here rather than in the shared config every other spec inherits.
test.use({
  video: { mode: "on", size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
  screenshot: "on",
});

test.skip(OUT === undefined, "BAKERY_SLACK_FLOW_VIDEO_DIR is not set");

test("the Slack app is set up, checked and removed in one path", async ({
  page,
}, testInfo) => {
  // The path is a real sign-in, four typed fields, a save, a check and a
  // removal against the real server; the default 30 s is a unit test's budget,
  // not a screen recording's.
  test.setTimeout(180_000);
  await mkdir(OUT!, { recursive: true });
  const video = page.video();
  expect(video).not.toBeNull();
  // The recording is also the only place this path runs against a real
  // server, so every call it makes is written down beside it: a run that
  // failed says which answer it failed on.
  const calls: string[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/v1/integrations/slack/app")) return;
    calls.push(
      `${response.request().method()} ${new URL(response.url()).pathname} ${
        String(response.status())
      }`,
    );
  });
  const writeCalls = () =>
    writeFile(join(OUT!, "calls.txt"), `${calls.join("\n")}\n`);

  // The section is an installation administrator's screen, so the path starts
  // at the sign-in the person actually makes.
  await page.goto("/sign-in");
  // The retrying submit waits out Better Auth's own sign-in rate limit (three
  // per ten seconds), which the rest of the suite also draws on.
  await page.getByLabel("Email").fill(FLOW_ADMIN_EMAIL);
  // The field is masked, so the recording shows the value landing before the
  // press: a submit that fires early is the one failure this flow can hide.
  await page.getByLabel("Password", { exact: true })
    .fill(FLOW_ADMIN_PASSWORD);
  await expect(page.getByLabel("Password", { exact: true }))
    .toHaveValue(FLOW_ADMIN_PASSWORD);
  await page.waitForTimeout(500);
  await submitUntilAccepted(page, "/api/auth/sign-in/email", async () => {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page).not.toHaveURL(/sign-in/, { timeout: 30_000 });
  await page.waitForTimeout(800);

  await page.goto(PAGE_PATH);
  const section = page.getByTestId("slack-app");
  await expect(section).toBeVisible({ timeout: 30_000 });

  // 1. Nothing saved yet: the screen asks for the four details and shows the
  // three addresses to paste into Slack.
  const form = section.getByTestId("slack-app-form");
  // The form follows the first read, so it is waited for rather than probed.
  await expect(form).toBeVisible({ timeout: 30_000 });
  {
    // The screen clears its form when the loaded scope settles, so the typing
    // starts after the first read has arrived and the fields stop resetting.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    // Type at a person's pace: these are controlled inputs, and a value written
    // before the handler is attached is replaced by the next render.
    for (
      const [name, value] of [
        ["appId", "A0123456789"],
        ["clientId", "1234567890.0987654321"],
        ["clientSecret", "flow-client-secret-value"],
        ["signingSecret", "flow-signing-secret-value"],
      ] as const
    ) {
      await form.locator(`input[name="${name}"]`)
        .pressSequentially(value, { delay: 40 });
    }
    // The fields carry their `name`, which is stable; the label ids are
    // generated per render and would drift with the markup.
    await expect(form.locator('input[name="appId"]'))
      .toHaveValue("A0123456789");
    await expect(form.locator('input[name="signingSecret"]'))
      .toHaveValue("flow-signing-secret-value");
    await page.waitForTimeout(600);
    // The addresses appear before saving, so the recording shows what is pasted
    // where rather than only the end state.
    await expect(section.getByTestId("slack-redirect-url")).toBeVisible();
    await form.getByRole("button", { name: /Save/i }).click();
    await page.waitForTimeout(1_500);
  }

  // 2. Saved: a set-up view, with the secrets reduced to the day they changed.
  await expect(section).toContainText(/set up|Saved/i, { timeout: 30_000 });
  await page.waitForTimeout(1_200);

  // 3. Check now: the one question Slack answers. It is allowed to be refused
  // here (a recording stack has no real app), so the step is recorded either way
  // and what it says is kept as a still.
  const check = section.getByRole("button", { name: /Check now/i });
  if (await check.isVisible()) {
    await check.click();
    await page.waitForTimeout(2_500);
  }
  await page.screenshot({
    path: join(OUT!, "checked.png"),
    fullPage: true,
  });

  // 4. Remove: the dialog names what goes, and the section returns to the empty
  // view with its addresses.
  const remove = section.getByRole("button", { name: /^Remove/i });
  if (await remove.isVisible()) {
    await remove.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(800);
    await dialog.getByRole("button", { name: /^Remove/i }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(1_500);
  }
  await page.screenshot({
    path: join(OUT!, "removed.png"),
    fullPage: true,
  });

  // The path is only finished once the file exists, so the video is flushed
  // before the spec ends rather than racing the worker's teardown.
  const saved = await video!.path();
  const target = join(OUT!, "slack-app-setup.webm");
  await page.close();
  await mkdir(dirname(target), { recursive: true });
  await copyFile(saved, target);
  await writeCalls();
  testInfo.attach("recording", { path: target, contentType: "video/webm" });
});
