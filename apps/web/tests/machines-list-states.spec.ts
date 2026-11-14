import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  type RowActionGeometry,
  rowActionGeometry,
} from "./helpers/row-action-overlap.ts";
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
    role?: "admin" | "developer";
    workers?: unknown;
    workersStatus?: number;
    hang?: boolean;
    enrollments?: unknown[];
    /** Answers the workers list itself (for paging): used instead of the fixed list. */
    workersRoute?: (route: Route) => Promise<void> | void;
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
      options.workersRoute
        ? options.workersRoute(route)
        : options.hang
        ? undefined
        : route.fulfill(
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
    (route) =>
      route.fulfill(
        json({ items: options.enrollments ?? [], nextCursor: null }),
      ),
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
      [
        "ci-linux-03",
        "Not responding",
        "Not responding. It has stopped answering Bakery.",
        "Open",
      ],
      ["ci-linux-04", "Offline", "Offline. Bakery cannot reach it.", "Open"],
      [
        "spare-linux-05",
        "Paused",
        "Paused. It takes no new work until someone resumes it.",
        "Open",
      ],
      [
        "spare-linux-06",
        "Finishing up",
        "Finishing its current work. It takes no new work.",
        "Open",
      ],
      [
        "new-linux-07",
        "Checking",
        "Linux · Claude Code, Codex · 2 slots",
        "Open",
      ],
      ["old-mac-08", "Retired", "Retired. It no longer takes work.", "Open"],
    ];
    const geometries: RowActionGeometry[] = [];
    for (const [name, badge, line, action] of expectations) {
      const row = rowOf(page, name);
      await expect(row, name).toContainText(badge);
      await expect(row, name).toContainText(line);
      // One control per row: a link on a wide screen, a button on a phone.
      const control = row.getByRole("link").or(row.getByRole("button"));
      await expect(control, name).toHaveCount(1);
      await expect(
        row.getByRole("link", { name: `${action} ${name}` }).or(
          row.getByRole("button", { name: `${action} ${name}` }),
        ),
        name,
      ).toBeVisible();
      // One badge on the row, not three.
      await expect(row.locator("[data-ui-component=badge]"), name).toHaveCount(
        1,
      );
      // The control sits beside or under the row's text, never on it.
      const geometry = await rowActionGeometry(row);
      expect(
        geometry.overlaps,
        `${name}: the ${geometry.label} control covers text`,
      )
        .toEqual([]);
      geometries.push(geometry);
    }
    // Fix and Open are the same size: one fixed width across the list.
    expect(
      new Set(
        geometries.map((geometry) => `${geometry.width}x${geometry.height}`),
      ).size,
      `control sizes: ${
        geometries.map((g) => `${g.label} ${g.width}x${g.height}`).join(", ")
      }`,
    ).toBe(1);
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
    // The invitation carries the action itself, in the card.
    await expect(
      page.locator("[data-ui-component=emptyState]").getByRole("button", {
        name: "Add machine",
        exact: true,
      }),
    ).toBeVisible();
    await shot(page, "machines-list-empty");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { workers: [], role: "developer" });
    await expect(
      page.getByText("Ask an organization administrator to add one."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toHaveCount(0);
    await expect(page.getByText("Enrollment controls are available"))
      .toHaveCount(0);
    await shot(page, "machines-list-empty-member");
  });

  test("a refused read, a failed read and a slow read each say so", async ({ page }) => {
    await open(page, { workersStatus: 403 });
    await expect(page.getByText("You cannot see machines")).toBeVisible();
    await expect(
      page.getByText("Only organization members can see machines."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toHaveCount(0);
    await shot(page, "machines-list-forbidden");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { workersStatus: 500 });
    await expect(page.getByText("Machines could not be loaded")).toBeVisible();
    // A failed read is not a refused one: Add machine stays, at both widths
    // (top bar on a wide screen, under the title on a phone), once.
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toHaveCount(1);
    await expect(page.getByRole("button", { name: "Add machine", exact: true }))
      .toBeVisible();
    await shot(page, "machines-list-error");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, { hang: true });
    await expect(page.getByTestId("machines-page")).toBeVisible();
    // Placeholder rows, and no table headings until there is data.
    await expect(page.locator("[data-ui-component=skeleton]")).toHaveCount(3);
    await expect(page.getByRole("table", { name: "Machines" })).toHaveCount(0);
    await shot(page, "machines-list-loading");
  });

  test("setups that are not finished are listed first, and only those", async ({ page }) => {
    const row = (
      id: string,
      name: string,
      state: string,
      expiresAt: string,
    ) => ({
      enrollmentId: id,
      state,
      name,
      os: "linux",
      architecture: "x86_64",
      capabilities: ["git", "shell", "web", "model", "claude"],
      slots: 1,
      expiresAt,
      consumedAt: null,
      canceledAt: null,
      workerHostId: null,
      replacementOfId: null,
      targetWorkerHostId: null,
      version: 1,
    });
    const later = new Date(Date.now() + 20 * 60_000).toISOString();
    const earlier = "2026-01-01T00:00:00.000Z";
    await open(page, {
      enrollments: [
        row(
          "00000000-0000-4000-8000-0000000000f1",
          "waiting-box",
          "pending",
          later,
        ),
        row(
          "00000000-0000-4000-8000-0000000000f2",
          "late-box",
          "expired",
          earlier,
        ),
        row(
          "00000000-0000-4000-8000-0000000000f3",
          "done-box",
          "consumed",
          earlier,
        ),
        row(
          "00000000-0000-4000-8000-0000000000f4",
          "dropped-box",
          "canceled",
          earlier,
        ),
      ],
    });
    const group = page.getByTestId("machines-finishing-setup");
    await expect(group.getByRole("heading", { name: "Finishing setup" }))
      .toBeVisible();
    await expect(group.locator("[data-enrollment-id]")).toHaveCount(2);
    await expect(group).toContainText("waiting-box");
    await expect(group).toContainText("late-box");
    await expect(group).not.toContainText("done-box");
    await expect(group).not.toContainText("dropped-box");
    // The machines below the group have their own heading, at the same level.
    await expect(
      page.getByRole("heading", { name: "Machines", level: 2 }),
    ).toBeVisible();
    // The machines come after the group.
    const groupBox = await group.boundingBox();
    const machinesBox = await rowOf(page, "build-linux-01").boundingBox();
    expect(groupBox!.y).toBeLessThan(machinesBox!.y);
    await shot(page, "machines-list-finishing");
    await group.getByRole("button", { name: "Get new settings for late-box" })
      .click();
    await expect(page).toHaveURL(
      /\/machines\/new\?finish=00000000-0000-4000-8000-0000000000f2$/,
    );
  });

  test("the list with setups to finish, more machines to load and a failed load together", async ({ page }) => {
    const later = new Date(Date.now() + 20 * 60_000).toISOString();
    // One machine a page: the list reads ten pages itself, then offers Load more;
    // the eleventh answer fails once.
    let failures = 1;
    await open(page, {
      workersRoute: (route) => {
        const cursor = new URL(route.request().url()).searchParams.get(
          "cursor",
        );
        const index = cursor ? Number(cursor.slice(1)) : 1;
        if (index === 11 && failures > 0) {
          failures -= 1;
          return route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/x",
              title: "x",
              status: 500,
              code: "INTERNAL_ERROR",
              retryable: true,
              detail: "Try again.",
              requestId: "00000000-0000-4000-8000-00000000f002",
              traceId: "00000000000000000000000000000002",
            }),
          });
        }
        return route.fulfill(json({
          items: [FLEET[(index - 1) % FLEET.length]!],
          nextCursor: index < 12 ? `c${index + 1}` : null,
        }));
      },
      enrollments: [{
        enrollmentId: "00000000-0000-4000-8000-0000000000f9",
        state: "pending",
        name: "waiting-box",
        os: "linux",
        architecture: "x86_64",
        capabilities: ["git", "shell", "web", "model", "claude"],
        slots: 1,
        expiresAt: later,
        consumedAt: null,
        canceledAt: null,
        workerHostId: null,
        replacementOfId: null,
        targetWorkerHostId: null,
        version: 1,
      }],
    });
    const group = page.getByTestId("machines-finishing-setup");
    await expect(group).toContainText("waiting-box");
    await expect(page.getByRole("heading", { name: "Machines", level: 2 }))
      .toBeVisible();
    // The failed load keeps what is there and offers Retry where Load more was.
    const more = page.getByRole("button", { name: /Load more|Retry/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(group).toContainText("waiting-box");
    // Retry is at the bottom of the list, so the click scrolled the page. The
    // shell's rail is sticky: a full-page capture taken scrolled keeps that
    // offset, which shows the off-screen skip link and a rail that starts low.
    // Back at the top, the capture is what a person sees on arrival.
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    await shot(page, "machines-list-finishing-paged");
  });
});
