import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { submitUntilAccepted } from "./helpers/api-retry.ts";

const fixtureSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization owning seeded artifact and browser principal",
  ),
  taskId: z.string().uuid().describe(
    "Task containing deterministic read-only fixture artifact",
  ),
  artifactId: z.string().uuid().describe(
    "Immutable artifact descriptor to open through task route",
  ),
  versionId: z.string().uuid().describe(
    "Stored artifact version used by scoped byte reads",
  ),
  digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 of exact seeded download bytes",
  ),
  text: z.string().describe(
    "UTF-8 fixture text expected from bounded extraction",
  ),
}).describe(
  "Owned PostgreSQL artifact fixture for required browser read boundary",
);

test("downloads immutable scoped bytes and denies revoked session reads", async ({ page, baseURL }) => {
  test.skip(
    process.env.BAKERY_BROWSER_MODE !== "core" &&
      process.env.BAKERY_REAL_API !== "1",
    "live fixture needs real API; required core fails without it",
  );
  expect(process.env.BAKERY_REAL_API, "core needs running real API").toBe("1");
  expect(process.env.BAKERY_ENV, "core seed needs isolated test environment")
    .toBe("test");
  const email = process.env.BAKERY_REAL_EMAIL ?? "browser-admin@example.test";
  const password = process.env.BAKERY_REAL_PASSWORD ??
    "Browser-Admin-Passw0rd-1";
  const helper = (name: string) =>
    fileURLToPath(
      new URL(`../../../tests/helpers/${name}.ts`, import.meta.url),
    );
  execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper("web-auth-seed"),
    email,
  ], {
    env: { ...process.env, WEB_AUTH_SEED_PASSWORD: password },
    stdio: "pipe",
  });
  const output = execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper("web-browser-artifact-seed"),
    email,
  ], { encoding: "utf8" });
  const fixture = fixtureSchema.parse(
    JSON.parse(output.trim().split("\n").at(-1) ?? "null"),
  );
  const path = `/tasks/${fixture.taskId}/artifacts/${fixture.artifactId}`;
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  await submitUntilAccepted(page, "/sign-in", async () => {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  });
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
  const detailsToggle = page.getByTestId("artifact-retrieval-details-toggle");
  await detailsToggle.click();
  await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("artifact-retrieval-details")).toBeVisible();
  await page.getByLabel(/Start byte/).fill("0");
  await page.getByTestId("artifact-retrieval-extract").click();
  await expect(page.getByTestId("artifact-retrieval-extraction-text"))
    .toHaveText(fixture.text);
  const button = page.getByTestId("artifact-retrieval-download");
  await button.focus();
  const [response, download] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(
        `/v1/artifact-versions/${fixture.versionId}/content`,
      )
    ),
    page.waitForEvent("download"),
    button.press("Enter"),
  ]);
  expect(response.status()).toBe(200);
  expect(response.headers().etag).toBe(`"${fixture.digest}"`);
  expect(await download.failure()).toBeNull();
  expect(
    createHash("sha256").update(await readFile(await download.path())).digest(
      "hex",
    ),
  ).toBe(fixture.digest);
  await expect(button).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const sessions = await page.request.get("/v1/me/sessions");
  expect(sessions.ok()).toBe(true);
  const body: unknown = await sessions.json();
  const sessionSchema = z.object({
    items: z.array(
      z.object({
        id: z.string().describe(
          "Session identifier accepted by revocation route",
        ),
        current: z.boolean().describe(
          "Whether session belongs to this browser",
        ),
      }).describe("Listed live session"),
    ).describe("Active sessions for signed-in principal"),
  }).describe(
    "Session-list wire response used to revoke core browser authority",
  );
  const current = sessionSchema.parse(body).items.find((item) => item.current);
  expect(current).toBeDefined();
  if (!current) throw new Error("CORE_CURRENT_SESSION_REQUIRED");
  await page.goto(`/settings/sessions/revoke?session=${current.id}`);
  await page.getByTestId("revoke-sessions-confirm").click();
  await expect(page).toHaveURL("/sign-in");
  await expect(page.getByTestId("artifact-retrieval-extraction-text"))
    .toHaveCount(0);
  const denied = await page.request.get(
    `/v1/artifact-versions/${fixture.versionId}/content`,
    {
      headers: {
        "Bakery-Organization-Id": fixture.organizationId,
        origin: baseURL ?? "",
      },
    },
  );
  expect(denied.status()).toBe(401);
});
