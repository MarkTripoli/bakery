import { expect, type Page, test } from "@playwright/test";
import { MOCK_PRINCIPAL_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { IDS, skillsFixture, versionId } from "./helpers/skills-fixture.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const AT = "2026-11-21T08:30:00.000Z";
const SKILL = IDS.releaseNotes;
const PAGE = `/library/skills/${SKILL}`;
const RUN = "00000000-0000-4000-8000-000000000801";
const INSTALLED = "a".repeat(40);
const LATEST = "b".repeat(40);

const account = (scope: "installation" | "run", runId: string | null) => ({
  scope,
  runId,
  periodStart: null,
  periodEnd: null,
  limitUsd: "0",
  reservedUsd: "0",
  settledUsd: "0",
  availableUsd: "0",
  unknownCount: 0,
});

const run = {
  id: RUN,
  kind: "skill_import",
  taskId: null,
  workflowVersionId: null,
  skillSourceId: IDS.source,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: MOCK_PRINCIPAL_ID,
  inngestRunId: null,
  status: "queued",
  budgetLimitUsd: "0",
  environment: "live",
  startedAt: null,
  finishedAt: null,
  createdAt: AT,
  updatedAt: AT,
  version: 1,
  budgetSummary: {
    installation: account("installation", null),
    run: account("run", RUN),
  },
  blockedReason: null,
  blockingTasks: [],
  waitingOnModel: false,
  releaseStep: "unknown",
};

const version = (revision: number) => ({
  id: versionId(SKILL, revision),
  skillId: SKILL,
  revision,
  sourceRevision: INSTALLED,
  digest: String(revision).repeat(64),
  entryPath: "SKILL.md",
  manifest: { schemaVersion: 1, entryPath: "SKILL.md", files: [] },
  status: "published",
  createdBy: MOCK_PRINCIPAL_ID,
  createdAt: AT,
  updatedAt: AT,
  version: 1,
  publishedAt: AT,
  label: null,
});

const change = (
  path: string,
  extra: Record<string, unknown>,
) => ({
  path,
  change: "changed",
  installedSha256: "c".repeat(64),
  latestSha256: "d".repeat(64),
  installedSizeBytes: 2048,
  latestSizeBytes: 3072,
  diff: null,
  diffOmitted: null,
  ...extra,
});

const CHANGES = [
  change("SKILL.md", {
    diff:
      "@@ -1,2 +1,2 @@\n # Release notes\n-List the pull requests.\n+Group the pull requests by area, and say who each change matters to.",
  }),
  change("images/example-of-a-very-long-file-name-in-a-folder.png", {
    change: "added",
    installedSha256: null,
    installedSizeBytes: null,
    diffOmitted: "binary",
  }),
];

type Setup = {
  readonly status?: "current" | "update_available" | "unreachable";
  readonly enabled?: boolean;
  readonly role?: "admin" | "developer";
  readonly takeReason?: string;
  readonly failureCode?: string;
};

async function open(page: Page, setup: Setup = {}, path = PAGE) {
  await skillsFixture(page, { role: setup.role ?? "admin" });
  const sent: { path: string; body: unknown; ifMatch?: string | null }[] = [];
  const state = { active: 2, versions: [version(2), version(1)], checks: 0 };
  const skill = () => ({
    id: SKILL,
    sourceId: IDS.source,
    slug: "release-notes",
    name: "Release notes",
    description: "Writes the release notes from the merged pull requests.",
    activeVersionId: versionId(SKILL, state.active),
    activeRevision: state.active,
    enabled: setup.enabled ?? true,
    scope: "organization",
    ownerPrincipalId: null,
    createdAt: AT,
    updatedAt: AT,
    version: 4,
    copiedFromSkillId: null,
    copiedFromVersionId: null,
  });
  const post = (path: string, body: unknown, ifMatch?: string | null) =>
    sent.push({ path, body, ifMatch });
  await page.route(
    (url) => url.pathname === `/v1/skills/${SKILL}`,
    (route) => route.fulfill({ json: skill() }),
  );
  await page.route(
    (url) => url.pathname === `/v1/skills/${SKILL}/versions`,
    (route) =>
      route.fulfill({ json: { items: state.versions, nextCursor: null } }),
  );
  await page.route(
    (url) => url.pathname === `/v1/skills/${SKILL}/active-version`,
    (route) => {
      const body = route.request().postDataJSON() as { versionId: string };
      post("active-version", body, route.request().headers()["if-match"]);
      state.active = body.versionId === versionId(SKILL, 1) ? 1 : 2;
      return route.fulfill({ json: skill() });
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/skills/${SKILL}/source-update`,
    (route) => {
      state.checks += 1;
      const status = setup.status ?? "update_available";
      return route.fulfill({
        json: {
          skillId: SKILL,
          sourceId: IDS.source,
          status,
          requestedRevision: "main",
          installedRevision: INSTALLED,
          latestRevision: status === "unreachable"
            ? null
            : status === "current"
            ? INSTALLED
            : LATEST,
          lastCheckedAt: AT,
          problem: status === "unreachable" ? "SOURCE_TIMEOUT" : null,
          changes: status === "update_available" ? CHANGES : [],
          changesTruncated: false,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/skills/${SKILL}/source-update/take`,
    (route) => {
      post(
        "take",
        route.request().postDataJSON(),
        route.request().headers()["if-match"],
      );
      if (setup.takeReason !== undefined) {
        return route.fulfill({
          status: 409,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Request refused",
            detail: "Request refused.",
            status: 409,
            code: "STATE_CONFLICT",
            reason: setup.takeReason,
            retryable: false,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      return route.fulfill({ json: run });
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/skill-imports/${RUN}`,
    (route) => {
      const failed = setup.failureCode !== undefined;
      if (!failed) {
        state.active = 3;
        state.versions = [version(3), version(2), version(1)];
      }
      return route.fulfill({
        json: {
          runId: RUN,
          state: failed ? "failed" : "completed",
          skillId: failed ? null : SKILL,
          versionId: failed ? null : versionId(SKILL, 3),
          failureCode: setup.failureCode ?? null,
        },
      });
    },
  );
  await page.goto(path);
  return { sent, state };
}

const versions = (page: Page) => page.getByTestId("skill-versions");
const origin = (page: Page) => page.getByTestId("skill-origin");
const take = (page: Page) =>
  page.getByRole("button", { name: "Take the update" });

test("an older version is put in use after asking", async ({ page }) => {
  const { sent } = await open(page);
  await expect(versions(page).getByRole("button")).toHaveCount(1);
  await versions(page).getByRole("button", { name: "Use version 1" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Use version 1" });
  await expect(dialog).toContainText(
    "Anything that already uses this skill keeps the version it has.",
  );
  await still(page, "skill-use-version-dialog");
  expect(sent).toEqual([]);
  await dialog.getByRole("button", { name: "Use version 1" }).click();
  await expect(page.getByTestId("skill-toast")).toContainText(
    "Version 1 is now the one in use.",
  );
  await expect(versions(page).getByRole("button", { name: "Use version 2" }))
    .toBeVisible();
  expect(sent).toEqual([{
    path: "active-version",
    body: { id: SKILL, versionId: versionId(SKILL, 1) },
    ifMatch: expect.stringContaining("4"),
  }]);
});

test("someone who cannot change the skill is offered neither", async ({ page }) => {
  await open(page, { role: "developer" });
  await expect(origin(page)).toContainText("Last checked");
  await expect(versions(page).getByRole("button")).toHaveCount(0);
  await expect(origin(page).getByRole("button")).toHaveCount(0);
});

test("a check with changes leads to a review, file by file, and takes the update", async ({ page }) => {
  const { sent } = await open(page);
  await origin(page).getByRole("button", { name: "Check for updates" }).click();
  await expect(origin(page)).toContainText("The source has changes.");
  await still(page, "skill-update-check-changes");
  await origin(page).getByRole("button", { name: "Review update" }).click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}/update$`));
  const review = page.getByTestId("skill-update-page");
  await expect(review).toContainText(
    "In use: version 2, from aaaaaaa. The source is now at bbbbbbb",
  );
  await expect(review).toContainText("2 files differ");
  await expect(review).toContainText("+Group the pull requests by area");
  await expect(review).toContainText(
    "Version 3 is added and becomes the one in use.",
  );
  await expect(review).toContainText(
    "1 agent and 2 workflows keep version 2 until someone updates them.",
  );
  await expect(review.getByText("This file is not text.")).toBeHidden();
  await review.getByText("images/example-of-a-very-long").click();
  await expect(review.getByText("This file is not text.")).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await still(page, "skill-update-review");
  await take(page).click();
  await expect(page.getByTestId("skill-toast")).toContainText(
    "Updated. Version 3 is in use.",
  );
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  expect(sent).toEqual([{
    path: "take",
    body: { id: SKILL, revision: LATEST },
    ifMatch: expect.stringContaining("4"),
  }]);
});

for (
  const [status, sentence] of [
    ["current", "Up to date with main. Checked"],
    ["unreachable", "did not answer in time. The skill still works."],
  ] as const
) {
  test(`a check that finds the source ${status} says so`, async ({ page }) => {
    const { state } = await open(page, { status });
    await origin(page).getByRole("button", { name: "Check for updates" })
      .click();
    await expect(origin(page)).toContainText(sentence);
    await still(page, `skill-update-check-${status}`);
    await origin(page).getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => state.checks).toBe(2);
  });
}

test("a source that moved since the check is read again, and says why", async ({ page }) => {
  const { state } = await open(page, {
    takeReason: "skill_update_revision_not_latest",
  }, `${PAGE}/update`);
  await expect(take(page)).toBeEnabled();
  const before = state.checks;
  await take(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "The source changed again since you looked. Review it once more.",
  );
  await expect.poll(() => state.checks).toBe(before + 1);
  await still(page, "skill-update-moved");
});

test("a failed take stays on the review and says why", async ({ page }) => {
  await open(page, { failureCode: "SOURCE_LIMIT_EXCEEDED" }, `${PAGE}/update`);
  await take(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "The skill is larger than 10 MB or has more than 256 files.",
  );
  await expect(take(page)).toBeEnabled();
});

test("a skill that is turned off shows the changes and cannot take them", async ({ page }) => {
  await open(page, { enabled: false }, `${PAGE}/update`);
  await expect(page.getByText("Turn the skill on to take updates."))
    .toBeVisible();
  await expect(take(page)).toBeDisabled();
});

test("someone who cannot change the skill cannot review an update by its address", async ({ page }) => {
  const { state } = await open(page, { role: "developer" }, `${PAGE}/update`);
  await expect(page.getByText("You cannot update this skill")).toBeVisible();
  expect(state.checks).toBe(0);
});
