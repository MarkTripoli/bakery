/**
 * Writes the stills for the Slack app section of installation integrations
 * (#415). Not a test of behaviour — the behaviour lives in
 * `installation-integrations.spec.ts` — but the same fixtures, so a still shows
 * a state the tests also assert.
 *
 *   BAKERY_EVIDENCE_DIR=~/rig-logs/stills/415-slack \
 *   BAKERY_EVIDENCE_HEAD=abc1234 \
 *     pnpm exec playwright test tests/slack-app-stills.spec.ts --workers=1
 *
 * Each still is written only after the section says what the design promises,
 * so a blank page or a spinner cannot pass as evidence. Skips itself when
 * `BAKERY_EVIDENCE_DIR` is unset, which is every lane run.
 */
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  INTEGRATIONS_PAGE_PATH,
  integrationsFixture,
  slackFixture,
  slackSet,
  slackUnset,
} from "./helpers/installation-integrations-fixtures.ts";

const OUT = process.env.BAKERY_EVIDENCE_DIR;
const THEMES = ["light", "dark"] as const;
const VIEWPORTS = [
  ["desktop-1440x900", { width: 1440, height: 900 }],
  ["phone-390x844", { width: 390, height: 844 }],
] as const;

/** The words the design promises, per state, checked before a still is kept. */
function expectState(state: string, body: string) {
  if (state === "unset") {
    expect(body).toContain("Slack is not set up yet");
    for (
      const label of [
        "Redirect URL",
        "Events request URL",
        "Interactivity request URL",
      ]
    ) {
      expect(body).toContain(label);
    }
    return;
  }
  // A pair Slack refused is not "set up", whatever the stored row says: the
  // block's own top line carries the refusal (#7 audit, #823).
  expect(body).toContain(
    state === "refused-check"
      ? "Slack does not accept these details."
      : "Slack is set up.",
  );
  // A secret is never on screen; only the day it was saved.
  expect(body).not.toContain("evidence-client-secret");
  expect(body).toContain("A0123ABCD");
  expect(body).toContain("1234567890.1234567890");
  expect(body).toContain("Sign-in details");
  expect(body).toContain("Requests from Slack");
}

const STATES = [
  ["unset", () => slackUnset],
  [
    "set",
    () => ({
      ...slackSet,
      detailsCheckedAt: "2026-11-20T10:00:00.000Z",
      detailsCheckResult: "accepted",
      lastRequestAt: "2026-11-20T11:30:00.000Z",
    }),
  ],
  [
    "refused-check",
    () => ({
      ...slackSet,
      detailsCheckedAt: "2026-11-20T10:00:00.000Z",
      detailsCheckResult: "client_id_refused",
    }),
  ],
] as const;

for (const [state, initial] of STATES) {
  for (const theme of THEMES) {
    for (const [label, viewport] of VIEWPORTS) {
      test(`still: ${state} ${theme} ${label}`, async ({ page }) => {
        test.skip(OUT === undefined, "evidence capture runs only when asked");
        const dir = OUT!;
        await mkdir(dir, { recursive: true });
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });

        // The GitHub App registration and the session, which the page also reads.
        await integrationsFixture(page);
        // The app's own state for this still, on top of the shared fixture.
        await page.unroute("**/v1/integrations/slack/app");
        await page.route(
          "**/v1/integrations/slack/app",
          (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(initial()),
            }),
        );

        await page.goto(INTEGRATIONS_PAGE_PATH, {
          waitUntil: "domcontentloaded",
        });
        const section = page.getByTestId("slack-app");
        await section.waitFor({ state: "visible", timeout: 45_000 });
        await expect(section).toContainText(
          state === "unset"
            ? "Slack is not set up yet"
            : state === "refused-check"
            ? "Slack does not accept these details."
            : "Slack is set up.",
        );
        expectState(state, await section.innerText());

        // The section, not the whole page: these stills are about one section,
        // and a full-page shot would shrink the words QA has to compare.
        await section.scrollIntoViewIfNeeded();
        // The section, not the whole page: these stills are about one section,
        // and a full-page shot would shrink the words QA has to compare. The
        // padding keeps the row borders off the image edge, which an element
        // screenshot puts them flush against.
        const box = await section.boundingBox();
        if (box === null) throw new Error("the Slack section has no box");
        // `fullPage` clips in document coordinates; the box is viewport-relative.
        const scrolled = await page.evaluate(() => globalThis.scrollY);
        await page.screenshot({
          path: join(dir, `${state}--${theme}--${label}.png`),
          clip: {
            x: Math.max(0, box.x - 16),
            y: box.y + scrolled - 16,
            width: box.width + 32,
            height: box.height + 32,
          },
          fullPage: true,
        });
        if (process.env.BAKERY_EVIDENCE_FULLPAGE === "1") {
          await page.screenshot({
            path: join(dir, `${state}--${theme}--${label}--page.png`),
            fullPage: true,
          });
        }
      });
    }
  }
}

/**
 * The states a person reaches by pressing something, so each still has to be
 * driven there: the Replace form, the Remove confirmation, and the banner the
 * page shows once the details are gone. They use the stateful `slackFixture`
 * rather than a fixed body, because the press has to be answered.
 */
const INTERACTIONS = [
  {
    state: "replace-form",
    prepare: async (page: import("@playwright/test").Page) => {
      await page.getByRole("button", { name: "Replace details" }).click();
    },
  },
  {
    state: "remove-dialog",
    prepare: async (page: import("@playwright/test").Page) => {
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(
        page.getByRole("alertdialog", {
          name: "Remove the Slack app details?",
        }),
      ).toBeVisible();
    },
  },
  {
    state: "removed",
    prepare: async (page: import("@playwright/test").Page) => {
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      const dialog = page.getByRole("alertdialog", {
        name: "Remove the Slack app details?",
      });
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.getByTestId("slack-app")).toContainText(
        "The Slack app details were removed.",
      );
    },
  },
] as const;

for (const { state, prepare } of INTERACTIONS) {
  for (const theme of THEMES) {
    for (const [label, viewport] of VIEWPORTS) {
      test(`still: ${state} ${theme} ${label}`, async ({ page }) => {
        test.skip(OUT === undefined, "evidence capture runs only when asked");
        const dir = OUT!;
        await mkdir(dir, { recursive: true });
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });

        await integrationsFixture(page);
        // Last registered wins: the app read, put, check and delete answered.
        await slackFixture(page, { ...slackSet, version: 1 });
        await page.goto(INTEGRATIONS_PAGE_PATH, {
          waitUntil: "domcontentloaded",
        });
        const section = page.getByTestId("slack-app");
        await section.waitFor({ state: "visible", timeout: 45_000 });
        await expect(section).toContainText("Slack is set up.");
        await prepare(page);

        // The dialog is its own layer, so a still of the section would miss it:
        // the viewport is what a person sees, and that is what is captured.
        const dialogOpen = state === "remove-dialog";
        await section.scrollIntoViewIfNeeded();
        const box = await section.boundingBox();
        if (box === null) throw new Error("the Slack section has no box");
        const scrolled = await page.evaluate(() => globalThis.scrollY);
        await page.screenshot({
          path: join(dir, `${state}--${theme}--${label}.png`),
          ...(dialogOpen ? {} : {
            clip: {
              x: Math.max(0, box.x - 16),
              y: box.y + scrolled - 16,
              width: box.width + 32,
              height: box.height + 32,
            },
            fullPage: true,
          }),
        });
      });
    }
  }
}
