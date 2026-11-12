import type { ChildProcess } from "node:child_process";
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
  historyRows,
  RULE_ENTRIES,
  type RuleEntry,
  ruleRow,
  rulesRegion,
} from "./helpers/repository-rules-fixtures.ts";

/**
 * Browser proof of the organization repository rules page against the real
 * API: a Deno child (tests/helpers/repository-rules-server.child.ts) runs the
 * real Bakery app on a real test database, and the page's requests are
 * forwarded to it unchanged. Revisions are published through the real
 * publication endpoint, so the page reads exactly what the server stored.
 *
 * Needs a migrated test database (`DATABASE_URL`, `BAKERY_APP_DATABASE_URL`,
 * `BAKERY_ENV=test`) and `deno`. It seeds its own Admin, so it runs alone in
 * the `desktop-real-rules` project when the operator sets both
 * `BAKERY_REAL_API=1` and `BAKERY_REAL_API_RULES=1`; it is never CI-selected.
 * `BAKERY_EVIDENCE_DIR=<dir>` saves desktop and phone screenshots.
 */
const enabled = process.env.BAKERY_REAL_API === "1" &&
  process.env.BAKERY_REAL_API_RULES === "1";
const PAGE_PATH = "/settings/organization/repository-rules";
/** The page asks for 25 revisions at a time. */
const PAGE_SIZE = 25;
const TOTAL_REVISIONS = PAGE_SIZE + 1;

type Published = {
  status: number;
  body: { revision?: number; digest?: string; code?: string } | null;
};
type State = {
  versions: { revision: number; digest: string; entries: number }[];
};

test.describe("organization repository rules against the real API", () => {
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

  const state = () => control<State>(server, "/state");
  const publish = async (expectedRevision: number, entries: RuleEntry[]) => {
    const published = await control<Published>(server, "/publish", {
      expectedRevision,
      entries,
    });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    return published.body!;
  };
  /** The standard entries with the commit subject limit changed, so revisions differ. */
  const withSubjectLimit = (limit: number): RuleEntry[] =>
    RULE_ENTRIES.map((entry) =>
      entry.ruleKey === "commits.semantic"
        ? {
          ...entry,
          options: {
            ...(entry.options as Record<string, unknown>),
            maxSubjectLength: limit,
          },
        }
        : entry
    );

  async function openAsAdmin(
    page: import("@playwright/test").Page,
    baseURL: string | undefined,
  ) {
    await forwardToApi(page, baseURL!, server, server.adminCookie);
    await page.goto(PAGE_PATH);
    await expect(
      page.getByRole("heading", { name: "Repository rules", level: 1 }),
    ).toBeVisible();
  }

  test("an organization with nothing published reads as empty from the real server", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await expect(
      page.getByText("No organization rules yet", { exact: true }),
    ).toBeVisible();
    expect((await state()).versions).toEqual([]);
    await shot(page, "rules-empty");
  });

  test("shows what the server published: the current revision, each rule and the history", async ({ page, baseURL }) => {
    // Revision 1 carries two rules, revision 2 all five.
    await publish(0, RULE_ENTRIES.slice(0, 2));
    const second = await publish(1, RULE_ENTRIES);
    expect(second.revision).toBe(2);

    await openAsAdmin(page, baseURL);
    const stored = (await state()).versions;
    expect(stored.map((row) => row.revision)).toEqual([1, 2]);
    expect(stored.map((row) => row.entries)).toEqual([2, 5]);

    await expect(page.getByTestId("org-rules-current")).toContainText(
      "Published revision 2",
    );
    const row = (name: string) => ruleRow(page, name);
    await expect(row("Semantic commits")).toContainText("Locked");
    await expect(row("PR / MR titles")).toContainText("Locked");
    await expect(row("Merge descriptions")).toContainText("Can override");
    await expect(row("Magic numbers")).toContainText("allow 0, 1");
    await expect(row("Magic strings")).toContainText("Off");

    const history = historyRows(page);
    // Both revisions, newest first.
    await expect(history).toHaveCount(2);
    // The digest on screen is the one the server stored for that revision.
    await expect(history.nth(0)).toContainText(
      stored[1].digest.slice(0, 8),
    );
    await expect(history.nth(1)).toContainText(
      stored[0].digest.slice(0, 8),
    );
    await shot(page, "rules-current");
  });

  test("pages the history with the server's cursor", async ({ page, baseURL }) => {
    for (let revision = 3; revision <= TOTAL_REVISIONS; revision += 1) {
      await publish(revision - 1, withSubjectLimit(40 + revision));
    }
    expect((await state()).versions).toHaveLength(TOTAL_REVISIONS);

    await openAsAdmin(page, baseURL);
    const history = historyRows(page);
    // One page of 25; the oldest revision is on the next page.
    await expect(history).toHaveCount(PAGE_SIZE);
    await expect(history.nth(0)).toContainText(
      String(TOTAL_REVISIONS),
    );
    await page.getByRole("button", { name: "Load more revisions" }).click();
    await expect(history).toHaveCount(TOTAL_REVISIONS);
    await expect(
      page.getByRole("button", { name: "Load more revisions" }),
    ).toHaveCount(0);
    await shot(page, "rules-history-paged");
  });

  test("a member who is not an administrator is refused by the server", async ({ page, baseURL }) => {
    // This person belongs to more than one organization; a returning browser
    // remembers the one they last worked in, here the Admin's.
    await page.addInitScript((organizationId) => {
      globalThis.localStorage.setItem(
        "bakery.organization.lastSelected.v1",
        organizationId,
      );
    }, server.organizationId);
    await forwardToApi(page, baseURL!, server, server.developerCookie);
    const read = page.waitForResponse((response) =>
      response.url().endsWith(
        `/v1/organizations/${server.organizationId}/repository-rules`,
      )
    );
    await page.goto(PAGE_PATH);
    // What the real server answers a person who is not an administrator there.
    expect((await read).status()).toBe(404);
    await expect(
      page.getByText(
        "Only organization administrators can manage repository rules.",
      ),
    ).toBeVisible();
    await expect(
      rulesRegion(page),
    ).toHaveCount(0);
    await shot(page, "rules-forbidden");
  });

  /** Edits one rule through the page's editor and applies it to the draft. */
  async function editRule(
    page: import("@playwright/test").Page,
    rule: string,
    change: (page: import("@playwright/test").Page) => Promise<void>,
  ) {
    await page.getByRole("button", { name: `Edit ${rule}` }).click();
    await expect(
      page.getByRole("heading", { name: `Edit ${rule}`, level: 1 }),
    ).toBeVisible();
    await change(page);
    await page.getByRole("button", { name: "Apply to draft" }).click();
  }
  const chooseMode =
    (mode: string) => async (page: import("@playwright/test").Page) => {
      await page.getByRole("group", { name: "Enforcement" }).getByRole(
        "radio",
        {
          name: mode,
          exact: true,
        },
      ).check({ force: true });
    };

  test("edits a rule, reviews what it would do and publishes it against the real server", async ({ page, baseURL }) => {
    await openAsAdmin(page, baseURL);
    await expect(page.getByTestId("org-rules-current")).toContainText(
      `Published revision ${TOTAL_REVISIONS}`,
    );
    await editRule(page, "Magic strings", async (editor) => {
      await editor.getByRole("switch", { name: "Rule enabled" }).check();
    });
    await expect(
      page.getByRole("status").filter({ hasText: "unpublished change" }),
    ).toContainText("1 unpublished change");
    await shot(page, "rules-draft");

    // The real preview answers: the dialog can publish only after it has.
    await page.getByRole("button", { name: "Review and publish" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(
      `Publish revision ${TOTAL_REVISIONS + 1}?`,
    );
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeEnabled();
    await expect(dialog).toContainText(/Applies to \d+ repositor(y|ies) now/);
    await shot(page, "rules-review");

    await dialog.getByRole("button", { name: "Publish rules" }).click();
    await expect(
      page.getByText(`Revision ${TOTAL_REVISIONS + 1} published.`),
    ).toBeVisible();
    // The server stored it, and the page now reads what the server stored.
    const stored = (await state()).versions;
    expect(stored.at(-1)).toMatchObject({
      revision: TOTAL_REVISIONS + 1,
      entries: 5,
    });
    await expect(page.getByTestId("org-rules-current")).toContainText(
      `Published revision ${TOTAL_REVISIONS + 1}`,
    );
    await expect(ruleRow(page, "Magic strings")).not.toContainText("Edited");
    await expect(ruleRow(page, "Magic strings")).toContainText("Warn");
    await shot(page, "rules-published");
  });

  test("a revision published meanwhile makes the real server refuse the review, and the draft is reconciled", async ({ page, baseURL }) => {
    const current = TOTAL_REVISIONS + 1;
    await openAsAdmin(page, baseURL);
    await editRule(page, "Semantic commits", chooseMode("Warn"));
    await expect(
      page.getByRole("status").filter({ hasText: "unpublished change" }),
    ).toContainText("1 unpublished change");

    // Someone else publishes the next revision, changing the same rule.
    const theirs = RULE_ENTRIES.map((entry) =>
      entry.ruleKey === "commits.semantic" ? { ...entry, mode: "guide" } : entry
    );
    const next = await publish(current, theirs);
    expect(next.revision).toBe(current + 1);

    // The real preview answers 412 for the revision this draft was made on.
    await page.getByRole("button", { name: "Review and publish" }).click();
    const notice = page.getByTestId("org-rules-stale");
    await expect(notice).toContainText(
      `Revision ${current + 1} was published while you were editing.`,
    );
    const conflicts = page.getByTestId("org-rules-conflicts");
    await expect(conflicts).toContainText("Semantic commits");
    await expect(conflicts).toContainText(`Changed in revision ${current + 1}`);
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeDisabled();
    await shot(page, "rules-stale");

    await page.getByRole("button", { name: "Keep mine for Semantic commits" })
      .click();
    await page.getByRole("button", { name: "Review and publish" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Publish revision ${current + 2}?`);
    await dialog.getByRole("button", { name: "Publish rules" }).click();
    await expect(page.getByText(`Revision ${current + 2} published.`))
      .toBeVisible();
    const stored = (await state()).versions;
    expect(stored.at(-1)?.revision).toBe(current + 2);
    // Mine won: the published rule is the one edited here, not the other revision's.
    await expect(ruleRow(page, "Semantic commits")).toContainText("Warn");
    await shot(page, "rules-stale-resolved");
  });
});
