import { expect, type Page, type Route, test } from "@playwright/test";
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
  /** The first preview (or publish) answers 412 because someone else published revision 4. */
  staleOn?: "preview" | "publish";
  /** The rules as that revision 4 published them. */
  theirs?: RuleEntry[];
  /** This page of the preview answers 500 the first time it is asked for. */
  failPageOnce?: string;
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
  let staleOn = options.staleOn;
  let failPageOnce = options.failPageOnce;
  /** Someone else publishes revision 4 while the draft is open. */
  const bump = () => {
    state.revision = 4;
    state.entries = options.theirs ?? state.entries;
  };
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
      if (staleOn === "publish") {
        staleOn = undefined;
        bump();
        return route.fulfill(problem(412));
      }
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
      if (staleOn === "preview") {
        staleOn = undefined;
        bump();
        return route.fulfill(problem(412));
      }
      if (state.previewStatus !== 200) {
        return route.fulfill(problem(state.previewStatus));
      }
      const cursor = (body.cursor as string | undefined) ?? "first";
      if (failPageOnce === cursor) {
        failPageOnce = undefined;
        return route.fulfill(problem(500));
      }
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
    await shot(page, "rules-review");
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
    await shot(page, "rules-review-loading");
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
    await shot(page, "rules-review-blocked");
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
    await shot(page, "rules-review-error");
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

  test("the review's actions end the row: Back to editing first, Publish rules last", async ({ page }) => {
    await publishFixture(page);
    await makeDraft(page);
    const dialog = await review(page);
    const publish = dialog.getByRole("button", { name: "Publish rules" });
    await expect(publish).toBeVisible();
    const back = await dialog.getByRole("button", { name: "Back to editing" })
      .boundingBox();
    const last = await publish.boundingBox();
    const frame = await dialog.boundingBox();
    if (!back || !last || !frame) throw new Error("the dialog has no box");
    expect(back.y < last.y || (back.y === last.y && back.x < last.x)).toBe(
      true,
    );
    // The primary action ends the row, a dialog's padding from the edge.
    expect(frame.x + frame.width - (last.x + last.width)).toBeLessThan(48);
  });

  test("publishing sends the draft with a key, clears it, says so and moves focus to the heading", async ({ page }) => {
    const state = await publishFixture(page);
    await makeDraft(page);
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Publish rules" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Revision 4 published.")).toBeVisible();
    await expect(draftBar(page)).toHaveCount(0);
    await shot(page, "rules-published");
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
    await shot(page, "rules-publish-failed");
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

/** Revision 4 as someone else published it: they changed Semantic commits and PR / MR titles. */
const THEIRS: RuleEntry[] = RULE_ENTRIES.map((entry) => {
  if (entry.ruleKey === "commits.semantic") {
    return { ...entry, mode: "guide" };
  }
  if (entry.ruleKey === "changeRequest.semanticTitle") {
    return {
      ...entry,
      options: { ...(entry.options as object), maxSubjectLength: 100 },
    };
  }
  return entry;
});
/** Revision 4 where only PR / MR titles changed: nothing the draft touches. */
const THEIRS_UNRELATED: RuleEntry[] = RULE_ENTRIES.map((entry) =>
  entry.ruleKey === "changeRequest.semanticTitle"
    ? {
      ...entry,
      options: { ...(entry.options as object), maxSubjectLength: 100 },
    }
    : entry
);

/** A second edit, to a rule nobody else touches: Magic strings switched on. */
async function enableMagicStrings(page: Page) {
  await page.getByRole("button", { name: "Edit Magic strings" }).click();
  await page.getByRole("switch", { name: "Rule enabled" }).check();
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect(draftBar(page)).toContainText("2 unpublished changes");
}

test.describe("organization repository rules: a newer revision was published", () => {
  // Each of these edits a rule or two, opens the review and then reconciles: a
  // longer path than the default 15 s allows on a busy host. Every assertion stays.
  test.beforeEach(() => {
    test.setTimeout(45_000);
  });

  test("a stale preview keeps the draft and asks only about the rules changed in both", async ({ page }) => {
    await publishFixture(page, { staleOn: "preview", theirs: THEIRS });
    await makeDraft(page);
    await enableMagicStrings(page);
    await page.getByRole("button", { name: "Review and publish" }).click();

    const notice = page.getByTestId("org-rules-stale");
    await expect(notice).toContainText(
      "Revision 4 was published while you were editing.",
    );
    await expect(notice).toContainText("Your changes are kept.");
    await expect(notice).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Both edits are still there, on top of revision 4.
    await expect(draftBar(page)).toContainText("2 unpublished changes");
    // While a question is open the bar says what to do, not where the draft started.
    await expect(draftBar(page)).not.toContainText("based on revision 4");
    // Only the rule changed in both is a question; the other edit carried over.
    const conflicts = page.getByTestId("org-rules-conflicts");
    await expect(conflicts).toContainText("Semantic commits");
    await expect(conflicts).toContainText("Changed in revision 4");
    // Two labelled lines, one per side, each with the whole summary.
    await expect(conflicts.locator("[class*='description-item__title']"))
      .toHaveText(["Yours", "Revision 4"]);
    const sides = conflicts.locator("[class*='description-item__description']");
    await expect(sides.nth(0)).toContainText("Warn");
    await expect(sides.nth(1)).toContainText("Guide");
    // Why the review is off, in words, on the bar.
    await expect(draftBar(page)).toContainText(
      "Decide 1 rule above to review.",
    );
    // The notice cannot be closed while a question is open.
    await expect(notice.getByRole("button", { name: "Dismiss alert" }))
      .toHaveCount(0);
    await shot(page, "rules-stale");
    await expect(conflicts).not.toContainText("Magic strings");
    await expect(ruleRow(page, "Magic strings")).toContainText("Edited");
    // What someone else changed shows as published now.
    await expect(ruleRow(page, "PR / MR titles")).toContainText(
      "100-character subject",
    );
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeDisabled();
  });

  test("Keep mine decides the rule and the next review is against the new revision", async ({ page }) => {
    const state = await publishFixture(page, {
      staleOn: "preview",
      theirs: THEIRS,
    });
    await makeDraft(page);
    await enableMagicStrings(page);
    await page.getByRole("button", { name: "Review and publish" }).click();
    await expect(page.getByTestId("org-rules-conflicts")).toBeVisible();

    await page.getByRole("button", { name: "Keep mine for Semantic commits" })
      .click();
    await expect(page.getByTestId("org-rules-conflicts")).toHaveCount(0);
    // Decided: the bar is back to saying where the draft starts.
    await expect(draftBar(page)).toContainText("based on revision 4");
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Review and publish" }).click();
    await expect(page.getByRole("dialog")).toContainText("Publish revision 5?");

    const asked = state.previewBodies.at(-1) as {
      expectedRevision: number;
      entries: RuleEntry[];
    };
    expect(asked.expectedRevision).toBe(4);
    // Mine stays; what someone else changed in a rule I did not edit is theirs.
    expect(asked.entries[0]).toMatchObject({
      ruleKey: "commits.semantic",
      mode: "warn",
    });
    expect(asked.entries[1]).toMatchObject({
      ruleKey: "changeRequest.semanticTitle",
      options: { maxSubjectLength: 100 },
    });
    await page.getByRole("dialog").getByRole("button", {
      name: "Publish rules",
    }).click();
    await expect(page.getByText("Revision 5 published.")).toBeVisible();
    expect(
      (state.publishBodies[0] as { expectedRevision: number })
        .expectedRevision,
    ).toBe(4);
  });

  test("Use the other revision drops my edit to that rule", async ({ page }) => {
    await publishFixture(page, { staleOn: "preview", theirs: THEIRS });
    await makeDraft(page);
    await enableMagicStrings(page);
    await page.getByRole("button", { name: "Review and publish" }).click();
    await expect(page.getByTestId("org-rules-conflicts")).toBeVisible();

    await page.getByRole("button", {
      name: "Use revision 4 for Semantic commits",
    }).click();
    await expect(page.getByTestId("org-rules-conflicts")).toHaveCount(0);
    // The rule is revision 4's again, and only the other edit is left.
    await expect(ruleRow(page, "Semantic commits")).toContainText("Guide");
    await expect(ruleRow(page, "Semantic commits")).not.toContainText("Edited");
    await expect(draftBar(page)).toContainText("1 unpublished change");
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeEnabled();
  });

  test("a stale publish is handled the same way and publishes nothing", async ({ page }) => {
    const state = await publishFixture(page, {
      staleOn: "publish",
      theirs: THEIRS,
    });
    await makeDraft(page);
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Publish rules" }).click();
    await expect(page.getByTestId("org-rules-stale")).toContainText(
      "Revision 4 was published while you were editing.",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Revision 4 published.")).toHaveCount(0);
    await expect(page.getByTestId("org-rules-conflicts")).toContainText(
      "Semantic commits",
    );
    // The one attempt was refused; nothing was published.
    expect(state.publishBodies).toHaveLength(1);
    expect(state.revision).toBe(4);
  });

  test("when nobody else touched the rules I edited, they carry over without a question", async ({ page }) => {
    await publishFixture(page, {
      staleOn: "preview",
      theirs: THEIRS_UNRELATED,
    });
    await makeDraft(page);
    await page.getByRole("button", { name: "Review and publish" }).click();
    await expect(page.getByTestId("org-rules-stale")).toContainText(
      "Revision 4 was published while you were editing.",
    );
    await expect(page.getByTestId("org-rules-conflicts")).toHaveCount(0);
    await expect(draftBar(page)).toContainText("1 unpublished change");
    await expect(draftBar(page)).not.toContainText("Decide");
    await expect(ruleRow(page, "Semantic commits")).toContainText("Edited");
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeEnabled();
    // With nothing left to decide the notice can be closed.
    await page.getByTestId("org-rules-stale").getByRole("button", {
      name: "Dismiss alert",
    }).click();
    await expect(page.getByTestId("org-rules-stale")).toHaveCount(0);
  });
});

/** Revision 4 where both rules this draft edits were changed by someone else. */
const THEIRS_BOTH: RuleEntry[] = THEIRS.map((entry) =>
  entry.ruleKey === "code.magicStrings"
    ? { ...entry, enabled: true, mode: "require" }
    : entry
);

test.describe("organization repository rules: focus follows an action that replaces its control", () => {
  test.beforeEach(() => {
    test.setTimeout(45_000);
  });

  test("confirming Discard, which removes the draft bar, moves focus to the page heading", async ({ page }) => {
    await publishFixture(page);
    await makeDraft(page);
    await draftBar(page).locator("..").getByRole("button", { name: "Discard" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", {
      name: "Discard changes",
    }).click();
    await expect(draftBar(page)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Repository rules", level: 1 }),
    ).toBeFocused();
  });

  test("closing the review by Back to editing, the close button or Escape returns focus to Review and publish", async ({ page }) => {
    await publishFixture(page);
    await makeDraft(page);
    const opener = page.getByRole("button", { name: "Review and publish" });
    const dialog = await review(page);
    await dialog.getByRole("button", { name: "Back to editing" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await page.getByRole("dialog").getByRole("button", {
      name: /^Close (dialog|sheet)$/,
    }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("deciding the last conflict moves focus to Review and publish", async ({ page }) => {
    await publishFixture(page, { staleOn: "preview", theirs: THEIRS });
    await makeDraft(page);
    await enableMagicStrings(page);
    await page.getByRole("button", { name: "Review and publish" }).click();
    await expect(page.getByTestId("org-rules-conflicts")).toBeVisible();
    await page.getByRole("button", { name: "Keep mine for Semantic commits" })
      .click();
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeFocused();
  });

  test("with two conflicts, deciding the first moves focus to the second", async ({ page }) => {
    await publishFixture(page, { staleOn: "preview", theirs: THEIRS_BOTH });
    await makeDraft(page);
    await enableMagicStrings(page);
    await page.getByRole("button", { name: "Review and publish" }).click();
    const conflicts = page.getByTestId("org-rules-conflicts");
    await expect(conflicts).toContainText("Semantic commits");
    await expect(conflicts).toContainText("Magic strings");
    await page.getByRole("button", { name: "Keep mine for Semantic commits" })
      .click();
    await expect(
      page.getByRole("button", { name: "Use revision 4 for Magic strings" }),
    ).toBeFocused();
    // Dropping the rule leaves one edit: focus goes on to Review and publish.
    await page.getByRole("button", { name: "Use revision 4 for Magic strings" })
      .click();
    await expect(page.getByRole("button", { name: "Review and publish" }))
      .toBeFocused();
  });

  test("a preview retry that works moves focus to Publish rules", async ({ page }) => {
    const state = await publishFixture(page, { previewStatus: 500 });
    await makeDraft(page);
    const dialog = await review(page);
    await expect(
      dialog.getByText("What this change would do could not be checked."),
    ).toBeVisible();
    state.previewStatus = 200;
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByRole("button", { name: "Publish rules" }))
      .toBeFocused();
  });

  test("a failed Load more focuses its Try again, and the retry that finishes the list focuses the rows", async ({ page }) => {
    await publishFixture(page, {
      failPageOnce: "page-2",
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
    await dialog.getByRole("button", { name: "Load more repositories" })
      .click();
    await expect(dialog.getByText("More repositories could not be loaded."))
      .toBeVisible();
    const retry = dialog.getByRole("button", { name: "Try again" });
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(dialog.getByRole("table", { name: "Affected repositories" }))
      .toContainText("acme/service-6");
    // The button that was pressed is gone, so focus is on the rows it loaded.
    await expect(dialog.locator('[data-ui-component="dataTable"]'))
      .toBeFocused();
  });
});
