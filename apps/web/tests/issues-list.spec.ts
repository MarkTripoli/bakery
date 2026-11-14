import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Issues list (design-ux, #56): the saved copy of the organization's GitHub
 * issues, one status and one control per row, Can start by default.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOURCE_ID = uuid(900);

type Check = {
  id: string;
  status: string;
  reason: string;
  evidence?: string[];
};
type Seed = {
  number: number;
  title: string;
  state?: "open" | "closed";
  labels?: string[];
  verdict?: "ready" | "waiting" | "rejected" | null;
  checks?: Check[];
  request?: { disposition: string; dispositionReason?: string | null } | null;
};

const ticket = (seed: Seed) => {
  const state = seed.state ?? "open";
  return {
    id: uuid(seed.number),
    organizationId: MOCK_ORGANIZATION_ID,
    ticketSourceId: SOURCE_ID,
    externalTicketId: `gh-${seed.number}`,
    key: `acme/web#${seed.number}`,
    number: String(seed.number),
    safeUrl: `https://github.com/acme/web/issues/${seed.number}`,
    snapshot: {
      title: seed.title,
      body: "",
      bodyTruncated: false,
      labels: seed.labels ?? ["ready for agent"],
      state,
      stateReason: null,
      locked: false,
      repositoryFullName: "acme/web",
      links: null,
    },
    requirementsDigest: "0".repeat(64),
    providerUpdateMarker: "m",
    visibility: "private",
    state,
    lastObservedAt: "2026-01-01T00:00:00.000Z",
    latestReadiness: seed.verdict
      ? {
        id: uuid(seed.number + 5000),
        version: 1,
        verdict: seed.verdict,
        checks: (seed.checks ?? []).map((check) => ({
          ...check,
          evidence: (check.evidence ?? []).map((ref) => ({ ref })),
        })),
        requirementsDigest: "0".repeat(64),
        dependencyDigest: "0".repeat(64),
        basisDigest: "0".repeat(64),
        sourcePolicyRevision: 1,
        evaluatedAt: "2026-01-01T00:00:00.000Z",
      }
      : null,
    activeRequest: seed.request
      ? {
        id: uuid(seed.number + 7000),
        intent: "start",
        generation: 1,
        disposition: seed.request.disposition,
        dispositionReason: seed.request.dispositionReason ?? null,
        workflowRunId: null,
      }
      : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
};

const ready: Check[] = [{ id: "source_live", status: "pass", reason: "ok" }];

const OPEN: Seed[] = [
  { number: 201, title: "Add invoice export", verdict: "ready", checks: ready },
  {
    number: 202,
    title: "Show the export button",
    verdict: "waiting",
    checks: [{
      id: "dependencies_satisfied",
      status: "wait",
      reason: "predecessor_open",
      evidence: ["blocker:acme/web#201"],
    }],
  },
  {
    number: 203,
    title: "Archive old invoices",
    verdict: "rejected",
    checks: [{
      id: "acceptance_present",
      status: "reject",
      reason: "acceptance_missing",
    }],
  },
  {
    number: 204,
    title: "Fix rounding on totals",
    verdict: "ready",
    checks: ready,
    request: { disposition: "active" },
  },
  { number: 205, title: "Review the new report layout", verdict: null },
];
const CLOSED: Seed[] = [
  { number: 190, title: "Old checkout bug", state: "closed", verdict: null },
];

type Options = {
  open?: Seed[];
  closed?: Seed[];
  sources?: "none" | "healthy" | "degraded";
  pageSize?: number;
};

/** Stubs the session, the role, the sources and the issues; returns the requests seen. */
async function issuesFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const seen = { lists: [] as string[], syncs: 0 };
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: "admin",
          capabilities: [],
        }),
      }),
  );
  const sourcesMode = options.sources ?? "healthy";
  await page.route(
    (url) => url.pathname === "/v1/ticket-sources",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: sourcesMode === "none" ? [] : [{
            id: SOURCE_ID,
            organizationId: MOCK_ORGANIZATION_ID,
            integrationConnectionId: uuid(901),
            integrationResourceId: uuid(902),
            applicationId: uuid(904),
            repositoryId: uuid(903),
            externalContainerId: "acme/web",
            enabled: true,
            policy: {},
            policyRevision: 1,
            syncHealth: sourcesMode === "degraded" ? "degraded" : "healthy",
            lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            lastProblemCode: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          }],
          nextCursor: null,
        }),
      }),
  );
  await page.route(
    (url) => /^\/v1\/ticket-sources\/[^/]+\/syncs$/.test(url.pathname),
    (route) => {
      seen.syncs += 1;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ operationId: uuid(950), status: "queued" }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/external-tickets",
    (route) => {
      const url = new URL(route.request().url());
      seen.lists.push(url.search);
      const closed = url.searchParams.get("state") === "closed";
      const all = (closed ? options.closed ?? CLOSED : options.open ?? OPEN)
        .map(ticket);
      const size = options.pageSize ?? 25;
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      const items = all.slice(offset, offset + size);
      const next = offset + size < all.length ? `c${offset + size}` : null;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, nextCursor: next }),
      });
    },
  );
  return seen;
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: issues list`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    // A row, on a wide screen or a phone, by the issue it shows.
    const row = (page: Page, number: number) =>
      page.locator(`[data-issue-id="${uuid(number)}"]`);

    test("shows only what can start by default, and everything open under All open, each row with one status and one reason", async ({ page }) => {
      await issuesFixture(page);
      await page.goto("/issues");
      await expect(page.getByRole("heading", { name: "Issues", level: 1 }))
        .toBeVisible();
      await expect(page.getByText(
        "Issues from your connected GitHub repositories, and whether Bakery can start on each.",
      )).toBeVisible();
      await expect(row(page, 201)).toContainText("Can start");
      // Every row's line starts with its repository.
      await expect(row(page, 201)).toContainText("acme/web");
      await expect(row(page, 202)).toHaveCount(0);
      // The age of the saved copy.
      await expect(page.getByText("Updated from GitHub 5 minutes ago"))
        .toBeVisible();
      await page.getByRole("radio", { name: "All open" }).click({
        force: true,
      });
      await expect(row(page, 202)).toContainText("Waiting");
      await expect(row(page, 202)).toContainText(
        "acme/web · Depends on #201, which is still open.",
      );
      await expect(row(page, 203)).toContainText("Cannot start");
      await expect(row(page, 203)).toContainText(
        "acme/web · The issue has no acceptance criteria.",
      );
      await expect(row(page, 204)).toContainText("In progress");
      await expect(row(page, 204)).toContainText(
        "acme/web · Bakery is working on this.",
      );
      await expect(row(page, 205)).toContainText("Not checked");
      await expect(row(page, 205)).toContainText(
        "acme/web · Bakery has not checked this issue yet.",
      );
      // One control per row: the issue on GitHub, in a new tab.
      for (const number of [201, 202, 203, 204, 205]) {
        const link = row(page, number).getByRole("link");
        await expect(link).toHaveCount(1);
        await expect(link).toHaveAttribute(
          "href",
          `https://github.com/acme/web/issues/${number}`,
        );
        await expect(link).toHaveAttribute("target", "_blank");
      }
      // The pointer rests away from the rail, so no item looks hovered.
      await page.mouse.move(700, 700);
      await shot(page, "issues-list");
    });

    test("In progress shows what Bakery is working on, and Closed asks for closed issues", async ({ page }) => {
      const seen = await issuesFixture(page);
      await page.goto("/issues");
      await page.getByRole("radio", { name: "In progress" }).click({
        force: true,
      });
      await expect(row(page, 204)).toContainText("In progress");
      await expect(row(page, 201)).toHaveCount(0);
      await page.getByRole("radio", { name: "Closed" }).click();
      await expect(row(page, 190)).toContainText("Closed");
      await expect(row(page, 190)).toContainText("Closed on GitHub.");
      expect(seen.lists.some((query) => query.includes("state=closed")))
        .toBe(true);
    });

    test("nothing ready says why and offers All open", async ({ page }) => {
      await issuesFixture(page, { open: OPEN.slice(1, 3) });
      await page.goto("/issues");
      await expect(
        page.getByRole("heading", { name: "No issue is ready to start" }),
      )
        .toBeVisible();
      await shot(page, "issues-none-ready");
      await page.getByRole("button", { name: "All open" }).click();
      await expect(row(page, 202)).toBeVisible();
    });

    test("with no repository to take issues from, an administrator is told to choose one", async ({ page }) => {
      await issuesFixture(page, { sources: "none" });
      await page.goto("/issues");
      await expect(page.getByRole("heading", {
        name: "Choose where Bakery takes issues from",
      })).toBeVisible();
      // The way forward until the repository sheet exists: the settings page.
      await expect(page.getByRole("button", { name: "Open Integrations" }))
        .toBeVisible();
      await shot(page, "issues-no-sources");
    });

    test("trouble reading GitHub is said at the top, with how old the list is", async ({ page }) => {
      await issuesFixture(page, { sources: "degraded" });
      await page.goto("/issues");
      await expect(page.getByText(
        "Bakery is having trouble reading GitHub. This list may be out of date.",
      )).toBeVisible();
      // The age is said once, under the filter.
      await expect(page.getByText("Updated from GitHub 5 minutes ago"))
        .toBeVisible();
      await shot(page, "issues-degraded");
    });

    test("Refresh asks the server to read GitHub again and says so", async ({ page }) => {
      const seen = await issuesFixture(page);
      await page.goto("/issues");
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByText(
        "Bakery is reading GitHub. The list updates when it is done.",
      )).toBeVisible();
      expect(seen.syncs).toBe(1);
    });

    test("Load more adds the next page and puts focus on the first issue it added", async ({ page }) => {
      const many: Seed[] = Array.from({ length: 30 }, (_, index) => ({
        number: 300 + index,
        title: `Issue number ${index + 1}`,
        verdict: "ready",
        checks: ready,
      }));
      await issuesFixture(page, { open: many });
      await page.goto("/issues");
      await expect(row(page, 324)).toBeVisible();
      await expect(row(page, 325)).toHaveCount(0);
      const more = page.getByRole("button", { name: "Load more" });
      await more.click();
      await expect(more).toHaveCount(0);
      await expect(row(page, 325)).toBeFocused();
      await expect(row(page, 329)).toBeVisible();
    });

    const rejected = (count: number, from: number): Seed[] =>
      Array.from({ length: count }, (_, index) => ({
        number: from + index,
        title: `Needs criteria ${index + 1}`,
        verdict: "rejected" as const,
        checks: [{
          id: "acceptance_present",
          status: "reject",
          reason: "acceptance_missing",
        }],
      }));

    test("Can start keeps reading pages until it finds an issue, never saying nothing over a Load more button", async ({ page }) => {
      // 25 issues that cannot start, then one that can on the next page.
      await issuesFixture(page, {
        open: [...rejected(25, 1000), {
          number: 2000,
          title: "Ready on the second page",
          verdict: "ready",
          checks: ready,
        }],
      });
      await page.goto("/issues");
      await expect(row(page, 2000)).toContainText("Can start");
      await expect(page.getByText("No issue is ready to start")).toHaveCount(0);
    });

    test("In progress looks past the first page too", async ({ page }) => {
      await issuesFixture(page, {
        open: [...rejected(25, 1000), {
          number: 2001,
          title: "Running on the second page",
          verdict: "ready",
          checks: ready,
          request: { disposition: "active" },
        }],
      });
      await page.goto("/issues");
      await page.getByRole("radio", { name: "In progress" }).click({
        force: true,
      });
      await expect(row(page, 2001)).toContainText("In progress");
    });

    test("when the search gives up at 200 issues, it says how far it looked and offers Load more", async ({ page }) => {
      await issuesFixture(page, {
        open: [...rejected(200, 1000), {
          number: 2002,
          title: "Ready on the ninth page",
          verdict: "ready",
          checks: ready,
        }],
      });
      await page.goto("/issues");
      await expect(page.getByText(
        "None of the issues loaded so far can start. Load more to look further.",
      )).toBeVisible();
      await expect(page.getByText("No issue is ready to start")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await shot(page, "issues-list-searched-partly");
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(row(page, 2002)).toContainText("Can start");
    });
  });
}
