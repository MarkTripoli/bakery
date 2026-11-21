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
      await expect(trail.getByText("Settings", { exact: true })).toBeVisible();
      await expect(trail.getByText("Repository rules")).toBeVisible();
    }

    await expect(page.getByTestId("org-rules-current")).toContainText(
      "Version 3 · published",
    );
    const row = (name: string) => ruleRow(page, name);
    await expect(row("Semantic commits")).toContainText("Require");
    await expect(row("Semantic commits")).toContainText(/No, locked|Locked/);
    await expect(row("Semantic commits")).toContainText(
      "Conventional Commits · all introduced commits",
    );
    await expect(row("PR / MR titles")).toContainText(
      "type(scope): summary · 72-character subject",
    );
    await expect(row("Merge descriptions")).toContainText(
      /Yes|Not locked/,
    );
    await expect(row("Merge descriptions")).toContainText(
      "Summary, Changes, Validation · Markdown template",
    );
    await expect(row("Magic numbers")).toContainText("allow 0, 1");
    // A switched-off rule is not an absent one.
    await expect(row("Magic strings")).toContainText("Off");

    const history = historyRows(page);
    await expect(history).toHaveCount(2);
    // Newest first, and no hash is shown at any width.
    await expect(history.nth(0)).not.toContainText(digest("3").slice(0, 8));
    // The table cell is the bare number; a phone row titles it "Version 3".
    await expect(history.nth(0)).toHaveText(/^(Version )?3/);
  });

  test("loads older revisions with the cursor", async ({ page }) => {
    const state = await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const history = historyRows(page);
    await expect(history).toHaveCount(2);
    await page.getByRole("button", { name: "Load older versions" }).click();
    await expect(history).toHaveCount(3);
    await expect(
      page.getByRole("button", { name: "Load older versions" }),
    ).toHaveCount(0);
    // The last page removed the button that had focus: focus goes to the first
    // row that load added, so a reader goes on from where they were.
    await expect(history.nth(2)).toBeFocused();
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
    await expect(page.getByRole("table", { name: "Published versions" }))
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

  test("no column shows a raw hash, and the words revision and digest are gone", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const content = page.locator('[data-testid="org-repository-rules"]');
    await expect(content).toContainText("Version 3 · published");
    await expect(content).toContainText(
      "Edit a rule, review what will change, then publish.",
    );
    await expect(content).not.toContainText(/revision|digest/i);
    await expect(content).not.toContainText(digest("3").slice(0, 8));
    await expect(page.getByRole("columnheader", { name: "Digest" }))
      .toHaveCount(0);
    await shot(page, "rules-current");
  });

  test("on a phone the column help is one closed disclosure under the version line", async ({ page, isMobile }) => {
    test.skip(!isMobile, "desktop keeps the header help buttons");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const disclosure = page.locator("details", {
      hasText: "What Require, Warn, Guide and Off mean",
    });
    const summary = disclosure.locator("summary");
    await expect(summary).toBeVisible();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(
      page.getByText("Require blocks delivery until the check passes."),
    )
      .toBeHidden();
    await shot(page, "rules-help-phone-closed", [], {
      only: "mobile",
      windowOnly: true,
    });
    await summary.click();
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(
      page.getByText("Require blocks delivery until the check passes."),
    )
      .toBeVisible();
    await expect(
      page.getByText("Locked rules apply to every repository as set here."),
    )
      .toBeVisible();
    await shot(page, "rules-help-phone-open", [], {
      only: "mobile",
      windowOnly: true,
    });
  });

  test("desktop has no phone disclosure", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone has the disclosure");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    await expect(page.locator("details", {
      hasText: "What Require, Warn, Guide and Off mean",
    })).toHaveCount(0);
  });

  test("both column headers carry a help button that explains the column", async ({ page, isMobile }) => {
    // A phone lists rows, not columns, so there are no headers to explain.
    test.skip(isMobile, "no column headers on a phone");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    const enforcement = page.getByRole("button", {
      name: "About enforcement",
    });
    // Each help button sits beside its header text, on the same line.
    for (
      const [column, help] of [
        ["Enforcement", enforcement],
        [
          "Repositories can change it",
          page.getByRole("button", {
            name: "About what repositories can change",
          }),
        ],
      ] as const
    ) {
      const text = await page.getByRole("columnheader", { name: column })
        .locator("span").first().boundingBox();
      const button = await help.boundingBox();
      expect(text && button).toBeTruthy();
      const apart = Math.abs(
        (button!.y + button!.height / 2) - (text!.y + text!.height / 2),
      );
      expect(apart).toBeLessThan(text!.height);
    }
    await enforcement.click();
    await expect(
      page.getByText("Require blocks delivery until the check passes."),
    )
      .toBeVisible();
    await shot(page, "rules-help-enforcement", [], {
      only: "desktop",
      windowOnly: true,
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", {
      name: "About what repositories can change",
    })
      .click();
    await expect(
      page.getByText("Locked rules apply to every repository as set here."),
    )
      .toBeVisible();
    await shot(page, "rules-help-access", [], {
      only: "desktop",
      windowOnly: true,
    });
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
    const history = await rightEdge("Published versions");
    expect(Math.abs(rules - history)).toBeLessThanOrEqual(1);
  });

  test("the table captions stay for screen readers and are not drawn", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone shows lists, which carry no caption");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    for (const name of ["Organization rules", "Published versions"]) {
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
      "Rules every repository in this organization starts with.",
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
    await page.getByRole("button", { name: "Load older versions" }).click();
    const notice = page.getByRole("alert").filter({
      hasText: "Older versions could not be loaded.",
    });
    await expect(notice).toBeVisible();
    // The button became this notice: its Try again takes focus.
    await expect(notice.getByRole("button", { name: "Try again" }))
      .toBeFocused();
    await shot(page, "rules-history-load-more-failed");
    // Nothing already shown is lost, and the failure is not offered as another Load more.
    await expect(history).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Load older versions" }),
    ).toHaveCount(0);
    state.failMoreHistory = false;
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(history).toHaveCount(3);
    await expect(notice).toHaveCount(0);
    // A Try again that works is a successful load: the first row it added.
    await expect(history.nth(2)).toBeFocused();
    expect(state.cursors).toEqual([null, "page-2", "page-2"]);
  });

  test("a failed first History read leaves the rules and offers a button to try again", async ({ page }) => {
    const state = await rulesFixture(page, { failFirstHistory: true });
    await page.goto(PAGE_PATH);
    await expect(ruleRow(page, "Semantic commits")).toBeVisible();
    const failure = page.getByRole("alert").filter({
      hasText: "The version history could not be loaded.",
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
    await expect(page.getByRole("columnheader", { name: "Version" }))
      .toHaveCount(0);
    release();
    await expect(page.getByTestId("org-rules-history-loading")).toHaveCount(0);
    await expect(historyRows(page)).toHaveCount(2);
  });

  test("a long rule summary is clamped, with a control that shows all of it and no title", async ({ page, isMobile }) => {
    test.skip(
      isMobile,
      "a phone row opens the editor instead; see the next test",
    );
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
    const row = ruleRow(page, "Merge descriptions");
    const summary = row.locator('[data-lines="2"]');
    const { height, lineHeight } = await summary.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(node).lineHeight),
    }));
    // Two lines and no more: a 16-section list does not grow the row without limit.
    expect(height).toBeLessThanOrEqual(lineHeight * 2 + 1);
    // No tooltip: the whole text is not hidden behind a hover.
    await expect(row.locator("[title]")).toHaveCount(0);
    // The control is reachable by keyboard and names the rule it opens.
    const show = row.getByRole("button", {
      name: "Show all of Merge descriptions",
    });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(show).toHaveText("Show all");
    await show.focus();
    await page.keyboard.press("Enter");
    const hide = row.getByRole("button", {
      name: "Show less of Merge descriptions",
    });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    await expect(hide).toHaveText("Show less");
    await expect(hide).toBeFocused();
    await expect(row).toContainText("Required section number 16");
    const open = await row.locator(".ui-expandable-text .ui-text").evaluate((
      node,
    ) => node.getBoundingClientRect().height);
    expect(open).toBeGreaterThan(lineHeight * 2 + 1);
    await page.keyboard.press("Space");
    await expect(show).toHaveAttribute("aria-expanded", "false");
    // A rule whose summary fits has no control and no reserved space.
    await expect(
      ruleRow(page, "Semantic commits").getByRole("button", {
        name: /Show all/,
      }),
    ).toHaveCount(0);
    // The rule's name is not clamped.
    await expect(row).toContainText("Merge descriptions");
  });

  test("on a phone the long summary is described by the row and carries no title", async ({ page, isMobile }) => {
    test.skip(!isMobile, "a wide screen shows the control in the table");
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
    const row = ruleRow(page, "Merge descriptions");
    await expect(row.locator("[title]")).toHaveCount(0);
    // The row's control is described by the summary, so it is announced whole
    // after "Edit Merge descriptions"; there is no button inside the row button.
    const control = row.getByRole("button");
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAccessibleDescription(
      /Required section number 16/,
    );
  });

  test("evidence: a long rule summary cut and shown whole, and the phone row", async ({ page, isMobile }) => {
    test.skip(
      !process.env.BAKERY_EVIDENCE_DIR,
      "only captures stills when asked to",
    );
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
    const row = ruleRow(page, "Merge descriptions");
    await expect(row).toBeVisible();
    if (isMobile) {
      await shot(page, "203-org-rules-phone-row", [], { only: "mobile" });
      return;
    }
    const show = row.getByRole("button", {
      name: "Show all of Merge descriptions",
    });
    await shot(page, "203-org-rules-summary-cut", [], { only: "desktop" });
    // A full-page capture can take focus away; focus the control afterwards.
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(
      row.getByRole("button", { name: "Show less of Merge descriptions" }),
    ).toHaveAttribute("aria-expanded", "true");
    await shot(page, "203-org-rules-summary-expanded", [], { only: "desktop" });
  });

  test("on a phone the enforcement and access label is shown whole", async ({ page, isMobile }) => {
    test.skip(!isMobile, "a wide screen lays it out in columns");
    await rulesFixture(page);
    await page.goto(PAGE_PATH);
    for (
      const [rule, label] of [
        ["Semantic commits", "Require · Locked"],
        ["Merge descriptions", "Require · Not locked"],
        ["Magic strings", "Off · Not locked"],
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
