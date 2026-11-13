import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { shot } from "./helpers/real-api.ts";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

// #70: the Machines list shows each machine as one badge, one line and one
// button, whatever the server reports along its other dimensions.

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

let sequence = 0;
function machine(name: string, over: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-0000000001${
      String(sequence).padStart(2, "0")
    }`,
    principalId: "00000000-0000-4000-8000-0000000000b0",
    name,
    os: "linux",
    architecture: "x86_64",
    capabilities: ["claude", "codex", "git", "model"],
    toolchainVersions: {},
    slots: 2,
    status: "online",
    desiredMode: "accepting",
    connectivity: "online",
    readiness: "ready",
    readinessReason: null,
    failedCheckIds: [],
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    credentialGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...over,
  };
}

const FLEET = [
  machine("build-linux-01"),
  machine("build-mac-01", {
    os: "macos",
    capabilities: ["claude", "pi"],
    slots: 1,
  }),
  machine("ci-linux-02", {
    readiness: "needs_attention",
    readinessReason: "check_failed",
    failedCheckIds: ["disk_threshold", "capability:model"],
  }),
  machine("ci-linux-03", { connectivity: "stale" }),
  machine("ci-linux-04", { connectivity: "offline" }),
  machine("spare-linux-05", { desiredMode: "paused", status: "offline" }),
  machine("spare-linux-06", { desiredMode: "draining", status: "draining" }),
  machine("new-linux-07", { readiness: "checking" }),
  machine("old-mac-08", {
    os: "macos",
    desiredMode: "revoked",
    status: "revoked",
    connectivity: "offline",
    readiness: "needs_attention",
    readinessReason: "revoked",
  }),
];

async function open(
  page: Page,
  options: {
    role?: "admin" | "member";
    workers?: unknown;
    workersStatus?: number;
    hang?: boolean;
  } = {},
) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) =>
      options.hang ? undefined : route.fulfill(
        options.workersStatus && options.workersStatus >= 400
          ? {
            status: options.workersStatus,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/x",
              title: "x",
              status: options.workersStatus,
              code: options.workersStatus === 403 ? "FORBIDDEN" : "INTERNAL",
            }),
          }
          : json({ items: options.workers ?? FLEET, nextCursor: null }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.goto("/machines");
}

const rowOf = (page: Page, name: string) =>
  page.getByRole("row").filter({ hasText: name }).or(
    page.locator("[data-machine-id]").filter({ hasText: name }),
  ).first();

test.describe("machines list states", () => {
  test("every state is one badge, one line and one button", async ({ page }) => {
    await open(page);
    const expectations: [string, string, string, string][] = [
      [
        "build-linux-01",
        "Ready",
        "Linux · Claude Code, Codex · 2 slots",
        "Open",
      ],
      ["build-mac-01", "Ready", "macOS · Claude Code, Pi · 1 slot", "Open"],
      ["ci-linux-02", "Needs attention", "2 checks failed.", "Fix"],
      ["ci-linux-03", "Not responding", "Not responding.", "Open"],
      ["ci-linux-04", "Offline", "Offline. Bakery cannot reach it.", "Open"],
      ["spare-linux-05", "Paused", "Paused.", "Fix"],
      ["spare-linux-06", "Finishing up", "Finishing up.", "Fix"],
      [
        "new-linux-07",
        "Checking",
        "Linux · Claude Code, Codex · 2 slots",
        "Open",
      ],
      ["old-mac-08", "Retired", "Retired.", "Open"],
    ];
    for (const [name, badge, line, action] of expectations) {
      const row = rowOf(page, name);
      await expect(row, name).toContainText(badge);
      await expect(row, name).toContainText(line);
      await expect(row.getByRole("link"), name).toHaveCount(1);
      await expect(
        row.getByRole("link", { name: `${action} ${name}` }),
        name,
      ).toBeVisible();
      // One badge on the row, not three.
      await expect(row.locator("[data-ui-component=badge]"), name).toHaveCount(
        1,
      );
    }
    // A fleet of nine machines is a list: no filter yet.
    await expect(page.getByRole("group", { name: "Show machines" }))
      .toHaveCount(0);
    // Nothing of the old table's columns or words in the list itself.
    const list = page.getByRole("table", { name: "Machines" }).or(
      page.getByRole("list", { name: "Machines" }),
    );
    for (
      const word of [
        "Connectivity",
        "Readiness",
        "Last heartbeat",
        "Capabilities",
      ]
    ) {
      await expect(list).not.toContainText(word);
    }
    await shot(page, "machines-list");
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("more than ten machines offer a filter that keeps what it names", async ({ page }) => {
    await open(page, {
      workers: [
        ...FLEET,
        machine("extra-linux-09"),
        machine("extra-linux-10", { connectivity: "offline" }),
      ],
    });
    const filter = page.getByRole("group", { name: "Show machines" });
    await expect(filter).toBeVisible();
    await filter.getByRole("radio", { name: "Offline" }).click();
    await expect(page.getByTestId("machines-page")).not.toContainText(
      "build-linux-01",
    );
    await expect(page.getByTestId("machines-page")).toContainText(
      "ci-linux-04",
    );
    await expect(page.getByTestId("machines-page")).toContainText(
      "extra-linux-10",
    );
    await filter.getByRole("radio", { name: "Needs attention" }).click();
    await expect(page.getByTestId("machines-page")).toContainText(
      "ci-linux-02",
    );
    await expect(page.getByTestId("machines-page")).toContainText(
      "ci-linux-03",
    );
    await expect(page.getByTestId("machines-page")).not.toContainText(
      "ci-linux-04",
    );
    await shot(page, "machines-list-filter");
  });

  test("an administrator with no machines is invited to add one; anyone else is told whom to ask", async ({ page }) => {
    await open(page, { workers: [] });
    await expect(page.getByText("No machines yet")).toBeVisible();
    await expect(
      page.getByText(
        "Agents run on your own computers. Add one to start work.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toBeVisible();
    await shot(page, "machines-list-empty");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { workers: [], role: "member" });
    await expect(
      page.getByText("Ask an organization administrator to add one."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toHaveCount(0);
    await shot(page, "machines-list-empty-member");
  });

  test("a refused read, a failed read and a slow read each say so", async ({ page }) => {
    await open(page, { workersStatus: 403 });
    await expect(page.getByText("Machines access is restricted")).toBeVisible();
    await shot(page, "machines-list-forbidden");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { workersStatus: 500 });
    await expect(page.getByText("Machines could not be loaded")).toBeVisible();
    await shot(page, "machines-list-error");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { hang: true });
    await expect(page.getByTestId("machines-page")).toBeVisible();
    await shot(page, "machines-list-loading");
  });
});
