import { expect, type Page, test } from "@playwright/test";
import { issuesFixture, uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/**
 * An evidence still of the settings page. The save bar sticks to the window, so
 * a full-page still would lay it over the options; it is left in the flow here.
 */
const evidence = async (page: Page, name: string) => {
  if (!process.env.BAKERY_EVIDENCE_DIR) return;
  await page.addStyleTag({
    content: ".ui-draft-bar { position: static !important; }",
  });
  await still(page, name);
};

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
  version: 2,
  labels: { execute: "bakery", planOnly: null, hold: "hold" },
  delegation: null,
  automatic: { enabled: false, since: null },
  readiness: { requireAcceptanceCriteria: true },
  approval: { plan: "human_approval" },
  workflow: { workflowId: uuid(950), builtIn: "fixed-coding" },
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
  /** Issues the preview says only wait because their label was on before automatic starts; omitted by an older server. */
  labeledBeforeWindow?: number;
  /** The people the username lookup knows, by login. */
  people?: Record<string, { id: string; canTrigger: boolean }>;
  /** The issues the counts read, as their last verdicts. */
  verdicts?: ("ready" | "waiting" | "rejected" | null)[];
  role?: "admin" | "developer";
  /** The saved routing rules: a label (by id and name) sent to a repository. */
  rules?: { labelId: string; labelName: string; repositoryId: string }[];
  /** What the labels read answers: ok (default), or GitHub not answering. */
  labels?: "ok" | "error";
  /** What replacing the rules answers: ok (default), refused, or stale. */
  replace?: "ok" | "refused" | "stale";
  /** The api repository is archived. */
  archivedApi?: boolean;
  /** The api repository has no role in the application. */
  noRoleApi?: boolean;
  /** Workflows the organization wrote, as the workflow list returns them. */
  workflows?: {
    id: string;
    name: string;
    description: string;
    needsInputs?: boolean;
    startsOverlapAdmission?: boolean;
  }[];
};

const writtenWorkflow = (
  workflow: {
    id: string;
    name: string;
    description: string;
    needsInputs?: boolean;
    startsOverlapAdmission?: boolean;
  },
) => ({
  needsInputs: false,
  startsOverlapAdmission: false,
  ...workflow,
  slug: workflow.name.toLowerCase().replaceAll(" ", "-"),
  activeVersionId: uuid(960),
  enabled: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  origin: {
    kind: "authored",
    catalogKey: null,
    catalogVersion: null,
    sourceWorkflowId: null,
    sourceVersionId: null,
    sourceDigest: null,
  },
  visibility: "listed",
});

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
    replaces: [] as { rules: Record<string, string>[] }[],
  };
  let saved = options.saved === null ? null : source(options.saved ?? {});

  await page.route(
    (url) => url.pathname === "/v1/workflows",
    (route) =>
      route.fulfill(json({
        items: (options.workflows ?? []).map(writtenWorkflow),
        nextCursor: null,
      })),
  );

  await page.route(
    (url) => url.pathname === "/v1/repositories",
    (route) =>
      route.fulfill(json({
        items: [
          repository(WEB_REPOSITORY, "web", "7001"),
          options.archivedApi
            ? {
              ...repository(API_REPOSITORY, "api", "7002"),
              archivedAt: STAMP,
            }
            : repository(API_REPOSITORY, "api", "7002"),
        ],
        nextCursor: null,
      })),
  );
  const ruleRow = (
    n: number,
    rule: {
      labelId: string;
      labelName: string;
      repositoryId: string;
      role?: string;
    },
  ) => ({
    id: uuid(9300 + n),
    organizationId: uuid(1),
    ticketSourceId: WEB_SOURCE,
    labelId: rule.labelId,
    repositoryId: rule.repositoryId,
    role: rule.role ?? (rule.repositoryId === API_REPOSITORY ? "api" : "web"),
    presetId: "fixed-coding",
    version: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    labelName: rule.labelName,
  });
  let ruleSet = {
    ticketSourceId: WEB_SOURCE,
    policyRevision: 3,
    version: 5,
    rules: (options.rules ?? []).map((rule, index) => ruleRow(index, rule)),
  };
  await page.route(
    (url) => url.pathname === `/v1/ticket-sources/${WEB_SOURCE}/routing-rules`,
    (route) => {
      if (route.request().method() !== "PUT") {
        return route.fulfill(json(ruleSet));
      }
      const body = route.request().postDataJSON() as {
        rules: Record<string, string>[];
      };
      settings.replaces.push(body);
      if (options.replace === "stale") {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      if (options.replace === "refused") {
        return route.fulfill({
          ...problem(422, "UNPROCESSABLE"),
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Request refused",
            detail: "Request refused.",
            status: 422,
            code: "UNPROCESSABLE",
            retryable: false,
            issues: [{
              path: ["rules", 0, "repositoryId"],
              code: "routing_repository_unavailable",
              message: "routing repository unavailable",
            }],
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      ruleSet = {
        ...ruleSet,
        version: ruleSet.version + 1,
        rules: body.rules.map((rule, index) => ruleRow(index, rule as never)),
      };
      return route.fulfill(json(ruleSet));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/ticket-sources/${WEB_SOURCE}/labels`,
    (route) =>
      options.labels === "error"
        ? route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"))
        : route.fulfill(json({
          items: [
            { id: "1001", name: "api-work", color: "0e8a16" },
            { id: "1002", name: "docs", color: null },
            { id: "1003", name: "bakery", color: null },
          ],
          nextCursor: null,
        })),
  );
  await page.route(
    (url) => url.pathname === `/v1/applications/${uuid(904)}/repository-roles`,
    (route) =>
      route.fulfill(json({
        items: [
          [WEB_REPOSITORY, "web", "web"],
          ...(options.noRoleApi ? [] : [[API_REPOSITORY, "api", "api"]]),
        ].map(([repositoryId, alias, role], index) => ({
          id: uuid(9400 + index),
          applicationId: uuid(904),
          alias,
          role,
          repositoryId,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        })),
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
          json({
            sourceId: WEB_SOURCE,
            policyRevision: 1,
            draft: false,
            evaluatedAt: "2026-11-10T12:00:00.000Z",
            counts: {
              wouldStart: 1,
              planOnly: 0,
              held: 0,
              blocked: (options.labeledBeforeWindow ?? 1) + 1,
              ...(options.labeledBeforeWindow === undefined
                ? {}
                : { labeledBeforeWindow: options.labeledBeforeWindow }),
            },
            issues: [
              {
                number: 1,
                title: "Ready",
                outcome: "would_start",
                verdict: "ready",
                reasons: [],
              },
              // As many waiting issues as the preview says only wait for the
              // label's date, so the counts are ones the server can return together.
              ...Array.from(
                { length: options.labeledBeforeWindow ?? 1 },
                (_, index) => ({
                  number: 2 + index,
                  title: `Waiting ${index + 1}`,
                  outcome: "blocked",
                  verdict: "waiting",
                  reasons: options.labeledBeforeWindow === undefined
                    ? ["predecessor_open"]
                    : ["adoption_required"],
                }),
              ),
              {
                number: 99,
                title: "Refused",
                outcome: "blocked",
                verdict: "rejected",
                reasons: ["has_sub_issues"],
              },
            ],
            skipped: 0,
          }, 201),
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
      await expect(
        page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }),
      ).toBeFocused();
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
        externalActorIds: ["4242"],
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

    const workflowBox = (page: Page) =>
      page.getByTestId("issue-settings-workflow");
    const automaticSwitch = (page: Page) =>
      page.getByLabel(/Start when the “bakery” label is added/);

    test("an administrator chooses the repository's built-in workflow, saved by the one Save", async ({ page }) => {
      const seen = await settingsFixture(page);
      await openSettings(page);
      const choice = workflowBox(page).getByLabel("Workflow");
      await expect(
        workflowBox(page).getByText(
          "The steps Bakery follows for issues from this repository.",
        ),
      ).toBeVisible();
      await expect(choice.getByRole("option")).toHaveCount(3);
      await expect(choice).toHaveValue("fixed-coding");
      await still(page, "issue-settings-workflow", undefined, {
        scrollTo: workflowBox(page),
      });
      await choice.selectOption("fixed-coding-reviewed");
      await expect(page.getByText(
        "Applies to issues started from now on. Work already started keeps the settings and routing it started with.",
      )).toBeVisible();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      expect(seen.patches).toHaveLength(1);
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect(sent.workflow).toEqual({ builtIn: "fixed-coding-reviewed" });
    });

    test("a workflow the organization wrote is listed, shown chosen, and saved by its id", async ({ page }) => {
      const triage = {
        id: uuid(970),
        name: "Triage and fix",
        description: "Reads the issue, fixes it and opens a pull request.",
      };
      const release = {
        id: uuid(971),
        name: "Release notes",
        description: "Writes the release notes for the issue.",
      };
      const seen = await settingsFixture(page, {
        saved: { policy: policy({ workflow: { workflowId: triage.id } }) },
        workflows: [triage, release],
      });
      await openSettings(page);
      const choice = workflowBox(page).getByLabel("Workflow");
      await expect(choice).toHaveValue(`workflow:${triage.id}`);
      await expect(choice.getByRole("option")).toHaveCount(5);
      await expect(workflowBox(page)).toContainText(triage.description);
      await expect(workflowBox(page)).not.toContainText(
        "People choose a workflow each time they start work.",
      );
      await still(page, "issue-settings-workflow-written", undefined, {
        scrollTo: workflowBox(page),
      });
      await choice.selectOption(`workflow:${release.id}`);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect(sent.workflow).toEqual({ workflowId: release.id });
    });

    test("a saved workflow missing from the list is named, one that cannot be read says so, and one that needs inputs is not offered", async ({ page }) => {
      const kept = {
        id: uuid(972),
        name: "Asks for a note",
        description: "Needs a note before it can run.",
        needsInputs: true,
      };
      await settingsFixture(page, {
        saved: { policy: policy({ workflow: { workflowId: kept.id } }) },
        workflows: [kept],
      });
      await page.route(
        (url) => url.pathname === `/v1/workflows/${kept.id}`,
        (route) => route.fulfill(json(writtenWorkflow(kept))),
      );
      await openSettings(page);
      const choice = workflowBox(page).getByLabel("Workflow");
      await expect(choice).toHaveValue(`workflow:${kept.id}`);
      await expect(choice.getByRole("option")).toHaveCount(4);
      await expect(choice.getByRole("option", { name: kept.name }))
        .toHaveCount(1);
      await expect(workflowBox(page)).not.toContainText(kept.id);
      await still(page, "issue-settings-workflow-unlisted", undefined, {
        scrollTo: workflowBox(page),
      });
    });

    test("with Start automatically on, a workflow that starts on its own when an issue is labeled is not offered", async ({ page }) => {
      const triage = {
        id: uuid(974),
        name: "Triage and fix",
        description: "Reads the issue, fixes it and opens a pull request.",
      };
      const onLabel = {
        id: uuid(975),
        name: "Runs on every label",
        description: "Starts by itself when an issue is labeled.",
        startsOverlapAdmission: true,
      };
      await settingsFixture(page, {
        saved: {
          policy: policy({
            automatic: { enabled: true, since: "2026-11-16T12:00:00.000Z" },
            workflow: { workflowId: triage.id },
          }),
        },
        workflows: [triage, onLabel],
      });
      await openSettings(page);
      const choice = workflowBox(page).getByLabel("Workflow");
      await expect(choice).toHaveValue(`workflow:${triage.id}`);
      await expect(choice.getByRole("option", { name: triage.name }))
        .toHaveCount(1);
      await expect(choice.getByRole("option", { name: onLabel.name }))
        .toHaveCount(0);
      await automaticSwitch(page).click();
      await expect(choice.getByRole("option", { name: onLabel.name }))
        .toHaveCount(1);
    });

    test("a saved workflow that cannot be read is said to be unavailable, never shown by its id", async ({ page }) => {
      const gone = uuid(973);
      await settingsFixture(page, {
        saved: { policy: policy({ workflow: { workflowId: gone } }) },
      });
      await page.route(
        (url) => url.pathname === `/v1/workflows/${gone}`,
        (route) =>
          route.fulfill({
            status: 404,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "about:blank",
              title: "Not found",
              status: 404,
              code: "RESOURCE_NOT_FOUND",
            }),
          }),
      );
      await openSettings(page);
      const choice = workflowBox(page).getByLabel("Workflow");
      await expect(
        choice.getByRole("option", {
          name: "A workflow that is no longer available",
        }),
      ).toHaveCount(1);
      await expect(workflowBox(page)).not.toContainText(gone);
    });

    test("a repository set to the reviewed workflow shows it chosen", async ({ page }) => {
      await settingsFixture(page, {
        saved: {
          policy: policy({
            workflow: {
              workflowId: uuid(951),
              builtIn: "fixed-coding-reviewed",
            },
          }),
        },
      });
      await openSettings(page);
      await expect(workflowBox(page).getByLabel("Workflow")).toHaveValue(
        "fixed-coding-reviewed",
      );
    });

    test("a repository with no workflow shows No workflow and what that means, and saves labels without inventing one", async ({ page }) => {
      const seen = await settingsFixture(page, {
        saved: { policy: policy({ workflow: undefined }) },
      });
      await openSettings(page);
      await expect(workflowBox(page).getByLabel("Workflow")).toHaveValue("");
      await expect(workflowBox(page)).toContainText(
        "People choose a workflow each time they start work.",
      );
      await still(page, "issue-settings-workflow-none", undefined, {
        scrollTo: workflowBox(page),
      });
      await page.getByLabel("Start work").fill("ready");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect("workflow" in sent).toBe(false);
    });

    test("Start automatically cannot be turned on without a workflow, and says what to do", async ({ page }) => {
      await settingsFixture(page, {
        saved: { policy: policy({ workflow: undefined }) },
      });
      await openSettings(page);
      await automaticSwitch(page).click();
      await expect(page.getByText(
        "Start automatically needs a workflow. Choose one above.",
      )).toBeVisible();
      await expect(automaticSwitch(page)).not.toBeChecked();
      await expect(page.getByText("Start work automatically?"))
        .toHaveCount(0);
      const needsWorkflow = page.getByRole("alert").filter({
        hasText: "Start automatically needs a workflow.",
      });
      await expect(needsWorkflow).toHaveAttribute("data-variant", "error");
      await expect(automaticSwitch(page)).toHaveAttribute(
        "aria-describedby",
        (await needsWorkflow.getAttribute("id")) ?? "",
      );
      await still(page, "issue-settings-automatic-needs-workflow", undefined, {
        scrollTo: page.getByTestId("issue-settings-automatic"),
      });
      await workflowBox(page).getByLabel("Workflow").selectOption(
        "fixed-coding",
      );
      await automaticSwitch(page).click();
      await expect(page.getByText("Start work automatically?"))
        .toBeVisible();
    });

    test("choosing No workflow while Start automatically is on turns it off and says so", async ({ page }) => {
      await settingsFixture(page, {
        saved: {
          policy: policy({
            automatic: { enabled: true, since: STAMP },
            delegation: { principalId: uuid(7), externalActorIds: ["4242"] },
          }),
        },
      });
      await openSettings(page);
      await expect(automaticSwitch(page)).toBeChecked();
      await workflowBox(page).getByLabel("Workflow").selectOption("");
      await expect(automaticSwitch(page)).not.toBeChecked();
      await expect(
        page.getByRole("status").filter({
          hasText:
            "Start automatically was turned off because no workflow is chosen.",
        }),
      ).toHaveAttribute("data-variant", "information");
      await still(page, "issue-settings-automatic-turned-off", undefined, {
        scrollTo: page.getByTestId("issue-settings-automatic"),
      });
    });

    test("someone who is not an administrator reads the workflow and cannot change it", async ({ page }) => {
      await settingsFixture(page, { role: "developer" });
      await openSettings(page);
      await expect(page.getByText("This repository runs Fixed coding."))
        .toBeVisible();
      await expect(workflowBox(page).getByLabel("Workflow")).toHaveCount(0);
      await still(page, "issue-settings-workflow-read-only", undefined, {
        scrollTo: workflowBox(page),
      });
    });

    test("someone who is not an administrator is told when no workflow is set", async ({ page }) => {
      await settingsFixture(page, {
        role: "developer",
        saved: { policy: policy({ workflow: undefined }) },
      });
      await openSettings(page);
      await expect(page.getByText(
        "No workflow is set for this repository. People choose one when they start work.",
      )).toBeVisible();
      await still(page, "issue-settings-workflow-read-only-none", undefined, {
        scrollTo: workflowBox(page),
      });
    });

    const rules = (page: Page) => page.getByTestId("issue-settings-routing");
    const rule = (page: Page) => page.getByTestId("routing-rule");

    test("where the work goes: the default, then a rule added, saved by the one Save", async ({ page }) => {
      const seen = await settingsFixture(page);
      await openSettings(page);
      await expect(rules(page).getByText("Work happens in acme/web."))
        .toBeVisible();
      await expect(rules(page).getByText("No rules.", { exact: false }))
        .toBeVisible();
      await rules(page).getByRole("button", { name: "Add rule" }).click();
      const row = rule(page).first();
      await row.getByLabel("Label").selectOption({ label: "api-work" });
      await row.getByLabel("Repository").selectOption({ label: "acme/api" });
      await expect(row.getByText("Role: api")).toBeVisible();
      await expect(page.getByText(
        "Applies to issues started from now on. Work already started keeps the settings and routing it started with.",
      )).toBeVisible();
      await page.mouse.move(700, 700);
      await evidence(page, "issue-settings-routing");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      // Only the rules changed: no settings write.
      expect(seen.patches).toHaveLength(0);
      expect(seen.replaces).toHaveLength(1);
      expect(seen.replaces[0].rules).toEqual([{
        labelId: "1001",
        labelName: "api-work",
        repositoryId: API_REPOSITORY,
        role: "api",
      }]);
    });

    test("two saved rules are listed, each with its label, repository and role", async ({ page }) => {
      await settingsFixture(page, {
        rules: [
          {
            labelId: "1001",
            labelName: "api-work",
            repositoryId: API_REPOSITORY,
          },
          { labelId: "1002", labelName: "docs", repositoryId: WEB_REPOSITORY },
        ],
      });
      await openSettings(page);
      await expect(rule(page)).toHaveCount(2);
      await expect(rule(page).nth(1).getByLabel("Repository")).toHaveValue(
        WEB_REPOSITORY,
      );
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await evidence(page, "issue-settings-routing-two-rules");
    });

    test("a saved rule is listed, and Remove takes it out on Save", async ({ page }) => {
      const seen = await settingsFixture(page, {
        rules: [{
          labelId: "1001",
          labelName: "api-work",
          repositoryId: API_REPOSITORY,
        }],
      });
      await openSettings(page);
      await expect(rule(page)).toHaveCount(1);
      await expect(rule(page).first().getByLabel("Repository")).toHaveValue(
        API_REPOSITORY,
      );
      await rule(page).first().getByRole("button", { name: "Remove rule 1" })
        .click();
      await expect(rule(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      expect(seen.replaces[0].rules).toEqual([]);
    });

    test("the same label to the same repository twice is one problem, and Save waits", async ({ page }) => {
      await settingsFixture(page, {
        rules: [{
          labelId: "1001",
          labelName: "api-work",
          repositoryId: API_REPOSITORY,
        }],
      });
      await openSettings(page);
      await rules(page).getByRole("button", { name: "Add rule" }).click();
      const second = rule(page).nth(1);
      await second.getByLabel("Label").selectOption({ label: "api-work" });
      await second.getByLabel("Repository").selectOption({ label: "acme/api" });
      await expect(
        second.getByText("This label already goes to that repository."),
      )
        .toBeVisible();
      await evidence(page, "issue-settings-routing-error");
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    test("a rule whose repository lost its role says so, and Save waits", async ({ page }) => {
      await settingsFixture(page, {
        noRoleApi: true,
        rules: [{
          labelId: "1001",
          labelName: "api-work",
          repositoryId: API_REPOSITORY,
        }],
      });
      await openSettings(page);
      await expect(
        rule(page).first().getByText(
          "That repository has no role in its project yet. Give it one in the project's settings.",
        ),
      ).toBeVisible();
      // Nothing was edited, so there is nothing to save.
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    });

    test("an archived repository is named as a problem on its rule", async ({ page }) => {
      await settingsFixture(page, {
        archivedApi: true,
        rules: [{
          labelId: "1001",
          labelName: "api-work",
          repositoryId: API_REPOSITORY,
        }],
      });
      await openSettings(page);
      await expect(rule(page).first().getByText("That repository is archived."))
        .toBeVisible();
    });

    test("settings save, the rules are refused: the person is told and the rules stay", async ({ page }) => {
      const seen = await settingsFixture(page, { replace: "refused" });
      await openSettings(page);
      await page.getByLabel("Start work").fill("ready");
      await rules(page).getByRole("button", { name: "Add rule" }).click();
      const row = rule(page).first();
      await row.getByLabel("Label").selectOption({ label: "docs" });
      await row.getByLabel("Repository").selectOption({ label: "acme/api" });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(
        "Settings saved. The routing rules were not saved: a repository is archived or not in this project.",
      )).toBeVisible();
      await evidence(page, "issue-settings-routing-partial-save");
      expect(seen.patches).toHaveLength(1);
      expect(seen.replaces).toHaveLength(1);
      // The rule is still in the form to fix.
      await expect(rule(page)).toHaveCount(1);
    });

    test("a rules save against an older version is a conflict, not a refusal", async ({ page }) => {
      await settingsFixture(page, { replace: "stale" });
      await openSettings(page);
      await rules(page).getByRole("button", { name: "Add rule" }).click();
      const row = rule(page).first();
      await row.getByLabel("Label").selectOption({ label: "docs" });
      await row.getByLabel("Repository").selectOption({ label: "acme/api" });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(/Someone else changed these settings/))
        .toBeVisible();
    });

    test("labels GitHub cannot list say so and offer Try again", async ({ page }) => {
      await settingsFixture(page, { labels: "error" });
      await openSettings(page);
      await expect(
        rules(page).getByText("Labels could not be read from GitHub."),
      )
        .toBeVisible();
      await expect(rules(page).getByRole("button", { name: "Try again" }))
        .toBeVisible();
    });

    test("50 rules is the most", async ({ page }) => {
      await settingsFixture(page, {
        rules: Array.from({ length: 50 }, (_, index) => ({
          labelId: String(2000 + index),
          labelName: `label-${index}`,
          repositoryId: API_REPOSITORY,
        })),
      });
      await openSettings(page);
      await expect(rule(page)).toHaveCount(50);
      await expect(rules(page).getByRole("button", { name: "Add rule" }))
        .toBeDisabled();
      await expect(rules(page).getByText("50 rules is the most."))
        .toBeVisible();
    });

    test("someone who is not an administrator cannot add or remove rules", async ({ page }) => {
      await settingsFixture(page, {
        role: "developer",
        rules: [{
          labelId: "1001",
          labelName: "api-work",
          repositoryId: API_REPOSITORY,
        }],
      });
      await openSettings(page);
      await expect(rules(page).getByRole("button", { name: "Add rule" }))
        .toBeDisabled();
      await expect(
        rule(page).first().getByRole("button", { name: "Remove rule 1" }),
      )
        .toBeDisabled();
    });

    test("the preview reads the saved settings only, and counts from its own answer", async ({ page }) => {
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
      // An older server's answer carries no such count, so no sentence is made up.
      await expect(page.getByTestId("issue-settings-before-window"))
        .toHaveCount(0);
      // The counts are the preview's answer: no read of the issues behind it.
      expect(seen.lists).toHaveLength(0);
      await shot(page, "issue-settings-preview", [], { windowOnly: true });
    });

    test("issues that had the label before automatic starts say they wait for Start work", async ({ page }) => {
      await settingsFixture(page, {
        labeledBeforeWindow: 2,
        saved: {
          policy: policy({
            // The server counts these issues only when automatic starts are on.
            automatic: { enabled: true, since: "2026-11-16T12:00:00.000Z" },
            delegation: { principalId: uuid(910), externalActorIds: ["4242"] },
          }),
        },
      });
      await openSettings(page);
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByTestId("issue-settings-before-window"))
        .toHaveText(
          "2 issues already had the “bakery” label before automatic starts were turned on. They wait for someone to press Start work.",
        );
      // Framed on the preview, so the phone still shows the sentence too.
      await still(page, "issue-settings-preview-before-window", undefined, {
        scrollTo: page.getByTestId("issue-settings-preview"),
      });
    });

    test("one issue that had the label before automatic starts is said in the singular", async ({ page }) => {
      await settingsFixture(page, {
        labeledBeforeWindow: 1,
        saved: {
          policy: policy({
            // The server counts these issues only when automatic starts are on.
            automatic: { enabled: true, since: "2026-11-16T12:00:00.000Z" },
            delegation: { principalId: uuid(910), externalActorIds: ["4242"] },
          }),
        },
      });
      await openSettings(page);
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.getByTestId("issue-settings-before-window"))
        .toHaveText(
          "1 issue already had the “bakery” label before automatic starts were turned on. It waits for someone to press Start work.",
        );
    });

    test("saving labels keeps the built-in workflow the repository was set to", async ({ page }) => {
      const seen = await settingsFixture(page, {
        saved: {
          policy: policy({
            workflow: {
              workflowId: uuid(951),
              builtIn: "fixed-coding-reviewed",
            },
          }),
        },
      });
      await openSettings(page);
      await page.getByLabel("Start work").fill("ready");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();
      const sent = seen.patches[0].policy as Record<string, unknown>;
      expect(sent.workflow).toEqual({ builtIn: "fixed-coding-reviewed" });
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
