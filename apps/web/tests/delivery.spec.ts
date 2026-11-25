import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deliveryFixture } from "./helpers/delivery-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { repository, uuid } from "./helpers/projects-fixture.ts";

registerPageHealth(test);
test("selected merged chart and table use the merge-count samples, not line counts", async ({ page }) => {
  const samples = Array.from({ length: 7 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 5 + index * 3)).toISOString(),
    value: 1,
    unknownReason: null,
  }));
  await deliveryFixture(page, {
    metricPoints: {
      "prs.merged": samples,
      "prs.changedLines": samples.map((sample, index) => ({
        ...sample,
        at: new Date(Date.UTC(2026, 10, 4 + index * 3)).toISOString(),
        value: 34 + index * 6,
      })),
    },
  });
  await page.goto("/delivery");
  const chart = page.getByTestId("delivery-chart");
  await expect(chart.locator("[data-chart-tick='max']")).toHaveText("1");
  await page.getByRole("button", { name: "Show as table" }).click();
  const table = page.getByRole("table", { name: "Pull requests merged" });
  await expect(table.getByRole("row")).toHaveCount(8);
  for (const [index, sample] of samples.entries()) {
    const row = table.getByRole("row").nth(index + 1);
    await expect(row.getByRole("cell")).toHaveText([
      `Nov ${5 + index * 3}, 2026`,
      String(sample.value),
    ]);
  }
});
const SHOW_CHOICES = [
  "Pull requests merged",
  "Pull requests opened",
  "Still open",
  "Closed without merging",
  "Lines changed",
  "Time a task took (typical)",
];

async function chooseShow(page: Page, label: string) {
  await page.getByRole("button", { name: /^Show:/ }).click();
  await page.getByRole("navigation", { name: "Show" }).getByRole("button", {
    name: label,
    exact: true,
    pressed: false,
  }).click();
}

test("Show is a menu of all six series and displays opened and changed lines", async ({ page }) => {
  await deliveryFixture(page);
  await page.goto("/delivery");
  await expect(page.getByRole("combobox", { name: "Show" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Show:/ }).click();
  const menu = page.getByRole("navigation", { name: "Show" });
  const triggerBox = await page.getByRole("button", { name: /^Show:/ })
    .boundingBox();
  const menuBox = await menu.boundingBox();
  expect(menuBox!.x).toBeGreaterThanOrEqual(triggerBox!.x - 1);
  for (const choice of SHOW_CHOICES) {
    await expect(menu.getByRole("button", { name: choice, exact: true }))
      .toBeVisible();
  }
  await expect(
    menu.getByRole("button", {
      name: "Pull requests merged",
      exact: true,
      pressed: true,
    }),
  ).toBeVisible();
  await page.mouse.move(700, 700);
  await still(page, "delivery-show-menu");
  await page.keyboard.press("Escape");
  await chooseShow(page, "Pull requests opened");
  await expect(
    page.getByRole("img", { name: "Pull requests opened" }),
  ).toBeVisible();
  await chooseShow(page, "Lines changed");
  await expect(page.getByRole("img", { name: "Lines changed" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show as table" }).click();
  await expect(
    page.getByRole("table", { name: "Lines changed" }).getByRole(
      "columnheader",
      { name: "Lines changed" },
    ),
  ).toBeVisible();
});

/** Answers the effective-access read with a role and the given capabilities. */
const access = (route: Route, capabilities: string[]) => {
  const organizationId = /organizations\/([^/]+)\/effective-access/.exec(
    route.request().url(),
  )![1];
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ organizationId, role: "developer", capabilities }),
  });
};

async function accessible(page: Page) {
  const results = await new AxeBuilder({ page }).include("main").analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

/** The Delivery page (#75): what was delivered, how long a task took, where the time went. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: delivery`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the page says how long a task took and where the time went", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      await expect(page.getByRole("heading", { name: "Delivery", level: 1 }))
        .toBeVisible();
      // The Repository and Period controls sit right of the title on a desktop, in the header on a phone.
      await expect(page.getByRole("button", { name: /^Repository:/ }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: /^Period:/ }))
        .toBeVisible();
      await expect(
        page.locator("[data-section='delivery-over-time']").getByText(
          "Every day has a measurement for Pull requests merged in this period.",
        ),
      ).toBeVisible();
      const time = page.getByTestId("delivery-time");
      await expect(time.getByRole("heading", { name: "How long a task took" }))
        .toBeVisible();
      await expect(time.getByText(/^Typical:/)).toBeVisible();
      await expect(time.getByText(/9 in 10 took less than/)).toBeVisible();
      // Two tasks reached a completed run, so the sentence names both delivery points.
      await expect(time.getByText(/for the 2 of 8 tasks with no pull request/))
        .toBeVisible();
      // The bar's key lists every part with its time, and Not accounted for is its own part.
      const bar = time.getByRole("img", { name: /^Where the time went:/ });
      await expect(bar).toBeVisible();
      // The bar says what its hours are: added up, not an average.
      await expect(time.getByRole("heading", { name: "Where the time went" }))
        .toBeVisible();
      await expect(time.getByText(/added up across 8 tasks, not an average/))
        .toBeVisible();
      for (
        const label of [
          "Agent working",
          "Waiting in queue",
          "In review",
          "Waiting for a person",
          "Not accounted for",
        ]
      ) await expect(time.getByText(label, { exact: true })).toBeVisible();
      // Blocked is not a part of the bar: Bakery keeps no history of it.
      await expect(time.getByText("Blocked: Unknown.")).toBeVisible();
      await expect(time.getByText("Not accounted for:")).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "delivery-time");
    });

    test("the task records show where each task stopped and what no record covers", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery?show=tasks");
      const records = page.getByTestId("delivery-records");
      await expect(records.getByText("merged pull request").first())
        .toBeVisible();
      await expect(records.getByText("completed run").first()).toBeVisible();
      if (viewport.name === "phone") {
        // A phone has stacked rows with every value labelled, not a clipped table.
        await expect(records.getByRole("list")).toBeVisible();
        await expect(records.getByText(/^Not accounted for:/).first())
          .toBeVisible();
        await expect(records.getByText(/^Agent working:/).first())
          .toBeVisible();
      } else {
        // Each row adds up: the four waits and what no record covers sit beside Total.
        for (
          const header of [
            "Total",
            "Agent working",
            "Waiting in queue",
            "In review",
            "Waiting for a person",
            "Not accounted for",
          ]
        ) {
          await expect(records.getByRole("columnheader", { name: header }))
            .toBeVisible();
        }
      }
      await expect(records.getByRole("columnheader", { name: "Blocked" }))
        .toHaveCount(0);
      await expect(records.getByRole("columnheader", { name: "Repository" }))
        .toHaveCount(0);
      await accessible(page);
      await page.mouse.move(700, 700);
      await still(page, "delivery-records-tasks", records);
    });

    test("fewer than five tasks are listed, not summarised", async ({ page }) => {
      await deliveryFixture(page, { merged: 2, runs: 1 });
      await page.goto("/delivery");
      const time = page.getByTestId("delivery-time");
      await expect(time.getByText("Too few tasks to summarise (3)."))
        .toBeVisible();
      await expect(time.getByText(/^Typical:/)).toHaveCount(0);
      // The bar is not drawn for a handful of tasks; the records still list them.
      await expect(time.getByRole("img", { name: /^Where the time went:/ }))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "delivery-too-few");
    });

    test("nothing unaccounted shows no hatched part, and the sentence follows the delivery points", async ({ page }) => {
      await deliveryFixture(page, {
        merged: 7,
        runs: 0,
        allAccountedFor: true,
      });
      await page.goto("/delivery");
      const time = page.getByTestId("delivery-time");
      await expect(
        time.getByText(/to a merged pull request\. Includes waiting/),
      )
        .toBeVisible();
      await expect(time.getByText("Not accounted for", { exact: true }))
        .toHaveCount(0);
      await expect(time.getByText("Blocked: Unknown.")).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "delivery-no-unaccounted");
    });

    test("all runs, and tasks left out for a missing time", async ({ page }) => {
      await deliveryFixture(page, { merged: 0, runs: 6, leftOut: 1 });
      await page.goto("/delivery");
      const time = page.getByTestId("delivery-time");
      await expect(time.getByText(/to a completed run\. Includes waiting/))
        .toBeVisible();
      await expect(time.getByText(/1 task was left out for a missing time/))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "delivery-runs-left-out");
    });

    test("pull request rows show real times and the reason a value is missing; a chosen figure marks the whole tile", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      const records = page.getByTestId("delivery-records");
      await expect(records.getByText("Add the metrics read")).toBeVisible();
      await expect(records.getByText(/Not line-counted/).first())
        .toBeVisible();
      const tile = page.getByRole("button", {
        name: /^Tasks delivered, 8\./,
        pressed: false,
      });
      const before = await tile.boundingBox();
      await tile.click();
      const chosen = page.getByRole("button", {
        name: /^Tasks delivered, 8\./,
        pressed: true,
      });
      await expect(chosen).toBeVisible();
      // The task records load: rows, not "could not be loaded".
      await expect(records.getByText("Tidy the settings page")).toBeVisible();
      await expect(records.getByText("The records could not be loaded."))
        .toHaveCount(0);
      const after = await chosen.boundingBox();
      expect(after).toEqual(before);
      expect(
        await page.evaluate(() => document.activeElement?.id),
      ).toBe("delivery-records-heading");
      await expect(records.getByRole("heading", { level: 2 }))
        .toContainText("Tasks delivered");
      await page.mouse.move(700, 700);
      await still(page, "delivery-pull-requests");
    });

    test("Lines changed records show counts and missing reasons", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      await chooseShow(page, "Lines changed");
      const records = page.getByTestId("delivery-records");
      const rowRole = viewport.name === "phone" ? "listitem" : "row";
      const known = records.getByRole(rowRole).filter({
        hasText: "Fix the retry window",
      });
      const missing = records.getByRole(rowRole).filter({
        hasText: "Tidy the settings copy",
      });
      if (viewport.name === "phone") {
        await expect(missing).toContainText(
          "Lines: Not line-counted · diff totals unavailable",
        );
      } else {
        await expect(records.getByRole("columnheader", { name: "Lines" }))
          .toBeVisible();
        await expect(known.getByRole("cell", { name: "51" })).toBeVisible();
        await expect(missing.getByRole("cell", {
          name: "Not line-counted · diff totals unavailable",
        })).toBeVisible();
      }
      await chooseShow(page, "Pull requests merged");
      const merged = records.getByRole(rowRole).filter({
        hasText: "Fix the retry window",
      });
      await expect(merged).toContainText("51");
    });

    test("Size and quality: lines, what could not be counted as a link to those records, and an honest Unknown", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      const section = page.getByTestId("delivery-quality");
      await expect(section.getByRole("heading", { name: "Size and quality" }))
        .toBeVisible();
      await expect(section.getByText("237 lines in 4 pull requests"))
        .toBeVisible();
      await expect(
        page.getByText(/merged pull requests? could not be line-counted/),
      ).toHaveCount(0);
      const sizes = await section.evaluate((root) => {
        const fontSize = (text: string) =>
          parseFloat(
            getComputedStyle(
              Array.from(root.querySelectorAll("*")).find((element) =>
                element.children.length === 0 && element.textContent === text
              )!,
            ).fontSize,
          );
        return {
          label: fontSize("Could not be line-counted"),
          value: fontSize("237 lines in 4 pull requests"),
        };
      });
      expect(sizes.value).toBeGreaterThanOrEqual(sizes.label);
      await expect(
        section.getByText("Counted once for each merged pull request."),
      ).toBeHidden();
      await section.getByRole("button", { name: "About lines changed" })
        .click();
      await expect(
        page.getByText("Counted once for each merged pull request."),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        section.getByText("Unknown. Not counted for the whole period yet."),
      )
        .toBeVisible();
      await section.getByRole("button", {
        name: "Show the 1 pull request that could not be line-counted",
      }).click();
      expect(
        await page.evaluate(() => document.activeElement?.id),
      ).toBe("delivery-records-heading");
      await expect(page).toHaveURL(/show=lines/);
      await expect(page).toHaveURL(/missing=/);
      const records = page.getByTestId("delivery-records");
      const rowRole = viewport.name === "phone" ? "listitem" : "row";
      await expect(records.getByText("Tidy the settings copy")).toBeVisible();
      await expect(records.getByText("Fix the retry window")).toHaveCount(0);
      await expect(
        records.getByRole(rowRole).filter({
          hasText: "Not line-counted",
        }),
      ).toHaveCount(1);
      await page.mouse.move(700, 700);
      await still(page, "delivery-size-and-quality");
    });

    test("Size and quality hides the uncounted row when every pull request was counted", async ({ page }) => {
      await deliveryFixture(page, { uncounted: 0 });
      await page.goto("/delivery");
      const section = page.getByTestId("delivery-quality");
      await expect(section.getByText("237 lines in 4 pull requests"))
        .toBeVisible();
      await expect(section.getByText("Could not be line-counted"))
        .toHaveCount(0);
    });

    test("offline says when the figures were last updated, and online says nothing", async ({ page, context }) => {
      await deliveryFixture(page);
      await page.goto("/delivery");
      await expect(page.getByTestId("delivery-quality")).toBeVisible();
      await expect(page.getByText(/^You are offline\./)).toHaveCount(0);
      await context.setOffline(true);
      await page.evaluate(() => globalThis.dispatchEvent(new Event("offline")));
      await expect(
        page.getByText(/^You are offline\. These figures were loaded at \d/),
      ).toHaveCount(1);
      await page.mouse.move(700, 700);
      await still(page, "delivery-offline");
      await context.setOffline(false);
      await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
      await expect(page.getByText(/^You are offline\./)).toHaveCount(0);
    });

    test("a reversed custom range names the end to fix, and asks for nothing", async ({ page }) => {
      const seen = await deliveryFixture(page);
      const before = seen.metricReads;
      await page.goto("/delivery?period=custom&from=2026-11-20&to=2026-11-10");
      await expect(
        page.getByText("Choose an end date after the start date."),
      ).toBeVisible();
      expect(seen.metricReads).toBe(before);
      await page.mouse.move(700, 700);
      await still(page, "delivery-range-reversed");
    });

    test("over time: one line, a named gap, the Show menu and the table", async ({ page }) => {
      await deliveryFixture(page);
      await page.goto("/delivery?show=tasks");
      await expect(page.getByRole("heading", { name: "Over time" }))
        .toBeVisible();
      const chart = page.getByTestId("delivery-chart");
      await expect(chart).toBeVisible();
      await expect(page.getByText(/A gap is not zero/)).toBeVisible();
      const band = chart.locator("[data-gap-band]");
      await expect(band).toHaveCount(1);
      expect(Number(await band.getAttribute("width"))).toBeGreaterThan(100);
      if (viewport.name === "phone") {
        await expect(chart.getByText(/^No data, /)).toHaveCount(0);
        await expect(page.getByText(/\(no data, Nov 3, 2026\)/))
          .toBeVisible();
      } else {
        await expect(chart.getByText("No data, Nov 3, 2026")).toBeVisible();
        await expect(
          page.getByText("No data for 1 day. A gap is not zero."),
        ).toBeVisible();
      }
      await expect(chart.locator("[data-chart-tick='max']")).toHaveText("40 h");
      const chartBox = await chart.boundingBox();
      expect(chartBox!.height).toBe(200);
      await expect(chart.locator("[data-chart-point]")).toHaveCount(1);
      const firstCaption = await page.getByText(/^Nov 1, 2026$/).boundingBox();
      const lastCaption = await page.getByText(/^Nov 4, 2026$/).boundingBox();
      expect(Math.abs(firstCaption!.y - lastCaption!.y)).toBeLessThan(2);
      expect(lastCaption!.x).toBeGreaterThan(firstCaption!.x);
      const table2 = page.getByRole("table", {
        name: "Time a task took (typical)",
      });
      await page.getByRole("button", { name: "Show as table" }).click();
      await expect(table2).toBeVisible();
      await expect(table2.getByRole("columnheader", { name: "Date" }))
        .toBeVisible();
      await expect(
        table2.getByRole("columnheader", {
          name: "Time a task took (typical)",
        }),
      ).toBeVisible();
      await expect(table2.getByText("40 h")).toBeVisible();
      await expect(table2.getByText("No data")).toHaveCount(1);
      await page.getByRole("button", { name: "Show as chart" }).click();
      await expect(page.getByTestId("delivery-chart")).toBeVisible();
      await accessible(page);
      await page.mouse.move(700, 700);
      await still(page, "delivery-over-time");
    });
    test("a period over 90 days labels complete weekly samples as weeks", async ({ page }) => {
      const samples = Array.from({ length: 13 }, (_, index) => ({
        at: new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString(),
        value: 1,
        unknownReason: null,
      }));
      const seen = await deliveryFixture(page, {
        metricPoints: { "prs.merged": samples },
      });
      await page.goto(
        "/delivery?period=custom&from=2026-01-01&to=2026-04-01",
      );
      await expect(page.getByTestId("delivery-chart")).toBeVisible();
      await expect.poll(() => seen.metricResolutions).toContain("week");
      await expect(
        page.locator("[data-section='delivery-over-time']").getByText(
          "Every week has a measurement for Pull requests merged in this period.",
        ),
      ).toBeVisible();
    });

    test("a failed chart stays inside Over time and retries without replacing the page", async ({ page }) => {
      const seen = await deliveryFixture(page, { chartFailsUntilRetry: true });
      await page.goto(
        "/delivery?period=custom&from=2026-01-01&to=2026-06-01",
      );
      const chart = page.locator("[data-section='delivery-over-time']");
      await expect(chart.getByText("The chart could not be loaded."))
        .toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Pull requests merged, 11\./ }),
      ).toBeVisible();
      seen.restoreChart();
      await chart.getByRole("button", { name: "Try again" }).click();
      await expect(chart.getByTestId("delivery-chart")).toBeVisible();
    });

    test("a dense series keeps the band label off the line", async ({ page }) => {
      await deliveryFixture(page);
      const days = Array.from({ length: 90 }, (_, index) => {
        const at = new Date(Date.UTC(2026, 7, 1 + index)).toISOString();
        return {
          at,
          value: index === 45 ? null : 30 + (index % 7),
          unknownReason: null,
        };
      });
      await page.route(
        (url) => url.pathname === "/v1/metrics",
        (route) => {
          const metric = new URL(route.request().url()).searchParams.get(
            "metric",
          );
          if (metric !== "tasks.leadTimeHours") return route.fallback();
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              name: metric,
              points: days,
              from: days[0]!.at,
              to: days.at(-1)!.at,
              resolution: "day",
              unit: "hours",
              cohort: "Tasks delivered in the window.",
              sampleCount: 89,
              missingCount: 1,
              measurementRevision: "metrics@3",
              lastSyncAt: "2026-10-30T09:00:00.000Z",
              completeness: "complete",
              missingReasons: [],
              hiddenCount: 0,
              repositories: [{
                repositoryId: repository(1, uuid(100), "web").id,
                state: "connected",
                since: null,
                lastSyncAt: "2026-10-30T09:00:00.000Z",
              }],
              summary: {
                median: 32,
                p90: 36,
                mean: 33,
                breakdown: [],
                deliveryPoints: [],
              },
            }),
          });
        },
      );
      await page.goto("/delivery?show=tasks");
      const chart = page.getByTestId("delivery-chart");
      await expect(chart).toBeVisible();
      await expect(chart.locator("[data-gap-band]")).toHaveCount(1);
      await expect(chart.getByText(/^No data, /)).toHaveCount(0);
      await expect(page.getByText(/A gap is not zero/)).toBeVisible();
    });

    test("a period with no measurement says so and draws no line", async ({ page }) => {
      await deliveryFixture(page, { nothingMeasured: true });
      await page.goto("/delivery?show=tasks");
      await expect(
        page.getByText("No data for this period. A gap is not zero."),
      ).toBeVisible();
      await expect(page.getByTestId("delivery-chart")).toHaveCount(0);
    });

    test("every metrics read is made for the page's organization", async ({ page }) => {
      const seen = await deliveryFixture(page);
      await page.goto("/delivery");
      await expect(page.getByRole("heading", { name: "Delivery", level: 1 }))
        .toBeVisible();
      expect(seen.organizationHeaders.length).toBeGreaterThanOrEqual(5);
      expect(new Set(seen.organizationHeaders)).toEqual(
        new Set([MOCK_ORGANIZATION_ID]),
      );
    });

    if (viewport.name === "desktop") {
      test("the rail lists Delivery for a reader with metric:read", async ({ page }) => {
        await deliveryFixture(page);
        await page.route(
          "**/v1/organizations/*/effective-access",
          (route) => access(route, ["metric:read"]),
        );
        await page.goto("/delivery");
        await expect(page.getByRole("link", { name: "Delivery", exact: true }))
          .toBeVisible();
        await page.mouse.move(700, 700);
        await still(page, "delivery-rail");
      });

      test("the rail does not list Delivery without metric:read", async ({ page }) => {
        await deliveryFixture(page);
        await page.route(
          "**/v1/organizations/*/effective-access",
          (route) => access(route, []),
        );
        await page.goto("/delivery");
        await expect(page.getByRole("link", { name: "Projects", exact: true }))
          .toBeVisible();
        await expect(page.getByRole("link", { name: "Delivery", exact: true }))
          .toHaveCount(0);
      });
    }
  });
}
