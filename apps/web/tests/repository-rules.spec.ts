import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { RULE_ENTRIES } from "./helpers/repository-rules-fixtures.ts";

const REPOSITORY_ID = "00000000-0000-4000-8000-000000000302";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000301";
const PROFILE_ID = "00000000-0000-4000-8000-000000000303";
const RULES_PATH = `/projects/repositories/${REPOSITORY_ID}/rules`;
const DIGEST = "9f2c41ab" + "d".repeat(56);

const repository = {
  id: REPOSITORY_ID,
  applicationId: APPLICATION_ID,
  integrationConnectionId: "00000000-0000-4000-8000-000000000304",
  providerRepoId: "acme/payments-api",
  slug: "payments-api",
  owner: "acme",
  name: "payments-api",
  defaultBranch: "main",
  activeProfileId: PROFILE_ID,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 3,
};

const problem = (status: number, code: string, title: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title,
    status,
    detail: title,
    code,
    requestId: "00000000-0000-4000-8000-000000000310",
    traceId: "00000000-0000-4000-8000-000000000311",
    retryable: false,
  }),
});

type Provenance =
  | "inherited"
  | "repository_override"
  | "repository_only"
  | "locked_by_organization";

type Effective = {
  entries: Record<string, unknown>[];
  supersededOverrides: Record<string, unknown>[];
  checkers: { state: string; unavailableRuleKeys: string[] };
  providerProtection: { state: string; reason: string | null };
  organizationRevision: number;
  profileRevision: number | null;
};

/** The five rules as one repository sees them: two locked, two inherited, one overridden. */
function effective(overrides: Partial<Effective> = {}): Effective {
  const provenance: Provenance[] = [
    "locked_by_organization",
    "locked_by_organization",
    "inherited",
    "inherited",
    "repository_override",
  ];
  return {
    entries: RULE_ENTRIES.map((entry, index) => {
      const { locked: _locked, ...rest } = entry;
      return {
        ...rest,
        // The override's own mode: Require, where the organization has Warn.
        ...(index === 4 ? { enabled: true, mode: "require" } : {}),
        provenance: provenance[index],
        organizationRevision: index === 4 ? null : 3,
      };
    }),
    // A repository override that the organization has since locked: saved, inactive.
    supersededOverrides: [{
      ruleKey: "commits.semantic",
      reason: "locked_by_organization",
      override: {
        ruleKey: "commits.semantic",
        enabled: true,
        mode: "warn",
        options: (RULE_ENTRIES[0] as { options: unknown }).options,
      },
    }],
    checkers: {
      state: "unavailable",
      unavailableRuleKeys: ["code.magicNumbers"],
    },
    providerProtection: { state: "unknown", reason: "not_checked" },
    organizationRevision: 3,
    profileRevision: 8,
    ...overrides,
  };
}

type Options = {
  rules?: Effective;
  /** Answers every rules read with a 500 until `recover()` is called. */
  failing?: boolean;
  rulesProblem?: ReturnType<typeof problem>;
  repositoryProblem?: ReturnType<typeof problem>;
};

async function rulesFixture(page: Page, options: Options = {}) {
  const requests: string[] = [];
  let failing = options.failing ?? false;
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/repositories/${REPOSITORY_ID}`,
    (route: Route) =>
      route.fulfill(
        options.repositoryProblem ?? {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(repository),
        },
      ),
  );
  await page.route(
    `**/v1/repositories/${REPOSITORY_ID}/rules`,
    (route: Route) => {
      requests.push(route.request().url());
      if (failing) {
        return route.fulfill(problem(500, "INTERNAL_ERROR", "Server error"));
      }
      if (options.rulesProblem) return route.fulfill(options.rulesProblem);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          repositoryId: REPOSITORY_ID,
          profileId: PROFILE_ID,
          digest: DIGEST,
          repositoryVersion: 3,
          ...(options.rules ?? effective()),
        }),
      });
    },
  );
  return {
    requests,
    recover: () => {
      failing = false;
    },
  };
}

const region = (page: Page) => page.getByTestId("repository-rules");
/**
 * Whether what is at the middle of `locator` is the locator itself or inside
 * it. `toBeVisible` is true for an element a scrolling table or list clips
 * away; the element that is hit at its centre is the one a person sees.
 */
const isSeen = (locator: Locator) =>
  locator.evaluate((node) => {
    // The text is an inline run; the panel around it is the box a person sees.
    const seen = node.closest(".ui-help-tip__panel") ?? node;
    const box = seen.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return hit !== null && seen.contains(hit);
  });
const checks = (page: Page) => page.getByTestId("repository-rules-checks");
const details = (page: Page) => page.getByTestId("repository-rules-details");

/** One rule's row in whichever layout is showing. */
function rule(page: Page, name: string): Locator {
  return region(page).getByRole("row", { name }).or(
    region(page).getByRole("listitem").filter({ hasText: name }),
  );
}

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 744;

test.describe("repository rules: the effective rules of one repository", () => {
  test("lists each rule with who set it", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await expect(
      page.getByRole("heading", { name: "Rules", level: 1 }),
    ).toBeVisible();
    await expect(region(page)).toContainText(
      "The rules Bakery applies to work in acme / payments-api.",
    );

    const semantic = rule(page, "Semantic commits");
    await expect(semantic).toContainText("Require");
    await expect(semantic).toContainText("Locked by organization");
    // An override that a lock switched off is saved, and says it is not used.
    await expect(semantic).toContainText(
      "This repository's own setting is saved but not used while the rule is locked.",
    );
    await expect(rule(page, "PR / MR titles")).toContainText(
      "Locked by organization",
    );
    await expect(rule(page, "PR / MR titles")).not.toContainText(
      "saved but not used",
    );
    await expect(rule(page, "Merge descriptions")).toContainText(
      "Organization default",
    );
    await expect(rule(page, "Magic numbers")).toContainText(
      "Organization default",
    );
    const own = rule(page, "Magic strings");
    await expect(own).toContainText("This repository");
    await expect(own).toContainText("Require");
    // The old words are gone from the page.
    await expect(region(page)).not.toContainText(/Inherited|override\b/i);
    await shot(page, "repository-rules");
  });

  test("the summary is one plain line, and the version numbers are at the end", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const summary = page.getByTestId("repository-rules-summary");
    await expect(summary).toHaveText(
      "2 locked by the organization · 2 organization defaults · 1 set for this repository",
    );
    // Not a coloured box: nothing is wrong, so nothing needs attention.
    await expect(region(page).getByRole("alert")).toHaveCount(0);
    // The words revision, profile and digest are not on the page.
    await expect(region(page)).not.toContainText(
      /\b(revision|profile|digest)\b/i,
    );
    const section = details(page);
    await expect(section).toContainText("Version details");
    await expect(section).toContainText("Organization rules version");
    await expect(section.getByText("3", { exact: true })).toBeVisible();
    await expect(section).toContainText("Repository settings version");
    await expect(section.getByText("8", { exact: true })).toBeVisible();
    // Eight characters on screen, the whole value as the title.
    const fingerprint = page.getByTestId("repository-rules-digest");
    await expect(fingerprint).toHaveText("9f2c41ab");
    await expect(fingerprint).toHaveAttribute("title", DIGEST);
    // Version details is the last thing on the page, after the checks.
    const checksBox = await checks(page).boundingBox();
    const detailsBox = await section.boundingBox();
    if (!checksBox || !detailsBox) throw new Error("a section has no box");
    expect(detailsBox.y).toBeGreaterThan(checksBox.y + checksBox.height - 1);
  });

  test("repository-only rules are counted when there are any", async ({ page }) => {
    const only = effective();
    only.entries = only.entries.map((entry, index) =>
      index === 3 ? { ...entry, provenance: "repository_only" } : entry
    );
    await rulesFixture(page, { rules: only });
    await page.goto(RULES_PATH);
    await expect(page.getByTestId("repository-rules-summary")).toHaveText(
      "2 locked by the organization · 1 organization defaults · 1 set for this repository · 1 only in this repository",
    );
    await expect(rule(page, "Magic numbers")).toContainText(
      "Only this repository",
    );
  });

  test("the rules fingerprint can be copied", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await details(page).getByRole("button", { name: "Copy" }).click();
    await expect(details(page).getByRole("button", { name: "Copied" }))
      .toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      DIGEST,
    );
  });

  test("a repository with no profile and no organization rules shows None for both versions", async ({ page }) => {
    await rulesFixture(page, {
      rules: effective({ organizationRevision: 0, profileRevision: null }),
    });
    await page.goto(RULES_PATH);
    const section = details(page);
    await expect(
      section.getByText("None", { exact: true }),
    ).toHaveCount(2);
  });

  test("a rule with no working check says so, and for Require says what to do", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const numbers = rule(page, "Magic numbers");
    // Require: the pill and, under it, the next step in words.
    await expect(numbers).toContainText("No working check");
    await expect(numbers).toContainText(
      "Blocks delivery until an organization administrator changes this rule to Warn.",
    );
    // The pill never wraps onto a second line.
    const pill = numbers.getByText("No working check", { exact: true });
    const pillBox = await pill.boundingBox();
    if (!pillBox) throw new Error("the pill has no box");
    expect(pillBox.height).toBeLessThan(30);
    // No other row claims a missing check.
    await expect(rule(page, "Semantic commits")).not.toContainText(
      "No working check",
    );
    await shot(page, "repository-rules-check-unavailable");
  });

  test("Warn and Guide show the pill without the blocking caption, and a switched-off rule shows neither", async ({ page }) => {
    const warn = effective({
      checkers: {
        state: "unavailable",
        unavailableRuleKeys: ["code.magicNumbers", "code.magicStrings"],
      },
    });
    warn.entries = warn.entries.map((entry) =>
      entry.ruleKey === "code.magicNumbers"
        ? { ...entry, mode: "warn" }
        : entry.ruleKey === "code.magicStrings"
        ? { ...entry, enabled: false }
        : entry
    );
    await rulesFixture(page, { rules: warn });
    await page.goto(RULES_PATH);
    const numbers = rule(page, "Magic numbers");
    await expect(numbers).toContainText("No working check");
    await expect(numbers).not.toContainText("Blocks delivery");
    const off = rule(page, "Magic strings");
    await expect(off).toContainText("Off");
    await expect(off).not.toContainText("No working check");
  });

  test("the checks section names Bakery's checks and branch protection, which is only ever Unknown", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const section = checks(page);
    await expect(section).toContainText("Checks");
    await expect(section).toContainText("Bakery checks");
    await expect(section).toContainText("1 rule has no working check");
    await expect(section).toContainText(
      "Branch protection in your Git provider",
    );
    await expect(page.getByTestId("repository-rules-protection")).toHaveText(
      "Unknown",
    );
    await expect(section).toContainText(
      "Bakery cannot read branch protection for this repository yet. Check it in your Git provider.",
    );
    // Not configured is a claim Bakery cannot make.
    await expect(section).not.toContainText(/not configured/i);
    // The locked note ends in a link to where locked rules are changed.
    const note = page.getByTestId("repository-rules-locked-note");
    await expect(note).toContainText(
      "Locked rules can only be changed in Organization rules.",
    );
    await expect(note.getByRole("link", { name: "Organization rules" }))
      .toHaveAttribute("href", "/settings/organization/repository-rules");
    await shot(page, "repository-rules-checks");
  });

  for (
    const [state, reason, text] of [
      [
        "unknown",
        "provider_not_connected",
        "No Git provider is connected for this repository.",
      ],
      ["unknown", null, null],
      // The server's type allows these; Bakery still shows only what it knows.
      ["verified", null, null],
      [
        "not_configured",
        "not_checked",
        "Bakery cannot read branch protection for this repository yet.",
      ],
    ] as const
  ) {
    test(`branch protection stays Unknown for state ${state} and reason ${reason}`, async ({ page }) => {
      await rulesFixture(page, {
        rules: effective({ providerProtection: { state, reason } }),
      });
      await page.goto(RULES_PATH);
      await expect(page.getByTestId("repository-rules-protection")).toHaveText(
        "Unknown",
      );
      const section = checks(page);
      if (text) await expect(section).toContainText(text);
      else {
        await expect(section).not.toContainText(
          "No Git provider is connected",
        );
        await expect(section).not.toContainText(
          "cannot read branch protection",
        );
      }
    });
  }

  test("checks that are all set up, or not required, say so", async ({ page }) => {
    await rulesFixture(page, {
      rules: effective({
        checkers: { state: "configured", unavailableRuleKeys: [] },
      }),
    });
    await page.goto(RULES_PATH);
    await expect(checks(page)).toContainText("All required checks are set up");
    await expect(rule(page, "Magic numbers")).not.toContainText(
      "No working check",
    );

    const none = await page.context().newPage();
    await rulesFixture(none, {
      rules: effective({
        checkers: { state: "not_required", unavailableRuleKeys: [] },
      }),
    });
    await none.goto(RULES_PATH);
    await expect(checks(none)).toContainText("No checks required");
  });

  test("with no locked rule there is no locked note", async ({ page }) => {
    const open = effective({ supersededOverrides: [] });
    open.entries = open.entries.map((entry) => ({
      ...entry,
      provenance: "inherited",
    }));
    await rulesFixture(page, { rules: open });
    await page.goto(RULES_PATH);
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(page.getByTestId("repository-rules-locked-note")).toHaveCount(
      0,
    );
  });

  test("a repository no rules apply to shows only the empty state, with one link to the organization's rules", async ({ page }) => {
    await rulesFixture(page, {
      rules: effective({
        entries: [],
        supersededOverrides: [],
        checkers: { state: "not_required", unavailableRuleKeys: [] },
      }),
    });
    await page.goto(RULES_PATH);
    await expect(page.getByText("No rules apply to this repository"))
      .toBeVisible();
    // No summary, no checks, no version details, and no second link.
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
    await expect(checks(page)).toHaveCount(0);
    await expect(details(page)).toHaveCount(0);
    await expect(
      region(page).getByRole("link", { name: "View organization rules" }),
    ).toHaveCount(1);
    await expect(region(page).getByRole("table")).toHaveCount(0);
    await shot(page, "repository-rules-empty");
    await region(page).getByRole("link", { name: "View organization rules" })
      .click();
    await expect(page).toHaveURL(/\/settings\/organization\/repository-rules$/);
  });

  test("View organization rules ends the title row on a wide screen and is a plain link under it on a phone", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const heading = region(page).getByRole("heading", {
      name: "Rules",
      level: 1,
    });
    const link = region(page).getByRole("link", {
      name: "View organization rules",
    });
    const head = await heading.boundingBox();
    const found = await link.boundingBox();
    const column = await region(page).boundingBox();
    if (!head || !found || !column) throw new Error("a box is missing");
    if (isPhone(page)) {
      // Stacked under the title block as a plain link, not a full-width box.
      expect(found.y).toBeGreaterThanOrEqual(head.y + head.height);
      await expect(link).toHaveCSS("border-top-width", "0px");
      expect(
        await link.evaluate((node) =>
          node.classList.contains("ui-link--button")
        ),
      )
        .toBe(false);
    } else {
      expect(
        await link.evaluate((node) =>
          node.classList.contains("ui-link--button")
        ),
      )
        .toBe(true);
      // Beside the title, at the end of its row.
      expect(found.x).toBeGreaterThanOrEqual(head.x + head.width);
      expect(found.y).toBeLessThan(head.y + head.height);
      expect(
        Math.abs(column.x + column.width - (found.x + found.width)),
      ).toBeLessThanOrEqual(32);
    }
  });

  test("View organization rules goes to the organization's rules", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await region(page).getByRole("link", { name: "View organization rules" })
      .click();
    await expect(page).toHaveURL(/\/settings\/organization\/repository-rules$/);
  });

  test("a repository the person may not read shows one information banner with a way back", async ({ page }) => {
    await rulesFixture(page, {
      rulesProblem: problem(403, "AUTH_FORBIDDEN", "Access forbidden"),
    });
    await page.goto(RULES_PATH);
    const banner = page.getByTestId("repository-rules-unavailable");
    await expect(banner).toContainText(
      "This repository was not found, or you do not have access to its rules.",
    );
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
    await expect(region(page).getByRole("row")).toHaveCount(0);
    await shot(page, "repository-rules-refused");
    await banner.getByRole("link", { name: "Back to projects" }).click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test("an unknown repository says the same, so nothing can be probed", async ({ page }) => {
    await rulesFixture(page, {
      rulesProblem: problem(404, "RESOURCE_NOT_FOUND", "Resource not found"),
      repositoryProblem: problem(
        404,
        "RESOURCE_NOT_FOUND",
        "Resource not found",
      ),
    });
    await page.goto(RULES_PATH);
    await expect(page.getByTestId("repository-rules-unavailable"))
      .toBeVisible();
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
  });

  test("a failed read says what to do and offers Try again, which loads the rules", async ({ page }) => {
    const { recover, requests } = await rulesFixture(page, { failing: true });
    await page.goto(RULES_PATH);
    await expect(page.getByText("Rules could not be loaded.")).toBeVisible();
    await expect(page.getByText("Check your connection, then try again."))
      .toBeVisible();
    await shot(page, "repository-rules-error");
    // The page reads twice while it mounts (the dev root runs StrictMode), so
    // the count that matters is what Try again adds: exactly one read.
    const before = requests.length;
    recover();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(page.getByText("Rules could not be loaded.")).toHaveCount(0);
    expect(requests.length).toBe(before + 1);
  });

  test("while the rules load there are placeholders, not a banner", async ({ page }) => {
    await rulesFixture(page);
    // Hold the rules read until we have looked.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      `**/v1/repositories/${REPOSITORY_ID}/rules`,
      async (route: Route) => {
        await gate;
        await route.fallback();
      },
    );
    await page.goto(RULES_PATH);
    await expect(page.getByTestId("repository-rules-loading")).toBeVisible();
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
    await shot(page, "repository-rules-loading");
    release();
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(page.getByTestId("repository-rules-loading")).toHaveCount(0);
  });

  test("the Enforcement and Source help, and the fingerprint's, show on hover and focus and close on Escape", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    // Desktop: the two buttons sit in the column headers; phone: after the Rules heading.
    const enforcement = region(page).getByRole("button", {
      name: "About enforcement",
    });
    const source = region(page).getByRole("button", { name: "About source" });
    await expect(enforcement).toBeVisible();
    await expect(source).toBeVisible();
    if (!isPhone(page)) {
      await expect(
        region(page).getByRole("columnheader", { name: /Enforcement/ })
          .getByRole("button", { name: "About enforcement" }),
      ).toBeVisible();
    } else {
      // Two labelled triggers, "Enforcement (i)" then "Source (i)", side by side; the
      // list heading stays for screen readers but takes no room.
      const trigger = async (name: string, label: string) => {
        const text = region(page).getByText(name, { exact: true }).first();
        const button = region(page).getByRole("button", { name: label });
        const a = (await text.boundingBox())!;
        const b = (await button.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
        expect(Math.abs(b.y + b.height / 2 - (a.y + a.height / 2)))
          .toBeLessThan(a.height);
      };
      await trigger("Enforcement", "About enforcement");
      await trigger("Source", "About source");
      const listHeading = region(page).getByRole("heading", {
        name: "Rules",
        level: 2,
      });
      await expect(listHeading).toHaveCount(1);
      // Its wrapper is clipped to a pixel; the heading inside it takes no room.
      const wrapper = listHeading.locator("xpath=..");
      expect((await wrapper.boundingBox())!.height).toBeLessThanOrEqual(1);
    }
    // Focus shows the text, and the button is described by it.
    await enforcement.focus();
    const help = page.getByRole("tooltip").filter({
      hasText: "Require blocks delivery until the check passes.",
    });
    await expect(help).toBeVisible();
    await expect(enforcement).toHaveAccessibleDescription(
      /Require blocks delivery until the check passes\. Warn reports problems without blocking\./,
    );
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    // Moving on opens the next one's own text.
    await source.focus();
    const sourceHelp = page.getByRole("tooltip").filter({
      hasText: "Who decides this rule's setting.",
    });
    await expect(sourceHelp).toBeVisible();
    // The column header sits inside a table that scrolls: the text must still be seen.
    expect(await isSeen(sourceHelp)).toBe(true);
    await shot(page, "repository-rules-help-source", [], {
      windowOnly: true,
      only: "desktop",
    });
    // The fingerprint's help sits after its label and says what the value is for.
    const fingerprintHelp = details(page).getByRole("button", {
      name: "About the rules fingerprint",
    });
    await fingerprintHelp.hover();
    const fingerprintText = page.getByRole("tooltip").filter({
      hasText: "Each run records the same value",
    });
    await expect(fingerprintText).toBeVisible();
    expect(await isSeen(fingerprintText)).toBe(true);
    // Focus keeps it open through the capture's viewport change; a hover would end.
    await fingerprintHelp.focus();
    await expect(fingerprintText).toBeVisible();
    // The window, not the page: what the page's own scrolling clips would show.
    await shot(page, "repository-rules-help-fingerprint", [], {
      windowOnly: true,
      only: "desktop",
    });
  });

  test("a help button is a real target and its text fits in 320 px inside the window", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const button = region(page).getByRole("button", {
      name: "About enforcement",
    });
    const box = await button.boundingBox();
    if (!box) throw new Error("the help button has no box");
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
    await button.focus();
    const tooltip = page.getByRole("tooltip").filter({
      hasText: "Require blocks delivery",
    });
    await expect(tooltip).toBeVisible();
    // Seen, not clipped by the table whose header holds the button.
    expect(await isSeen(tooltip)).toBe(true);
    const tip = await tooltip.boundingBox();
    if (!tip) throw new Error("the tooltip has no box");
    expect(tip.width).toBeLessThanOrEqual(321);
    // It stays inside the window.
    const window = page.viewportSize();
    if (!window) throw new Error("no viewport");
    expect(tip.x).toBeGreaterThanOrEqual(0);
    expect(tip.x + tip.width).toBeLessThanOrEqual(window.width);
  });

  test("on a phone the help is a panel pinned to the bottom of the screen, as design-ux decided", async ({ page }) => {
    test.skip(!isPhone(page), "the panel is the phone behaviour");
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const window = page.viewportSize();
    if (!window) throw new Error("no viewport");
    const enforcement = region(page).getByRole("button", {
      name: "About enforcement",
    });
    await enforcement.click();
    const panel = page.locator(
      '[data-ui-component="helpTip"] .ui-help-tip__panel',
    ).filter({
      has: page.getByText("Require blocks delivery until the check passes."),
    });
    await expect(panel).toBeVisible();
    // The first line says what it is about, because the text is no longer beside its button.
    await expect(panel.locator(".ui-help-tip__title")).toHaveText(
      "About enforcement",
    );
    const box = await panel.boundingBox();
    if (!box) throw new Error("the panel has no box");
    // Full width less the 16 px gutters, 16 px above the bottom edge, at most half the screen.
    expect(Math.abs(box.x - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x + box.width - (window.width - 16)))
      .toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height - (window.height - 16)))
      .toBeLessThanOrEqual(2);
    expect(box.height).toBeLessThanOrEqual(window.height / 2 + 1);
    // Focus stays on the help button, which the text still describes.
    await expect(enforcement).toBeFocused();
    await expect(enforcement).toHaveAccessibleDescription(
      /Require blocks delivery until the check passes\./,
    );
    // The window, not the page: a full-page capture scrolls, and scrolling closes the panel.
    await shot(page, "repository-rules-help-panel", [], {
      windowOnly: true,
      only: "mobile",
    });

    // Opening a second one replaces the first: never two at once.
    await region(page).getByRole("button", { name: "About source" }).click();
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(1);
    await expect(
      page.getByRole("tooltip").filter({
        hasText: "Who decides this rule's setting.",
      }),
    ).toBeVisible();

    // Escape closes it; the close button closes it and focus returns to the help button.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(0);
    await enforcement.click();
    await page.getByRole("button", { name: "Close help" }).filter({
      visible: true,
    })
      .click();
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(0);
    await expect(enforcement).toBeFocused();
    // A tap elsewhere closes it too.
    await enforcement.click();
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(1);
    await page.getByRole("heading", { name: "Rules", level: 1 }).click();
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(0);
  });

  test("from 744 px the help is a tooltip anchored to its button, without the phone panel's label and close button", async ({ page }) => {
    test.skip(isPhone(page), "the tooltip is the wide-screen behaviour");
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const button = region(page).getByRole("button", {
      name: "About enforcement",
    });
    await button.focus();
    const panel = page.locator(
      '[data-ui-component="helpTip"][data-state="focus"] .ui-help-tip__panel',
    );
    await expect(panel).toBeVisible();
    expect(
      await panel.evaluate((node) => getComputedStyle(node).position),
    ).toBe("fixed");
    // Seen, not clipped by the table whose header holds the button.
    expect(await isSeen(panel)).toBe(true);
    // The label line and the close button belong to the phone panel.
    await expect(panel.locator(".ui-help-tip__title")).toBeHidden();
    await expect(panel.getByRole("button", { name: "Close help" }))
      .toBeHidden();
    // Anchored to the start of its button.
    const tip = await panel.boundingBox();
    const trigger = await button.boundingBox();
    if (!tip || !trigger) throw new Error("a box is missing");
    expect(Math.abs(tip.x - trigger.x)).toBeLessThanOrEqual(2);
    // Next to it without covering it: above, or below when the button is near the top of the window.
    expect(
      tip.y + tip.height <= trigger.y + 1 ||
        tip.y >= trigger.y + trigger.height - 1,
    ).toBe(true);
  });

  test("on a wide screen the Rule column takes half the table and no rule summary is cut", async ({ page }) => {
    test.skip(isPhone(page), "the table is the wide-screen layout");
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await expect(page.locator("thead th")).toHaveCount(3);
    const widths = await page.locator("thead th").evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width)
    );
    const total = widths.reduce((sum, width) => sum + width, 0);
    // About half for Rule, about a quarter each for Enforcement and Source.
    expect(widths[0] / total).toBeGreaterThan(0.45);
    expect(widths[1] / total).toBeLessThan(0.3);
    expect(widths[2] / total).toBeLessThan(0.3);
    // No summary is clamped: what is drawn is what is there.
    const cut = await page.locator("tbody .ui-text").evaluateAll((nodes) =>
      nodes.filter((node) => node.scrollHeight > node.clientHeight + 1).length
    );
    expect(cut).toBe(0);
  });

  test("the help buttons are plain icons, the warning badge is amber and Version details reads like Checks", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    // Plain (ghost) icons: no border, no fill, wherever they sit.
    await expect(
      details(page).getByRole("button", {
        name: "About the rules fingerprint",
      }),
    ).toBeVisible();
    const helpButtons = region(page).locator(".ui-help-tip > .ui-icon-button");
    const count = await helpButtons.count();
    expect(count).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < count; index += 1) {
      const style = await helpButtons.nth(index).evaluate((node) => {
        const css = getComputedStyle(node);
        return { border: css.borderTopWidth, background: css.backgroundColor };
      });
      expect(style.border).toBe("0px");
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
    }
    // "1 rule has no working check" has the warning tone.
    const badge = checks(page).getByText("1 rule has no working check");
    const warning = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-status-warning)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(await badge.evaluate((node) => getComputedStyle(node).color))
      .toBe(warning);
    // Version details: the label at the start, the value at the end, like Checks.
    const section = details(page);
    for (
      const [label, value] of [
        ["Organization rules version", "3"],
        ["Repository settings version", "8"],
      ]
    ) {
      const labelBox = (await section.getByText(label, { exact: true })
        .boundingBox())!;
      const valueBox = (await section.getByText(value, { exact: true })
        .boundingBox())!;
      const sectionBox = (await section.boundingBox())!;
      // Same line, value flush to the end of the section.
      expect(Math.abs(valueBox.y - labelBox.y)).toBeLessThan(labelBox.height);
      expect(valueBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
      expect(sectionBox.x + sectionBox.width - (valueBox.x + valueBox.width))
        .toBeLessThan(32);
    }
  });

  test("on a phone, scrolling the panel's own long text does not close it", async ({ page }) => {
    test.skip(!isPhone(page), "the panel is the phone behaviour");
    await rulesFixture(page);
    // A short window makes the help text longer than half the screen.
    await page.setViewportSize({ width: 195, height: 240 });
    await page.goto(RULES_PATH);
    const trigger = region(page).getByRole("button", {
      name: "About enforcement",
    });
    // Bring the button into the window first and let that scroll settle: a scroll
    // after the panel opens would close it, which is the other behaviour.
    await trigger.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await trigger.click();
    const panel = page.locator(
      '[data-ui-component="helpTip"] .ui-help-tip__panel',
    ).filter({
      has: page.getByText("Require blocks delivery until the check passes."),
    });
    await expect(panel).toBeVisible();
    expect(
      await panel.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    const scrolled = await panel.evaluate((node) => {
      node.scrollTop = 12;
      return node.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await page.evaluate(() =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
    );
    await expect(panel).toBeVisible();
  });

  test("on a wide screen opening one help closes the other", async ({ page }) => {
    test.skip(isPhone(page), "the phone panel is covered by its own test");
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await region(page).getByRole("button", { name: "About enforcement" })
      .click();
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(1);
    await region(page).getByRole("button", { name: "About source" }).hover();
    await expect(
      page.getByRole("tooltip").filter({
        visible: true,
        hasText: "Who decides this rule's setting.",
      }),
    ).toHaveCount(1);
    await expect(page.getByRole("tooltip").filter({ visible: true }))
      .toHaveCount(1);
  });

  test("Copy says it copied, then goes back to Copy; a refused copy says so", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await details(page).getByRole("button", { name: "Copy" }).click();
    await expect(details(page).getByRole("status")).toHaveText("Copied");
    await expect(details(page).getByRole("button", { name: "Copied" }))
      .toBeVisible();
    // The label returns and the announcement is forgotten.
    await expect(details(page).getByRole("button", { name: "Copy" }))
      .toBeVisible(
        { timeout: 6000 },
      );
    await expect(details(page).getByRole("status")).toHaveText("");
  });

  test("a refused clipboard write is visible: a caption and the whole fingerprint to select, until the next copy works", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // The first write is refused, the next one goes through.
    await page.addInitScript(() => {
      let writes = 0;
      const real = navigator.clipboard;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () => real.readText(),
          writeText: (text: string) =>
            writes++ === 0
              ? Promise.reject(new Error("denied"))
              : real.writeText(text),
        },
      });
    });
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const row = details(page);
    await row.getByRole("button", { name: "Copy" }).click();
    // Said out loud and shown, in the error colour, under the fingerprint row.
    const caption = row.getByRole("alert");
    await expect(caption).toHaveText(
      "Could not copy the fingerprint. Select it and copy it yourself.",
    );
    const error = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-destructive)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(await caption.evaluate((node) => getComputedStyle(node).color))
      .toBe(error);
    // The whole value replaces the short form, so there is something to select.
    await expect(page.getByTestId("repository-rules-digest")).toHaveText(
      DIGEST,
    );
    // The label stays Copy, and the caption does not time out.
    await expect(row.getByRole("button", { name: "Copy" })).toBeVisible();
    await page.waitForTimeout(3200);
    await expect(caption).toBeVisible();
    await shot(page, "repository-rules-copy-failed");
    // The next copy that works clears it and the short form returns.
    await row.getByRole("button", { name: "Copy" }).click();
    await expect(row.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("repository-rules-digest")).toHaveText(
      "9f2c41ab",
    );
  });

  test("on a phone the fingerprint sits under its label and Copy alone is at the end", async ({ page }) => {
    test.skip(!isPhone(page), "the wide-screen row puts the value beside Copy");
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const section = details(page);
    const label = (await section.locator(".ui-description-item__title")
      .filter({ hasText: "Rules fingerprint" }).boundingBox())!;
    const value = (await page.getByTestId("repository-rules-digest")
      .boundingBox())!;
    const copy = (await section.getByRole("button", { name: "Copy" })
      .boundingBox())!;
    const box = (await section.boundingBox())!;
    // The value is on the next line, starting where the label starts.
    expect(value.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
    expect(Math.abs(value.x - label.x)).toBeLessThanOrEqual(2);
    // Copy is alone at the end of the row, not stacked with the value.
    expect(box.x + box.width - (copy.x + copy.width)).toBeLessThan(32);
    expect(copy.x).toBeGreaterThan(value.x + value.width);
  });

  test("has no accessibility violations", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await expect(rule(page, "Semantic commits")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="repository-rules"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("long repository names and rule text stay inside the page", async ({ page }) => {
    const long = "a-very-long-repository-name-".repeat(6);
    await rulesFixture(page);
    await page.route(
      `**/v1/repositories/${REPOSITORY_ID}`,
      (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...repository, name: long }),
        }),
    );
    await page.goto(RULES_PATH);
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(region(page)).toContainText(long);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
  });

  test("renders in the dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await shot(page, "repository-rules-dark");
  });
});
