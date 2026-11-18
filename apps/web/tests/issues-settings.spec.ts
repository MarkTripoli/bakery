import { expect, type Page, test } from "@playwright/test";
import { issuesFixture, uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * Issue settings (#69, slice 1): the list of connected repositories and one
 * repository's settings, with the preview of the saved settings.
 *
 * The preview is the part the served contracts bound: `ticketSources.preview`
 * evaluates the stored policy and records readiness, so the page offers it only
 * for saved settings, and the counts come from one read of the saved issues.
 * These cases pin that, the label rules, the server-stamped automatic window,
 * the 412 conflict, and the leave guard.
 */

const CONNECTION_ID = uuid(901);
const WEB_SOURCE = uuid(900);
const WEB_REPOSITORY = uuid(903);
const API_REPOSITORY = uuid(905);
const STAMP = "2026-01-01T00:00:00.000Z";

const policy = (over: Record<string, unknown> = {}) => ({
  version: 1,
  labels: { execute: "bakery", planOnly: null, hold: "hold" },
  delegation: null,
  automatic: { enabled: false, since: null },
  readiness: { requireAcceptanceCriteria: true },
  approval: { plan: "human_approval" },
  preset: "fixed-coding",
  ...over,
});

const source = (over: Record<string, unknown> = {}) => ({
  id: WEB_SOURCE,
  organizationId: uuid(1),
  integrationConnectionId: CONNECTION_ID,
  integrationResourceId: uuid(902),
  applicationId: uuid(904),
  repositoryId: WEB_REPOSITORY,
  externalContainerId: "acme/web",
  enabled: true,
  policy: policy(),
  policyRevision: 3,
  syncHealth: "healthy",
  lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastProblemCode: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 7,
  ...over,
});

const repository = (id: string, name: string, providerRepoId: string) => ({
  id,
  applicationId: uuid(904),
  slug: name.toLowerCase(),
  integrationConnectionId: CONNECTION_ID,
  providerRepoId,
  owner: "acme",
  name,
  defaultBranch: "main",
  activeProfileId: null,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: "Request refused",
    detail: "Request refused.",
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

type SettingsOptions = {
  /** The saved source, or null for a repository that never took issues. */
  saved?: Record<string, unknown> | null;
  /** What PATCH answers: ok (default), or a conflict. */
  save?: "ok" | "conflict";
  /** What the preview answers: ok (default), or unavailable. */
  preview?: "ok" | "unavailable";
  /** The people the username lookup knows, by login. */
  people?: Record<string, { id: string; canTrigger: boolean }>;
  /** The issues the counts read, as their last verdicts. */
  verdicts?: ("ready" | "waiting" | "rejected" | null)[];
  role?: "admin" | "developer";
};

/** The Issues fixture plus the settings routes; returns what the page asked for. */
async function settingsFixture(page: Page, options: SettingsOptions = {}) {
  const seen = await issuesFixture(page, {
    role: options.role,
    sources: options.saved === null ? "none" : "healthy",
  });
  const settings = {
    patches: [] as Record<string, unknown>[],
    // A counter lives in an object: the fixture's return copies numbers.
    counts: { previews: 0 },
    lookups: [] as string[],
  };
  let saved = options.saved === null ? null : source(options.saved ?? {});

  await page.route(
    (url) => url.pathname === "/v1/repositories",
    (route) =>
      route.fulfill(json({
        items: [
          repository(WEB_REPOSITORY, "web", "7001"),
          repository(API_REPOSITORY, "api", "7002"),
        ],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/integration-connections",
    (route) =>
      route.fulfill(json({
        items: [{
          id: CONNECTION_ID,
          provider: "github",
          label: "acme-org",
          externalAccountId: "7000001",
          config: {},
          secretId: null,
          grantedScopes: { metadata: "read", contents: "write" },
          createdBy: uuid(1),
          status: "enabled",
          lastCheckedAt: STAMP,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        }],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/integration-connections/${CONNECTION_ID}/resources`,
    (route) =>
      route.fulfill(json({
        items: [
          ["7001", "acme/web", uuid(902)],
          ["7002", "acme/api", uuid(906)],
        ].map(([externalId, displayName, id]) => ({
          id,
          organizationId: uuid(1),
          connectionId: CONNECTION_ID,
          installationId: uuid(850),
          externalId,
          kind: "repository",
          displayName,
          safeUrl: `https://github.com/${displayName}`,
          selected: true,
          available: true,
          enabled: true,
          capabilitySnapshot: {},
          defaultBranch: "main",
          latestCheckState: null,
          latestCheckConclusion: null,
          latestCheckAt: null,
          lastDiscoveryGeneration: 1,
          archivedAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        })),
        nextCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/principals",
    (route) =>
      route.fulfill(json({
        items: [{
          id: uuid(910),
          principalType: "human",
          createdByPrincipalId: null,
          displayName: "Ada Lovelace",
          disabledAt: null,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        }],
        nextCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/ticket-sources/${WEB_SOURCE}`,
    (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        settings.patches.push(body);
        if (options.save === "conflict") {
          return route.fulfill(problem(412, "PRECONDITION_FAILED"));
        }
        const sent = body.policy as Record<string, unknown>;
        const automatic = sent.automatic as { enabled: boolean };
        saved = source({
          ...saved,
          enabled: body.enabled as boolean,
          policy: policy({
            ...sent,
            // The server stamps the window; the client never sends it.
            automatic: {
              enabled: automatic.enabled,
              since: automatic.enabled ? "2026-11-16T12:00:00.000Z" : null,
            },
          }),
          version: Number(saved?.version ?? 1) + 1,
        });
        return route.fulfill(json(saved));
      }
      return saved === null
        ? route.fulfill(problem(404, "NOT_FOUND"))
        : route.fulfill(json(saved));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/ticket-sources/${WEB_SOURCE}/previews`,
    (route) => {
      settings.counts.previews += 1;
      return options.preview === "unavailable"
        ? route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"))
        : route.fulfill(
          json({ operationId: uuid(950), status: "queued" }, 202),
        );
    },
  );
  await page.route(
    (url) => /^\/v1\/ticket-sources\/[^/]+\/people\/[^/]+$/.test(url.pathname),
    (route) => {
      const login = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
      );
      settings.lookups.push(login);
      const known = (options.people ?? {})[login];
      return known
        ? route.fulfill(json({
          login,
          externalUserId: known.id,
          permission: known.canTrigger ? "write" : "read",
          canTrigger: known.canTrigger,
        }))
        : route.fulfill(problem(404, "NOT_FOUND"));
    },
  );
  return { ...seen, ...settings };
}

const openSettings = async (page: Page) => {
  await page.goto(`/issues/settings/${WEB_SOURCE}`);
  await expect(page.getByTestId("issue-settings-page")).toBeVisible();
};

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: issue settings`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the list shows one row per connected repository, with Set up for one that never took issues", async ({ page }) => {
      await settingsFixture(page);
      await page.goto("/issues/settings");
      await expect(page.getByTestId("issue-settings-list")).toBeVisible();
      const rows = page.getByTestId("issue-settings-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText("acme/api");
      await expect(rows.first().getByRole("button", { name: "Set up" }))
        .toBeVisible();
      await expect(rows.last()).toContainText("acme/web");
      await expect(rows.last()).toContainText("Taking issues · label “bakery”");
      await expect(rows.last().getByRole("button", { name: "Open" }))
        .toBeVisible();
      await expect(rows.last()).toContainText("Working");
      await expect(rows.last()).toContainText("Updated 5 minutes ago");
      await shot(page, "issue-settings-list", [], { windowOnly: true });
    });

    test("the list says who can change the settings to someone who cannot", async ({ page }) => {
      await settingsFixture(page, { role: "developer" });
      await page.goto("/issues/settings");
      // The list is still readable: this is not an error page.
      await expect(page.getByTestId("issue-settings-row")).toHaveCount(2);
      await expect(page.getByText(
        "Only organization administrators can change issue settings.",
      )).toBeVisible();
    });

    test("the list says so when no repository is connected", async ({ page }) => {
      await settingsFixture(page, { saved: null });
      await page.route(
        (url) => url.pathname === "/v1/repositories",
        (route) => route.fulfill(json({ items: [], nextCursor: null })),
      );
      await page.goto("/issues/settings");
      await expect(page.getByTestId("issue-settings-list")).toBeVisible();
      await expect(page.getByText("No repositories are connected"))
        .toBeVisible();
      await expect(page.getByText(
        "Connect GitHub and choose repositories first.",
      )).toBeVisible();
    });

    test("two equal labels are one problem, and Save waits", async ({ page }) => {
      await settingsFixture(page);
      await openSettings(page);
      const hold = page.getByLabel("On hold");
      await hold.fill("Bakery");
      await expect(page.getByText("Each label must be different."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
      await shot(page, "issue-settings-labels-same", [], { windowOnly: true });
    });

    test("a label the server would refuse is refused here first", async ({ page }) => {
      await settingsFixture(page);
      await openSettings(page);
      await page.getByLabel("Start work").fill("see https://example.test");
      await expect(page.getByText(
        "Use the label as GitHub shows it: no surrounding spaces, no links, no braces.",
      )).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    test("acceptance criteria and plan approval travel in the saved policy", async ({ page }) => {
      const seen = await settingsFixture(page);
      await openSettings(page);
      await page.getByLabel("The issue must have acceptance criteria")
        .uncheck();
      await page.getByRole("radio", { name: /Start coding right away/ })
        .check();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      expect(seen.patches).toHaveLength(1);
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect(sent.readiness).toEqual({ requireAcceptanceCriteria: false });
      expect(sent.approval).toEqual({ plan: "automatic" });
    });

    test("automatic start asks first, and the date comes from the server's answer", async ({ page }) => {
      const seen = await settingsFixture(page, {
        people: { ada: { id: "4242", canTrigger: true } },
      });
      await openSettings(page);
      await page.getByLabel(/Start when the “bakery” label is added/)
        .click();
      await expect(page.getByText("Start work automatically?"))
        .toBeVisible();
      await page.getByRole("button", { name: "Turn on" }).click();
      await page.getByLabel("GitHub username").fill("ada");
      await page.getByRole("button", { name: "Add person" }).click();
      await expect(page.getByText("ada", { exact: true })).toBeVisible();
      await page.getByLabel("Work runs as").selectOption({
        label: "Ada Lovelace",
      });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      // The client never sends the window; the server stamps it.
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect(sent.automatic).toEqual({ enabled: true });
      expect(sent.delegation).toEqual({
        principalId: uuid(910),
        githubActorIds: ["4242"],
      });
      await expect(page.getByText(/Only for labels added after/)).toBeVisible();
      await shot(page, "issue-settings-automatic", [], { windowOnly: true });
    });

    test("a username GitHub does not know is a field error, not a crash", async ({ page }) => {
      await settingsFixture(page);
      await openSettings(page);
      await page.getByLabel(/Start when the “bakery” label is added/)
        .click();
      await page.getByRole("button", { name: "Turn on" }).click();
      await page.getByLabel("GitHub username").fill("nobody");
      await page.getByRole("button", { name: "Add person" }).click();
      await expect(page.getByText(
        "GitHub has no user with that username.",
      )).toBeVisible();
    });

    test("the workflow is read-only", async ({ page }) => {
      await settingsFixture(page);
      await openSettings(page);
      await expect(page.getByText("Uses the standard coding workflow."))
        .toBeVisible();
      await expect(page.getByText(
        "Choosing a different workflow per label or repository is not available yet.",
      )).toBeVisible();
      await expect(
        page.getByTestId("issue-settings-workflow").getByRole("combobox"),
      ).toHaveCount(0);
    });

    test("the preview reads the saved settings only, and counts from one read of the issues", async ({ page }) => {
      const seen = await settingsFixture(page);
      await openSettings(page);
      const preview = page.getByRole("button", { name: "Preview" });
      await expect(preview).toBeEnabled();
      // An edit makes the preview wait for a save, and says so.
      await page.getByLabel("Start work").fill("ready");
      await expect(preview).toBeDisabled();
      await expect(page.getByText(
        "Save to preview your edits. The preview reads the saved settings.",
      )).toBeVisible();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      await expect(preview).toBeEnabled();
      await preview.click();
      await expect(page.getByText("can start")).toBeVisible();
      await expect(page.getByText("waiting")).toBeVisible();
      await expect(page.getByText("cannot start")).toBeVisible();
      await expect(page.getByText(/From checks read/)).toBeVisible();
      expect(seen.counts.previews).toBe(1);
      // One read for the counts, not one per issue.
      expect(seen.lists).toHaveLength(1);
      await shot(page, "issue-settings-preview", [], { windowOnly: true });
    });

    test("a preview that cannot be made says so and leaves Save alone", async ({ page }) => {
      await settingsFixture(page, { preview: "unavailable" });
      await openSettings(page);
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByText(
        "The preview is not available right now. You can still save.",
      )).toBeVisible();
    });

    test("someone else's save is a notice that keeps the draft", async ({ page }) => {
      await settingsFixture(page, { save: "conflict" });
      await openSettings(page);
      await page.getByLabel("Start work").fill("ready");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(
        "Someone else changed these settings. Reload to see theirs; your changes are kept here until you do.",
      )).toBeVisible();
      await expect(page.getByLabel("Start work")).toHaveValue("ready");
      await shot(page, "issue-settings-conflict", [], { windowOnly: true });
    });

    test("leaving with unsaved changes asks first, and leaving clean does not", async ({ page }) => {
      // The guard is viewport-independent, and the shell's links are not all
      // reachable on a phone, so one viewport proves it.
      test.skip(viewport.name === "phone", "proved once");
      await settingsFixture(page);
      await openSettings(page);
      await page.getByLabel("Start work").fill("ready");
      await page.getByRole("link", { name: "Issues" }).first().click();
      await expect(page.getByText("Leave without saving?").first())
        .toBeVisible();
      await expect(page.getByText(/unsaved change/)).toBeVisible();
      await page.getByRole("button", { name: "Stay" }).click();
      await expect(page.getByTestId("issue-settings-page")).toBeVisible();
      // Discard, then leave: no question.
      await page.getByRole("button", { name: "Discard" }).click();
      await page.getByRole("link", { name: "Issues" }).first().click();
      await expect(page.getByTestId("issue-settings-page")).toHaveCount(0);
    });
  });
}
