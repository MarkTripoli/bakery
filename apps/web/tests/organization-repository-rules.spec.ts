import { expect, type Page, type Route, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
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
};

async function rulesFixture(
  page: Page,
  options: Partial<Pick<Fixture, "revision" | "entries" | "versions">> & {
    readStatus?: number;
    /** The rules read waits for this before it answers. */
    hold?: Promise<void>;
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
    (route: Route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      state.cursors.push(cursor);
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
