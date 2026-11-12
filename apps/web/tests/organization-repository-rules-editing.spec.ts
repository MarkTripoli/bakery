import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import {
  RULE_ENTRIES,
  type RuleEntry,
  ruleRow,
} from "./helpers/repository-rules-fixtures.ts";

const LIST_PATH = "/settings/organization/repository-rules";
const AUTHOR_ID = "00000000-0000-4000-8000-0000000000a1";
const DIGEST = "a".repeat(64);

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The published rules, and every request that tried to change something. */
async function editingFixture(
  page: Page,
  options: { entries?: RuleEntry[]; revision?: number } = {},
) {
  const entries = options.entries ?? RULE_ENTRIES;
  const revision = options.revision ?? 3;
  const writes: string[] = [];
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/**`,
    (route: Route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rules`,
    (route: Route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        revision,
        entries,
        digest: DIGEST,
        createdAt: "2026-10-03T09:30:00.000Z",
        createdBy: AUTHOR_ID,
      })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rule-versions**`,
    (route: Route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  page.on("request", (request) => {
    if (
      request.method() !== "GET" && request.url().includes("/repository-rule")
    ) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  return { writes };
}

/** Whether the page is laid out for a phone (the single 743px breakpoint). */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 744;

const draftBar = (page: Page) =>
  page.getByRole("status").filter({ hasText: "unpublished change" });

/** Opens one rule's editor from the list, the same way on a table and on a phone list. */
async function openEditor(page: Page, rule: string) {
  await page.getByRole("button", { name: `Edit ${rule}` }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`^(Edit|Add) ${rule}$`) }),
  ).toBeVisible();
}

/**
 * Picks one choice of a segmented control. The control is a group of radio
 * inputs under visible labels, so the input is the thing to set; `check`
 * confirms the choice really changed.
 */
async function choose(page: Page, group: string, label: string) {
  await page.getByRole("group", { name: group }).getByRole("radio", {
    name: label,
    exact: true,
  }).check({ force: true });
}

test.describe("organization repository rules: editing", () => {
  test("Edit opens the rule's editor with its current values", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}/commits.semantic$`));
    await expect(page.getByRole("switch", { name: "Rule enabled" }))
      .toBeChecked();
    // A locked rule is one repositories cannot override.
    await expect(
      page.getByRole("switch", { name: "Repositories can override" }),
    ).not.toBeChecked();
    await expect(page.getByLabel("Allowed types")).toHaveValue(
      "feat, fix, docs",
    );
    await expect(page.getByLabel("Maximum subject length")).toHaveValue("72");
    await shot(page, "rules-editor");
    await expect(
      page.getByRole("group", { name: "Enforcement" }).getByRole("radio", {
        name: "Require",
      }),
    ).toBeChecked();
  });

  test("an applied edit joins the draft and nothing is sent to the server", async ({ page }) => {
    const { writes } = await editingFixture(page);
    await page.goto(LIST_PATH);
    // No draft once the rules are showing: the bar is only for unpublished edits.
    await expect(ruleRow(page, "Semantic commits")).toBeVisible();
    await expect(draftBar(page)).toHaveCount(0);
    await openEditor(page, "Semantic commits");
    await choose(page, "Enforcement", "Warn");
    await page.getByRole("button", { name: "Apply to draft" }).click();

    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toContainText("1 unpublished change");
    await expect(draftBar(page)).toContainText(
      "based on revision 3 · nothing applies until you publish",
    );
    const row = ruleRow(page, "Semantic commits");
    await expect(row).toContainText("Edited");
    await expect(row).toContainText("Warn");
    // The old value is text beside the new one, never colour alone.
    await expect(row).toContainText("was Require");
    await shot(page, "rules-draft");
    // The other rules are untouched.
    await expect(ruleRow(page, "PR / MR titles")).not.toContainText("Edited");
    expect(writes).toEqual([]);
  });

  test("the draft is kept while moving between the list and an editor", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await choose(page, "Enforcement", "Warn");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(draftBar(page)).toContainText("1 unpublished change");

    // Open the same rule again: it starts from the draft, not the published rule.
    await openEditor(page, "Semantic commits");
    await expect(
      page.getByRole("group", { name: "Enforcement" }).getByRole("radio", {
        name: "Warn",
      }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toContainText("1 unpublished change");
  });

  test("applying an edit that matches the published rule leaves no draft", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Magic numbers");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toHaveCount(0);
    await expect(ruleRow(page, "Magic numbers")).not.toContainText("Edited");
  });

  test("Discard asks first and then removes the draft", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Magic strings");
    await page.getByRole("switch", { name: "Rule enabled" }).check();
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(ruleRow(page, "Magic strings")).toContainText("Edited");

    await draftBar(page).locator("..").getByRole("button", { name: "Discard" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Discard 1 unpublished change?");
    await shot(page, "rules-discard-confirm");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(draftBar(page)).toContainText("1 unpublished change");

    await draftBar(page).locator("..").getByRole("button", { name: "Discard" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Discard changes",
    }).click();
    await expect(draftBar(page)).toHaveCount(0);
    await expect(ruleRow(page, "Magic strings")).not.toContainText("Edited");
    await expect(ruleRow(page, "Magic strings")).toContainText("Off");
  });

  test("the editor checks the contract's bounds inline and applies nothing while they fail", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await page.getByLabel("Allowed types").fill("");
    await page.getByLabel("Maximum subject length").fill("5");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(page.getByText("Enter at least one item.")).toBeVisible();
    await expect(
      page.getByText("Enter a whole number between 20 and 200."),
    ).toBeVisible();
    await shot(page, "rules-editor-errors");
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}/commits.semantic$`));
    await page.getByLabel("Allowed types").fill("feat, fix");
    await page.getByLabel("Maximum subject length").fill("100");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toContainText("1 unpublished change");
  });

  test("Add rule lists only the rules that are not there yet", async ({ page }) => {
    await editingFixture(page, { entries: RULE_ENTRIES.slice(0, 3) });
    await page.goto(LIST_PATH);
    await page.getByRole("button", { name: "Add rule" }).click();
    const menu = page.getByRole("navigation", { name: "Rules you can add" });
    await expect(menu.getByRole("button")).toHaveText([
      "Magic numbers",
      "Magic strings",
    ]);
    await shot(page, "rules-add-menu");
    await menu.getByRole("button", { name: "Magic numbers" }).click();
    await expect(page.getByRole("heading", { name: "Add Magic numbers" }))
      .toBeVisible();
    await page.getByLabel("Allowed numbers").fill("0, 1, 100");
    await page.getByRole("button", { name: "Apply to draft" }).click();

    await expect(draftBar(page)).toContainText("1 unpublished change");
    const row = ruleRow(page, "Magic numbers");
    await expect(row).toContainText("Edited");
    await expect(row).toContainText("allow 0, 1, 100");
    // It is in the draft now, so it is no longer offered.
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(
      page.getByRole("navigation", { name: "Rules you can add" }).getByRole(
        "button",
      ),
    ).toHaveText(["Magic strings"]);
  });

  test("Add rule sits with the title and its list opens over the page without moving it", async ({ page }) => {
    await editingFixture(page, { entries: RULE_ENTRIES.slice(0, 3) });
    await page.goto(LIST_PATH);
    const heading = page.getByRole("heading", {
      name: "Repository rules",
      level: 1,
    });
    const add = page.getByRole("button", { name: "Add rule" });
    const row = ruleRow(page, "Semantic commits");
    await expect(row).toBeVisible();
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      if (!found) throw new Error("the element has no box");
      return found;
    };
    const head = await box(heading);
    const button = await box(add);
    if (isPhone(page)) {
      // Under the description, across the column.
      const column = await box(page.getByTestId("org-repository-rules"));
      expect(button.y).toBeGreaterThanOrEqual(head.y + head.height);
      expect(button.width).toBeGreaterThan(column.width * 0.9);
    } else {
      // Beside the title, at the end of its row.
      expect(button.x).toBeGreaterThanOrEqual(head.x + head.width);
      expect(button.y).toBeLessThan(head.y + head.height);
    }

    const before = await box(row);
    await add.click();
    const menu = page.getByRole("navigation", { name: "Rules you can add" });
    await expect(menu).toBeVisible();
    // An overlay: nothing under it moved, and it stays inside the window.
    expect((await box(row)).y).toBe(before.y);
    const open = await box(menu);
    const window = page.viewportSize();
    if (!window) throw new Error("no viewport");
    expect(open.x).toBeGreaterThanOrEqual(0);
    expect(open.x + open.width).toBeLessThanOrEqual(window.width);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    await shot(page, "rules-add-menu-open");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    expect((await box(row)).y).toBe(before.y);
  });

  test("the editor does not repeat the list description and ends with Cancel, then Apply to draft", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await expect(
      page.getByText(
        "A shared starting point for every repository in this organization.",
      ),
    ).toHaveCount(0);
    const cancel = page.getByRole("button", { name: "Cancel" });
    const apply = page.getByRole("button", { name: "Apply to draft" });
    const first = await cancel.boundingBox();
    const last = await apply.boundingBox();
    if (!first || !last) throw new Error("the actions have no box");
    // Secondary first, primary last: left to right, or top to bottom when they stack.
    expect(
      first.y < last.y || (first.y === last.y && first.x < last.x),
    ).toBe(true);
    if (!isPhone(page)) {
      const form = await page.locator("form").boundingBox();
      if (!form) throw new Error("the form has no box");
      // Right-aligned like the other settings forms.
      expect(form.x + form.width - (last.x + last.width)).toBeLessThan(2);
    }
  });

  test("the Edited badge sits beside the rule's name", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await choose(page, "Enforcement", "Warn");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    const row = ruleRow(page, "Semantic commits");
    await expect(row).toContainText("was Require");
    const name = await row.getByText("Semantic commits", { exact: true })
      .first()
      .boundingBox();
    const badge = await row.getByText("Edited", { exact: true }).boundingBox();
    if (!name || !badge) throw new Error("the name or the badge has no box");
    // Same line, and right behind the name rather than at the far end of the row.
    expect(Math.abs((badge.y + badge.height / 2) - (name.y + name.height / 2)))
      .toBeLessThan(name.height);
    expect(badge.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
    expect(badge.x - (name.x + name.width)).toBeLessThanOrEqual(16);
    if (isPhone(page)) {
      // One headline: the name and its badge are a single unit in the row.
      const headline = row.locator("[class*='list-row__headline']");
      await expect(headline).toContainText("Semantic commits");
      await expect(headline).toContainText("Edited");
    }
  });

  test("with all five rules there is nothing to add", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await expect(ruleRow(page, "Magic strings")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add rule" })).toHaveCount(0);
  });

  test("leaving the rules pages with a draft asks first", async ({ page }) => {
    await editingFixture(page);
    await page.goto(LIST_PATH);
    await openEditor(page, "Semantic commits");
    await choose(page, "Enforcement", "Warn");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await expect(draftBar(page)).toContainText("1 unpublished change");

    const leave = async () => {
      const menu = page.locator(".bakery-section-navigation__summary");
      if (await menu.isVisible()) await menu.click();
      await page.getByRole("navigation", { name: "Settings sections" })
        .getByRole("link", { name: "Appearance" }).click();
    };
    await leave();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Leave without publishing?");
    await expect(dialog).toContainText("You have 1 unpublished change.");
    await shot(page, "rules-leave-confirm");
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toContainText("1 unpublished change");

    await leave();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Leave and discard",
    }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    // The draft was thrown away with the visit.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
    await expect(draftBar(page)).toHaveCount(0);
  });

  test("the editor shows the whole rule summary that the list clamps, without a hover", async ({ page }) => {
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
    await editingFixture(page, { entries });
    await page.goto(LIST_PATH);
    await openEditor(page, "Merge descriptions");
    const summary = page.getByTestId("org-rule-summary");
    await expect(summary).toBeVisible();
    // The last item is there in the text, on screen, not only in a tooltip.
    await expect(summary).toContainText("Required section number 16");
    const { height, lineHeight } = await summary.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      lineHeight: parseFloat(getComputedStyle(node).lineHeight),
    }));
    // More than the two lines the list allows: nothing is clamped here.
    expect(height).toBeGreaterThan(lineHeight * 2);
  });

  test("an unknown rule key says so", async ({ page }) => {
    await editingFixture(page);
    await page.goto(`${LIST_PATH}/not-a-rule`);
    await expect(page.getByText("That rule does not exist.")).toBeVisible();
    await page.getByRole("button", { name: "Back to repository rules" })
      .click();
    await expect(page).toHaveURL(new RegExp(`${LIST_PATH}$`));
  });
});
