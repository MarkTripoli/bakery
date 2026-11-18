import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { shot } from "./helpers/real-api.ts";

type Row = {
  id: string;
  organizationId: string | null;
  principalId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  outcome: "succeeded";
  requestId: string;
  traceId: string;
  details: Record<string, never>;
  createdAt: string;
};

function row(index: number, operation: string): Row {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organizationId: null,
    principalId: "11111111-1111-4111-8111-111111111111",
    operation,
    resourceType: "installation_settings",
    resourceId: `resource-${index}`,
    outcome: "succeeded",
    requestId: `request-${index}`,
    traceId: `trace-${index}`,
    details: {},
    createdAt: `2026-10-13T0${index}:00:00.000Z`,
  };
}

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code}`,
    title: code,
    detail: code,
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

async function installationAuditFixture(
  page: Page,
  options: { forbidden?: boolean; failOlderOnce?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
  const seen: string[] = [];
  let olderFailures = options.failOlderOnce ? 1 : 0;
  await page.route("**/v1/installation/audit-events**", (route) => {
    const url = new URL(route.request().url());
    seen.push(url.search);
    if (options.forbidden) return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    const cursor = url.searchParams.get("cursor");
    if (cursor && olderFailures > 0) {
      olderFailures -= 1;
      return route.fulfill(problem(500, "INTERNAL_ERROR"));
    }
    const operation = url.searchParams.get("operation");
    const items = cursor
      ? [row(1, "installationAdministrators.create")]
      : operation
      ? [row(3, operation)]
      : [row(3, "installationSettings.update"), row(2, "auth.password.change")];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        nextCursor: cursor || operation ? null : "next-page",
      }),
    });
  });
  return seen;
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("installation audit log lists events newest first and loads older pages", async ({ page }) => {
      const seen = await installationAuditFixture(page);
      await page.goto("/installation/audit");
      await expect(page.getByRole("heading", { name: "Audit log" }).first())
        .toBeVisible();
      await expect(
        page.getByRole("cell", { name: "Installation settings updated" }),
      )
        .toBeVisible();
      await expect(page.getByRole("cell", { name: "Password changed" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Load older events" }).click();
      await expect(
        page.getByRole("cell", { name: "Installation administrator added" }),
      )
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Load older events" }))
        .toHaveCount(0);
      expect(seen.some((search) => search.includes("cursor=next-page")))
        .toBe(true);
      // The button that was pressed is gone: focus is on the first row that load added.
      await expect(
        page.getByRole("row").filter({
          hasText: "Installation administrator added",
        }),
      ).toBeFocused();
    });

    test("a failed load of older events leaves focus on the button that retries it, then on the first new row", async ({ page }) => {
      await installationAuditFixture(page, { failOlderOnce: true });
      await page.goto("/installation/audit");
      const more = page.getByRole("button", { name: "Load older events" });
      await more.click();
      // The banner and the table both say so.
      await expect(
        page.getByText("The audit log could not be loaded", { exact: false })
          .first(),
      ).toBeVisible();
      await expect(more).toBeFocused();
      await more.click();
      await expect(
        page.getByRole("row").filter({
          hasText: "Installation administrator added",
        }),
      ).toBeFocused();
    });

    test("action filter narrows the list through the server query", async ({ page }) => {
      const seen = await installationAuditFixture(page);
      await page.goto("/installation/audit");
      await page.getByLabel("Action").selectOption("auth.password.change");
      await expect(page.getByRole("cell", { name: "Password changed" }))
        .toBeVisible();
      await expect(
        page.getByRole("cell", { name: "Installation settings updated" }),
      )
        .toHaveCount(0);
      expect(
        seen.some((search) =>
          search.includes("operation=auth.password.change")
        ),
      ).toBe(true);
    });

    test("a refusal clears the table and shows the forbidden notice", async ({ page }) => {
      await installationAuditFixture(page, { forbidden: true });
      await page.goto("/installation/audit");
      await expect(
        page.getByText("Only administrators can read the audit log."),
      ).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
    });
  });
}

const ADA_ID = "00000000-0000-4000-8000-0000000000a1";
const BOT_ID = "00000000-0000-4000-8000-0000000000a2";

type OrgRow = Row & { outcomeOverride?: string };

function orgRow(
  index: number,
  overrides: Partial<Row> = {},
): Row {
  return {
    ...row(index, "organizationMemberships.update"),
    organizationId: MOCK_ORGANIZATION_ID,
    principalId: ADA_ID,
    resourceType: "organization_membership",
    resourceId: BOT_ID,
    ...overrides,
  };
}

async function organizationAuditFixture(
  page: Page,
  options: { items?: Row[]; failReads?: boolean; retentionDays?: number } = {},
) {
  await mockAuthenticatedSession(page);
  const state = {
    retentionDays: (options.retentionDays ?? null) as number | null,
    exportQuery: "",
    reads: 0,
    failing: options.failReads === true,
  };
  await page.route("**/v1/audit-events/export**", (route) => {
    state.exportQuery = new URL(route.request().url()).search;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        filename: "audit-events.jsonl",
        contentType: "application/x-ndjson",
        lineCount: 0,
        truncated: false,
        content: "",
      }),
    });
  });
  await page.route("**/v1/audit-events?**", (route) => {
    state.reads += 1;
    if (state.failing) return route.fulfill(problem(500, "INTERNAL_ERROR"));
    const operation = new URL(route.request().url()).searchParams.get(
      "operation",
    );
    const items = (options.items ?? []).filter((item) =>
      !operation || item.operation === operation
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, nextCursor: null }),
    });
  });
  await page.route("**/v1/principals**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          [ADA_ID, "Ada Rivera", "human"],
          [BOT_ID, "Release bot", "service"],
        ].map(([id, displayName, principalType]) => ({
          id,
          principalType,
          createdByPrincipalId: null,
          displayName,
          disabledAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          version: 1,
        })),
        nextCursor: null,
      }),
    }));
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: MOCK_ORGANIZATION_ID,
          name: "Fixture Org",
          slug: "fixture-org",
          logo: null,
          metadata: {},
          defaultLocale: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          version: 1,
        }),
      }),
  );
  await page.route("**/v1/audit-retention", (route) => {
    if (route.request().method() === "PATCH") {
      state.retentionDays =
        (route.request().postDataJSON() as { retentionDays: number | null })
          .retentionDays;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        retentionDays: state.retentionDays,
        version: 1,
        updatedAt: "2026-10-13T00:00:00.000Z",
      }),
    });
  });
  return state;
}

test.describe("organization audit log", () => {
  test("filters sit on one row at their natural width and the caption is not shown", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await organizationAuditFixture(page, { items: [orgRow(3)] });
    await page.goto("/settings/audit");
    const action = page.getByLabel("Action");
    const period = page.getByLabel("Period");
    await expect(action).toBeVisible();
    const [a, p] = [await action.boundingBox(), await period.boundingBox()];
    expect(Math.abs(a!.y - p!.y)).toBeLessThan(4);
    expect(a!.width).toBeLessThan(400);
    expect(p!.width).toBeLessThan(300);
    // The table keeps its name for assistive technology but draws no caption.
    await expect(page.getByRole("table", { name: "Audit events" }))
      .toBeVisible();
    const caption = await page.locator("caption").boundingBox();
    expect(caption === null || caption.width <= 1).toBe(true);
    await expect(
      page.getByText(
        "Changes to members, roles and settings in Fixture Org, newest first.",
      ),
    ).toBeVisible();
    await shot(page, "audit-list");
  });

  test("actors and targets are names or a kind with a short identifier, never a bare id", async ({ page }) => {
    await organizationAuditFixture(page, {
      items: [
        orgRow(3),
        orgRow(2, {
          principalId: null,
          resourceType: "organization_role",
          resourceId: "7c1d4a52-1111-4111-8111-aaaaaaaaaaaa",
        }),
      ],
    });
    await page.goto("/settings/audit");
    const first = page.getByRole("row").filter({ hasText: "Ada Rivera" });
    await expect(first).toContainText("Member · Release bot");
    const second = page.getByRole("row").filter({ hasText: "System" });
    await expect(second).toContainText("Organization role");
    await expect(second).toContainText("7c1d4a52");
    // The full identifier is a hover title, not the cell.
    await expect(second).not.toContainText("7c1d4a52-1111");
  });

  test("a failed event is a red badge and a row opens the full event", async ({ page }) => {
    await organizationAuditFixture(page, {
      items: [
        orgRow(3, { outcome: "failed" as never }),
        orgRow(2),
      ],
    });
    await page.goto("/settings/audit");
    const failed = page.getByRole("row").filter({ hasText: "Failed" });
    await expect(failed.locator('[data-ui-component="badge"]')).toHaveAttribute(
      "data-variant",
      "danger",
    );
    await shot(page, "audit-failed");
    await page.getByRole("row").filter({ hasText: "Failed" }).getByRole(
      "button",
    ).first().click();
    const detail = page.getByTestId("audit-event-detail");
    await expect(detail).toContainText("Ada Rivera");
    await expect(detail).toContainText("Member · Release bot");
    await expect(detail).toContainText("Failed");
    await expect(detail).toContainText("request-3");
    await shot(page, "audit-event-sheet", [], { windowOnly: true });
  });

  test("an empty result offers Clear filters; nothing recorded says why", async ({ page }) => {
    await organizationAuditFixture(page, { items: [orgRow(3)] });
    await page.goto("/settings/audit");
    await expect(page.getByRole("cell", { name: /Ada Rivera/ })).toBeVisible();
    await page.getByLabel("Action").selectOption("scimConnection.rotate");
    await expect(page.getByText("No events match these filters")).toBeVisible();
    await shot(page, "audit-empty-filtered");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("cell", { name: /Ada Rivera/ })).toBeVisible();

    const none = await page.context().newPage();
    await organizationAuditFixture(none, { items: [] });
    await none.goto("/settings/audit");
    await expect(none.getByText("Nothing has been recorded yet")).toBeVisible();
    await expect(
      none.getByText(
        "Changes to settings, members and sign-in appear here as they happen.",
      ),
    ).toBeVisible();
    await expect(none.getByRole("button", { name: "Clear filters" }))
      .toHaveCount(0);
    await shot(none, "audit-empty-none");
  });

  test("a failed load shows a retry that works and returns focus to the heading", async ({ page }) => {
    const state = await organizationAuditFixture(page, {
      items: [orgRow(3)],
      failReads: true,
    });
    await page.goto("/settings/audit");
    await expect(page.getByText("The audit log could not be loaded"))
      .toBeVisible();
    await expect(page.getByText("Check your connection, then try again."))
      .toBeVisible();
    await shot(page, "audit-error");
    state.failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("cell", { name: /Ada Rivera/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Audit log", level: 1 }))
      .toBeFocused();
  });

  test("the retention period is explained beside the Period filter", async ({ page }) => {
    await organizationAuditFixture(page, {
      items: [orgRow(3)],
      retentionDays: 90,
    });
    await page.goto("/settings/audit");
    await page.getByRole("button", { name: "About the period" }).focus();
    await expect(page.getByText("Events are kept for 90 days.")).toBeVisible();
  });
});

test.describe("organization audit export and retention", () => {
  test("export downloads a window and retention saves", async ({ page }) => {
    const state = await organizationAuditFixture(page);
    await page.goto("/settings/audit");
    await page.getByRole("button", { name: "Export" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON Lines" }).click();
    expect((await download).suggestedFilename()).toBe("audit-events.jsonl");
    expect(state.exportQuery).toContain("since=");
    await page.getByLabel("Keep audit events for").selectOption("90");
    await page.getByRole("button", { name: "Save retention" }).click();
    await expect(page.getByText("Retention saved.")).toBeVisible();
    expect(state.retentionDays).toBe(90);
  });
});
