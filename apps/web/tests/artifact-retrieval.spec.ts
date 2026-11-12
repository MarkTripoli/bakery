import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "node:process";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";
import { setArtifactLocale } from "./helpers/artifact-live-preferences.ts";
import { submitUntilAccepted } from "./helpers/api-retry.ts";
import { firstRender } from "./helpers/first-render.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { openAccountMenu } from "./helpers/shell-navigation.ts";

const enabled = env.BAKERY_REAL_API === "1" &&
  !!env.BAKERY_ARTIFACT_EMAIL?.trim();

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing live artifact fixture variable ${name}`);
  return value;
}

/**
 * Live-only acceptance against the real API, a real database and the
 * operator's real bare-Git fixture. Nothing here is stubbed: the principal
 * signs in for real, the protected route resolves a real organization scope,
 * and the saved file's own bytes are hashed and compared to the advertised
 * whole-version digest. The stubbed describe below only adds the denial and
 * reconnect states this real fixture cannot produce on demand; it never
 * replaces this one.
 *
 * Required variables when BAKERY_REAL_API=1 and BAKERY_ARTIFACT_EMAIL is set:
 * BAKERY_ARTIFACT_EMAIL, BAKERY_ARTIFACT_PASSWORD,
 * BAKERY_ARTIFACT_ORGANIZATION_ID, BAKERY_ARTIFACT_TASK_ID,
 * BAKERY_ARTIFACT_ID, BAKERY_ARTIFACT_VERSION_ID, and
 * BAKERY_ARTIFACT_SHA256. The fixture must be a safe text version with a
 * published artifact and an organization membership for this principal.
 */
test.describe("protected artifact retrieval", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with BAKERY_ARTIFACT_EMAIL and an isolated live artifact fixture",
  );

  test(
    "loads scoped provenance, verifies a real download, and extracts bounded UTF-8 text",
    async ({
      page,
    }, testInfo) => {
      const email = required("BAKERY_ARTIFACT_EMAIL");
      const password = required("BAKERY_ARTIFACT_PASSWORD");
      const organizationId = required("BAKERY_ARTIFACT_ORGANIZATION_ID");
      const taskId = required("BAKERY_ARTIFACT_TASK_ID");
      const artifactId = required("BAKERY_ARTIFACT_ID");
      const versionId = required("BAKERY_ARTIFACT_VERSION_ID");
      const sha256 = required("BAKERY_ARTIFACT_SHA256").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new Error(
          "BAKERY_ARTIFACT_SHA256 must be a lowercase SHA-256 value",
        );
      }

      // The Arabic pseudo catalog is selected before the application mounts;
      // regex labels still exercise the real sign-in controls while the target
      // route proves RTL layout, not a source-level locale flag.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "languages", {
          configurable: true,
          get: () => ["ar-XB"],
        });
      });

      const path = `/tasks/${taskId}/artifacts/${artifactId}`;
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);

      // Better Auth caps `/sign-in*` at 3 requests per 10s per IP, and both
      // Playwright projects drive this same file against the same server, so
      // the submit has to outlast a `429` rather than assume a free bucket.
      await submitUntilAccepted(page, "/sign-in", async () => {
        await page.getByLabel(/Email/).fill(email);
        await page.getByLabel(/Password/).fill(password);
        await page.getByRole("button", { name: /Sign in/ }).click();
      });
      await expect(page).not.toHaveURL(/\/sign-in(?:\?|$)/);

      await setArtifactLocale(
        page,
        organizationId,
        new URL(page.url()).origin,
        "ar-XB",
      );

      // A full document load drops the in-memory query scope, so this is also
      // the proof that the route rehydrates the organization itself instead of
      // dead-ending on an organization-required notice.
      await page.goto(path);
      await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const detailsToggle = page.getByTestId(
        "artifact-retrieval-details-toggle",
      );
      await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
      await detailsToggle.click();
      await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("artifact-retrieval-details"))
        .toBeVisible();
      await expect(
        page.getByText(new RegExp(organizationId.replaceAll("-", "[-]"))),
      ).toBeVisible();
      await expect(page.getByTestId("artifact-retrieval-provenance"))
        .toContainText(
          sha256,
        );

      const extractionStart = page.getByLabel(/Start byte/);
      await extractionStart.fill("0");
      const extract = page.getByTestId("artifact-retrieval-extract");
      await extract.focus();
      await extract.press("Enter");
      const extractionResult = page.getByTestId(
        "artifact-retrieval-extraction-result",
      );
      await expect(extractionResult).toBeVisible();
      await expect(extractionResult).toContainText(/Showing bytes/);
      const extractedText = page.getByTestId(
        "artifact-retrieval-extraction-text",
      );
      if (await extractedText.count() === 1) {
        const extractedBytes = await extractedText.evaluate((node) =>
          new TextEncoder().encode(node.textContent ?? "").byteLength
        );
        expect(extractedBytes).toBeLessThanOrEqual(65_536);
      } else {
        await expect(extractionResult).toContainText(
          /bounded window is empty/i,
        );
      }

      const downloadButton = page.getByTestId("artifact-retrieval-download");
      await downloadButton.focus();
      const [contentResponse, download] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/v1/artifact-versions/${versionId}/content`)
        ),
        page.waitForEvent("download"),
        downloadButton.press("Enter"),
      ]);
      expect(contentResponse.status()).toBe(200);
      expect(contentResponse.headers().etag).toBe(`"${sha256}"`);
      expect(await download.failure()).toBeNull();

      // The acceptance criterion is the saved bytes, not the file name: hash
      // what the browser actually wrote to disk.
      const savedPath = await download.path();
      const savedBytes = await readFile(savedPath);
      expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(
        sha256,
      );
      await expect(page.getByTestId("artifact-retrieval-download-verified"))
        .toContainText(sha256);

      // The control must not disable itself mid-download: a disabled element is
      // blurred, which would strand the keyboard user on <body>.
      await expect(downloadButton).toBeFocused();

      const noHorizontalOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      );
      expect(noHorizontalOverflow).toBe(true);
      if (testInfo.project.name === "mobile") {
        expect(
          await page.evaluate(() =>
            matchMedia("(pointer: coarse)").matches &&
            matchMedia("(max-width: 743px)").matches
          ),
        ).toBe(true);
        const box = await downloadButton.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
    },
  );
});

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000004";
const TASK_ID = "00000000-0000-4000-8000-000000000101";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000102";
const VERSION_ID = "00000000-0000-4000-8000-000000000103";
const AUTHOR_ID = "00000000-0000-4000-8000-000000000104";
const ARTIFACT_PATH = `/tasks/${TASK_ID}/artifacts/${ARTIFACT_ID}`;
const INVITATION_ID = "00000000-0000-4000-8000-000000000107";
const INVITATION_PATH = `/invitations/${INVITATION_ID}`;
const INVITATION_EXPIRES_AT = "2027-01-01T00:00:00.000Z";

const CONTENT = "bounded text\n";
const CONTENT_SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const AUTHENTICATED_IDENTITY = {
  principalId: "00000000-0000-4000-8000-000000000001",
  principalType: "human",
  displayName: "Fixture Admin",
  locale: "en",
  timeZone: null,
  direction: "ltr",
  catalogVersion: "2",
  twoFactorEnabled: false,
  email: "fixture-admin@example.test",
  backupCodesRemaining: null,
};

/** Shared membership fields; only `id`/`name` vary between the two stubs. */
const ORGANIZATION_STUB = {
  slug: "stub-org",
  logo: null,
  defaultLocale: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  role: "admin",
};

const ARTIFACT = {
  id: ARTIFACT_ID,
  taskId: TASK_ID,
  artifactType: "log",
  name: "Bounded retrieval stub",
  currentVersionId: VERSION_ID,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 1,
};

const VERSION = {
  id: VERSION_ID,
  artifactId: ARTIFACT_ID,
  revision: 1,
  runStepId: null,
  authorId: AUTHOR_ID,
  mediaType: "text/plain; charset=utf-8",
  sizeBytes: new TextEncoder().encode(CONTENT).byteLength,
  sha256: CONTENT_SHA256,
  subjectHeadSha: null,
  subjectBaseSha: null,
  metadata: { source: "stub" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};
const OTHER_VERSION_ID = "00000000-0000-4000-8000-000000000105";
const OTHER_AUTHOR_ID = "00000000-0000-4000-8000-000000000106";
const OTHER_CONTENT = "other tenant text\n";
const OTHER_CONTENT_SHA256 = createHash("sha256").update(OTHER_CONTENT).digest(
  "hex",
);
const OTHER_ARTIFACT = {
  ...ARTIFACT,
  name: "Other tenant retrieval stub",
  currentVersionId: OTHER_VERSION_ID,
};
const OTHER_VERSION = {
  ...VERSION,
  id: OTHER_VERSION_ID,
  authorId: OTHER_AUTHOR_ID,
  sizeBytes: new TextEncoder().encode(OTHER_CONTENT).byteLength,
  sha256: OTHER_CONTENT_SHA256,
  metadata: { source: "other-tenant-stub" },
};

/** Problem body in the shape `authProblemCode`/`failureCode` actually parse. */
function problemBody(status: number, code: string) {
  return {
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    status,
    detail: `Stubbed ${code}.`,
    code,
    requestId: "00000000-0000-4000-8000-000000000301",
    traceId: "00000000-0000-4000-8000-000000000302",
    retryable: false,
  };
}

function json(value: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  };
}
function problemResponse(status: number, code: string) {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify(problemBody(status, code)),
  };
}

/**
 * Serves the three artifact reads the route issues. `artifact` may answer with
 * a Problem or abort instead, which is how the denial and transport states are
 * produced; `listNextCursor` drives the count caption's "is this a total?"
 * decision.
 */
async function stubArtifactReads(page: Page, options: {
  readonly artifact?: { readonly status: number; readonly code: string };
  readonly version?: typeof VERSION;
  readonly abortArtifact?: boolean;
  readonly listStatus?: number;
  readonly listNextCursor?: string | null;
  readonly onArtifactRequest?: () => void;
} = {}): Promise<void> {
  await page.route("**/v1/artifacts**", async (route) => {
    options.onArtifactRequest?.();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/versions")) {
      return await route.fulfill(json({
        items: [options.version ?? VERSION],
        nextCursor: null,
      }));
    }
    if (url.pathname.endsWith(`/v1/artifacts/${ARTIFACT_ID}`)) {
      if (options.abortArtifact) return await route.abort("connectionfailed");
      if (options.artifact) {
        return await route.fulfill({
          status: options.artifact.status,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(
            problemBody(options.artifact.status, options.artifact.code),
          ),
        });
      }
      return await route.fulfill(json(ARTIFACT));
    }
    if (options.listStatus !== undefined) {
      return await route.fulfill({
        status: options.listStatus,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify(problemBody(options.listStatus, "INTERNAL_ERROR")),
      });
    }
    return await route.fulfill(
      json({
        items: [ARTIFACT],
        nextCursor: options.listNextCursor ?? null,
      }),
    );
  });
}

type OrganizationRetryStub = {
  readonly statuses: number[];
  readonly allowSuccess: () => void;
  readonly releaseSuccess: () => void;
};

async function stubOrganizationResolutionRetry(
  page: Page,
  options: { readonly delaySuccess?: boolean } = {},
): Promise<OrganizationRetryStub> {
  const statuses: number[] = [];
  let allowSuccess = false;
  let releaseSuccess: () => void = () => {};
  const successReady = new Promise<void>((resolve) => {
    releaseSuccess = resolve;
  });
  await page.route("**/v1/organizations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const status = allowSuccess ? 200 : 500;
    statuses.push(status);
    if (status === 500) {
      return await route.fulfill({
        status,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify(problemBody(status, "INTERNAL_ERROR")),
      });
    }
    if (options.delaySuccess) await successReady;
    return await route.fulfill(json({
      items: [
        { ...ORGANIZATION_STUB, id: ORGANIZATION_ID, name: "First Org" },
      ],
      nextCursor: null,
    }));
  });
  return {
    statuses,
    allowSuccess: () => {
      allowSuccess = true;
    },
    releaseSuccess,
  };
}

/**
 * Bounded response interception for exactly the states a real fixture cannot
 * produce on demand — denial, expiry, transport loss — plus the organization
 * scope and presentation rails for this route. The authenticated real-stack
 * download above remains the acceptance evidence.
 */
test.describe("artifact retrieval states", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedSession(page);
  });

  test("hydrates the organization scope on a direct deep link and shows the selected revision", async ({ page }) => {
    await stubArtifactReads(page);
    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-reconnecting"))
      .toHaveCount(0);
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toContainText(CONTENT_SHA256);
    await page.getByTestId("artifact-retrieval-details-toggle")
      .click();
    const descriptor = page.locator('[data-ui-component="artifactDescriptor"]');
    await expect(descriptor).toBeVisible();
    await expect(descriptor).toContainText(CONTENT_SHA256);
    await expect(descriptor).toContainText(`${VERSION.sizeBytes} bytes`);
    await expect(descriptor).toContainText(VERSION.mediaType);
    // The revision the provenance, download and extraction sections describe
    // is identified to sighted users, not only through `aria-pressed`.
    const selected = page.getByTestId("artifact-version-1");
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await expect(selected.locator("svg")).toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-version-metadata"))
      .toHaveAttribute("role", "region");

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test("continues after sign-in when scope resolution retries without re-submitting credentials", async ({ page }) => {
    let signInRequests = 0;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.route(
      "**/api/auth/sign-in/email",
      (route) => {
        signInRequests += 1;
        return route.fulfill(json({}));
      },
    );
    const organization = await stubOrganizationResolutionRetry(page, {
      delaySuccess: true,
    });

    await page.goto("/sign-in");
    await page.getByLabel(/Email/).fill("member@example.com");
    await page.getByLabel(/Password/).fill("correct horse battery staple");
    await page.getByRole("button", { name: /Sign in/ }).click();

    await expect(page.getByTestId("sign-in-continuation-failed")).toBeVisible();
    await expect(
      page.getByTestId("sign-in-continuation-failed").locator("h1"),
    ).toBeFocused();
    await expect.poll(() => organization.statuses[0] ?? null).toBe(500);
    organization.allowSuccess();
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect.poll(() => organization.statuses.length).toBe(2);
    // The destination's identity loader can outlive organization resolution.
    // Accepted credentials must not reappear while that navigation is pending.
    let destinationStarted = false;
    let releaseDestination = () => {};
    const destinationReady = new Promise<void>((resolve) => {
      releaseDestination = resolve;
    });
    await page.route("**/v1/me", async (route) => {
      destinationStarted = true;
      await destinationReady;
      await route.fallback();
    });
    try {
      organization.releaseSuccess();
      await expect.poll(() => destinationStarted).toBe(true);
      await expect(
        page.getByRole("navigation", { name: "Application navigation" }),
      ).toHaveCount(0);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByTestId("sign-in-continuation-failed"))
        .toBeVisible();
      await expect(page.getByLabel(/Email/)).toHaveCount(0);
      await expect(page.getByLabel(/Password/)).toHaveCount(0);
    } finally {
      releaseDestination();
    }

    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect.poll(() => organization.statuses.at(-1) ?? null).toBe(200);
    expect(organization.statuses).toEqual([500, 200]);
    expect(signInRequests).toBe(1);
  });

  for (
    const continuationFailure of [
      { code: "AUTH_REQUIRED", path: "/sign-in" },
      { code: "AUTH_EXPIRED", path: "/sign-in?reason=expired" },
    ] as const
  ) {
    test(`resets sign-in after ${continuationFailure.code} on the same route and preserves the artifact return-to`, async ({ page }) => {
      let signInRequests = 0;
      let continuationFailureReturned = false;
      await page.addInitScript((returnTo) => {
        sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
      }, ARTIFACT_PATH);
      await page.goto("/sign-in");
      await page.unroute("**/v1/me");
      await page.route("**/v1/me", (route) => {
        if (signInRequests === 1 && !continuationFailureReturned) {
          continuationFailureReturned = true;
          return route.fulfill(problemResponse(401, continuationFailure.code));
        }
        return route.fulfill(json(AUTHENTICATED_IDENTITY));
      });
      await page.route(
        "**/api/auth/sign-in/email",
        (route) => {
          signInRequests += 1;
          return route.fulfill(json({}));
        },
      );
      await stubArtifactReads(page);

      await page.getByLabel(/Email/).fill("member@example.com");
      await page.getByLabel(/Password/).fill("correct horse battery staple");
      await page.getByRole("button", { name: /Sign in/ }).click();

      await expect(page).toHaveURL(continuationFailure.path);
      await expect.poll(() =>
        page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
      ).toBe(ARTIFACT_PATH);
      if (continuationFailure.code === "AUTH_EXPIRED") {
        await expect(page.getByTestId("sign-in-expired")).toBeVisible();
        await page.getByRole("button", { name: /Sign in again/ }).click();
      }
      await expect(page.getByLabel(/Email/)).toBeVisible();
      await expect(page.getByLabel(/Password/)).toBeVisible();

      await page.getByLabel(/Email/).fill("member@example.com");
      await page.getByLabel(/Password/).fill("new credential");
      await page.getByRole("button", { name: /Sign in/ }).click();

      await expect(page).toHaveURL(ARTIFACT_PATH);
      await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
      await expect.poll(() =>
        page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
      ).toBe(null);
      expect(signInRequests).toBe(2);
    });
  }

  test("preserves an invitation destination after an indeterminate sign-in response and factor continuation", async ({ page }) => {
    let authState: "authenticated" | "factor-pending" = "authenticated";
    await page.unroute("**/v1/me");
    await page.route("**/v1/me", (route) => {
      return authState === "factor-pending"
        ? route.fulfill(problemResponse(401, "AUTH_FACTOR_REQUIRED"))
        : route.fulfill(json(AUTHENTICATED_IDENTITY));
    });
    await page.route(
      `**/v1/invitations/${INVITATION_ID}`,
      (route) =>
        route.fulfill(json({
          invitationId: INVITATION_ID,
          organizationName: "Fixture Org",
          inviterDisplayName: "Fixture Admin",
          role: "developer",
          email: "fixture-admin@example.test",
          expiresAt: INVITATION_EXPIRES_AT,
        })),
    );
    await page.route(
      "**/api/auth/organization/get-invitation*",
      (route) =>
        route.fulfill(json({
          id: INVITATION_ID,
          email: "fixture-admin@example.test",
          role: "developer",
          organizationId: ORGANIZATION_ID,
          inviterId: null,
          status: "pending",
          expiresAt: INVITATION_EXPIRES_AT,
          organizationName: "Fixture Org",
          organizationSlug: "fixture-org",
          inviterEmail: "fixture-admin@example.test",
        })),
    );
    await page.route("**/api/auth/sign-in/email", (route) => {
      authState = "factor-pending";
      return route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "not json",
      });
    });
    await page.route("**/api/auth/two-factor/verify-totp", (route) => {
      authState = "authenticated";
      return route.fulfill(json({}));
    });

    await page.goto(`/sign-in?invitation=${INVITATION_ID}`);
    await page.getByLabel("Password", { exact: true }).fill(
      "correct horse battery staple",
    );
    await page.getByRole("button", {
      name: "Sign in and continue",
      exact: true,
    }).click();

    await expect(page).toHaveURL("/sign-in/two-factor");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(INVITATION_PATH);

    await page.getByLabel(/Authentication code/).fill("123456");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page).toHaveURL(INVITATION_PATH);
    await expect(page.getByTestId("invitation-authenticated")).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
  });

  test("resets the TOTP challenge after factor-pending on the same route and preserves the artifact return-to", async ({ page }) => {
    let verificationRequests = 0;
    let continuationFailureReturned = false;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.goto("/sign-in/two-factor");
    await page.unroute("**/v1/me");
    await page.route("**/v1/me", (route) => {
      if (verificationRequests === 1 && !continuationFailureReturned) {
        continuationFailureReturned = true;
        return route.fulfill(problemResponse(401, "AUTH_FACTOR_REQUIRED"));
      }
      return route.fulfill(json(AUTHENTICATED_IDENTITY));
    });
    await page.route(
      "**/api/auth/two-factor/verify-totp",
      (route) => {
        verificationRequests += 1;
        return route.fulfill(json({}));
      },
    );
    await stubArtifactReads(page);

    await page.getByLabel(/Authentication code/).fill("123456");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page).toHaveURL("/sign-in/two-factor");
    await expect(page.getByTestId("two-factor")).toBeVisible();
    await expect(page.getByLabel(/Authentication code/)).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(ARTIFACT_PATH);

    await page.getByLabel(/Authentication code/).fill("654321");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
    expect(verificationRequests).toBe(2);
  });

  test("continues after TOTP verification when scope resolution retries without re-verifying the factor", async ({ page }) => {
    let verificationRequests = 0;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.route(
      "**/api/auth/two-factor/verify-totp",
      (route) => {
        verificationRequests += 1;
        return route.fulfill(json({}));
      },
    );
    const organization = await stubOrganizationResolutionRetry(page);

    await page.goto("/sign-in/two-factor");
    await page.getByLabel(/Authentication code/).fill("123456");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page.getByTestId("two-factor-continuation-failed"))
      .toBeVisible();
    await expect(
      page.getByTestId("two-factor-continuation-failed").locator("h1"),
    ).toBeFocused();
    await expect(page.getByLabel(/Authentication code/)).toHaveCount(0);
    await expect.poll(() => organization.statuses[0] ?? null).toBe(500);
    organization.allowSuccess();
    await page.getByRole("button", { name: "Try again", exact: true }).click();

    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect.poll(() => organization.statuses.at(-1) ?? null).toBe(200);
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
    expect(verificationRequests).toBe(1);
  });

  test("reconciles a lost TOTP response with an indeterminate identity without replaying the code", async ({ page }) => {
    let verificationRequests = 0;
    let identityRequests = 0;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.route(
      "**/api/auth/two-factor/verify-totp",
      (route) => {
        verificationRequests += 1;
        return route.abort("connectionfailed");
      },
    );
    await page.goto("/sign-in/two-factor");
    await page.unroute("**/v1/me");
    await page.route("**/v1/me", (route) => {
      if (verificationRequests === 0) {
        return route.fulfill(json(AUTHENTICATED_IDENTITY));
      }
      identityRequests += 1;
      return identityRequests === 1
        ? route.abort("connectionfailed")
        : route.fulfill(json(AUTHENTICATED_IDENTITY));
    });
    await stubArtifactReads(page);

    await page.getByLabel(/Authentication code/).fill("123456");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page.getByTestId("two-factor-continuation-failed"))
      .toBeVisible();
    await expect(
      page.getByTestId("two-factor-continuation-failed").locator("h1"),
    ).toBeFocused();
    await expect(page.getByLabel(/Authentication code/)).toHaveCount(0);
    expect(verificationRequests).toBe(1);

    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
    expect(verificationRequests).toBe(1);
  });

  test("continues after recovery-code verification when scope resolution retries without re-verifying the factor", async ({ page }) => {
    let verificationRequests = 0;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.route(
      "**/api/auth/two-factor/verify-backup-code",
      (route) => {
        verificationRequests += 1;
        return route.fulfill(json({}));
      },
    );
    const organization = await stubOrganizationResolutionRetry(page);

    await page.goto("/sign-in/recovery-code");
    await page.getByLabel(/Backup code/).fill("abcde-12345");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page.getByTestId("recovery-code-continuation-failed"))
      .toBeVisible();
    await expect(
      page.getByTestId("recovery-code-continuation-failed").locator("h1"),
    ).toBeFocused();
    await expect(page.getByLabel(/Backup code/)).toHaveCount(0);
    await expect.poll(() => organization.statuses[0] ?? null).toBe(500);
    organization.allowSuccess();
    await page.getByRole("button", { name: "Try again", exact: true }).click();

    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect.poll(() => organization.statuses.at(-1) ?? null).toBe(200);
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
    expect(verificationRequests).toBe(1);
  });

  test("reconciles a lost backup-code response to the authenticated deep link without replaying the code", async ({ page }) => {
    let verificationRequests = 0;
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await page.route(
      "**/api/auth/two-factor/verify-backup-code",
      (route) => {
        verificationRequests += 1;
        return route.abort("connectionfailed");
      },
    );
    await stubArtifactReads(page);

    await page.goto("/sign-in/recovery-code");
    await page.getByLabel(/Backup code/).fill("abcde-12345");
    await page.getByRole("button", { name: /Verify and sign in/ }).click();

    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(null);
    expect(verificationRequests).toBe(1);
  });

  test("does not continue an in-flight auth mutation after a same-document auth transition", async ({ page }) => {
    await page.addInitScript((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);

    const flows = [
      {
        endpoint: "/api/auth/sign-in/email",
        input: "Email",
        path: "/sign-in",
        value: "member@example.com",
        password: true,
        submit: /Sign in/,
        nextPath: "/register",
        transition: async () => {
          await page.getByRole("link", {
            name: "Join through an invitation",
            exact: true,
          }).click();
        },
      },
      {
        endpoint: "/api/auth/two-factor/verify-totp",
        input: "Authentication code",
        path: "/sign-in/two-factor",
        value: "123456",
        password: false,
        submit: /Verify and sign in/,
        nextPath: "/sign-in",
        transition: async () => {
          await page.getByRole("link", {
            name: "Back to sign in",
            exact: true,
          }).click();
        },
      },
      {
        endpoint: "/api/auth/two-factor/verify-backup-code",
        input: "Backup code",
        path: "/sign-in/recovery-code",
        value: "abcde-12345",
        password: false,
        submit: /Verify and sign in/,
        nextPath: "/sign-in/two-factor",
        transition: async () => {
          await page.getByRole("link", {
            name: "Use authenticator instead",
            exact: true,
          }).click();
        },
      },
    ] as const;

    let protectedReadRequests = 0;
    let identityRequests = 0;
    const onRequest = (request: Request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/v1/me") {
        identityRequests += 1;
      }
      if (
        pathname === "/v1/organizations" ||
        pathname === "/v1/artifacts" ||
        pathname.startsWith("/v1/artifacts/") ||
        pathname.startsWith("/v1/artifact-versions/")
      ) {
        protectedReadRequests += 1;
      }
    };
    page.on("request", onRequest);

    try {
      for (const flow of flows) {
        let releaseResponse: () => void = () => {};
        const responseReleased = new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });
        let requestStarted: () => void = () => {};
        const requestInFlight = new Promise<void>((resolve) => {
          requestStarted = resolve;
        });
        let routeHandlersPending = 0;
        let routeHandlersStarted = 0;

        await page.route(`**${flow.endpoint}`, async (route) => {
          routeHandlersStarted += 1;
          routeHandlersPending += 1;
          requestStarted();
          try {
            await responseReleased;
            await route.fulfill(json({}));
          } catch {
            // The page may abort the provider request during cleanup.
          } finally {
            routeHandlersPending -= 1;
          }
        });

        try {
          await page.goto(flow.path);
          await page.getByLabel(flow.input).fill(flow.value);
          if (flow.password) {
            await page.getByLabel("Password", { exact: true }).fill(
              "correct horse battery staple",
            );
          }
          await page.getByRole("button", { name: flow.submit }).click();
          await requestInFlight;

          await flow.transition();
          await expect(page).toHaveURL(flow.nextPath);
          // Requests caused by the completed transition are the baseline; only
          // an increment after the delayed mutation is released is stale work.
          const identityRequestsBeforeRelease = identityRequests;

          releaseResponse();
          await expect.poll(() => routeHandlersPending).toBe(0);
          await expect(page).toHaveURL(flow.nextPath);
          await expect(page.getByTestId("artifact-retrieval-page"))
            .toHaveCount(0);
          await expect(page.getByTestId("artifact-retrieval-provenance"))
            .toHaveCount(0);
          expect(
            await page.evaluate(() =>
              sessionStorage.getItem("bakery.auth.returnTo.v1")
            ),
          ).toBe(ARTIFACT_PATH);
          expect(routeHandlersStarted).toBe(1);
          expect(protectedReadRequests).toBe(0);
          expect(identityRequests).toBe(identityRequestsBeforeRelease);
        } finally {
          releaseResponse();
          await expect.poll(() => routeHandlersPending).toBe(0);
          await page.unroute(`**${flow.endpoint}`);
        }
      }
    } finally {
      page.off("request", onRequest);
    }
  });

  test("keeps a transient organization failure on the deep link and recovers on explicit retry", async ({ page }) => {
    const organizationStatuses: number[] = [];
    let allowOrganizationSuccess = false;
    let releaseOrganizationSuccess: () => void = () => {};
    const organizationSuccessReady = new Promise<void>((resolve) => {
      releaseOrganizationSuccess = resolve;
    });
    let artifactRequests = 0;
    await page.route(
      "**/v1/organizations",
      async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const status = allowOrganizationSuccess ? 200 : 500;
        organizationStatuses.push(status);
        if (status === 500) {
          return await route.fulfill({
            status,
            headers: { "content-type": "application/problem+json" },
            body: JSON.stringify(problemBody(status, "INTERNAL_ERROR")),
          });
        }
        await organizationSuccessReady;
        return await route.fulfill(json({
          items: [
            { ...ORGANIZATION_STUB, id: ORGANIZATION_ID, name: "First Org" },
          ],
          nextCursor: null,
        }));
      },
    );
    await stubArtifactReads(page, {
      onArtifactRequest: () => {
        artifactRequests += 1;
      },
    });

    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-error")).toBeVisible();
    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect.poll(() => organizationStatuses[0] ?? null).toBe(500);
    expect(organizationStatuses[0]).toBe(500);
    expect(artifactRequests).toBe(0);
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toHaveCount(0);

    allowOrganizationSuccess = true;
    const retry = page.getByTestId("artifact-retrieval-retry");
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute("data-testid"))
    ).toBe("artifact-retrieval-retry");
    releaseOrganizationSuccess();

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toContainText(CONTENT_SHA256);
    await expect(page.locator("main h1")).toHaveAttribute("tabindex", "-1");
    await expect(page.locator("main h1")).toBeFocused();
    await expect.poll(() => organizationStatuses.at(-1) ?? null).toBe(200);
    expect(organizationStatuses[0]).toBe(500);
    expect(artifactRequests).toBeGreaterThan(0);
  });

  test("does not focus a new same-path location after a retry", async ({ page }) => {
    await stubArtifactReads(page);
    const organization = await stubOrganizationResolutionRetry(page, {
      delaySuccess: true,
    });
    await page.goto(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-error")).toBeVisible();

    organization.allowSuccess();
    const retry = page.getByTestId("artifact-retrieval-retry");
    await retry.focus();
    await retry.press("Enter");
    await expect.poll(() => organization.statuses.at(-1) ?? null).toBe(200);

    await page.evaluate(() => {
      const next = `${globalThis.location.pathname}?view=other#other`;
      globalThis.history.pushState({}, "", next);
      globalThis.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page).toHaveURL(`${ARTIFACT_PATH}?view=other#other`);

    organization.releaseSuccess();
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.locator("main h1")).not.toBeFocused();
  });

  test("keeps a persistent organization failure as an error without retrying or leaking artifact reads", async ({ page }) => {
    let organizationRequests = 0;
    let artifactRequests = 0;
    await page.route(
      "**/v1/organizations",
      (route) => {
        if (route.request().method() !== "GET") return route.continue();
        organizationRequests += 1;
        return route.fulfill({
          status: 500,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify(problemBody(500, "INTERNAL_ERROR")),
        });
      },
    );
    await stubArtifactReads(page, {
      onArtifactRequest: () => {
        artifactRequests += 1;
      },
    });

    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-error")).toBeVisible();
    await expect(page).toHaveURL(ARTIFACT_PATH);
    expect(organizationRequests).toBeGreaterThan(0);
    expect(artifactRequests).toBe(0);
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toHaveCount(0);
    await expect(page.getByTestId("artifact-retrieval-download"))
      .toHaveCount(0);
  });

  for (
    const organizationFailure of [
      {
        code: "AUTH_FORBIDDEN",
        status: 403,
        testId: "artifact-retrieval-forbidden",
      },
      {
        code: "AUTH_REQUIRED",
        status: 401,
        testId: "artifact-retrieval-auth-required",
      },
      {
        code: "AUTH_EXPIRED",
        status: 401,
        testId: "artifact-retrieval-auth-required",
      },
      {
        code: "AUTH_INVALID",
        status: 401,
        testId: "artifact-retrieval-auth-required",
      },
      {
        code: "AUTH_FACTOR_REQUIRED",
        status: 401,
        testId: "artifact-retrieval-auth-required",
      },
    ]
  ) {
    test(`classifies organization ${organizationFailure.code} without opening the artifact`, async ({ page }) => {
      let artifactRequests = 0;
      await page.route(
        "**/v1/organizations",
        (route) =>
          route.request().method() === "GET"
            ? route.fulfill({
              status: organizationFailure.status,
              headers: { "content-type": "application/problem+json" },
              body: JSON.stringify(
                problemBody(
                  organizationFailure.status,
                  organizationFailure.code,
                ),
              ),
            })
            : route.continue(),
      );
      await stubArtifactReads(page, {
        onArtifactRequest: () => {
          artifactRequests += 1;
        },
      });

      await page.goto(ARTIFACT_PATH);

      await expect(page.getByTestId(organizationFailure.testId)).toBeVisible();
      await expect(page).toHaveURL(ARTIFACT_PATH);
      expect(artifactRequests).toBe(0);
      await expect(page.getByTestId("artifact-retrieval-provenance"))
        .toHaveCount(0);
      await expect(page.getByTestId("artifact-retrieval-download"))
        .toHaveCount(0);
      if (organizationFailure.code !== "AUTH_FORBIDDEN") {
        if (organizationFailure.code === "AUTH_FACTOR_REQUIRED") {
          await expect(
            page.getByTestId("artifact-retrieval-recovery-action"),
          ).toBeVisible();
        }
        const destination = organizationFailure.code === "AUTH_EXPIRED" ||
            organizationFailure.code === "AUTH_INVALID"
          ? "/sign-in?reason=expired"
          : organizationFailure.code === "AUTH_FACTOR_REQUIRED"
          ? "/sign-in/two-factor"
          : "/sign-in";
        await page.getByTestId("artifact-retrieval-auth-action").click();
        await expect(page).toHaveURL(destination);
        await expect.poll(() =>
          page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
        ).toBe(ARTIFACT_PATH);
      }
    });
  }

  test("sends a principal who must choose an organization to the picker and keeps the deep link", async ({ page }) => {
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill(json({
            items: [
              { ...ORGANIZATION_STUB, id: ORGANIZATION_ID, name: "First Org" },
              {
                ...ORGANIZATION_STUB,
                id: OTHER_ORGANIZATION_ID,
                name: "Second Org",
              },
            ],
            nextCursor: null,
          }))
          : route.continue(),
    );
    await stubArtifactReads(page);

    await page.goto(ARTIFACT_PATH);

    await expect(page).toHaveURL("/organizations");
    await expect.poll(() =>
      page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
    ).toBe(ARTIFACT_PATH);
  });

  for (
    const denial of [
      {
        code: "AUTH_FORBIDDEN",
        status: 403,
        testId: "artifact-retrieval-forbidden",
      },
      {
        code: "AUTH_EXPIRED",
        status: 401,
        testId: "artifact-retrieval-auth-required",
      },
      {
        code: "RESOURCE_NOT_FOUND",
        status: 404,
        testId: "artifact-retrieval-unavailable",
      },
    ]
  ) {
    test(`renders the ${denial.code} state instead of loading forever`, async ({ page }) => {
      await stubArtifactReads(page, {
        artifact: { status: denial.status, code: denial.code },
      });
      await page.goto(ARTIFACT_PATH);

      await expect(page.getByTestId(denial.testId)).toBeVisible();
      await expect(page.getByTestId("artifact-retrieval-loading")).toHaveCount(
        0,
      );
      await expect(page.getByTestId("artifact-retrieval-provenance"))
        .toHaveCount(0);
      await expect(page.getByText(CONTENT_SHA256)).toHaveCount(0);
      await expect(page.getByTestId("artifact-retrieval-download"))
        .toHaveCount(0);
      await expect(page.getByTestId("artifact-retrieval-extract")).toHaveCount(
        0,
      );
      // A permanent 404 must not be dressed up as a retryable failure.
      await expect(page.getByTestId("artifact-retrieval-error")).toHaveCount(0);
      // The route-level notice is the page heading, so the shell's focus
      // target and the axe heading rule are both satisfied.
      await expect(page.locator("main h1")).toHaveCount(1);

      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }

  test("never offers text extraction for an active HTML artifact", async ({ page }) => {
    await stubArtifactReads(page, {
      version: { ...VERSION, mediaType: "text/html" },
    });
    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await page.getByTestId("artifact-retrieval-details-toggle")
      .click();
    await expect(page.getByTestId("artifact-retrieval-unsafe-media"))
      .toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-extract")).toHaveCount(0);
  });

  test("offers a retry after a transport failure and recovers on reconnect", async ({ page }) => {
    await stubArtifactReads(page, { abortArtifact: true });
    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-offline")).toBeVisible();
    await expect(page.locator("main h1")).toHaveCount(1);

    await page.unroute("**/v1/artifacts**");
    await stubArtifactReads(page);
    const retry = page.getByTestId("artifact-retrieval-retry");
    await retry.focus();
    await retry.press("Enter");

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.locator("main h1")).toHaveAttribute("tabindex", "-1");
    await expect(page.locator("main h1")).toBeFocused();
  });

  test("keeps the artifact readable when only the cosmetic list query fails", async ({ page }) => {
    await stubArtifactReads(page, { listStatus: 500 });
    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByText(/artifacts? in this task/)).toHaveCount(0);
  });

  test("does not report a page of artifacts as the task total", async ({ page }) => {
    await stubArtifactReads(page, { listNextCursor: "cursor-2" });
    await page.goto(ARTIFACT_PATH);

    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByText(/artifacts? in this task/)).toHaveCount(0);
  });

  test("refetches distinct tenant provenance and bytes after an organization switch", async ({ page }) => {
    const organizationHeaders: string[] = [];
    const contentRequests: string[] = [];
    let delayOtherTenant = false;
    let releaseOtherTenant: () => void = () => {};
    const otherTenantReady = new Promise<void>((resolve) => {
      releaseOtherTenant = resolve;
    });
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill(json({
            items: [
              { ...ORGANIZATION_STUB, id: ORGANIZATION_ID, name: "First Org" },
              {
                ...ORGANIZATION_STUB,
                id: OTHER_ORGANIZATION_ID,
                name: "Second Org",
              },
            ],
            nextCursor: null,
          }))
          : route.continue(),
    );
    await page.route("**/v1/artifacts**", async (route) => {
      const url = new URL(route.request().url());
      const organizationId = route.request().headers()[
        "bakery-organization-id"
      ] ?? "";
      const otherTenant = organizationId === OTHER_ORGANIZATION_ID;
      if (
        otherTenant && delayOtherTenant &&
        url.pathname.endsWith(`/v1/artifacts/${ARTIFACT_ID}`)
      ) {
        await otherTenantReady;
      }
      const artifact = otherTenant ? OTHER_ARTIFACT : ARTIFACT;
      const version = otherTenant ? OTHER_VERSION : VERSION;
      if (url.pathname.endsWith(`/v1/artifacts/${ARTIFACT_ID}`)) {
        organizationHeaders.push(organizationId);
        return await route.fulfill(json(artifact));
      }
      if (url.pathname.endsWith("/versions")) {
        return await route.fulfill(
          json({ items: [version], nextCursor: null }),
        );
      }
      return await route.fulfill(json({ items: [artifact], nextCursor: null }));
    });
    await page.route(
      "**/v1/artifact-versions/*/content",
      (route) => {
        contentRequests.push(
          route.request().headers()["bakery-organization-id"] ?? "",
        );
        const otherTenant = route.request().headers()[
          "bakery-organization-id"
        ] === OTHER_ORGANIZATION_ID;
        const content = otherTenant ? OTHER_CONTENT : CONTENT;
        const digest = otherTenant ? OTHER_CONTENT_SHA256 : CONTENT_SHA256;
        const length = new TextEncoder().encode(content).byteLength;
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(length),
            "content-disposition": 'attachment; filename="artifact.txt"',
            etag: `"${digest}"`,
          },
          body: content,
        });
      },
    );

    await page.goto(ARTIFACT_PATH);
    await expect(page).toHaveURL("/organizations");
    await page.getByRole("button", { name: /First Org/ }).click();
    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toContainText(CONTENT_SHA256);

    // Inline previews now verify bytes automatically. Pin the authorized
    // first-tenant reads before switching, then prove the pending new scope
    // issues no byte read until its own metadata is authorized.
    await expect(page.locator('[data-ui-component="artifactViewer"]'))
      .toContainText(CONTENT.trim());
    const firstTenantReadCount = contentRequests.length;
    expect(firstTenantReadCount).toBeGreaterThan(0);
    expect(
      contentRequests.every((organizationId) =>
        organizationId === ORGANIZATION_ID
      ),
    ).toBe(true);

    await page.evaluate((returnTo) => {
      sessionStorage.setItem("bakery.auth.returnTo.v1", returnTo);
    }, ARTIFACT_PATH);
    await (await openAccountMenu(page, "Fixture Admin"))
      .getByRole("button", { name: "Switch organization" }).click();
    await expect(page).toHaveURL("/organizations");
    delayOtherTenant = true;
    await page.getByRole("button", { name: /Second Org/ }).click();
    await expect(page).toHaveURL(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-loading")).toBeVisible();
    await expect(page.getByText(CONTENT_SHA256)).toHaveCount(0);
    await expect(page.getByText("Bounded retrieval stub", { exact: true }))
      .toHaveCount(0);
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toHaveCount(0);
    expect(contentRequests).toHaveLength(firstTenantReadCount);

    releaseOtherTenant();
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toContainText(OTHER_CONTENT_SHA256);
    await expect(page.getByTestId("artifact-retrieval-provenance"))
      .toContainText("other-tenant-stub");
    await expect(page.getByText(CONTENT_SHA256)).toHaveCount(0);

    await expect(page.locator('[data-ui-component="artifactViewer"]'))
      .toContainText(OTHER_CONTENT.trim());
    const previewRequests = contentRequests.slice(firstTenantReadCount);
    expect(previewRequests.length).toBeGreaterThan(0);
    expect(previewRequests.every((id) => id === OTHER_ORGANIZATION_ID)).toBe(
      true,
    );
    const beforeDownloadCount = contentRequests.length;

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("artifact-retrieval-download").click(),
    ]);
    const savedPath = await download.path();
    expect(await readFile(savedPath, "utf8")).toBe(OTHER_CONTENT);
    expect(contentRequests.slice(beforeDownloadCount)).toEqual([
      OTHER_ORGANIZATION_ID,
    ]);
    expect(organizationHeaders).toContain(ORGANIZATION_ID);
    expect(organizationHeaders).toContain(OTHER_ORGANIZATION_ID);
  });

  test("survives 200% zoom, both themes, and reduced motion", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await stubArtifactReads(page);
    await page.goto(ARTIFACT_PATH);
    await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.evaluate(() => {
      document.documentElement.style.zoom = "200%";
    });
    await expect.poll(() =>
      page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1
      )
    ).toBe(true);
    const darkAccessibility = await new AxeBuilder({ page }).analyze();
    expect(darkAccessibility.violations).toEqual([]);

    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightAccessibility = await new AxeBuilder({ page }).analyze();
    expect(lightAccessibility.violations).toEqual([]);
  });

  test("stops animating the loading skeleton when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The skeleton on this route is the router's pending state (`RoutePending`),
    // shown while the root `beforeLoad` awaits `GET /v1/installation/status`.
    // The router shows it at once (`defaultPendingMs: 0`) and keeps it for at
    // least `defaultPendingMinMs` (500 ms by default), then it is gone: the
    // artifact page's own loading view draws no skeleton, so holding the
    // artifact requests kept nothing on screen. With the status stubbed by
    // `mockAuthenticatedSession` that left a window of about half a second, and
    // a runner that finishes `goto` after it never sees the skeleton, whatever
    // the wait. Never answering the status request keeps the pending state, and
    // its skeleton, for the whole test. Registered after the describe's stubs,
    // so it takes precedence.
    await page.route("**/v1/installation/status", () => {});

    const skeleton = page.locator(
      '[data-ui-component="skeleton"][data-state="loading"]',
    ).last();
    // The app still has to boot first, which is what the suite's first-render
    // budget is for.
    await firstRender(() => page.goto(ARTIFACT_PATH), async (timeout) => {
      await expect(skeleton).toBeVisible({ timeout });
    });
    await expect.poll(() =>
      skeleton.evaluate((element) => getComputedStyle(element).animationName)
    ).toBe("none");
  });
});
