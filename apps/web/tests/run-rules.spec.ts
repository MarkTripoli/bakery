import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  check,
  CHECKS_A,
  openRun,
  REPOSITORY_ID,
  RULES_A,
  RULES_B,
  STEP_IMPLEMENT,
  STEP_VERIFY,
} from "./helpers/run-rules-world.ts";

// The run's own Details, not the Delivery card's, which comes first on the page.
const details = (page: Page) => page.locator("#run-details > summary");
const block = (page: Page) => page.getByTestId("run-rules");

test.describe("Rules this run used", () => {
  test("shows both fingerprints, the settings version and that the rules are unchanged", async ({ page }) => {
    await openRun(page, {
      checks: [
        check(1, RULES_A, CHECKS_A, STEP_IMPLEMENT, "2026-01-01T00:00:03.000Z"),
      ],
      currentDigest: RULES_A,
    });
    // Closed: nothing is added to the run header.
    await expect(page.getByTestId("run-rules-changed-notice")).toHaveCount(0);
    await expect(block(page)).toBeHidden();
    await details(page).click();
    await expect(block(page)).toContainText("Rules this run used");
    await expect(block(page)).toContainText(
      "Fixed when the run started. Editing the rules does not change a run in progress.",
    );
    const rules = page.getByTestId("run-rules-fingerprint");
    await expect(rules).toContainText("Rules fingerprint");
    await expect(rules).toContainText(RULES_A.slice(0, 12));
    const checks = page.getByTestId("run-checks-fingerprint");
    await expect(checks).toContainText("Checks fingerprint");
    await expect(checks).toContainText(CHECKS_A.slice(0, 12));
    await expect(page.getByTestId("run-rules-settings-version")).toHaveText(
      "Repository settings version: 4",
    );
    const comparison = page.getByTestId("run-rules-comparison");
    await expect(comparison).toContainText("Same as the rules in force now.");
    await expect(comparison.getByRole("link", { name: "Open rules" }))
      .toHaveAttribute("href", `/projects/repositories/${REPOSITORY_ID}/rules`);
    expect(
      (await new AxeBuilder({ page }).include('[data-testid="run-rules"]')
        .analyze()).violations,
    ).toEqual([]);
  });

  test("when the rules changed while the run is in progress, a line says so and Details opens and takes focus", async ({ page }) => {
    await openRun(page, {
      checks: [
        check(1, RULES_A, null, STEP_IMPLEMENT, "2026-01-01T00:00:03.000Z"),
      ],
      currentDigest: RULES_B,
    });
    const notice = page.getByTestId("run-rules-changed-notice");
    await expect(notice).toHaveText("Rules changed after this run started.");
    await expect(block(page)).toBeHidden();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(block(page)).toBeVisible();
    await expect(page.getByTestId("run-rules-heading")).toBeFocused();
    const comparison = page.getByTestId("run-rules-comparison");
    await expect(comparison).toContainText(
      "The rules have changed since this run started. This run keeps the rules it started with.",
    );
    await expect(comparison.getByRole("link", { name: "See current rules" }))
      .toBeVisible();
    await expect(page.getByTestId("run-rules-no-checks")).toHaveText(
      "No check commands applied to this run.",
    );
  });

  test("a finished run says it used the rules it started with", async ({ page }) => {
    await openRun(page, {
      finished: true,
      checks: [
        check(1, RULES_A, CHECKS_A, STEP_IMPLEMENT, "2026-01-01T00:00:03.000Z"),
      ],
      currentDigest: RULES_B,
    });
    await details(page).click();
    await expect(page.getByTestId("run-rules-comparison")).toContainText(
      "This run used the rules it started with.",
    );
    // A finished run is not "in progress": the fixed line says only when.
    await expect(block(page)).toContainText("Fixed when the run started.");
    await expect(block(page)).not.toContainText("in progress");
  });

  test("a run that held two rules fingerprints lists the newest first with its step", async ({ page }) => {
    await openRun(page, {
      checks: [
        check(1, RULES_A, null, STEP_IMPLEMENT, "2026-01-01T00:00:03.000Z"),
        check(2, RULES_B, null, STEP_VERIFY, "2026-01-01T00:00:05.000Z"),
      ],
      currentDigest: RULES_B,
    });
    await details(page).click();
    const rows = page.getByTestId("run-rules-fingerprint");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(RULES_B.slice(0, 12));
    await expect(rows.nth(1)).toContainText(RULES_A.slice(0, 12));
    // "from {step}" sits in its own line under each row's name.
    await expect(rows.nth(0)).toContainText("from verify");
    await expect(rows.nth(1)).toContainText("from implement");
    // The comparison uses the newest.
    await expect(page.getByTestId("run-rules-comparison")).toContainText(
      "Same as the rules in force now.",
    );
  });

  test("a repository whose settings name no checks says so, and keeps the version and Open rules", async ({ page }) => {
    await openRun(page, { checks: [], hasFixedPolicy: false });
    await details(page).click();
    await expect(page.getByTestId("run-rules-state")).toHaveText(
      "This repository's settings name no checks, so runs here record no rules fingerprint.",
    );
    await expect(page.getByTestId("run-rules-fingerprint")).toHaveCount(0);
    await expect(page.getByTestId("run-rules-comparison")).toHaveCount(0);
    await expect(page.getByTestId("run-rules-settings-version")).toBeVisible();
    await expect(block(page).getByRole("link", { name: "Open rules" }))
      .toBeVisible();
  });

  test("with no check recorded, a running run says none has run yet and a finished one says none ran", async ({ page }) => {
    await openRun(page, { checks: [] });
    await details(page).click();
    await expect(page.getByTestId("run-rules-state")).toHaveText(
      "No check has run yet, so the rules for this run are not recorded.",
    );
  });

  test("a finished run with no check never says yet", async ({ page }) => {
    await openRun(page, { finished: true, checks: [] });
    await details(page).click();
    const text = await page.getByTestId("run-rules-state").innerText();
    expect(text).toBe(
      "No check ran in this run, so no rules fingerprint was recorded.",
    );
    expect(text).not.toContain("yet");
  });

  test("when the current rules cannot be read the comparison is left out, never 'same'", async ({ page }) => {
    await openRun(page, {
      checks: [
        check(1, RULES_A, null, STEP_IMPLEMENT, "2026-01-01T00:00:03.000Z"),
      ],
      currentDigest: null,
    });
    await details(page).click();
    await expect(page.getByTestId("run-rules-fingerprint")).toBeVisible();
    await expect(page.getByTestId("run-rules-comparison")).toHaveCount(0);
    await expect(block(page)).not.toContainText("Same as the rules");
    await expect(page.getByTestId("run-rules-changed-notice")).toHaveCount(0);
  });

  test("a failed read says so with Try again, and a refused read says there is no access", async ({ page }) => {
    const world = await openRun(page, { checksStatus: 500 });
    await details(page).click();
    await expect(block(page)).toContainText(
      "The rules this run used could not be loaded.",
    );
    world.recoverChecks();
    await block(page).getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("run-rules-state")).toBeVisible();
  });

  test("a start the server refuses because the repository's rules changed shows that reason and keeps the task a draft", async ({ page }) => {
    // #65 AC3: a rule change cannot silently alter a run. A task planned under
    // other rules is refused at admission, and the person is told why.
    await openRun(page, {
      refusedStart: {
        status: 412,
        code: "PRECONDITION_FAILED",
        title: "Precondition failed",
        reason: "source_policy_changed",
      },
    });
    const start = page.getByRole("button", { name: "Start run", exact: true });
    await start.click();
    const refusal = page.getByRole("status").filter({
      hasText: "The repository's rules changed before this run could start.",
    });
    await expect(refusal).toContainText(
      "The repository's rules changed before this run could start. Check the rules, then start the run again.",
    );
    await expect(refusal.getByRole("link", { name: "Open rules" }))
      .toHaveAttribute(
        "href",
        new RegExp(`/projects/repositories/${REPOSITORY_ID}/rules$`),
      );
    // No run was made up: still a draft with a Start run to try again.
    await expect(page.getByRole("heading", { name: "Current run" }))
      .toHaveCount(0);
    await expect(start).toBeVisible();
  });

  test("a read the person may not make says they have no access", async ({ page }) => {
    await openRun(page, { checksStatus: 403 });
    await details(page).click();
    await expect(block(page)).toContainText(
      "You do not have access to see which rules this run used.",
    );
  });
});
