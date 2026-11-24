import { expect as baseExpect, type Page, test } from "@playwright/test";
import { IDS, skillsFixture } from "./helpers/skills-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const expect = baseExpect.configure({ timeout: 15_000 });

const SKILL = IDS.releaseNotes;
const FILE_MARKDOWN = "aaaaaaaa-0000-4000-8000-000000000001";
const FILE_SCRIPT = "aaaaaaaa-0000-4000-8000-000000000002";

const markdown =
  `# Release notes\n\nWrite the notes from the merged pull requests.\n`;
const script = `#!/bin/sh\necho notes\n`;

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

type Draft = {
  id: string;
  skillId: string;
  baseVersionId: string | null;
  baseRevision: number | null;
  entryPath: string;
  license: string | null;
  files: {
    id: string;
    path: string;
    mediaType: string;
    isExecutable: boolean;
    sizeBytes: number;
  }[];
  totalBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const draftOf = (version: number, baseRevision: number | null): Draft => ({
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  skillId: SKILL,
  baseVersionId: baseRevision === null
    ? null
    : "cccccccc-0000-4000-8000-000000000001",
  baseRevision,
  entryPath: "SKILL.md",
  license: "MIT",
  files: [
    {
      id: FILE_MARKDOWN,
      path: "SKILL.md",
      mediaType: "text/markdown",
      isExecutable: false,
      sizeBytes: Buffer.byteLength(markdown),
    },
    {
      id: FILE_SCRIPT,
      path: "scripts/notes.sh",
      mediaType: "text/x-shellscript",
      isExecutable: true,
      sizeBytes: Buffer.byteLength(script),
    },
  ],
  totalBytes: Buffer.byteLength(markdown) + Buffer.byteLength(script),
  version,
  createdAt: "2026-11-22T11:00:00.000Z",
  updatedAt: "2026-11-22T11:30:00.000Z",
});

type Seen = {
  method: string;
  path: string;
  ifMatch: string | null;
  body: Record<string, unknown> | null;
};

async function draftWorld(
  page: Page,
  overrides: {
    checkProblems?: {
      file: string | null;
      line: number | null;
      message: string;
    }[];
    saveStatus?: number;
    publishStatus?: number;
  } = {},
) {
  await skillsFixture(page, { role: "admin" });
  const seen: Seen[] = [];
  let draft = draftOf(4, 3);
  const record = (route: {
    request: () => {
      method: () => string;
      url: () => string;
      headers: () => Record<string, string>;
      postData: () => string | null;
    };
  }) => {
    const request = route.request();
    const entry = {
      method: request.method(),
      path: new URL(request.url()).pathname,
      ifMatch: request.headers()["if-match"] ?? null,
      body: request.postData() === null
        ? null
        : JSON.parse(request.postData()!),
    };
    seen.push(entry);
    return entry;
  };

  await page.route(
    (url) => /^\/v1\/skills\/[^/]+\/draft(\/.*)?$/.test(url.pathname),
    (route) => {
      const entry = record(route);
      const path = entry.path;
      if (path.endsWith("/check")) {
        const problems = overrides.checkProblems ?? [];
        return route.fulfill({
          json: {
            ok: problems.length === 0,
            problems: problems.map((problem) => ({
              file: problem.file,
              line: problem.line,
              code: "missing_file",
              message: problem.message,
            })),
            draftVersion: draft.version,
          },
        });
      }
      if (path.endsWith("/publish")) {
        if (overrides.publishStatus !== undefined) {
          return route.fulfill({
            status: overrides.publishStatus,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/precondition_failed",
              title: "PRECONDITION_FAILED",
              detail: "Stubbed conflict.",
              status: overrides.publishStatus,
              code: "PRECONDITION_FAILED",
              requestId: SKILL,
              traceId: SKILL,
              retryable: false,
              timestamp: "2026-11-22T12:00:00.000Z",
              violations: [],
            }),
          });
        }
        return route.fulfill({
          json: {
            id: "dddddddd-0000-4000-8000-000000000001",
            skillId: SKILL,
            revision: 4,
            sourceRevision: "1",
            digest: "ab".repeat(32),
            entryPath: "SKILL.md",
            manifest: [],
            status: "published",
            createdBy: "00000000-0000-4000-8000-000000000001",
            createdAt: "2026-11-22T12:00:00.000Z",
            updatedAt: "2026-11-22T12:00:00.000Z",
            version: 1,
            publishedAt: "2026-11-22T12:00:00.000Z",
            label: null,
          },
        });
      }
      if (path.endsWith("/files/rename")) {
        const body = entry.body as { path: string; newPath: string };
        draft = {
          ...draft,
          version: draft.version + 1,
          entryPath: draft.entryPath === body.path
            ? body.newPath
            : draft.entryPath,
          files: draft.files.map((file) =>
            file.path === body.path ? { ...file, path: body.newPath } : file
          ),
        };
        return route.fulfill({ json: draft });
      }
      if (entry.method === "POST" && path.endsWith("/files")) {
        if (overrides.saveStatus !== undefined) {
          return route.fulfill({
            status: overrides.saveStatus,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/precondition_failed",
              title: "PRECONDITION_FAILED",
              detail: "Stubbed conflict.",
              status: overrides.saveStatus,
              code: "PRECONDITION_FAILED",
              requestId: SKILL,
              traceId: SKILL,
              retryable: false,
              timestamp: "2026-11-22T12:00:00.000Z",
              violations: [],
            }),
          });
        }
        const body = entry.body as {
          path: string;
          contentBase64: string;
          mediaType: string;
        };
        const bytes = Buffer.from(body.contentBase64, "base64").length;
        const existing = draft.files.find((file) => file.path === body.path);
        draft = {
          ...draft,
          version: draft.version + 1,
          totalBytes: draft.totalBytes - (existing?.sizeBytes ?? 0) + bytes,
          files: [
            ...draft.files.filter((file) => file.path !== body.path),
            {
              id: existing?.id ?? "eeeeeeee-0000-4000-8000-000000000001",
              path: body.path,
              mediaType: body.mediaType,
              isExecutable: false,
              sizeBytes: bytes,
            },
          ],
        };
        return route.fulfill({ json: draft });
      }
      if (entry.method === "PATCH") {
        const body = entry.body as { license?: string; entryPath?: string };
        draft = {
          ...draft,
          version: draft.version + 1,
          license: body.license ?? draft.license,
          entryPath: body.entryPath ?? draft.entryPath,
        };
        return route.fulfill({ json: draft });
      }
      if (entry.method === "DELETE" && !path.includes("/files/")) {
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fulfill({ json: draft });
    },
  );

  await page.route(
    (url) => /^\/v1\/skills\/[^/]+\/draft\/files\/[^/]+$/.test(url.pathname),
    (route) => {
      record(route);
      const fileId = new URL(route.request().url()).pathname.split("/").pop();
      const isScript = fileId === FILE_SCRIPT;
      return route.fulfill({
        json: {
          id: fileId,
          path: isScript ? "scripts/notes.sh" : "SKILL.md",
          mediaType: isScript ? "text/x-shellscript" : "text/markdown",
          isExecutable: isScript,
          sizeBytes: Buffer.byteLength(isScript ? script : markdown),
          sha256: "cd".repeat(32),
          contentBase64: encode(isScript ? script : markdown),
        },
      });
    },
  );

  await page.route(
    (url) => url.pathname === "/v1/skills",
    (route) => {
      record(route);
      return route.fulfill({
        status: 201,
        json: {
          id: SKILL,
          sourceId: null,
          slug: "house-voice",
          name: "House voice",
          description: null,
          activeVersionId: null,
          activeRevision: null,
          enabled: true,
          scope: "organization",
          ownerPrincipalId: null,
          createdAt: "2026-11-22T12:00:00.000Z",
          updatedAt: "2026-11-22T12:00:00.000Z",
          version: 1,
          copiedFromSkillId: null,
          copiedFromVersionId: null,
        },
      });
    },
  );

  return { seen, setDraft: (next: Draft) => (draft = next) };
}

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: a skill draft`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("New skill asks who it is for and a name, then opens the draft", async ({ page }) => {
      const { seen } = await draftWorld(page);
      await page.goto("/library?tab=skills");
      await page.getByRole("button", { name: "New skill" }).click();
      await page.getByLabel("Name").fill("House voice");
      await page.getByRole("button", { name: "Create skill" }).click();
      await expect(page).toHaveURL(/\/library\/skills\/[^/]+\/edit/);
      await expect(page.getByText("Draft · based on version 3")).toBeVisible();
      const create = seen.find((entry) =>
        entry.method === "POST" && entry.path === "/v1/skills"
      );
      expect(create?.body).toMatchObject({
        slug: "house-voice",
        name: "House voice",
        scope: "organization",
      });
      await still(page, "skill-draft-new");
    });

    test("the draft shows its files, the size line and the instructions file's contents", async ({ page }) => {
      await draftWorld(page);
      await page.goto(`/library/skills/${SKILL}/edit`);
      await expect(page.getByTestId("skill-draft-editor")).toBeVisible();
      await expect(
        page.getByTestId("skill-draft-files").getByText("SKILL.md"),
      ).toHaveCount(2);
      await expect(page.getByTestId("skill-draft-size"))
        .toContainText("of 10 MB");
      await expect(page.getByLabel("Contents")).toHaveValue(markdown);
      await still(page, "skill-draft-editor");
    });

    test("saving a file sends its bytes with the draft's version as If-Match", async ({ page }) => {
      const { seen } = await draftWorld(page);
      await page.goto(`/library/skills/${SKILL}/edit`);
      const content = page.getByLabel("Contents");
      await content.fill("# Release notes\n\nWrite the notes.\n");
      await page.getByRole("button", { name: "Save file" }).click();
      await expect
        .poll(() => seen.filter((entry) => entry.method === "POST").length)
        .toBeGreaterThan(0);
      const save = seen.find((entry) =>
        entry.method === "POST" && entry.path.endsWith("/draft/files")
      );
      expect(save?.ifMatch).toBe('"v4"');
      expect(
        Buffer.from(String(save?.body?.contentBase64), "base64").toString(),
      )
        .toBe("# Release notes\n\nWrite the notes.\n");
    });

    test("Check lists each problem with its file and line, and a row opens that file", async ({ page }) => {
      await draftWorld(page, {
        checkProblems: [
          {
            file: "scripts/notes.sh",
            line: 2,
            message:
              "The instructions mention this file, which is not in the skill.",
          },
        ],
      });
      await page.goto(`/library/skills/${SKILL}/edit`);
      await page.getByRole("button", { name: "Check" }).click();
      const problems = page.getByTestId("skill-draft-problems");
      await expect(problems).toContainText("Fix 1 problems to publish");
      await expect(problems).toContainText(
        "scripts/notes.sh · line 2: The instructions mention this file, which is not in the skill.",
      );
      await still(page, "skill-draft-problems");
      await problems.getByRole("button").first().click();
      await expect(page.getByLabel("Contents")).toHaveValue(script);
    });

    test("Publish checks first and shows the problems instead of publishing", async ({ page }) => {
      const { seen } = await draftWorld(page, {
        checkProblems: [{
          file: null,
          line: null,
          message: "No instructions.",
        }],
      });
      await page.goto(`/library/skills/${SKILL}/edit`);
      await page.getByRole("button", { name: "Publish" }).click();
      await expect(page.getByTestId("skill-draft-problems")).toContainText(
        "The whole skill: No instructions.",
      );
      expect(seen.some((entry) => entry.path.endsWith("/publish"))).toBe(false);
    });

    test("Publish on a clean draft asks once and then says which version is published", async ({ page }) => {
      const { seen } = await draftWorld(page);
      await page.goto(`/library/skills/${SKILL}/edit`);
      await page.getByRole("button", { name: "Publish" }).click();
      await expect(page.getByText("Publish version 4?")).toBeVisible();
      await page.getByRole("button", { name: "Publish" }).last().click();
      await expect(page.getByText("Version 4 is published.")).toBeVisible();
      const publish = seen.find((entry) => entry.path.endsWith("/publish"));
      expect(publish?.ifMatch).toBe('"v4"');
    });

    test("a save that loses a race says so and offers the latest draft", async ({ page }) => {
      await draftWorld(page, { saveStatus: 412 });
      await page.goto(`/library/skills/${SKILL}/edit`);
      await page.getByLabel("Contents").fill("# Changed\n");
      await page.getByRole("button", { name: "Save file" }).click();
      await expect(
        page.getByText(
          "This draft was changed somewhere else, so your last change to SKILL.md was not saved.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Load the latest" }))
        .toBeVisible();
      await still(page, "skill-draft-conflict");
    });
  });
}
