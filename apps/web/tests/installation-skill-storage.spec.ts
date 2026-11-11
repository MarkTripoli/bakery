import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

/**
 * Object storage section of the installation Integrations page (E05, #49).
 * The Bakery API is mocked, so this proves the section's states and what the
 * browser sends and keeps; the real-API spec proves them against a server.
 * It has no per-project skip: it runs in the desktop and the mobile projects.
 */
const PAGE_PATH = "/settings/installation/integrations";
const ACCOUNT_ID = "a".repeat(32);
const BUCKET = "bakery-skills";
const ACCESS_KEY_ID = "AKIA-browser-canary-0123456789";
const SECRET_ACCESS_KEY = "secret-browser-canary-abcdefghijklmnop";

const unconfigured = {
  backend: "filesystem",
  configured: false,
  accountId: null,
  bucket: null,
  credentialUpdatedAt: null,
  credentialRevision: null,
  updatedAt: null,
  version: 0,
};
const configured = {
  backend: "filesystem",
  configured: true,
  accountId: ACCOUNT_ID,
  bucket: BUCKET,
  credentialUpdatedAt: "2026-10-28T12:00:00.000Z",
  credentialRevision: 2,
  updatedAt: "2026-10-28T12:00:00.000Z",
  version: 3,
};
const active = { ...configured, backend: "r2" };

type Settings = typeof unconfigured | typeof configured;
type Refusal = {
  status: number;
  code: string;
  reason?: string;
  issueCode?: string;
};

function problem(
  status: number,
  code: string,
  reason?: string,
  issueCode?: string,
) {
  return {
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
      ...(reason === undefined ? {} : { reason }),
      ...(issueCode === undefined ? {} : {
        issues: [{
          path: ["secretAccessKey"],
          code: issueCode,
          message: issueCode.replaceAll("_", " "),
        }],
      }),
    }),
  };
}

/** Mocks the three storage operations; `state` is live and recorded. */
async function storageFixture(
  page: Page,
  initial: Settings | "forbidden" | "error" = unconfigured,
) {
  await mockAuthenticatedSession(page);
  const state = {
    current: initial,
    reads: 0,
    putAnswer: "ok" as "ok" | Refusal,
    verifyAnswer: "verified" as string | Refusal,
    verifyDelayMs: 0,
    puts: [] as {
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }[],
    verifies: 0,
  };
  await page.route("**/v1/installation/skill-storage", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      state.puts.push({
        body: request.postDataJSON(),
        headers: request.headers(),
      });
      const answer = state.putAnswer;
      if (answer !== "ok") {
        return route.fulfill(
          problem(answer.status, answer.code, answer.reason, answer.issueCode),
        );
      }
      const body = request.postDataJSON() as Record<string, string>;
      const previous = typeof state.current === "object"
        ? state.current
        : unconfigured;
      state.current = {
        ...(previous.configured ? previous : configured),
        accountId: body.accountId,
        bucket: body.bucket,
        configured: true,
        credentialRevision: body.accessKeyId === undefined
          ? previous.credentialRevision ?? 1
          : (previous.credentialRevision ?? 0) + 1,
        version: previous.version + 1,
      } as Settings;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.current),
      });
    }
    state.reads++;
    if (state.current === "forbidden") {
      return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    }
    if (state.current === "error") {
      return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state.current),
    });
  });
  await page.route(
    "**/v1/installation/skill-storage/verification",
    async (route) => {
      state.verifies++;
      if (state.verifyDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, state.verifyDelayMs)
        );
      }
      const answer = state.verifyAnswer;
      if (typeof answer !== "string") {
        return route.fulfill(
          problem(answer.status, answer.code, answer.reason),
        );
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: answer,
          checkedAt: "2026-10-28T12:30:00.000Z",
        }),
      });
    },
  );
  return state;
}

const section = (page: Page) => page.getByTestId("skill-storage");
const form = (page: Page) => page.getByTestId("skill-storage-form");
const field = (page: Page, name: string) =>
  form(page).locator(`input[name="${name}"]`);
const saveButton = (page: Page) =>
  form(page).getByRole("button", { name: /^Save settings$|^Saving$/ });
const verifyButton = (page: Page) =>
  section(page).getByRole("button", {
    name: /^Verify connection$|^Verifying$/,
  });

async function fillForm(
  page: Page,
  values: Partial<
    Record<"accountId" | "bucket" | "accessKeyId" | "secretAccessKey", string>
  >,
) {
  for (const [name, value] of Object.entries(values)) {
    await field(page, name).fill(value);
  }
}

/** No typed credential is left in a field, the page text or browser storage. */
async function expectNoCredentialRetained(page: Page) {
  for (const name of ["accessKeyId", "secretAccessKey"]) {
    await expect(field(page, name)).toHaveValue("");
  }
  const retained = await page.evaluate(() =>
    document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) +
    JSON.stringify({ ...sessionStorage })
  );
  expect(retained).not.toContain(ACCESS_KEY_ID);
  expect(retained).not.toContain(SECRET_ACCESS_KEY);
  expect(page.url()).not.toContain(SECRET_ACCESS_KEY);
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("unconfigured: the section explains R2, shows the filesystem and offers an empty form", async ({ page }) => {
  await storageFixture(page);
  await page.goto(PAGE_PATH);
  await expect(section(page).getByRole("heading", { name: "Object storage" }))
    .toBeVisible();
  await expect(section(page).getByText("Server disk (filesystem)"))
    .toBeVisible();
  await expect(section(page).getByText("R2 is not configured")).toBeVisible();
  await expect(section(page).getByText("Not stored")).toBeVisible();
  for (
    const name of ["accountId", "bucket", "accessKeyId", "secretAccessKey"]
  ) {
    await expect(field(page, name)).toHaveValue("");
  }
  await expect(saveButton(page)).toBeDisabled();
  // Nothing is stored yet, so nothing can be verified.
  await expect(verifyButton(page)).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("validation: malformed account, bucket and half a credential pair never reach the server", async ({ page }) => {
  const f = await storageFixture(page);
  await page.goto(PAGE_PATH);
  await fillForm(page, {
    accountId: "NOT-HEX",
    bucket: "A",
    accessKeyId: ACCESS_KEY_ID,
  });
  await expect(field(page, "accountId")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByText("Enter exactly 32 lowercase hexadecimal characters."),
  ).toBeVisible();
  await expect(field(page, "bucket")).toHaveAttribute("aria-invalid", "true");
  await expect(saveButton(page)).toBeDisabled();
  await fillForm(page, { accountId: ACCOUNT_ID, bucket: BUCKET });
  // Half a pair: the missing half is flagged and Save stays disabled.
  await expect(field(page, "secretAccessKey")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(saveButton(page)).toBeDisabled();
  await fillForm(page, { secretAccessKey: "x".repeat(1025) });
  await expect(field(page, "secretAccessKey")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(saveButton(page)).toBeDisabled();
  await fillForm(page, { secretAccessKey: "has a space" });
  await expect(saveButton(page)).toBeDisabled();
  await fillForm(page, { secretAccessKey: SECRET_ACCESS_KEY });
  await expect(saveButton(page)).toBeEnabled();
  expect(f.puts).toHaveLength(0);
});

test("first save sends the credentials once, clears them, and shows only revision and date", async ({ page }) => {
  const f = await storageFixture(page);
  await page.goto(PAGE_PATH);
  await fillForm(page, {
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await saveButton(page).click();
  await expect(
    page.getByText(
      "Settings saved. The credentials are encrypted and cannot be shown again.",
    ),
  ).toBeVisible();
  expect(f.puts).toHaveLength(1);
  // A first save carries no If-Match and an Idempotency-Key.
  expect(f.puts[0].headers["if-match"]).toBeUndefined();
  expect(f.puts[0].headers["idempotency-key"]).toBeTruthy();
  expect(f.puts[0].body).toEqual({
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await expect(section(page).getByText(ACCOUNT_ID)).toBeVisible();
  await expect(section(page).getByText(BUCKET, { exact: true })).toBeVisible();
  await expect(section(page).getByText(/Stored, revision 1/)).toBeVisible();
  await expectNoCredentialRetained(page);
  // The saved form keeps the non-secret values and now offers Verify.
  await expect(field(page, "accountId")).toHaveValue(ACCOUNT_ID);
  await expect(verifyButton(page)).toBeEnabled();
});

test("a later save sends If-Match and keeps stored credentials when both fields are empty", async ({ page }) => {
  const f = await storageFixture(page, configured);
  await page.goto(PAGE_PATH);
  await expect(section(page).getByText(/Stored, revision 2/)).toBeVisible();
  await expect(
    section(page).getByText(
      "Stored (revision 2). Leave both credential fields empty to keep them, or enter both to replace them.",
    ),
  ).toBeVisible();
  await expect(field(page, "accountId")).toHaveValue(ACCOUNT_ID);
  await expect(field(page, "bucket")).toHaveValue(BUCKET);
  await field(page, "bucket").fill("another-bucket");
  await saveButton(page).click();
  await expect(page.getByText(/^Settings saved\./)).toBeVisible();
  expect(f.puts[0].headers["if-match"]).toBe('"v3"');
  expect(f.puts[0].body).toEqual({
    accountId: ACCOUNT_ID,
    bucket: "another-bucket",
  });
  await expect(section(page).getByText(/Stored, revision 2/)).toBeVisible();
});

test("rotation sends both credentials with If-Match and shows the next revision", async ({ page }) => {
  const f = await storageFixture(page, configured);
  await page.goto(PAGE_PATH);
  await fillForm(page, {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await saveButton(page).click();
  await expect(section(page).getByText(/Stored, revision 3/)).toBeVisible();
  expect(f.puts[0].headers["if-match"]).toBe('"v3"');
  expect(f.puts[0].body).toEqual({
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await expectNoCredentialRetained(page);
});

for (
  const [label, refusal, copy] of [
    [
      "a stale version",
      { status: 412, code: "PRECONDITION_FAILED" },
      "The settings changed since this page loaded. Nothing was saved.",
    ],
    [
      "a missing If-Match",
      { status: 428, code: "PRECONDITION_REQUIRED" },
      "The settings changed since this page loaded. Nothing was saved.",
    ],
    [
      "malformed credentials",
      { status: 400, code: "MALFORMED_REQUEST" },
      "The credentials are not valid",
    ],
    [
      "an invalid account or bucket",
      { status: 422, code: "UNPROCESSABLE" },
      "The account ID or the bucket name is not valid.",
    ],
    [
      "R2 being the active backend",
      { status: 409, code: "STATE_CONFLICT", reason: "backend_active" },
      "R2 is the active storage, so the account and bucket cannot change.",
    ],
    [
      "no secrets key",
      { status: 409, code: "STATE_CONFLICT" },
      "Credentials cannot be stored until the person who runs this installation configures the secrets key.",
    ],
    [
      "a server error",
      { status: 503, code: "DEPENDENCY_UNAVAILABLE" },
      "The settings could not be saved. Nothing was saved.",
    ],
  ] as const
) {
  test(`saving with ${label} says nothing was saved and clears the credentials`, async ({ page }) => {
    const f = await storageFixture(page, configured);
    f.putAnswer = refusal;
    await page.goto(PAGE_PATH);
    const reads = f.reads;
    await fillForm(page, {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    });
    await saveButton(page).click();
    await expect(page.getByText(copy, { exact: false })).toBeVisible();
    await expectNoCredentialRetained(page);
    await expect(section(page).getByText(/Stored, revision 2/)).toBeVisible();
    // A version conflict re-reads so the next attempt starts from the server.
    if ([412, 428].includes(refusal.status)) {
      await expect.poll(() => f.reads).toBeGreaterThan(reads);
    }
  });
}

for (
  const [outcome, copy] of [
    ["not_configured", "Nothing to verify yet."],
    ["credentials_rejected", "R2 rejected the credentials."],
    [
      "access_denied",
      "These credentials cannot read, write and delete objects in this bucket.",
    ],
    [
      "bucket_not_found",
      "R2 reports that this bucket does not exist for this account.",
    ],
    ["endpoint_unreachable", "Bakery could not reach R2."],
    [
      "integrity_failed",
      "The bucket returned different bytes than were written.",
    ],
    ["provider_error", "R2 returned an unexpected error."],
  ] as const
) {
  test(`a rotation the probe refuses as ${outcome} shows that outcome and saves nothing`, async ({ page }) => {
    const f = await storageFixture(page, configured);
    f.putAnswer = {
      status: 422,
      code: "UNPROCESSABLE",
      issueCode: outcome,
    };
    await page.goto(PAGE_PATH);
    await fillForm(page, {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    });
    await saveButton(page).click();
    await expect(section(page).getByText(copy, { exact: false }))
      .toBeVisible();
    await expect(
      section(page).getByText("account ID or the bucket name", {
        exact: false,
      }),
    ).toHaveCount(0);
    await expectNoCredentialRetained(page);
    await expect(section(page).getByText(/Stored, revision 2/)).toBeVisible();
  });
}

test("saving is single-flight", async ({ page }) => {
  const f = await storageFixture(page);
  await page.route("**/v1/installation/skill-storage", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fallback();
  });
  await page.goto(PAGE_PATH);
  await fillForm(page, {
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await form(page).evaluate((node) => {
    const element = node as HTMLFormElement;
    element.requestSubmit();
    element.requestSubmit();
  });
  await expect(section(page).getByText(/Stored, revision 1/)).toBeVisible();
  expect(f.puts).toHaveLength(1);
});

test("verify shows the verifying state, then success", async ({ page }) => {
  const f = await storageFixture(page, configured);
  f.verifyDelayMs = 400;
  await page.goto(PAGE_PATH);
  await verifyButton(page).click();
  await expect(verifyButton(page)).toHaveText("Verifying");
  await expect(verifyButton(page)).toBeDisabled();
  await expect(
    page.getByText(
      "Verified: the bucket accepted a test object and returned it intact.",
    ),
  ).toBeVisible();
  expect(f.verifies).toBe(1);
});

for (
  const [outcome, copy] of [
    ["credentials_rejected", "R2 rejected the credentials."],
    [
      "access_denied",
      "These credentials cannot read, write and delete objects",
    ],
    ["bucket_not_found", "R2 reports that this bucket does not exist"],
    ["endpoint_unreachable", "Bakery could not reach R2."],
    [
      "integrity_failed",
      "The bucket returned different bytes than were written.",
    ],
    ["provider_error", "R2 returned an unexpected error."],
    ["not_configured", "Nothing to verify yet."],
  ] as const
) {
  test(`verify-failed: ${outcome} has its own message and no provider text`, async ({ page }) => {
    const f = await storageFixture(page, configured);
    f.verifyAnswer = outcome;
    await page.goto(PAGE_PATH);
    await verifyButton(page).click();
    await expect(page.getByText(copy, { exact: false })).toBeVisible();
    await expect(verifyButton(page)).toBeEnabled();
  });
}

test("verify-failed: a request failure says the verification could not run", async ({ page }) => {
  const f = await storageFixture(page, configured);
  f.verifyAnswer = { status: 503, code: "DEPENDENCY_UNAVAILABLE" };
  await page.goto(PAGE_PATH);
  await verifyButton(page).click();
  await expect(page.getByText("The verification could not run. Try again."))
    .toBeVisible();
});

test("R2 active: account and bucket are read-only and the note explains the switch", async ({ page }) => {
  await storageFixture(page, active);
  await page.goto(PAGE_PATH);
  await expect(section(page).getByText("Cloudflare R2").first()).toBeVisible();
  await expect(field(page, "accountId")).toHaveAttribute("readonly", "");
  await expect(field(page, "bucket")).toHaveAttribute("readonly", "");
  await expect(
    section(page).getByText(/R2 is the active storage, so the account/),
  )
    .toBeVisible();
  await expect(
    section(page).getByText(
      /Switching to R2 copies and verifies every object first, with the server paused\./,
    ),
  )
    .toBeVisible();
  // No control on the page can switch the backend.
  await expect(
    section(page).getByRole("button", { name: /switch|activate|use r2/i }),
  ).toHaveCount(0);
});

test("forbidden: a viewer who is not an installation administrator sees no form", async ({ page }) => {
  await storageFixture(page, "forbidden");
  await page.goto(PAGE_PATH);
  await expect(
    section(page).getByText(
      "Only an installation administrator can change object storage.",
    ),
  ).toBeVisible();
  await expect(form(page)).toHaveCount(0);
  await expect(verifyButton(page)).toHaveCount(0);
});

test("forbidden: authority revoked after load removes the form on the next save", async ({ page }) => {
  const f = await storageFixture(page);
  f.putAnswer = { status: 403, code: "AUTH_FORBIDDEN" };
  await page.goto(PAGE_PATH);
  await fillForm(page, {
    accountId: ACCOUNT_ID,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await saveButton(page).click();
  await expect(
    section(page).getByText(
      "Only an installation administrator can change object storage.",
    ),
  ).toBeVisible();
  await expect(form(page)).toHaveCount(0);
});

test("a failed load offers Try again", async ({ page }) => {
  const f = await storageFixture(page, "error");
  await page.goto(PAGE_PATH);
  await expect(
    section(page).getByText("Object storage settings could not be loaded."),
  ).toBeVisible();
  f.current = configured;
  await section(page).getByRole("button", { name: "Try again" }).click();
  await expect(section(page).getByText(/Stored, revision 2/)).toBeVisible();
});

test("the configured section has no axe violations and does not scroll sideways", async ({ page }) => {
  const f = await storageFixture(page, configured);
  f.verifyAnswer = "access_denied";
  await page.goto(PAGE_PATH);
  await verifyButton(page).click();
  await expect(
    page.getByText("These credentials cannot read, write and delete objects", {
      exact: false,
    }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("the unconfigured section has no axe violations and does not scroll sideways", async ({ page }) => {
  await storageFixture(page);
  await page.goto(PAGE_PATH);
  await expect(section(page).getByText("R2 is not configured")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await noHorizontalScroll(page)).toBe(true);
});
