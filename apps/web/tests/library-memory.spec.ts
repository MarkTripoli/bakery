import { expect, type Page, test } from "@playwright/test";
import { libraryFixture, uuid } from "./helpers/library-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Memory tab (design-ux, #72, slice 1): remembered facts with one badge
 * each, where each came from, and a read-only panel for one fact. The entry
 * carries its current revision, so the list is one read, not one per fact.
 */
const STAMP = "2026-11-01T10:00:00.000Z";
const API = uuid(900);
const WEB = uuid(901);

type Source = "available" | "deleted" | "no_access" | "unknown";
type Fact = {
  n: number;
  body: string;
  status?: "proposed" | "active" | "retired";
  source?: Source;
  repository?: string;
  /** How many wordings the fact has had. */
  revisions?: number;
  confidence?: string;
  expiresAt?: string | null;
  artifact?: string;
  artifactVersion?: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const revisionOf = (fact: Fact, revision: number) => {
  const state = fact.source ?? "available";
  const named = state === "available" || state === "deleted";
  return {
    id: uuid(fact.n * 100 + revision),
    memoryId: uuid(fact.n),
    revision,
    body: revision === (fact.revisions ?? 1)
      ? fact.body
      : `${fact.body} (earlier wording ${revision})`,
    reason: revision === 1 ? null : `Correction ${revision - 1}`,
    sourceArtifactVersionId: state === "no_access" ? null : uuid(7000 + fact.n),
    sourceState: state,
    sourceName: named ? fact.artifact ?? "Runbook" : null,
    sourceRevision: named ? fact.artifactVersion ?? 3 : null,
    supersedesId: revision === 1 ? null : uuid(fact.n * 100 + revision - 1),
    confidence: fact.confidence ?? "0.900000",
    expiresAt: fact.expiresAt ?? null,
    createdBy: uuid(1),
    createdAt: `2026-11-0${revision}T10:00:00.000Z`,
    updatedAt: STAMP,
    version: 1,
  };
};

const entryOf = (fact: Fact) => {
  const last = fact.revisions ?? 1;
  const current = revisionOf(fact, last);
  return {
    id: uuid(fact.n),
    repositoryId: fact.repository ?? API,
    topic: `topic-${fact.n}`,
    tags: [],
    currentRevisionId: current.id,
    currentRevision: current,
    sourceState: fact.source ?? "available",
    status: fact.status ?? "active",
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  };
};

const repository = (id: string, name: string) => ({
  id,
  applicationId: uuid(800),
  slug: name,
  integrationConnectionId: uuid(801),
  providerRepoId: "5001",
  owner: "acme",
  name,
  defaultBranch: "main",
  activeProfileId: null,
  nextProfileRevision: 1,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const WORLD: Fact[] = [
  {
    n: 1,
    body: "Deploys run from main, never from a branch.",
    revisions: 3,
    expiresAt: "2027-01-15T00:00:00.000Z",
  },
  {
    n: 2,
    body: "The staging database is reset every Monday.",
    status: "proposed",
    confidence: "0.600000",
  },
  {
    n: 3,
    body: "Releases are tagged by the on-call engineer.",
    source: "deleted",
    repository: WEB,
    confidence: "0.300000",
  },
  {
    n: 4,
    body: "Billing code lives in the payments package.",
    source: "no_access",
  },
  { n: 5, body: "Feature flags are read once at start-up.", status: "retired" },
];

async function memoryFixture(
  page: Page,
  facts: Fact[] = WORLD,
  options: { fail?: boolean } = {},
) {
  await libraryFixture(page, {});
  const seen = { revisionReads: [] as string[], listReads: 0 };
  await page.route("**/v1/repositories**", (route) =>
    route.fulfill(json({
      items: [repository(API, "api-service"), repository(WEB, "web-app")],
      nextCursor: null,
    })));
  await page.route("**/v1/memories**", (route) => {
    const url = new URL(route.request().url());
    const revisions = url.pathname.match(/\/v1\/memories\/([^/]+)\/revisions$/);
    if (revisions) {
      seen.revisionReads.push(revisions[1]);
      const fact = facts.find((item) => uuid(item.n) === revisions[1]);
      return route.fulfill(json({
        items: fact
          ? Array.from(
            { length: fact.revisions ?? 1 },
            (_, index) => revisionOf(fact, index + 1),
          )
          : [],
        nextCursor: null,
      }));
    }
    seen.listReads += 1;
    if (options.fail) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "INTERNAL_ERROR",
          detail: "INTERNAL_ERROR",
          status: 500,
          code: "INTERNAL_ERROR",
          retryable: true,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    return route.fulfill(json({ items: facts.map(entryOf), nextCursor: null }));
  });
  return seen;
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: memory tab`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const row = (page: Page, n: number) =>
      page.getByTestId("library-memory").locator(
        `[data-library-id="${uuid(n)}"]`,
      );

    test("lists each fact with one badge and where it came from, retired facts last, from one read", async ({ page }) => {
      const seen = await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await expect(page.getByRole("tab", { name: "Memory" })).toBeVisible();
      await expect(
        page.getByText("Facts agents are given before they start work."),
      ).toBeVisible();
      await expect(row(page, 1)).toContainText(
        "Deploys run from main, never from a branch.",
      );
      await expect(row(page, 1)).toContainText("In use");
      await expect(row(page, 1)).toContainText(
        "Source: Runbook, version 3 · corrected 2 times",
      );
      await expect(row(page, 1)).toContainText("Repository: api-service");
      await expect(row(page, 2)).toContainText("Suggested");
      await expect(row(page, 2)).toContainText("Source: Runbook, version 3");
      await expect(row(page, 2)).not.toContainText("corrected");
      await expect(row(page, 3)).toContainText("Source missing");
      await expect(row(page, 3)).toContainText("Its source was deleted");
      await expect(row(page, 3)).toContainText("Repository: web-app");
      await expect(row(page, 4)).toContainText("In use");
      await expect(row(page, 4)).toContainText(
        "You do not have access to its source",
      );
      // Nothing names a document the reader may not see.
      await expect(row(page, 4)).not.toContainText("Runbook");
      await expect(row(page, 5)).toContainText("No longer used");
      // Facts no longer used come last.
      const ids = await page.getByTestId("library-memory").locator(
        "[data-library-id]",
      )
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-library-id"))
        );
      expect(ids.at(-1)).toBe(uuid(5));
      // The list needs no read per fact: no revision is read until a fact is
      // opened. (The shell re-issues its first reads once it restores the
      // organization, so the number of list requests is not asserted.)
      expect(seen.revisionReads).toEqual([]);
      await page.mouse.move(700, 700);
      await shot(page, "library-memory-list");
    });

    test("opening a fact shows its wording, source, confidence, expiry and every wording it has had", async ({ page }) => {
      const seen = await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await row(page, 1).getByRole("button", { name: /^Open fact:/ }).click();
      await expect(page).toHaveURL(new RegExp(`fact=${uuid(1)}`));
      const sheet = page.getByTestId("memory-fact");
      await expect(sheet.getByTestId("memory-fact-body")).toHaveText(
        "Deploys run from main, never from a branch.",
      );
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Source: Runbook, version 3",
      );
      await expect(sheet).toContainText("How sure: High");
      await expect(sheet).toContainText("It is a guide, not a measurement.");
      await expect(sheet).toContainText("Expires:");
      await expect(sheet).toContainText("2027");
      const history = sheet.getByTestId("memory-history");
      await expect(history.getByRole("listitem")).toHaveCount(3);
      // Newest first; the current one is marked In use, earlier ones are earlier wordings with their reasons.
      await expect(history.getByRole("listitem").first()).toContainText(
        "In use",
      );
      await expect(history.getByRole("listitem").nth(1)).toContainText(
        "Earlier wording",
      );
      await expect(history.getByRole("listitem").nth(1)).toContainText(
        '"Correction 1"',
      );
      // Only the opened fact's history is read.
      expect([...new Set(seen.revisionReads)]).toEqual([uuid(1)]);
      await shot(page, "library-memory-fact", [], { windowOnly: true });
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page).not.toHaveURL(/fact=/);
      await expect(row(page, 1)).toBeVisible();
    });

    test("a fact with a deleted source says so and what to do; no access names nothing", async ({ page }) => {
      await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await row(page, 3).getByRole("button", { name: /^Open fact:/ }).click();
      const sheet = page.getByTestId("memory-fact");
      await expect(sheet).toContainText("Source missing");
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "This source was deleted.",
      );
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Bakery still gives agents this fact.",
      );
      await expect(sheet).toContainText("How sure: Low");
      await expect(sheet).toContainText("Expires: Never");
      await shot(page, "library-memory-source-missing", [], {
        windowOnly: true,
      });
      await sheet.getByRole("button", { name: "Close" }).click();
      await row(page, 4).getByRole("button", { name: /^Open fact:/ }).click();
      const denied = page.getByTestId("memory-fact");
      await expect(denied.getByTestId("memory-source")).toContainText(
        "You do not have access to this source.",
      );
      await expect(denied.getByTestId("memory-source")).toContainText(
        "Someone who can open it can check this fact.",
      );
      await expect(denied).not.toContainText("Runbook");
    });
  });
}

test.describe("memory tab states", () => {
  test("no facts shows the empty state; a failed read says so and Try again reads again", async ({ page }) => {
    await memoryFixture(page, []);
    await page.goto("/library?tab=memory");
    await expect(page.getByText("No remembered facts yet")).toBeVisible();
    await expect(
      page.getByText(
        "Facts Bakery remembers about your repositories appear here",
      ),
    ).toBeVisible();
  });

  test("a failed read says so, and Try again reads the list again", async ({ page }) => {
    const seen = await memoryFixture(page, WORLD, { fail: true });
    await page.goto("/library?tab=memory");
    await expect(page.getByText("The library could not be loaded."))
      .toBeVisible();
    const before = seen.listReads;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => seen.listReads).toBeGreaterThan(before);
  });

  test("Memory is a Library tab and the others still open", async ({ page }) => {
    await memoryFixture(page);
    await page.goto("/library");
    await page.getByRole("tab", { name: "Memory" }).click();
    await expect(page).toHaveURL(/tab=memory/);
    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.getByTestId("library-built-in")).toBeVisible();
  });
});

// The organization the stubs answer for.
void MOCK_ORGANIZATION_ID;
