import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

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
  options: { forbidden?: boolean } = {},
) {
  await mockAuthenticatedSession(page);
  const seen: string[] = [];
  await page.route("**/v1/installation/audit-events**", (route) => {
    const url = new URL(route.request().url());
    seen.push(url.search);
    if (options.forbidden) return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    const cursor = url.searchParams.get("cursor");
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

async function organizationAuditFixture(page: Page) {
  await mockAuthenticatedSession(page);
  const state = { retentionDays: null as number | null, exportQuery: "" };
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
  await page.route("**/v1/audit-events?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }));
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
