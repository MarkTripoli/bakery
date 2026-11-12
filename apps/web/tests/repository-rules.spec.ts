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

/** One rule's row in whichever layout is showing. */
function rule(page: Page, name: string): Locator {
  return region(page).getByRole("row", { name }).or(
    region(page).getByRole("listitem").filter({ hasText: name }),
  );
}

test.describe("repository rules: the effective rules of one repository", () => {
  test("lists each rule with where it came from", async ({ page }) => {
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
    // A repository override that a lock switched off is saved, and says it is inactive.
    await expect(semantic).toContainText(
      "Your override is saved but inactive.",
    );
    await expect(rule(page, "PR / MR titles")).toContainText(
      "Locked by organization",
    );
    await expect(rule(page, "PR / MR titles")).not.toContainText(
      "Your override",
    );
    await expect(rule(page, "Merge descriptions")).toContainText("Inherited");
    await expect(rule(page, "Magic numbers")).toContainText("Inherited");
    const override = rule(page, "Magic strings");
    await expect(override).toContainText("Repository override");
    await expect(override).toContainText("Require");
    await shot(page, "repository-rules");
  });

  test("the summary says what is inherited, counts the sources and shows the digest", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const summary = page.getByTestId("repository-rules-summary");
    await expect(summary).toContainText(
      "Inherits organization revision 3 · repository profile 8",
    );
    await expect(summary).toContainText(
      "2 locked · 2 inherited · 1 repository override",
    );
    // Eight characters on screen, the whole value as the title.
    const digest = page.getByTestId("repository-rules-digest");
    await expect(digest).toHaveText("Digest 9f2c41ab");
    await expect(digest).toHaveAttribute("title", DIGEST);
  });

  test("the digest can be copied", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await page.getByRole("button", { name: "Copy digest" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      DIGEST,
    );
  });

  test("a repository with no organization rules and no profile says so", async ({ page }) => {
    await rulesFixture(page, {
      rules: effective({ organizationRevision: 0, profileRevision: null }),
    });
    await page.goto(RULES_PATH);
    await expect(page.getByTestId("repository-rules-summary")).toContainText(
      "No organization rules are published · no repository profile",
    );
  });

  test("a rule with no working check says so, and says it blocks delivery only for Require", async ({ page }) => {
    const warnNumbers = effective();
    warnNumbers.entries = warnNumbers.entries.map((entry) =>
      entry.ruleKey === "code.magicNumbers" ? { ...entry, mode: "warn" } : entry
    );
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    // Require: the check is what delivery waits on.
    await expect(rule(page, "Magic numbers")).toContainText(
      "Check unavailable · blocks delivery",
    );
    // No other row claims a missing check.
    await expect(rule(page, "Semantic commits")).not.toContainText(
      "Check unavailable",
    );
    await shot(page, "repository-rules-check-unavailable");

    const warn = await page.context().newPage();
    await rulesFixture(warn, { rules: warnNumbers });
    await warn.goto(RULES_PATH);
    await expect(rule(warn, "Magic numbers")).toContainText(
      "Check unavailable",
    );
    await expect(rule(warn, "Magic numbers")).not.toContainText(
      "blocks delivery",
    );
  });

  test("a switched-off rule never claims a missing check", async ({ page }) => {
    const off = effective({
      checkers: {
        state: "unavailable",
        unavailableRuleKeys: ["code.magicStrings"],
      },
    });
    off.entries = off.entries.map((entry) =>
      entry.ruleKey === "code.magicStrings"
        ? { ...entry, enabled: false }
        : entry
    );
    await rulesFixture(page, { rules: off });
    await page.goto(RULES_PATH);
    await expect(rule(page, "Magic strings")).toContainText("Off");
    await expect(rule(page, "Magic strings")).not.toContainText(
      "Check unavailable",
    );
  });

  test("the footer names the checks and never says anything about provider protection but Unknown", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    const footer = page.getByTestId("repository-rules-footer");
    await expect(footer).toContainText("Bakery checks");
    await expect(footer).toContainText("1 rule has no working check");
    await expect(footer).toContainText("Provider branch protection");
    await expect(page.getByTestId("repository-rules-protection")).toHaveText(
      "Unknown",
    );
    await expect(footer).toContainText(
      "Bakery cannot read branch protection for this repository yet. Check it in your Git provider.",
    );
    await expect(footer).toContainText(
      "Locked rules can only change in Organization → Repository rules.",
    );
    // Not configured is a claim Bakery cannot make.
    await expect(footer).not.toContainText(/not configured/i);
    await shot(page, "repository-rules-footer");
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
    test(`provider protection stays Unknown for state ${state} and reason ${reason}`, async ({ page }) => {
      await rulesFixture(page, {
        rules: effective({ providerProtection: { state, reason } }),
      });
      await page.goto(RULES_PATH);
      await expect(page.getByTestId("repository-rules-protection")).toHaveText(
        "Unknown",
      );
      const footer = page.getByTestId("repository-rules-footer");
      if (text) await expect(footer).toContainText(text);
      else {
        await expect(footer).not.toContainText("No Git provider is connected");
        await expect(footer).not.toContainText("cannot read branch protection");
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
    await expect(page.getByTestId("repository-rules-footer")).toContainText(
      "All required checks are set up",
    );
    await expect(rule(page, "Magic numbers")).not.toContainText(
      "Check unavailable",
    );

    const none = await page.context().newPage();
    await rulesFixture(none, {
      rules: effective({
        checkers: { state: "not_required", unavailableRuleKeys: [] },
      }),
    });
    await none.goto(RULES_PATH);
    await expect(none.getByTestId("repository-rules-footer")).toContainText(
      "No checks required",
    );
  });

  test("a repository no rules apply to says so and links to the organization's", async ({ page }) => {
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
    await expect(region(page).getByRole("table")).toHaveCount(0);
    await shot(page, "repository-rules-empty");
    await region(page).getByRole("link", { name: "View organization rules" })
      .last().click();
    await expect(page).toHaveURL(/\/settings\/organization\/repository-rules$/);
  });

  test("View organization rules goes to the organization's rules", async ({ page }) => {
    await rulesFixture(page);
    await page.goto(RULES_PATH);
    await region(page).getByRole("link", { name: "View organization rules" })
      .click();
    await expect(page).toHaveURL(/\/settings\/organization\/repository-rules$/);
  });

  test("a repository the person may not read shows an information banner and no rules", async ({ page }) => {
    await rulesFixture(page, {
      rulesProblem: problem(403, "AUTH_FORBIDDEN", "Access forbidden"),
    });
    await page.goto(RULES_PATH);
    await expect(page.getByTestId("repository-rules-unavailable"))
      .toContainText(
        "This repository was not found, or you do not have access to its rules.",
      );
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
    await expect(region(page).getByRole("row")).toHaveCount(0);
    await shot(page, "repository-rules-refused");
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

  test("a failed read offers Try again, which loads the rules", async ({ page }) => {
    const { requests } = await rulesFixture(page, { failFirst: 1 });
    await page.goto(RULES_PATH);
    await expect(page.getByText("Rules could not be loaded.")).toBeVisible();
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
