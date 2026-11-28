import { expect, type Page, test } from "@playwright/test";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import {
  IDS,
  type Seen,
  skillsFixture,
  versionId,
} from "./helpers/skills-fixture.ts";

registerPageHealth(test);

const ADD = "/library/skills/add";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-11-25T10:00:00.000Z";

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

const run = (sourceId: string, status: string) => ({
  id: uuid(801),
  kind: "skill_import",
  taskId: null,
  workflowVersionId: null,
  skillSourceId: sourceId,
  repositoryProfileId: null,
  repositoryProfileRevision: null,
  repositoryProfileDigest: null,
  observationId: null,
  observationDigest: null,
  baseSha: null,
  workspaceBaseSha: null,
  requestedBy: uuid(1),
  inngestRunId: null,
  status,
  budgetLimitUsd: "0",
  environment: "live",
  startedAt: null,
  finishedAt: null,
  createdAt: AT,
  updatedAt: AT,
  version: 1,
  budgetSummary: {
    installation: account("installation", null),
    run: account("run", uuid(801)),
  },
  blockedReason: null,
  blockingTasks: [],
  waitingOnModel: false,
  releaseStep: "unknown",
});

type Source = {
  readonly id: string;
  readonly name: string;
  readonly locator: string;
  readonly license?: string;
  readonly sourceType?: "git" | "url";
};

const source = (
  { id, name, locator, license = "MIT", sourceType = "git" }: Source,
) => ({
  id,
  name,
  sourceType,
  locator,
  publisher: null,
  license,
  lastCheckedAt: null,
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
  version: 1,
});

const ACME = {
  id: uuid(811),
  name: "Acme skills",
  locator: "https://example.test/acme/skills",
};

type Setup = {
  readonly role?: "admin" | "developer" | "viewer";
  readonly saved?: readonly Source[];
  readonly failureCode?: string;
  readonly unreadable?: string;
  readonly hold?: boolean;
  readonly createStatus?: number;
  readonly madeVersionId?: string;
  readonly inUseBefore?: number;
  readonly nameless?: boolean;
};

async function addPage(page: Page, setup: Setup = {}) {
  await skillsFixture(page, { role: setup.role ?? "admin" });
  if (setup.nameless === true) {
    await page.route(
      (url) => url.pathname === "/v1/organizations",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [{
              id: MOCK_ORGANIZATION_ID,
              name: "",
              slug: "fixture-org",
              logo: null,
              defaultLocale: null,
              metadata: {},
              createdAt: AT,
              updatedAt: AT,
              version: 1,
              role: "admin",
            }],
            nextCursor: null,
          }),
        }),
    );
  }
  const sent: Seen[] = [];
  const state = { held: setup.hold ?? false };
  const sources = (setup.saved ?? []).map(source);
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: status < 400 ? "application/json" : "application/problem+json",
    body: JSON.stringify(body),
  });
  const record = (path: string, body: Record<string, unknown>) =>
    sent.push({ method: "POST", path, search: "", body });
  const earlier = setup.inUseBefore;
  if (earlier !== undefined) {
    await page.route(
      (url) => url.pathname === "/v1/skills",
      (route) =>
        route.fulfill(json({
          items: [{
            id: IDS.releaseNotes,
            sourceId: null,
            slug: "release-notes",
            name: "Release notes",
            description: null,
            activeVersionId: versionId(IDS.releaseNotes, earlier),
            activeRevision: earlier,
            enabled: true,
            scope: "organization",
            ownerPrincipalId: null,
            createdAt: AT,
            updatedAt: AT,
            version: 1,
            copiedFromSkillId: null,
            copiedFromVersionId: null,
          }],
          nextCursor: null,
        })),
    );
  }
  await page.route(
    (url) => url.pathname === "/v1/skill-sources",
    (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill(json({ items: sources, nextCursor: null }));
      }
      const body = route.request().postDataJSON() as {
        url: string;
        name: string;
        sourceType: "git" | "url";
      };
      record("/v1/skill-sources", body);
      if (setup.createStatus !== undefined) {
        return route.fulfill(
          json({
            type: "about:blank",
            title: "x",
            status: setup.createStatus,
            code: "STATE_CONFLICT",
          }, setup.createStatus),
        );
      }
      const made = source({
        id: uuid(812),
        name: body.name,
        locator: body.url,
        sourceType: body.sourceType,
      });
      sources.push(made);
      return route.fulfill(json(made, 201));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/skill-imports",
    (route) => {
      const body = route.request().postDataJSON() as { sourceId: string };
      record("/v1/skill-imports", body);
      if (setup.unreadable !== undefined) {
        return route.fulfill(json({
          type: "about:blank",
          title: "x",
          status: 503,
          code: "DEPENDENCY_UNAVAILABLE",
          detail: "x",
          requestId: uuid(110),
          traceId: uuid(111),
          retryable: true,
          reason: setup.unreadable,
        }, 503));
      }
      return route.fulfill(json(run(body.sourceId, "queued"), 201));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/skill-imports/${uuid(801)}`,
    (route) => {
      const done = !state.held;
      const failed = done && setup.failureCode !== undefined;
      return route.fulfill(json({
        runId: uuid(801),
        state: done ? failed ? "failed" : "completed" : "queued",
        skillId: done && !failed ? IDS.releaseNotes : null,
        versionId: done && !failed ? setup.madeVersionId ?? uuid(821) : null,
        failureCode: failed ? setup.failureCode : null,
      }));
    },
  );
  await page.goto(ADD);
  return { sent, state };
}

const box = (page: Page, name: RegExp) => page.getByRole("textbox", { name });
const submit = (page: Page) =>
  page.getByRole("button", { name: /^(Add skill|Try again: add skill)$/ });

async function fillRepository(page: Page) {
  await box(page, /Repository address/).fill(
    "https://example.test/acme/release",
  );
  await box(page, /Name for this source/).fill("Acme release");
  await box(page, /Licence/).fill("Apache-2.0");
  await box(page, /Branch, tag or commit/).fill("v2.1.0");
  await box(page, /Folder/).fill("skills/release-notes");
}

test.describe("add a skill from a source", () => {
  test("it is reached from the Skills tab", async ({ page }) => {
    await skillsFixture(page, { role: "admin" });
    await page.goto("/library?tab=skills");
    await page.getByRole("button", { name: "Add from a source" }).click();
    await expect(page).toHaveURL(/\/library\/skills\/add$/);
    await expect(
      page.getByRole("heading", { name: "Add a skill from a source" }),
    ).toBeVisible();
  });

  test("someone who does not manage skills is told so", async ({ page }) => {
    await addPage(page, { role: "viewer" });
    await expect(
      page.getByText(
        "Only people who manage skills can add one from a source.",
      ),
    ).toBeVisible();
    await expect(submit(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to skills" }))
      .toBeVisible();
  });

  test("a developer adds a private skill from a saved source", async ({ page }) => {
    const { sent } = await addPage(page, { role: "developer", saved: [ACME] });
    await expect(page.getByRole("radio", { name: "A Git repository" }))
      .toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Organization" }))
      .toBeDisabled();
    await expect(page.getByRole("radio", { name: "Private" })).toBeChecked();
    await expect(
      page.getByText(
        "Only people who manage the Library can add organization skills.",
      ),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "Source" }).selectOption(ACME.id);
    await box(page, /Branch, tag or commit/).fill("main");
    await still(page, "skill-add-developer");
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${IDS.releaseNotes}$`));
    expect(sent.map((one) => [one.path, one.body])).toEqual([
      ["/v1/skill-imports", {
        sourceId: ACME.id,
        revision: "main",
        scope: "personal",
      }],
    ]);
  });

  test("a developer with no saved source is told who adds one", async ({ page }) => {
    await addPage(page, { role: "developer" });
    await expect(page.getByText("No source to add from yet")).toBeVisible();
    await expect(submit(page)).toHaveCount(0);
    await still(page, "skill-add-no-source");
  });

  test("a web address is saved and added with a version name and no revision", async ({ page }) => {
    const { sent } = await addPage(page);
    await page.getByRole("radio", { name: "A web address" }).check();
    await expect(box(page, /Branch, tag or commit/)).toHaveCount(0);
    await submit(page).click();
    await expect(page.getByText("Enter the web address.")).toBeVisible();
    await box(page, /Web address/).fill(
      "https://example.test/acme/release.tar.gz",
    );
    await box(page, /Name for this source/).fill("Acme archive");
    await box(page, /Licence/).fill("MIT");
    await box(page, /Version name/).fill("Spring release");
    await still(page, "skill-add-web-address");
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${IDS.releaseNotes}$`));
    expect(sent.map((one) => [one.path, one.body])).toEqual([
      ["/v1/skill-sources", {
        sourceType: "url",
        url: "https://example.test/acme/release.tar.gz",
        name: "Acme archive",
        license: "MIT",
      }],
      ["/v1/skill-imports", {
        sourceId: uuid(812),
        label: "Spring release",
        scope: "organization",
      }],
    ]);
  });

  test("an archive that is not a skill is said in plain words", async ({ page }) => {
    await addPage(page, {
      failureCode: "SOURCE_INVALID",
      saved: [{
        id: uuid(813),
        name: "Acme archive",
        locator: "https://example.test/acme/release.tar.gz",
        sourceType: "url",
      }],
    });
    await page.getByRole("radio", { name: "A source added before" }).check();
    await page.getByRole("combobox", { name: "Source" }).selectOption(
      uuid(813),
    );
    await expect(box(page, /Branch, tag or commit/)).toHaveCount(0);
    await submit(page).click();
    await expect(page.getByRole("alert")).toContainText(
      "The file at https://example.test/acme/release.tar.gz is not a skill Bakery can use. It needs to be a .tar.gz archive",
    );
    await still(page, "skill-add-web-failed");
  });

  test("an archive that cannot be read is said in plain words and keeps the source", async ({ page }) => {
    await addPage(page, { unreadable: "SOURCE_UNAVAILABLE" });
    await page.getByRole("radio", { name: "A web address" }).check();
    await box(page, /Web address/).fill(
      "https://example.test/acme/release.tar.gz",
    );
    await box(page, /Name for this source/).fill("Acme archive");
    await box(page, /Licence/).fill("MIT");
    await submit(page).click();
    await expect(page.getByRole("alert")).toContainText(
      "Bakery could not read https://example.test/acme/release.tar.gz. Check the address and that this installation can read it.",
    );
    await expect(page.getByRole("alert")).toContainText("The source is saved");
    await expect(page.getByText("Enter a branch, tag or commit.")).toHaveCount(
      0,
    );
    await expect(box(page, /Branch, tag or commit/)).toHaveCount(0);
    await still(page, "skill-add-web-unreadable");
  });

  test("missing and unusable fields are named, and nothing is sent", async ({ page }) => {
    const { sent } = await addPage(page);
    await submit(page).click();
    await expect(box(page, /Repository address/)).toBeFocused();
    for (
      const sentence of [
        "Enter the repository address.",
        "Enter a name for this source.",
        "Enter the licence.",
        "Enter a branch, tag or commit.",
      ]
    ) await expect(page.getByText(sentence)).toBeVisible();
    await box(page, /Repository address/).fill("git@example.test:acme/x.git");
    await expect(
      page.getByText("Use an https address with no port"),
    ).toBeVisible();
    await still(page, "skill-add-problems");
    expect(sent).toEqual([]);
  });

  test("a repository is saved, read, and the new skill opens", async ({ page }) => {
    const { sent, state } = await addPage(page, { hold: true });
    await fillRepository(page);
    await expect(
      page.getByText('It is named after its folder: "release-notes".'),
    ).toBeVisible();
    await still(page, "skill-add-form");
    await submit(page).click();
    await expect(page.getByRole("button", { name: "Reading the source…" }))
      .toBeDisabled();
    await expect(page.getByText("You can leave this page.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to skills" }))
      .toBeEnabled();
    await expect(box(page, /Repository address/)).toHaveAttribute(
      "readonly",
      "",
    );
    await still(page, "skill-add-reading");
    state.held = false;
    await expect(page).toHaveURL(new RegExp(`/skills/${IDS.releaseNotes}$`));
    await expect(page.getByTestId("skill-toast")).toHaveText(
      /^Added Release notes\.\W*$/,
    );
    expect(sent.map((one) => [one.path, one.body])).toEqual([
      ["/v1/skill-sources", {
        sourceType: "git",
        url: "https://example.test/acme/release",
        name: "Acme release",
        license: "Apache-2.0",
      }],
      ["/v1/skill-imports", {
        sourceId: uuid(812),
        revision: "v2.1.0",
        path: "skills/release-notes",
        scope: "organization",
      }],
    ]);
  });

  test("a saved source is reused, for yourself", async ({ page }) => {
    const { sent } = await addPage(page, { saved: [ACME] });
    await page.getByRole("radio", { name: "A source added before" }).check();
    await expect(page.getByText("1 source. Its address")).toBeVisible();
    await page.getByRole("combobox", { name: "Source" }).selectOption(ACME.id);
    await expect(page.getByText(ACME.locator, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Source" }).locator("option:checked"),
    ).toHaveText("Acme skills");
    await box(page, /Branch, tag or commit/).fill("main");
    await expect(page.getByText("The skill is added for Fixture Org."))
      .toBeVisible();
    await expect(page.getByRole("radio", { name: "Organization" }))
      .toBeChecked();
    await page.getByRole("radio", { name: "Private" }).check();
    await expect(page.getByText("The skill is added for you only."))
      .toBeVisible();
    await still(page, "skill-add-saved");
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`/skills/${IDS.releaseNotes}$`));
    expect(sent.map((one) => [one.path, one.body])).toEqual([
      ["/v1/skill-imports", {
        sourceId: ACME.id,
        revision: "main",
        scope: "personal",
      }],
    ]);
  });

  test("a branch or tag that is not there is named", async ({ page }) => {
    await addPage(page, { failureCode: "SOURCE_REVISION_NOT_FOUND" });
    await fillRepository(page);
    await submit(page).click();
    await expect(page.getByRole("alert")).toContainText(
      "https://example.test/acme/release has no branch, tag or commit called v2.1.0.",
    );
    await still(page, "skill-add-missing-revision");
  });

  test("a short commit hash is asked for in full, not called missing", async ({ page }) => {
    await addPage(page, { failureCode: "SOURCE_REVISION_NOT_FOUND" });
    await fillRepository(page);
    await box(page, /Branch, tag or commit/).fill("e4bb5d9");
    await submit(page).click();
    await expect(page.getByRole("alert")).toContainText(
      "https://example.test/acme/release has no branch or tag called e4bb5d9. If it is a commit, enter all 40 characters of it.",
    );
    await still(page, "skill-add-short-commit");
  });

  test("a failure keeps the work, names the fix and keeps the saved source", async ({ page }) => {
    const { sent } = await addPage(page, {
      failureCode: "SOURCE_UNAVAILABLE",
    });
    await fillRepository(page);
    await submit(page).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The skill was not added");
    await expect(alert).toBeInViewport();
    await expect(page.locator("#skill-add-failure")).toBeFocused();
    await expect(alert).toContainText(
      "Bakery could not read v2.1.0 from https://example.test/acme/release.",
    );
    await expect(alert).toContainText("The source is saved");
    await expect(
      page.getByRole("radio", { name: "A source added before" }),
    ).toBeChecked();
    await expect(box(page, /Branch, tag or commit/)).toHaveValue("v2.1.0");
    await expect(box(page, /Folder/)).toHaveValue("skills/release-notes");
    await still(page, "skill-add-failed");
    await box(page, /Branch, tag or commit/).fill("v2.1.1");
    await page.getByRole("button", { name: "Try again: add skill" }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].body).toEqual({
      sourceId: uuid(812),
      revision: "v2.1.1",
      path: "skills/release-notes",
      scope: "organization",
    });
  });

  test("an address already saved says where to find it", async ({ page }) => {
    const { sent } = await addPage(page, { createStatus: 409 });
    await fillRepository(page);
    await submit(page).click();
    await expect(page.getByRole("alert")).toContainText(
      "This repository is already saved. Choose it under A source added before.",
    );
    expect(sent.map((one) => one.path)).toEqual(["/v1/skill-sources"]);
  });

  test("files that did not change are not called a new version", async ({ page }) => {
    await addPage(page, {
      saved: [ACME],
      madeVersionId: versionId(IDS.releaseNotes, 2),
    });
    await page.getByRole("radio", { name: "A source added before" }).check();
    await page.getByRole("combobox", { name: "Source" }).selectOption(ACME.id);
    await box(page, /Branch, tag or commit/).fill("v2.2.0");
    await submit(page).click();
    await expect(page.getByTestId("skill-toast")).toHaveText(
      /^Release notes already had these files\.\W*$/,
    );
  });

  test("the aside never names an organization it does not know", async ({ page }) => {
    await addPage(page, { nameless: true });
    await expect(page.getByText("Nothing from the source is run"))
      .toBeVisible();
    await expect(page.getByText("The skill is added for")).toHaveCount(0);
  });

  test("a saved source with no licence shows no empty licence row", async ({ page }) => {
    await addPage(page, { saved: [{ ...ACME, license: "" }] });
    await page.getByRole("radio", { name: "A source added before" }).check();
    await page.getByRole("combobox", { name: "Source" }).selectOption(ACME.id);
    await expect(page.getByText(ACME.locator, { exact: true })).toBeVisible();
    await expect(page.getByText("Licence", { exact: true })).toHaveCount(0);
  });

  test("older files put back say which version is in use again", async ({ page }) => {
    await addPage(page, {
      saved: [ACME],
      madeVersionId: versionId(IDS.releaseNotes, 1),
      inUseBefore: 2,
    });
    await page.getByRole("radio", { name: "A source added before" }).check();
    await page.getByRole("combobox", { name: "Source" }).selectOption(ACME.id);
    await box(page, /Branch, tag or commit/).fill("v2.0.0");
    await submit(page).click();
    await expect(page.getByTestId("skill-toast")).toHaveText(
      /^Release notes already had these files, so version 1 is in use again \(was version 2\)\.\W*$/,
    );
  });
});
