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
  /** Answers the first `n` rules reads with a 500 before the real answer. */
  failFirst?: number;
  rulesProblem?: ReturnType<typeof problem>;
  repositoryProblem?: ReturnType<typeof problem>;
};

async function rulesFixture(page: Page, options: Options = {}) {
  const requests: string[] = [];
  let failures = options.failFirst ?? 0;
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
      if (failures > 0) {
        failures -= 1;
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
  return { requests };
}

const region = (page: Page) => page.getByTestId("repository-rules");
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
    await expect(page).toHaveURL(/\/projects\/onboarding/);
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
    const { requests } = await rulesFixture(page, { failFirst: 1 });
    await page.goto(RULES_PATH);
    await expect(page.getByText("Rules could not be loaded.")).toBeVisible();
    await expect(page.getByText("Check your connection, then try again."))
      .toBeVisible();
    await shot(page, "repository-rules-error");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(page.getByText("Rules could not be loaded.")).toHaveCount(0);
    expect(requests.length).toBe(2);
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
      await expect(
        region(page).getByRole("heading", { name: "Rules", level: 2 }),
      ).toBeVisible();
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
    await expect(
      page.getByRole("tooltip").filter({
        hasText: "Who decides this rule's setting.",
      }),
    ).toBeVisible();
    // The fingerprint's help sits after its label and says what the value is for.
    const fingerprintHelp = details(page).getByRole("button", {
      name: "About the rules fingerprint",
    });
    await fingerprintHelp.hover();
    await expect(
      page.getByRole("tooltip").filter({
        hasText: "Each run records the same value",
      }),
    ).toBeVisible();
    await shot(page, "repository-rules-help");
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
    await shot(page, "repository-rules-help-panel");

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
    ).toBe("absolute");
    // The label line and the close button belong to the phone panel.
    await expect(panel.locator(".ui-help-tip__title")).toBeHidden();
    await expect(panel.getByRole("button", { name: "Close help" }))
      .toBeHidden();
    // Anchored to the start of its button, above it.
    const tip = await panel.boundingBox();
    const trigger = await button.boundingBox();
    if (!tip || !trigger) throw new Error("a box is missing");
    expect(Math.abs(tip.x - trigger.x)).toBeLessThanOrEqual(2);
    expect(tip.y + tip.height).toBeLessThanOrEqual(trigger.y + 1);
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
