import { expect, type Page, type Route, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deliveryFixture } from "./helpers/delivery-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { repository, uuid } from "./helpers/projects-fixture.ts";

registerPageHealth(test);

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
        await expect(page.getByText(/\(no data, Nov 2, 2026\)/))
          .toBeVisible();
      } else {
        await expect(chart.getByText("No data, Nov 2, 2026")).toBeVisible();
        await expect(
          page.getByText("No data for 1 day. A gap is not zero."),
        ).toBeVisible();
      }
      await expect(chart.locator("[data-chart-tick='max']")).toHaveText("40");
      const chartBox = await chart.boundingBox();
      expect(chartBox!.height).toBe(200);
      await expect(chart.locator("[data-chart-point]")).toHaveCount(1);
      const firstCaption = await page.getByText(/^Oct 31, 2026$/).boundingBox();
      const lastCaption = await page.getByText(/^Nov 3, 2026$/).boundingBox();
      expect(Math.abs(firstCaption!.y - lastCaption!.y)).toBeLessThan(2);
      expect(lastCaption!.x).toBeGreaterThan(firstCaption!.x);
      const table2 = page.getByRole("table", { name: "Tasks delivered" });
      await page.getByRole("button", { name: "Show as table" }).click();
      await expect(table2).toBeVisible();
      await expect(table2.getByRole("columnheader", { name: "Date" }))
        .toBeVisible();
      await expect(
        table2.getByRole("columnheader", { name: "Tasks delivered" }),
      )
        .toBeVisible();
      await expect(table2.getByText("No data")).toHaveCount(1);
      await page.getByRole("button", { name: "Show as chart" }).click();
      await expect(page.getByTestId("delivery-chart")).toBeVisible();
      await accessible(page);
      await page.mouse.move(700, 700);
      await still(page, "delivery-over-time");
    });
    test("a period over 90 days asks for weekly chart points", async ({ page }) => {
      const seen = await deliveryFixture(page);
      await page.goto(
        "/delivery?period=custom&from=2026-01-01&to=2026-06-01",
      );
      await expect(page.getByRole("heading", { name: "Over time" }))
        .toBeVisible();
      await expect.poll(() => seen.metricResolutions).toContain("week");
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
