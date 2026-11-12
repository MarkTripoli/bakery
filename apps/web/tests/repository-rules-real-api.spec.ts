import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "@playwright/test";
import {
  type ChildServer,
  control,
  expect,
  forwardToApi,
  shot,
  startChild,
  stopChild,
} from "./helpers/real-api.ts";
import {
  RULE_ENTRIES,
  type RuleEntry,
} from "./helpers/repository-rules-fixtures.ts";

/**
 * Browser proof of the repository rules page (`/projects/repositories/$id/rules`)
 * against the real API: a Deno child (tests/helpers/repository-rules-server.child.ts)
 * runs the real Bakery app on a real test database, and the page's requests are
 * forwarded to it unchanged. Organization rules are published through the real
 * publication endpoint and a repository overrides them through the real profile
 * endpoint, so the page reads exactly what the server computed.
 *
 * Needs a migrated test database (`DATABASE_URL`, `BAKERY_APP_DATABASE_URL`,
 * `BAKERY_ENV=test`) and `deno`. It seeds its own Admin and Developer, so it
 * runs alone in the `desktop-real-rules` project when the operator sets both
 * `BAKERY_REAL_API=1` and `BAKERY_REAL_API_RULES=1`; it is never CI-selected.
 * `BAKERY_EVIDENCE_DIR=<dir>` saves desktop and phone screenshots.
 */
const enabled = process.env.BAKERY_REAL_API === "1" &&
  process.env.BAKERY_REAL_API_RULES === "1";
const rulesPath = (repositoryId: string) =>
  `/projects/repositories/${repositoryId}/rules`;

type Effective = {
  digest: string;
  organizationRevision: number;
  profileRevision: number | null;
  entries: { ruleKey: string; provenance: string }[];
  supersededOverrides: { ruleKey: string }[];
  checkers: { state: string; unavailableRuleKeys: string[] };
  providerProtection: { state: string; reason: string | null };
};
type Probe = { status: number; code: string | null; body: Effective | null };
type Written = { status: number; body: { revision?: number } | null };

/** An organization entry as a repository overrides it: without the lock flag. */
function overrideOf(entry: RuleEntry): RuleEntry {
  const { locked: _locked, ...rest } = entry;
  return rest;
}

test.describe("repository rules against the real API", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 and BAKERY_REAL_API_RULES=1 with a test database for the child API",
  );

  let child: ChildProcess | undefined;
  let server: ChildServer;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ child, server } = await startChild<ChildServer>(
      "tests/helpers/repository-rules-server.child.ts",
    ));
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
  test.afterAll(async () => {
    await stopChild(child);
  });
  test.beforeEach(() => {
    test.setTimeout(90_000);
  });

  const publish = async (expectedRevision: number, entries: RuleEntry[]) => {
    const written = await control<Written>(server, "/publish", {
      expectedRevision,
      entries,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    return written.body!;
  };
  const seedRepository = async (name: string) =>
    (await control<{ repositoryId: string }>(server, "/repository", {
      owner: "acme",
      name,
    })).repositoryId;
  const createProfile = async (
    repositoryId: string,
    repositoryRules: unknown,
    expectedOrganizationRulesRevision: number,
  ) => {
    const written = await control<Written>(server, "/profile", {
      repositoryId,
      revision: 1,
      repositoryRules,
      expectedOrganizationRulesRevision,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
  };
  /** What the real server says the repository's rules are, read as the Admin. */
  const effective = async (repositoryId: string) => {
    const probe = await control<Probe>(
      server,
      `/probe?who=admin&path=${
        encodeURIComponent(`/v1/repositories/${repositoryId}/rules`)
      }`,
    );
    expect(probe.status, JSON.stringify(probe)).toBe(200);
    return probe.body!;
  };

  async function open(
    page: import("@playwright/test").Page,
    baseURL: string | undefined,
    repositoryId: string,
    cookie = server.adminCookie,
  ) {
    await forwardToApi(page, baseURL!, server, cookie);
    await page.goto(rulesPath(repositoryId));
    await expect(
      page.getByRole("heading", { name: "Rules", level: 1 }),
    ).toBeVisible();
  }
  const rule = (page: import("@playwright/test").Page, name: string) => {
    const region = page.getByTestId("repository-rules");
    return region.getByRole("row", { name }).or(
      region.getByRole("listitem").filter({ hasText: name }),
    );
  };

  test("a repository with no profile follows the organization's rules, and the page shows the server's digest", async ({ page, baseURL }) => {
    expect((await publish(0, RULE_ENTRIES)).revision).toBe(1);
    const repositoryId = await seedRepository("payments-api");
    const served = await effective(repositoryId);

    await open(page, baseURL, repositoryId);
    const summary = page.getByTestId("repository-rules-summary");
    await expect(summary).toHaveText(
      "2 locked by the organization · 3 organization defaults · 0 set for this repository",
    );
    // The versions are at the end: organization rules 1, and no repository settings yet.
    const versions = page.getByTestId("repository-rules-details");
    await expect(versions.getByText("1", { exact: true })).toBeVisible();
    await expect(versions.getByText("None", { exact: true })).toBeVisible();
    // The digest on screen is the one the server computed.
    const digest = page.getByTestId("repository-rules-digest");
    await expect(digest).toHaveText(served.digest.slice(0, 8));
    await expect(digest).toHaveAttribute("title", served.digest);

    await expect(rule(page, "Semantic commits")).toContainText(
      "Locked by organization",
    );
    await expect(rule(page, "PR / MR titles")).toContainText(
      "Locked by organization",
    );
    await expect(rule(page, "Merge descriptions")).toContainText(
      "Organization default",
    );
    // Whatever the server says it cannot check is what the page says.
    const unavailable = served.checkers.unavailableRuleKeys.length;
    const footer = page.getByTestId("repository-rules-checks");
    if (served.checkers.state === "unavailable") {
      await expect(footer).toContainText(
        unavailable === 1
          ? "1 rule has no working check"
          : `${unavailable} rules have no working check`,
      );
    } else {
      await expect(footer).not.toContainText("no working check");
    }
    // Provider protection is Unknown, with the reason the server gives.
    await expect(page.getByTestId("repository-rules-protection")).toHaveText(
      "Unknown",
    );
    expect(served.providerProtection.state).toBe("unknown");
    if (served.providerProtection.reason === "provider_not_connected") {
      await expect(footer).toContainText(
        "No Git provider is connected for this repository.",
      );
    }
    await shot(page, "repository-rules-real-inherited");
  });

  test("a repository override shows as one, and a lock that came after it says the override is inactive", async ({ page, baseURL }) => {
    // Revision 2 lets repositories override Semantic commits.
    const open2 = RULE_ENTRIES.map((entry) =>
      entry.ruleKey === "commits.semantic" ? { ...entry, locked: false } : entry
    );
    expect((await publish(1, open2)).revision).toBe(2);
    const repositoryId = await seedRepository("ledger");
    await createProfile(repositoryId, {
      entries: RULE_ENTRIES.filter((entry) =>
        entry.ruleKey === "commits.semantic" ||
        entry.ruleKey === "code.magicStrings"
      ).map((entry) =>
        entry.ruleKey === "commits.semantic"
          ? { ...overrideOf(entry), mode: "warn" }
          : { ...overrideOf(entry), enabled: true, mode: "require" }
      ),
    }, 2);
    // Revision 3 locks it again: the override stays saved and stops applying.
    expect((await publish(2, RULE_ENTRIES)).revision).toBe(3);
    const served = await effective(repositoryId);
    expect(
      served.supersededOverrides.map((superseded) => superseded.ruleKey),
    ).toEqual(["commits.semantic"]);

    await open(page, baseURL, repositoryId);
    const summary = page.getByTestId("repository-rules-summary");
    await expect(summary).toHaveText(
      "2 locked by the organization · 2 organization defaults · 1 set for this repository",
    );
    const versions = page.getByTestId("repository-rules-details");
    await expect(versions.getByText("3", { exact: true })).toBeVisible();
    await expect(versions.getByText("1", { exact: true })).toBeVisible();
    const semantic = rule(page, "Semantic commits");
    await expect(semantic).toContainText("Locked by organization");
    await expect(semantic).toContainText(
      "This repository's own setting is saved but not used while the rule is locked.",
    );
    const strings = rule(page, "Magic strings");
    await expect(strings).toContainText("This repository");
    await expect(strings).toContainText("Require");
    await shot(page, "repository-rules-real-override");
  });

  test("a Developer can read the rules of a repository", async ({ page, baseURL }) => {
    const repositoryId = await seedRepository("web");
    // This person belongs to more than one organization; a returning browser
    // remembers the one they last worked in, here the Admin's.
    await page.addInitScript((organizationId) => {
      globalThis.localStorage.setItem(
        "bakery.organization.lastSelected.v1",
        organizationId,
      );
    }, server.organizationId);
    const read = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/repositories/${repositoryId}/rules`)
    );
    await open(page, baseURL, repositoryId, server.developerCookie);
    expect((await read).status()).toBe(200);
    await expect(rule(page, "Semantic commits")).toBeVisible();
    await expect(page.getByTestId("repository-rules-summary")).toContainText(
      "locked by the organization",
    );
    await expect(
      page.getByTestId("repository-rules-details").getByText("3", {
        exact: true,
      }),
    ).toBeVisible();
    await shot(page, "repository-rules-real-developer");
  });

  test("a repository the server does not know is refused without saying why", async ({ page, baseURL }) => {
    await forwardToApi(page, baseURL!, server, server.adminCookie);
    const read = page.waitForResponse((response) =>
      response.url().includes("/rules") &&
      response.url().includes("/v1/repositories/")
    );
    await page.goto(rulesPath(randomUUID()));
    expect((await read).status()).toBe(404);
    await expect(page.getByTestId("repository-rules-unavailable"))
      .toContainText(
        "This repository was not found, or you do not have access to its rules.",
      );
    await expect(page.getByTestId("repository-rules-summary")).toHaveCount(0);
    await shot(page, "repository-rules-real-unavailable");
  });
});
