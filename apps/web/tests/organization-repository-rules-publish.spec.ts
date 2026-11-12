import { expect, type Page, type Route, test } from "@playwright/test";
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
const problem = (status: number) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/internal",
    title: "INTERNAL",
    detail: "INTERNAL",
    status,
    code: "INTERNAL",
    retryable: false,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
  }),
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type PreviewItem = {
  repositoryId: string;
  applicationId: string;
  repositoryName: string;
  status: "inherited" | "overridden" | "newly_locked";
  unsupported: boolean;
  supersededRules: string[];
  reactivatedRules: string[];
};
const repo = (n: number, extra: Partial<PreviewItem> = {}): PreviewItem => ({
  repositoryId: uuid(200 + n),
  applicationId: uuid(300 + n),
  repositoryName: `acme/service-${n}`,
  status: "inherited",
  unsupported: false,
  supersededRules: [],
  reactivatedRules: [],
  ...extra,
});
type PreviewPage = {
  counts: {
    repositories: number;
    inherited: number;
    overridden: number;
    newlyLocked: number;
    unsupported: number;
  };
  items: PreviewItem[];
  nextCursor: string | null;
};
/** Five repositories: three inherit, one keeps an override, one is newly locked. */
const FIRST_PAGE: PreviewPage = {
  counts: {
    repositories: 5,
    inherited: 3,
    overridden: 1,
    newlyLocked: 1,
    unsupported: 0,
  },
  items: [
    repo(1, { status: "overridden" }),
    repo(2, { status: "newly_locked", supersededRules: ["commits.semantic"] }),
    repo(3),
    repo(4, { reactivatedRules: ["code.magicNumbers"] }),
    repo(5),
  ],
  nextCursor: null,
};

type Options = {
  pages?: Record<string, PreviewPage>;
  holdPreview?: Promise<void>;
  previewStatus?: number;
  publishStatus?: number;
};

async function publishFixture(page: Page, options: Options = {}) {
  const state = {
    revision: 3,
    entries: RULE_ENTRIES as RuleEntry[],
    previewBodies: [] as Record<string, unknown>[],
    previewStatus: options.previewStatus ?? 200,
    publishBodies: [] as Record<string, unknown>[],
    publishKeys: [] as (string | undefined)[],
    publishStatus: options.publishStatus ?? 200,
  };
  const pages = options.pages ?? { first: FIRST_PAGE };
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
        revision: state.revision,
        entries: state.entries,
        digest: DIGEST,
        createdAt: "2026-10-03T09:30:00.000Z",
        createdBy: AUTHOR_ID,
      })),
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rule-versions**`,
    (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        return route.fulfill(json({ items: [], nextCursor: null }));
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      state.publishBodies.push(body);
      state.publishKeys.push(request.headers()["idempotency-key"]);
      if (state.publishStatus !== 200) {
        return route.fulfill(problem(state.publishStatus));
      }
      state.revision = (body.expectedRevision as number) + 1;
      state.entries = body.entries as RuleEntry[];
      return route.fulfill(json({
        id: uuid(900),
        organizationId: MOCK_ORGANIZATION_ID,
        revision: state.revision,
        entries: state.entries,
        digest: DIGEST,
        createdAt: "2026-10-04T09:30:00.000Z",
        createdBy: AUTHOR_ID,
      }, 201));
    },
  );
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/repository-rule-previews`,
    async (route: Route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.previewBodies.push(body);
      await options.holdPreview;
      if (state.previewStatus !== 200) {
        return route.fulfill(problem(state.previewStatus));
      }
      const cursor = (body.cursor as string | undefined) ?? "first";
      return route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        currentRevision: state.revision,
        draftRevision: state.revision + 1,
        draftDigest: DIGEST,
        ...pages[cursor],
      }));
    },
  );
  return state;
}

const draftBar = (page: Page) =>
  page.getByRole("status").filter({ hasText: "unpublished change" });

/** Edits Semantic commits to Warn and returns to the list, so there is a draft to publish. */
async function makeDraft(page: Page) {
  await page.goto(LIST_PATH);
  await page.getByRole("button", { name: "Edit Semantic commits" }).click();
  await page.getByRole("group", { name: "Enforcement" }).getByRole("radio", {
    name: "Warn",
    exact: true,
  }).check({ force: true });
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect(draftBar(page)).toContainText("1 unpublished change");
}

const review = async (page: Page) => {
  await page.getByRole("button", { name: "Review and publish" }).click();
  return page.getByRole("dialog");
};

test.describe("organization repository rules: review and publish", () => {
  test("the review asks the server what the draft would do and lists only the affected repositories", async ({ page }) => {
    const state = await publishFixture(page);
    await makeDraft(page);
    const dialog = await review(page);
    await expect(dialog).toContainText("Publish revision 4?");
    await expect(dialog).toContainText("Applies to 5 repositories now");
    for (
      const [label, value] of [
        ["Inherit as is", "3"],
        ["Keep an override", "1"],
        ["Override newly locked", "1"],
        ["No working check", "0"],
      ]
    ) {
      await expect(dialog.getByText(label, { exact: true }).first())
        .toBeVisible();
      await expect(dialog).toContainText(value);
    }
    // Repositories that inherit unchanged are counted, not listed.
    const table = dialog.getByRole("table", { name: "Affected repositories" });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table).toContainText("acme/service-1");
    await expect(table).toContainText("acme/service-2");
    await expect(table).toContainText("acme/service-4");
    await expect(table).not.toContainText("acme/service-3");
    await expect(table).toContainText("Override active again");
    // What the server was asked: the draft against the revision it was made on.
    expect(state.previewBodies).toHaveLength(1);
    const asked = state.previewBodies[0] as {
      expectedRevision: number;
      entries: RuleEntry[];
    };
    expect(asked.expectedRevision).toBe(3);
    expect(asked.entries.map((entry) => entry.ruleKey)).toEqual(
      RULE_ENTRIES.map((entry) => entry.ruleKey),
    );
    expect(asked.entries[0]).toMatchObject({
      ruleKey: "commits.semantic",
      mode: "warn",
    });
    expect(asked.entries.slice(1)).toEqual(RULE_ENTRIES.slice(1));
    // No repository lacks a working check, so there is nothing to warn about.
    await expect(dialog.getByText("no working check for a required rule"))
      .toHaveCount(0);
  });

  test("Publish rules stays off until the preview has answered", async ({ page }) => {
    let release!: () => void;
    const holdPreview = new Promise<void>((resolve) => {
      release = resolve;
    });
    await publishFixture(page, { holdPreview });
    await makeDraft(page);
    const dialog = await review(page);
    await expect(page.getByTestId("org-rules-preview-loading")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeDisabled();
    release();
    await expect(page.getByTestId("org-rules-preview-loading")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeEnabled();
  });

  test("a repository with no working check warns that delivery is blocked", async ({ page }) => {
    await publishFixture(page, {
      pages: {
        first: {
          ...FIRST_PAGE,
          counts: { ...FIRST_PAGE.counts, unsupported: 2 },
          items: [
            repo(1, { unsupported: true }),
            repo(2, { unsupported: true }),
          ],
        },
      },
    });
    await makeDraft(page);
    const dialog = await review(page);
    await expect(
      dialog.getByText(
        "2 repositories have no working check for a required rule.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("table", { name: "Affected repositories" }))
      .toContainText("No working check");
  });

  test("more repositories load with the server's cursor", async ({ page }) => {
    const state = await publishFixture(page, {
      pages: {
        first: { ...FIRST_PAGE, nextCursor: "page-2" },
        "page-2": {
          ...FIRST_PAGE,
          items: [repo(6, { status: "overridden" })],
          nextCursor: null,
        },
      },
    });
    await makeDraft(page);
    const dialog = await review(page);
    await expect(dialog.getByRole("table", { name: "Affected repositories" }))
      .not.toContainText("acme/service-6");
    await dialog.getByRole("button", { name: "Load more repositories" })
      .click();
    await expect(dialog.getByRole("table", { name: "Affected repositories" }))
      .toContainText("acme/service-6");
    await expect(
      dialog.getByRole("button", { name: "Load more repositories" }),
    ).toHaveCount(0);
    expect(state.previewBodies.map((body) => body.cursor ?? null)).toEqual([
      null,
      "page-2",
    ]);
  });

  test("a preview that fails offers Try again and publishes nothing", async ({ page }) => {
    const state = await publishFixture(page, { previewStatus: 500 });
    await makeDraft(page);
    const dialog = await review(page);
    await expect(
      dialog.getByText("What this change would do could not be checked."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeDisabled();
    state.previewStatus = 200;
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog).toContainText("Applies to 5 repositories now");
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeEnabled();
    expect(state.publishBodies).toEqual([]);
  });

  test("Back to editing closes the review and keeps the draft", async ({ page }) => {
    const state = await publishFixture(page);
    await makeDraft(page);
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Back to editing" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(draftBar(page)).toContainText("1 unpublished change");
    expect(state.publishBodies).toEqual([]);
  });

  test("publishing sends the draft with a key, clears it, says so and moves focus to the heading", async ({ page }) => {
    const state = await publishFixture(page);
    await makeDraft(page);
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Publish rules" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Revision 4 published.")).toBeVisible();
    await expect(draftBar(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Repository rules", level: 1 }),
    ).toBeFocused();
    // The page now shows what was published, not an edit.
    await expect(page.getByTestId("org-rules-current")).toContainText(
      "Published revision 4",
    );
    await expect(ruleRow(page, "Semantic commits")).not.toContainText("Edited");
    await expect(ruleRow(page, "Semantic commits")).toContainText("Warn");

    expect(state.publishBodies).toHaveLength(1);
    const sent = state.publishBodies[0] as {
      expectedRevision: number;
      entries: RuleEntry[];
    };
    expect(sent.expectedRevision).toBe(3);
    expect(sent.entries[0]).toMatchObject({
      ruleKey: "commits.semantic",
      mode: "warn",
    });
    expect(state.publishKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a failed publish keeps the draft, says so, and never claims success", async ({ page }) => {
    const state = await publishFixture(page, { publishStatus: 500 });
    await makeDraft(page);
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Publish rules" }).click();
    await expect(
      dialog.getByText(
        "The rules could not be published. Your changes are kept.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Revision 4 published.")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Back to editing" }).click();
    await expect(draftBar(page)).toContainText("1 unpublished change");

    // The retry is a fresh attempt: a definite error does not pin the old key.
    state.publishStatus = 200;
    await page.getByRole("button", { name: "Review and publish" }).click();
    await page.getByRole("dialog").getByRole("button", {
      name: "Publish rules",
    }).click();
    await expect(page.getByText("Revision 4 published.")).toBeVisible();
    expect(state.publishKeys).toHaveLength(2);
    expect(state.publishKeys[0]).not.toEqual(state.publishKeys[1]);
  });
});
