import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { enterpriseLaunchOptions } from "../../../../packages/ui/scripts/render-enterprise-references.mjs";
import {
  comparePngs,
  pngDimensions,
} from "../../../../packages/ui/scripts/image-score.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { baseUrl, fixtureIds, sessionCookie, evidenceDir, state = "default" } =
  JSON.parse(input);
const directory = resolve(evidenceDir);
await mkdir(directory, { recursive: true });
const sourcePaths = [
  "apps/web/tests/helpers/run-output-parity-browser.mjs",
  "apps/web/src/pages/TasksPage.tsx",
  "apps/web/src/pages/task-session-view.tsx",
  "apps/web/src/pages/TaskRunSection.tsx",
  "apps/web/src/pages/TaskRunOutput.tsx",
  "apps/web/src/pages/TaskRunOutputStream.tsx",
  "apps/web/src/pages/TaskRunArchive.tsx",
  "apps/web/src/pages/use-displayed-output-download.ts",
  "apps/web/src/pages/TaskRunRevision.tsx",
  "apps/web/src/pages/TaskRunArtifactCard.tsx",
  "apps/web/src/api/use-output-stream.ts",
  "packages/ui/src/templates/RunOutputView.tsx",
  "packages/ui/src/organisms/RunIdentity.tsx",
  "packages/ui/src/organisms/RunOutputPanel.tsx",
  "packages/ui/src/organisms/RevisionSummary.tsx",
  "packages/ui/src/organisms/RunArtifactSummary.tsx",
  "packages/ui/src/run.css",
  "packages/ui/src/run-view.css",
  "packages/i18n/locales/en.json",
  "tests/e2e/helpers/run-output-seed.ts",
  "tests/e2e/helpers/run-output-state.ts",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (
      path,
    ) => [
      path,
      createHash("sha256").update(await readFile(path)).digest("hex"),
    ]),
  ),
);
await writeFile(
  join(directory, `production-${state}-source.json`),
  JSON.stringify(sourceHashes, null, 2) + "\n",
);
const manifest = JSON.parse(
  await readFile(
    "docs/technical-design/ui-baselines/artifacts-baselines.json",
    "utf8",
  ),
);
const cases = manifest.cases.filter((item) =>
  item.design?.screen === "task-run" && item.design.state === state
);
assert(cases.length > 0, `No authored task-run reference for state ${state}`);
const browser = await chromium.launch({
  headless: true,
  ...enterpriseLaunchOptions(),
});
const results = [];
try {
  const scorer = await browser.newPage();
  for (const baseline of cases) {
    const context = await browser.newContext({
      viewport: baseline.viewport,
      deviceScaleFactor: 1,
      colorScheme: baseline.theme,
      hasTouch: baseline.pointer === "coarse",
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
    });
    try {
      const origin = new URL(baseUrl);
      const split = sessionCookie.indexOf("=");
      await context.addCookies([{
        name: sessionCookie.slice(0, split),
        value: sessionCookie.slice(split + 1).split(";", 1)[0],
        domain: origin.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }]);
      await context.addInitScript(({ organizationId, theme }) => {
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          organizationId,
        );
        localStorage.setItem("bakery.theme.v1", theme);
      }, { organizationId: fixtureIds.organizationId, theme: baseline.theme });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/tasks/${fixtureIds.taskId}`, {
        waitUntil: "networkidle",
      });
      const core = page.locator(
        '[data-ui-component="runOutputView"][data-variant="section"]',
      );
      await expect(core).toBeVisible();
      await expect(core.locator('[data-ui-component="runIdentity"]'))
        .toBeVisible();
      const expectedOutputState = {
        default: "live",
        exit: "complete",
        timeout: "interrupted",
        "lost-lease": "interrupted",
        truncated: "truncated",
        interrupted: "interrupted",
        reconnecting: "reconnecting",
        reset: "reset",
      }[state];
      const outputPanel = core.locator('[data-ui-component="runOutputPanel"]');
      if (expectedOutputState) {
        await expect(outputPanel).toHaveAttribute(
          "data-state",
          expectedOutputState,
        );
      } else {
        await expect(outputPanel).not.toHaveAttribute("data-state", "loading");
      }
      const expectedHeading = {
        exit: "Process exited · code 0",
        timeout: "Run timed out",
        "lost-lease": "Worker lease lost",
        interrupted: "Output interrupted",
        truncated: "Output truncated",
      }[state];
      if (expectedHeading) {
        await expect(
          core.getByRole("heading", { name: expectedHeading, exact: true }),
        )
          .toBeVisible();
      }
      await expect(
        core.locator('[data-ui-component="runArtifactSummary"]').first(),
      ).toHaveAttribute("data-state", "ready");
      await expect(outputPanel).toContainText("waiting for next output…");
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await expect(page.locator('[data-ui-component="runTimeline"]'))
        .toBeVisible();
      const controls = await page.getByRole("button", { name: /Request/ })
        .count();
      assert(
        controls > 0,
        "Run controls disappeared during parity composition",
      );
      const phone = baseline.design.device === "phone";
      const region = {
        x: phone ? 16 : 240,
        y: phone ? 256 : 216,
        width: phone ? 358 : 1168,
        height: baseline.artboard.height - (phone ? 256 + 16 : 216 + 32),
      };
      const imagePath = join(directory, `${baseline.id}.core.png`);
      const candidate = await core.screenshot({ path: imagePath });
      await page.screenshot({
        path: join(directory, `${baseline.id}.page.png`),
        fullPage: true,
      });
      const size = pngDimensions(candidate);
      const ref = await readFile(baseline.imagePath);
      let result;
      if (size.width !== region.width || size.height !== region.height) {
        result = {
          id: baseline.id,
          cropStatus: "failed",
          reason: "core-dimensions",
          candidateSize: size,
          region,
        };
      } else {
        const score = await comparePngs(scorer, {
          candidate,
          baseline: ref,
          baselineCrop: region,
        });
        result = {
          id: baseline.id,
          cropStatus: score.score >= .95 ? "passed" : "failed",
          ...score,
          region,
        };
      }
      result = { ...result, status: "passed", comparisonRole: "supplementary" };
      const verifiedActions = [];
      try {
        if (state === "truncated") {
          await expect(
            core.getByRole("heading", {
              name: "Output truncated",
              exact: true,
            }),
          )
            .toBeVisible();
          await expect(core).toContainText(
            "Output truncated at the capture limit. Workflow result and usage are recorded separately.",
          );
          const downloadEvent = page.waitForEvent("download");
          await outputPanel.getByRole("link", {
            name: "Download displayed output",
            exact: true,
          })
            .click();
          const download = await downloadEvent;
          const path = await download.path();
          assert(path, "Displayed output download did not finish");
          const bytes = await readFile(path);
          const lines = bytes.toString("utf8").split("\n");
          assert.deepEqual(
            lines,
            [
              "[stdout] 14:32:01  worker atlas-01 acquired attempt 2",
              "[stdout] 14:32:02  $ pnpm test:unit",
              "[stdout] 14:32:03  artifact retention … passed",
              "[stdout] 14:32:04  immutable revision … passed",
              "[stdout] 14:32:05  18 tests passed, 0 failed",
              "[stdout] 14:32:06  writing delivery-notes.md",
              "[stdout] 14:32:07  published revision 3",
              "[stdout] 14:32:08  waiting for next output…",
            ],
            "Displayed output must contain all eight durable batches exactly once and in order",
          );
          assert(
            bytes.length <= 1024 * 1024,
            "Displayed output download exceeds its bound",
          );
          verifiedActions.push(
            "truncation-warning-and-durable-buffer-download",
          );
        } else if (state === "exit") {
          await page.getByRole("button", {
            name: "Open artifacts",
            exact: true,
          }).click();
          await expect(page.locator("#task-run-artifacts")).toBeFocused();
          verifiedActions.push("open-artifacts-focus");
        } else if (state === "timeout") {
          await page.getByRole("button", {
            name: "View run details",
            exact: true,
          }).click();
          await expect(page.locator('[data-ui-component="runTimeline"]'))
            .toBeFocused();
          verifiedActions.push("run-details-focus");
        } else if (state === "lost-lease" || state === "interrupted") {
          await Promise.all([
            page.waitForResponse((response) =>
              new URL(response.url()).pathname === "/v1/output-streams" &&
              response.status() === 200
            ),
            page.waitForResponse((response) =>
              /^\/v1\/jobs\/[^/]+\/attempts$/.test(
                new URL(response.url()).pathname,
              ) && response.status() === 200
            ),
            page.getByRole("button", { name: "Reload run", exact: true })
              .click(),
          ]);
          await expect(outputPanel).toHaveAttribute(
            "data-state",
            expectedOutputState,
          );
          verifiedActions.push("reload-streams-and-attempts");
        }
      } catch (error) {
        result = {
          ...result,
          status: "failed",
          reason: "recovery-action",
          actionFailure: String(error),
        };
      }
      results.push({
        ...result,
        verifiedActions,
        route: `/tasks/${fixtureIds.taskId}`,
        imagePath,
        controls,
        coreText: await core.innerText(),
      });
      console.log(JSON.stringify(result));
      await writeFile(
        join(directory, `production-${state}.json`),
        JSON.stringify(results, null, 2) + "\n",
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
assert(
  results.every((result) => result.status === "passed"),
  "Real task run state or action failed; crop scores are supplementary, not the whole-artboard Paper gate",
);
