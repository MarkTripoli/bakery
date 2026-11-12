import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { shot } from "./helpers/real-api.ts";
import {
  historyRows,
  RULE_ENTRIES,
  type RuleEntry,
  ruleRow,
  rulesRegion,
} from "./helpers/repository-rules-fixtures.ts";

const PAGE_PATH = "/settings/organization/repository-rules";
const AUTHOR_ID = "00000000-0000-4000-8000-0000000000a1";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
  }),
});

type Entry = RuleEntry;
const ENTRIES = RULE_ENTRIES;

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const version = (revision: number, entries: Entry[]) => ({
  id: `00000000-0000-4000-8000-0000000001${String(revision).padStart(2, "0")}`,
  organizationId: MOCK_ORGANIZATION_ID,
  revision,
  entries,
  digest: digest(String(revision)),
  createdAt: `2026-10-0${revision}T09:30:00.000Z`,
  createdBy: AUTHOR_ID,
});

type Fixture = {
  /** The current baseline read; revision 0 is the empty baseline. */
  revision: number;
  entries: Entry[];
  versions: ReturnType<typeof version>[];
  readStatus: number;
  /** Cursors the history read was asked for, in order. */
  cursors: (string | null)[];
  /** The first page of the history answers 500 while this is true. */
  failFirstHistory: boolean;
  /** Any later page of the history answers 500 while this is true. */
  failMoreHistory: boolean;
};

async function rulesFixture(
  page: Page,
  options: Partial<Pick<Fixture, "revision" | "entries" | "versions">> & {
    readStatus?: number;
    /** The rules read waits for this before it answers. */
    hold?: Promise<void>;
    /** The first page of the history waits for this before it answers. */
    holdHistory?: Promise<void>;
    failFirstHistory?: boolean;
    failMoreHistory?: boolean;
  } = {},
): Promise<Fixture> {
  const revision = options.revision ?? 3;
  const state: Fixture = {
    revision,
    entries: options.entries ?? ENTRIES,
    versions: options.versions ??
      [3, 2, 1].map((n) => version(n, n === 3 ? ENTRIES : [])),
    readStatus: options.readStatus ?? 200,
    cursors: [],
    failFirstHistory: options.failFirstHistory ?? false,
    failMoreHistory: options.failMoreHistory ?? false,
  };
  await mockAuthenticatedSession(page);
  // The page reads only rules: answer every other organization call empty.
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/**`,
    (route: Route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rules`,
    async (route: Route) => {
      await options.hold;
      if (state.readStatus !== 200) {
        return route.fulfill(
          problem(
            state.readStatus,
            state.readStatus === 403
              ? "AUTH_FORBIDDEN"
              : state.readStatus === 404
              ? "RESOURCE_NOT_FOUND"
              : "INTERNAL",
          ),
        );
      }
      return route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        revision: state.revision,
        entries: state.revision === 0 ? [] : state.entries,
        digest: digest(String(state.revision)),
        createdAt: state.revision === 0
          ? null
          : `2026-10-0${state.revision}T09:30:00.000Z`,
        createdBy: state.revision === 0 ? null : AUTHOR_ID,
      }));
    },
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rule-versions**`,
    async (route: Route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      state.cursors.push(cursor);
      if (cursor === null) await options.holdHistory;
      if (cursor === null ? state.failFirstHistory : state.failMoreHistory) {
        return route.fulfill(problem(500, "INTERNAL"));
      }
      // Two revisions a page: the second page holds the oldest.
      const all = state.versions;
      const items = cursor === null ? all.slice(0, 2) : all.slice(2);
      return route.fulfill(json({
        items,
        nextCursor: cursor === null && all.length > 2 ? "page-2" : null,
      }));
    },
  );
  return state;
}

test.describe("organization repository rules", () => {
  test("shows the current revision, each rule and the history", async ({ page, isMobile }) => {
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    await expect(
      page.getByRole("heading", { name: "Repository rules", level: 1 }),
    ).toBeVisible();
    if (!isMobile) {
      const trail = page.getByRole("navigation", { name: "Breadcrumb" });
      await expect(trail.getByText("Organization", { exact: true }))
        .toBeVisible();
      await expect(trail.getByText("Repository rules")).toBeVisible();
    }

    await expect(page.getByTestId("org-rules-current")).toContainText(
      "Published revision 3",
    );
    const row = (name: string) => ruleRow(page, name);
    await expect(row("Semantic commits")).toContainText("Require");
    await expect(row("Semantic commits")).toContainText("Locked");
    await expect(row("Semantic commits")).toContainText(
      "Conventional Commits · all introduced commits",
    );
    await expect(row("PR / MR titles")).toContainText(
      "type(scope): summary · 72-character subject",
    );
    await expect(row("Merge descriptions")).toContainText("Can override");
    await expect(row("Merge descriptions")).toContainText(
      "Summary, Changes, Validation · Markdown template",
    );
    await expect(row("Magic numbers")).toContainText("allow 0, 1");
    // A switched-off rule is not an absent one.
    await expect(row("Magic strings")).toContainText("Off");

    const history = historyRows(page);
    await expect(history).toHaveCount(2);
    // Newest first, each with the start of its digest.
    await expect(history.nth(0)).toContainText(digest("3").slice(0, 8));
    // The table cell is the bare number; a phone row titles it "Revision 3".
    await expect(history.nth(0)).toHaveText(/^(Revision )?3/);
  });

  test("loads older revisions with the cursor", async ({ page }) => {
    const state = await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const history = historyRows(page);
    await expect(history).toHaveCount(2);
    await page.getByRole("button", { name: "Load more revisions" }).click();
    await expect(history).toHaveCount(3);
    await expect(
      page.getByRole("button", { name: "Load more revisions" }),
    ).toHaveCount(0);
    // The last page removed the button that had focus: focus goes to the History heading.
    await expect(page.getByRole("heading", { name: "History", level: 2 }))
      .toBeFocused();
    expect(state.cursors).toEqual([null, "page-2"]);
  });

  test("an organization with nothing published says so", async ({ page }) => {
    await rulesFixture(page, { revision: 0, entries: [], versions: [] });
    await page.goto(PAGE_PATH);
    await expect(
      page.getByText("No organization rules yet", { exact: true }),
    ).toBeVisible();
    await expect(
      rulesRegion(page),
    ).toHaveCount(0);
    // The empty state already says nothing is published: no History to repeat it.
    await expect(page.getByRole("heading", { name: "History" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Published revisions" }))
      .toHaveCount(0);
  });

  test("a member who is not an administrator sees only the notice", async ({ page }) => {
    await rulesFixture(page, { readStatus: 403 });
    await page.goto(PAGE_PATH);
    await expect(
      page.getByText(
        "Only organization administrators can manage repository rules.",
      ),
    ).toBeVisible();
    await expect(
      rulesRegion(page),
    ).toHaveCount(0);
  });

  test("a read the server answers with 404 is a refusal, not a failure", async ({ page }) => {
    await rulesFixture(page, { readStatus: 404 });
    await page.goto(PAGE_PATH);
    await expect(
      page.getByText(
        "Only organization administrators can manage repository rules.",
      ),
    ).toBeVisible();
    await expect(page.getByText("could not be loaded", { exact: false }))
      .toHaveCount(0);
  });

  test("has no permanent explanatory banner above the rules", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    await expect(page.getByTestId("org-rules-current")).toBeVisible();
    await expect(page.getByText("Defaults flow", { exact: false }))
      .toHaveCount(0);
  });

  test("shows placeholder rows while the rules load, not a loading banner", async ({ page }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await rulesFixture(page, { hold });
    await page.goto(PAGE_PATH);
    const loading = page.getByTestId("org-rules-loading");
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("Loading repository rules.")).toHaveCount(0);
    await shot(page, "rules-loading");
    release();
    await expect(loading).toHaveCount(0);
    await expect(page.getByTestId("org-rules-current")).toBeVisible();
  });

  test("a failed read offers Try again, which loads the rules", async ({ page }) => {
    const state = await rulesFixture(page, { readStatus: 500 });
    await page.goto(PAGE_PATH);
    await expect(
      page.getByRole("alert").filter({
        hasText: "The repository rules could not be loaded.",
      }),
    ).toBeVisible();
    await shot(page, "rules-load-error");
    state.readStatus = 200;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("org-rules-current")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a digest never wraps onto a second line", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const digestBox = await historyRows(page).nth(0)
      .locator('[data-ui-component="dataText"]').boundingBox();
    // One line of the data face, not two.
    expect(digestBox!.height).toBeLessThan(26);
  });

  test("a failed read says so and offers no rules", async ({ page }) => {
    await rulesFixture(page, { readStatus: 500 });
    await page.goto(PAGE_PATH);
    await expect(
      page.getByText("The repository rules could not be loaded.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      rulesRegion(page),
    ).toHaveCount(0);
  });

  test("the rules table is as wide as the history table", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone lays the rules out as a list");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    // The right edge of what is drawn: a block-level table box spans the
    // column whatever its cells do, so measure the last column header.
    const rightEdge = async (table: string) => {
      const box = await page.getByRole("table", { name: table })
        .getByRole("columnheader").last().boundingBox();
      return box!.x + box!.width;
    };
    const rules = await rightEdge("Organization rules");
    const history = await rightEdge("Published revisions");
    expect(Math.abs(rules - history)).toBeLessThanOrEqual(1);
  });

  test("the table captions stay for screen readers and are not drawn", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone shows lists, which carry no caption");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    for (const name of ["Organization rules", "Published revisions"]) {
      const table = page.getByRole("table", { name });
      await expect(table).toBeVisible();
      const caption = await table.locator("caption").boundingBox();
      expect(caption!.width).toBeLessThanOrEqual(1);
      expect(caption!.height).toBeLessThanOrEqual(1);
    }
  });

  test("the title sits close to its description, as on the other settings pages", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const title = await page.getByRole("heading", {
      name: "Repository rules",
      level: 1,
    }).boundingBox();
    const description = await page.getByText(
      "A shared starting point for every repository in this organization.",
    ).boundingBox();
    const gap = description!.y - (title!.y + title!.height);
    // The column's own gap is 28px; the header group is tighter than that.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(16);
  });

  test("renders in the dark theme without horizontal overflow", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("org-rules-current")).toBeVisible();
    await expect(rulesRegion(page)).toBeVisible();
    await shot(page, "rules-current-dark");
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a failed Load more keeps the revisions on screen and retries the same cursor", async ({ page }) => {
    const state = await rulesFixture(page, { failMoreHistory: true });
    await page.goto(PAGE_PATH);
    const history = historyRows(page);
    await expect(history).toHaveCount(2);
    await page.getByRole("button", { name: "Load more revisions" }).click();
    const notice = page.getByRole("alert").filter({
      hasText: "Older revisions could not be loaded.",
    });
    await expect(notice).toBeVisible();
    // The button became this notice: its Try again takes focus.
    await expect(notice.getByRole("button", { name: "Try again" }))
      .toBeFocused();
    await shot(page, "rules-history-load-more-failed");
    // Nothing already shown is lost, and the failure is not offered as another Load more.
    await expect(history).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Load more revisions" }),
    ).toHaveCount(0);
    state.failMoreHistory = false;
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(history).toHaveCount(3);
    await expect(notice).toHaveCount(0);
    expect(state.cursors).toEqual([null, "page-2", "page-2"]);
  });

  test("a failed first History read leaves the rules and offers a button to try again", async ({ page }) => {
    const state = await rulesFixture(page, { failFirstHistory: true });
    await page.goto(PAGE_PATH);
    await expect(ruleRow(page, "Semantic commits")).toBeVisible();
    const failure = page.getByRole("alert").filter({
      hasText: "The revision history could not be loaded.",
    });
    await expect(failure).toBeVisible();
    await shot(page, "rules-history-load-failed");
    // The sentence no longer tells people to try again with nothing to press.
    await expect(failure).not.toContainText("Try again.");
    state.failFirstHistory = false;
    await failure.getByRole("button", { name: "Try again" }).click();
    await expect(historyRows(page)).toHaveCount(2);
    await expect(failure).toHaveCount(0);
  });

  test("on a phone the History shows placeholder rows while it loads, never the table header", async ({ page, isMobile }) => {
    test.skip(!isMobile, "a wide screen shows the table's own loading state");
    let release!: () => void;
    const holdHistory = new Promise<void>((resolve) => {
      release = resolve;
    });
    await rulesFixture(page, { holdHistory });
    await page.goto(PAGE_PATH);
    await expect(ruleRow(page, "Semantic commits")).toBeVisible();
    await expect(page.getByTestId("org-rules-history-loading")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Revision" }))
      .toHaveCount(0);
    release();
    await expect(page.getByTestId("org-rules-history-loading")).toHaveCount(0);
    await expect(historyRows(page)).toHaveCount(2);
  });

  test("a rule summary is clamped to two lines with the whole text as its title", async ({ page }) => {
    const sections = Array.from(
      { length: 16 },
      (_, index) => `Required section number ${index + 1}`,
    );
    const entries = RULE_ENTRIES.map((entry) =>
      entry.ruleKey === "changeRequest.description"
        ? {
          ...entry,
          options: { ...(entry.options as object), requiredSections: sections },
        }
        : entry
    );
    await rulesFixture(page, { entries });
    await page.goto(PAGE_PATH);
    const summary = ruleRow(page, "Merge descriptions").locator(
      '[data-lines="2"]',
    );
    await expect(summary).toHaveAttribute(
      "title",
      /Required section number 16/,
    );
    const { height, lineHeight } = await summary.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(node).lineHeight),
    }));
    // Two lines and no more: a 16-section list does not grow the row without limit.
    expect(height).toBeLessThanOrEqual(lineHeight * 2 + 1);
    // The rule's name is not clamped.
    await expect(ruleRow(page, "Merge descriptions")).toContainText(
      "Merge descriptions",
    );
  });

  test("on a phone the enforcement and access label is shown whole", async ({ page, isMobile }) => {
    test.skip(!isMobile, "a wide screen lays it out in columns");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    for (
      const [rule, label] of [
        ["Semantic commits", "Require · Locked"],
        ["Merge descriptions", "Require · Can override"],
        ["Magic strings", "Off · Can override"],
      ]
    ) {
      const row = ruleRow(page, rule);
      await expect(row).toContainText(label);
      // Whatever does not fit beside the name wraps under it; nothing is clipped.
      const clipped = await row.evaluate((node) =>
        node.scrollWidth > node.clientWidth
      );
      expect(clipped).toBe(false);
    }
  });

  test("is reachable from the settings navigation", async ({ page }) => {
    await rulesFixture(page);
    await page.goto("/settings/appearance");
    await page.locator("main#bakery-main").waitFor();
    const menu = page.locator(".bakery-section-navigation__summary");
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Repository rules" })
      .click();
    await expect(page).toHaveURL(new RegExp(`${PAGE_PATH}$`));
    await expect(
      page.getByRole("heading", { name: "Repository rules", level: 1 }),
    ).toBeVisible();
  });
});
