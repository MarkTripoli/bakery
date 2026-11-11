import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const realApi = process.env.BAKERY_REAL_API === "1";
const realEmail = process.env.BAKERY_REAL_EMAIL ?? "";
const realPassword = process.env.BAKERY_REAL_PASSWORD ?? "";
const captureDirectory = fileURLToPath(
  new URL(
    "../../../artifacts/ui-baseline/repository-profile-ui/",
    import.meta.url,
  ),
);

async function expectOk(response: import("@playwright/test").APIResponse) {
  expect(
    response.ok(),
    `${response.url()} failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return await response.json() as Record<string, unknown>;
}

test(
  "real mounted API repository profile task scope",
  async ({ browser }, testInfo) => {
    test.skip(
      !realApi,
      "set BAKERY_REAL_API=1 against the owned mounted stack",
    );
    test.skip(
      testInfo.project.name !== "desktop-shared-admin",
      "the `desktop-shared-admin` worker owns the real database fixture and records phone proof in-process",
    );
    test.skip(
      !realEmail || !realPassword,
      "real API credentials were not supplied",
    );
    test.setTimeout(120_000);
    mkdirSync(captureDirectory, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: {
        dir: captureDirectory,
        size: { width: 1440, height: 1000 },
      },
    });
    const page = await context.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(realEmail);
    await page.getByLabel("Password", { exact: true }).fill(realPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/");

    const organizations = await expectOk(
      await page.request.get("/v1/organizations"),
    );
    const realOrganizationId = (organizations.items as { id: string }[])[0].id;
    const headers = {
      "Bakery-Organization-Id": realOrganizationId,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: new URL(page.url()).origin,
    };
    const suffix = crypto.randomUUID().slice(0, 8);
    const realApplication = await expectOk(
      await page.request.post("/v1/applications", {
        headers,
        data: {
          slug: `issue128-${suffix}`,
          name: `Issue 128 ${suffix}`,
          description: "Mounted API repository profile proof",
        },
      }),
    );
    const realApplicationId = realApplication.id as string;
    const realRepository = await expectOk(
      await page.request.post("/v1/repositories", {
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        data: {
          applicationId: realApplicationId,
          slug: `bakery-${suffix}`,
          integrationConnectionId: crypto.randomUUID(),
          providerRepoId: "MarkTripoli/bakery",
          owner: "MarkTripoli",
          name: "bakery",
          defaultBranch: "main",
        },
      }),
    );
    const realRepositoryId = realRepository.id as string;
    const profileConfig = {
      branches: { allowedPatterns: ["delivery/*", "fix/*"], base: "main" },
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      worktree: { root: ".agents/worktrees/bakery" },
    };
    const profileDigest = createHash("sha256")
      .update(JSON.stringify(profileConfig)).digest("hex");
    const realProfile = await expectOk(
      await page.request.post(`/v1/repositories/${realRepositoryId}/profiles`, {
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        data: { revision: 1, config: profileConfig, digest: profileDigest },
      }),
    );
    const realProfileId = realProfile.id as string;
    const repositoryAfterProfile = await expectOk(
      await page.request.get(`/v1/repositories/${realRepositoryId}`, {
        headers: { "Bakery-Organization-Id": realOrganizationId },
      }),
    );
    await expectOk(
      await page.request.patch(`/v1/repositories/${realRepositoryId}`, {
        headers: {
          ...headers,
          "Idempotency-Key": crypto.randomUUID(),
          "If-Match": `"${repositoryAfterProfile.version}"`,
        },
        data: { activeProfileId: realProfileId },
      }),
    );

    const realDeepLink =
      `/projects/onboarding?application=${realApplicationId}&repository=${realRepositoryId}&profile=${realProfileId}`;
    await page.goto(realDeepLink);
    const boundary = page.getByTestId("projects-onboarding-profile-boundary");
    await expect(boundary).toContainText("MarkTripoli/bakery");
    const scope = page.getByTestId("projects-onboarding-task-scope");
    await scope.getByLabel("Task title").fill("Mounted profile task");
    await scope.getByLabel("Task description").fill("Real PostgreSQL draft");
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope).toContainText(
      "Draft task created with authoritative profile pins",
    );
    await page.screenshot({
      path: `${captureDirectory}/desktop-success.png`,
      fullPage: true,
    });
    const taskId = await scope.locator("dd").first().textContent();
    expect(taskId).toBeTruthy();
    const runs = await expectOk(
      await page.request.get(`/v1/tasks/${taskId}/runs`, {
        headers: { "Bakery-Organization-Id": realOrganizationId },
      }),
    );
    expect(runs.items).toEqual([]);

    const secondProfile = await expectOk(
      await page.request.post(`/v1/repositories/${realRepositoryId}/profiles`, {
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        data: { revision: 2, config: profileConfig, digest: profileDigest },
      }),
    );
    const repositoryBeforeSwitch = await expectOk(
      await page.request.get(`/v1/repositories/${realRepositoryId}`, {
        headers: { "Bakery-Organization-Id": realOrganizationId },
      }),
    );
    await expectOk(
      await page.request.patch(`/v1/repositories/${realRepositoryId}`, {
        headers: {
          ...headers,
          "Idempotency-Key": crypto.randomUUID(),
          "If-Match": `"${repositoryBeforeSwitch.version}"`,
        },
        data: { activeProfileId: secondProfile.id },
      }),
    );
    // A created draft locks the composer until the user starts another task
    // (the mocked spec asserts this), so re-enter the same draft first.
    await scope.getByRole("button", { name: "Start another task" }).click();
    await scope.getByLabel("Task title").fill("Mounted profile task");
    await scope.getByRole("button", { name: "Create draft task" }).click();
    await expect(scope).toContainText("The active repository profile changed");
    await expect(scope.getByLabel("Task title")).toHaveValue(
      "Mounted profile task",
    );
    await expect(scope.getByRole("button", { name: "Create draft task" }))
      .toBeDisabled();
    const tasksAfterConflict = await expectOk(
      await page.request.get("/v1/tasks", {
        headers: { "Bakery-Organization-Id": realOrganizationId },
      }),
    );
    expect(
      (tasksAfterConflict.items as unknown[]).filter((item) =>
        (item as { repositoryId?: string }).repositoryId === realRepositoryId
      ),
    ).toHaveLength(1);
    await page.screenshot({
      path: `${captureDirectory}/desktop-stale-conflict.png`,
      fullPage: true,
    });

    const storageState = await context.storageState();
    const desktopVideo = page.video();
    await context.close();
    await desktopVideo?.saveAs(`${captureDirectory}/desktop-session.webm`);

    const phoneContext = await browser.newContext({
      storageState,
      viewport: { width: 390, height: 844 },
      recordVideo: {
        dir: captureDirectory,
        size: { width: 390, height: 844 },
      },
    });
    const phone = await phoneContext.newPage();
    const secondProfileId = secondProfile.id as string;
    await phone.goto(
      `/projects/onboarding?application=${realApplicationId}&repository=${realRepositoryId}&profile=${secondProfileId}`,
    );
    await expect(phone.getByTestId("projects-onboarding-profile-boundary"))
      .toContainText("delivery/*");
    await phone.screenshot({
      path: `${captureDirectory}/phone-boundary.png`,
      fullPage: true,
    });
    const phoneVideo = phone.video();
    await phoneContext.close();
    await phoneVideo?.saveAs(`${captureDirectory}/phone-session.webm`);
  },
);
