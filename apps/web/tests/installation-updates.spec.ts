import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/** What a person reads in a region: a release inside a sentence is its own box. */
const said = (region: Locator) =>
  region.evaluate((element) =>
    (element as HTMLElement).innerText.replace(/\s+/g, " ").replace(
      / ([,.:])/g,
      "$1",
    )
  );

/**
 * The Updates page (#59 slice 4, design-ux revisions 3 and 4): which version
 * runs, the one kept to go back to, the policy, and the history. Every read is
 * stubbed in the page.
 */

const RUNNING = "4f2a9c1e7b3d5a60c8e2f1d9b7a5c3e1f0d2b4a6";
const KEPT = "9b81d3f07e6c2a4b5d9f1e3c7a0b2d4f6e8c1a3b";
const NEWER = "c3e5a7b9d1f3e5a7b9c1d3e5f7a9b1c3d5e7f9a1";

type Kind =
  | "installed"
  | "updated"
  | "rolled_back"
  | "went_back"
  | "refused"
  | "decided_go_back"
  | "decided_stay"
  | "interrupted";

function event(
  index: number,
  kind: Kind,
  fields: {
    by?: string | null;
    from?: string | null;
    to?: string | null;
    detail?: string | null;
  } = {},
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    kind,
    at: new Date(Date.UTC(2026, 10, 21, 2, 14) - index * 86_400_000)
      .toISOString(),
    by: fields.by ?? null,
    fromRelease: fields.from ?? null,
    toRelease: fields.to ?? null,
    detail: fields.detail ?? null,
    dismissedAt: null,
  };
}

/** Newest first: the first page of 25 rows, then a second page of 3. */
const HISTORY = [
  event(1, "went_back", { from: NEWER, to: RUNNING }),
  event(2, "updated", { by: "ana", from: KEPT, to: RUNNING }),
  event(3, "refused", {
    by: "ana",
    to: NEWER,
    detail: "the database change cannot be undone",
  }),
  event(4, "decided_stay", { by: "ana", from: RUNNING, to: KEPT }),
  event(5, "updated", { by: "ana", from: KEPT, to: RUNNING }),
  event(6, "decided_go_back", { by: "ana", from: NEWER, to: KEPT }),
  event(7, "decided_stay", { from: NEWER, to: KEPT }),
  event(8, "interrupted", { from: NEWER, to: KEPT }),
  event(9, "rolled_back", { by: "ana", from: NEWER, to: KEPT }),
  ...Array.from(
    { length: 18 },
    (_, index) =>
      event(10 + index, "updated", { by: "ana", from: KEPT, to: KEPT }),
  ),
  event(28, "installed", { to: KEPT }),
];

type Options = {
  failure?: ReturnType<typeof event> | null;
  healthy?: boolean;
  dates?: boolean;
  empty?: boolean;
  held?: number;
  statusCode?: number;
  restoreHeld?: boolean;
};

async function updatesFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const failure = options.failure === undefined ? HISTORY[0] : options.failure;
  const state = { failure, dismissed: [] as string[] };
  const settings = {
    registrationMode: "invitation",
    organizationCreationPolicy: "installation_admins",
    updateFailurePolicy: "go_back",
    version: 3,
    updatedByPrincipalId: null,
    updatedAt: "2026-11-01T10:00:00.000Z",
  };
  const writes: { body: unknown; ifMatch: string | undefined }[] = [];
  let changedElsewhere = false;
  await page.route("**/v1/installation/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bootstrapped: true,
        restoreHeld: options.restoreHeld ?? false,
        updatePaused: false,
        release: RUNNING,
      }),
    }));
  await page.route(
    (url) => url.pathname === "/v1/installation/updates/status",
    (route) => {
      if (options.statusCode !== undefined) {
        return route.fulfill({
          status: options.statusCode,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Refused",
            detail: "Refused.",
            status: options.statusCode,
            code: options.statusCode === 403
              ? "AUTH_FORBIDDEN"
              : "DEPENDENCY_UNAVAILABLE",
            retryable: false,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      const dates = options.dates ?? true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runningRelease: RUNNING,
          runningSince: dates ? "2026-11-20T09:30:00.000Z" : null,
          healthy: options.healthy ?? true,
          previousRelease: KEPT,
          previousRanFrom: dates ? "2026-11-02T08:00:00.000Z" : null,
          previousRanUntil: "2026-11-20T09:30:00.000Z",
          lastFailure: state.failure,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/updates",
    (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      const items = options.empty
        ? []
        : cursor === "page-2"
        ? HISTORY.slice(25)
        : HISTORY.slice(0, 25);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items,
          nextCursor: options.empty || cursor === "page-2" ? null : "page-2",
        }),
      });
    },
  );
  await page.route(
    (url) => /^\/v1\/installation\/updates\/[^/]+\/dismiss$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[4] ?? "";
      state.dismissed.push(id);
      const dismissed = {
        ...(state.failure ?? HISTORY[0]),
        dismissedAt: new Date().toISOString(),
      };
      state.failure = null;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(dismissed),
      });
    },
  );
  await page.route(
    "**/v1/installation/uncertain-actions",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          (options.held ?? 0) === 0
            ? { kinds: [], total: 0 }
            : options.held === 1
            ? {
              kinds: [{
                operation: "github.issue.create",
                count: 1,
                since: "2026-11-21T02:10:00.000Z",
              }],
              total: 1,
            }
            : {
              kinds: [
                {
                  operation: "github.issue.create",
                  count: (options.held ?? 0) - 1,
                  since: "2026-11-21T02:10:00.000Z",
                },
                {
                  operation: "slack.message.post",
                  count: 1,
                  since: "2026-11-21T02:12:00.000Z",
                },
              ],
              total: options.held,
            },
        ),
      }),
  );
  await page.route("**/v1/installation/settings", (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      writes.push({
        body: request.postDataJSON(),
        ifMatch: request.headers()["if-match"],
      });
      if (changedElsewhere) {
        settings.version++;
        changedElsewhere = false;
        return route.fulfill({
          status: 412,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Changed",
            detail: "Changed.",
            status: 412,
            code: "PRECONDITION_FAILED",
            retryable: false,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      Object.assign(settings, request.postDataJSON());
      settings.version++;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(settings),
    });
  });
  return {
    state,
    writes,
    changeElsewhere: () => {
      changedElsewhere = true;
    },
  };
}

for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: updates`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("an update that went back: the notice, the facts and the history", async ({ page }) => {
      const fixture = await updatesFixture(page, { held: 3 });
      await page.goto("/installation/updates");
      await expect(page.getByRole("heading", { name: "Updates", level: 1 }))
        .toBeVisible();
      const notice = page.locator("[data-failure='went_back']");
      await expect.poll(() => said(notice)).toContain(
        "The update to c3e5a7b9 did not go through",
      );
      await expect.poll(() => said(notice)).toContain(
        "the new version did not become ready, so Bakery went back to 4f2a9c1e by itself. Paused work carried on.",
      );
      await expect.poll(() => said(notice)).toContain(
        "3 outside actions are held until someone checks them.",
      );
      await expect(notice.getByRole("button", { name: "See them" }))
        .toBeVisible();
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("4f2a9c1e · since");
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("Healthy");
      await expect.poll(() => said(page.locator("[data-fact='previous']")))
        .toMatch(/9b81d3f0 · ran .+ to /);
      await expect.poll(() => said(page.locator("[data-fact='started']")))
        .toContain("bakery-release deploy");
      await expect(
        page.getByRole("heading", { name: "3 outside actions are held" }),
      ).toBeVisible();
      // No search field: the list read has none.
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      const rows = page.locator("[data-event]");
      await expect(rows).toHaveCount(25);
      await expect.poll(() => said(rows.first())).toContain(
        "Update to c3e5a7b9 did not become ready. Bakery went back to 4f2a9c1e.",
      );
      await expect.poll(() => said(rows.first())).toContain("Went back");
      await expect.poll(() => said(rows.first())).toContain(
        "Bakery, by itself",
      );
      // The update a later choice stayed on reads as Not ready.
      await expect.poll(() => said(rows.nth(4))).toContain("Not ready");
      await expect.poll(() => said(rows.nth(4))).toContain(
        "Updated from 9b81d3f0 to 4f2a9c1e, but 4f2a9c1e did not become ready.",
      );
      await expect.poll(() => said(rows.nth(3))).toContain(
        "ana chose to stay on 4f2a9c1e.",
      );
      await expect.poll(() => said(rows.nth(3))).toContain(
        "ana, on the server",
      );
      await expect.poll(() => said(rows.nth(6))).toContain(
        "No one could be asked, so Bakery stayed on c3e5a7b9.",
      );
      await expect.poll(() => said(rows.nth(7))).toContain("Interrupted");
      await expect.poll(() => said(rows.nth(8))).toContain("Went back by hand");
      // A full stop after a release stays on the release's line.
      const joined = rows.first().locator("[data-trailing='.']").last();
      await expect.poll(() => said(joined)).toBe("4f2a9c1e.");
      expect(
        await joined.evaluate((element) =>
          getComputedStyle(element).whiteSpace
        ),
      ).toBe("nowrap");
      const action = notice.getByRole("button", { name: "Dismiss" });
      const text = notice.getByText("Paused work carried on.", {
        exact: false,
      });
      const actionBox = (await action.boundingBox())!;
      const textBox = (await text.boundingBox())!;
      const noticeBox = (await notice.boundingBox())!;
      if (viewport.name === "phone") {
        // The notice's buttons sit on their own row under the text, sharing the width.
        expect(actionBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
        const see = (await notice.getByRole("button", { name: "See them" })
          .boundingBox())!;
        expect(Math.abs(see.width - actionBox.width)).toBeLessThan(2);
        expect(see.width + actionBox.width).toBeGreaterThan(
          noticeBox.width * 0.6,
        );
        // Held actions are stacked rows, not a three-column table.
        await expect(page.getByRole("table")).toHaveCount(0);
        const held = page.locator("[data-held]");
        await expect(held).toHaveCount(2);
        await expect.poll(() => said(held.first())).toContain(
          "github.issue.create",
        );
        await expect.poll(() => said(held.first())).toMatch(
          /2 held since Nov 2[01], 2026/,
        );
      } else {
        // Desktop is unchanged: the buttons sit beside the text.
        expect(actionBox.x).toBeGreaterThan(textBox.x + textBox.width - 1);
        await expect(page.getByRole("table")).toHaveCount(2);
        await expect(page.locator("[data-held]")).toHaveCount(0);
      }
      await page.mouse.move(5, 5);
      await still(page, "updates-went-back");
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(rows).toHaveCount(28);
      await expect.poll(() => said(rows.last())).toContain(
        "Installed 9b81d3f0.",
      );
      await expect(page.getByRole("button", { name: "Load more" }))
        .toHaveCount(0);
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await expect(notice).toHaveCount(0);
      expect(fixture.state.dismissed).toEqual([HISTORY[0]!.id]);
      // The row stays in the history.
      await expect.poll(() => said(rows.first())).toContain("Went back");
    });

    test("staying on a release that is not ready, with missing dates", async ({ page }) => {
      await updatesFixture(page, {
        failure: event(4, "decided_stay", {
          by: "ana",
          from: RUNNING,
          to: KEPT,
        }),
        healthy: false,
        dates: false,
      });
      await page.goto("/installation/updates");
      const notice = page.locator("[data-failure='decided_stay']");
      await expect.poll(() => said(notice)).toContain(
        "Bakery is running 4f2a9c1e, which did not become ready",
      );
      await expect.poll(() => said(notice)).toContain(
        "ana chose on the server to stay on it. To go back, run bakery-release rollback on the server.",
      );
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("Not healthy");
      await expect.poll(() => said(page.locator("[data-fact='running']"))).not
        .toContain("since");
      await expect.poll(() => said(page.locator("[data-fact='previous']")))
        .toMatch(/9b81d3f0 · ran until /);
      await expect.poll(() => said(page.locator("[data-notice='not-healthy']")))
        .toContain(
          "Bakery answers, but its health check fails. On the server, run bakery-release status.",
        );
      await page.mouse.move(5, 5);
      await still(page, "updates-stayed-not-healthy");
    });

    test("the policy saves the whole settings with its version, and says when someone else changed it", async ({ page }) => {
      const fixture = await updatesFixture(page, { failure: null });
      await page.goto("/installation/updates");
      const save = page.getByRole("button", { name: "Save" });
      await expect(page.getByRole("radio", { name: "Go back by itself" }))
        .toBeChecked();
      await expect(save).toBeDisabled();
      await page.getByRole("radio", { name: "Stop and ask" }).check();
      await expect(save).toBeEnabled();
      await save.click();
      const policy = page.locator("[data-section='policy']");
      const savedToast = policy.locator("[data-result='saved']");
      await expect(savedToast).toHaveText(
        /Saved\. It applies from the next update\./,
      );
      // The answer to Save sits right under the button, inside the section.
      const saveBox = (await save.boundingBox())!;
      const savedBox = (await savedToast.boundingBox())!;
      expect(savedBox.y).toBeGreaterThanOrEqual(saveBox.y + saveBox.height);
      expect(savedBox.y - (saveBox.y + saveBox.height)).toBeLessThan(40);
      expect(fixture.writes).toEqual([{
        body: {
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
          updateFailurePolicy: "ask",
        },
        ifMatch: '"v3"',
      }]);
      await expect(save).toBeDisabled();
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-saved");
      fixture.changeElsewhere();
      await page.getByRole("radio", { name: "Go back by itself" }).check();
      await save.click();
      await expect(
        page.getByText(
          "Someone else changed this just now. The latest is shown.",
        ),
      ).toBeVisible();
      expect(fixture.writes[1]?.ifMatch).toBe('"v4"');
      const conflict = policy.locator("[data-result='conflict']");
      await expect(conflict).toBeVisible();
      const conflictBox = (await conflict.boundingBox())!;
      expect(conflictBox.y).toBeGreaterThanOrEqual(saveBox.y + saveBox.height);
      // Changing the choice clears the saved message.
      await expect(savedToast).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-conflict");
    });

    test("one held action is named in the singular", async ({ page }) => {
      await updatesFixture(page, { held: 1 });
      await page.goto("/installation/updates");
      const notice = page.locator("[data-failure='went_back']");
      await expect.poll(() => said(notice)).toContain(
        "1 outside action is held until someone checks it.",
      );
      await expect(notice.getByRole("button", { name: "See it" }))
        .toBeVisible();
      await expect(
        page.getByRole("heading", { name: "1 outside action is held" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "It may or may not have happened. Bakery never sends it again; it is checked first.",
        ),
      ).toBeVisible();
    });

    test("held after a restore: the policy cannot change, with the way out", async ({ page }) => {
      await updatesFixture(page, { failure: null, restoreHeld: true });
      await page.goto("/installation/updates");
      await expect(
        page.getByText(
          "Bakery is held after a restore. Finish the restore first.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("radio", { name: "Stop and ask" }))
        .toBeDisabled();
      await expect(page.getByRole("button", { name: "Finish the restore" }))
        .toBeVisible();
    });

    test("no updates yet", async ({ page }) => {
      await updatesFixture(page, { failure: null, empty: true });
      await page.goto("/installation/updates");
      await expect(page.getByRole("heading", { name: "No updates yet" }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Load more" }))
        .toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-empty");
    });

    test("a failed read offers Try again; someone who is not an administrator is not shown the page", async ({ page }) => {
      await updatesFixture(page, { statusCode: 503 });
      await page.goto("/installation/updates");
      await expect(page.getByText("Updates could not be loaded."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await page.mouse.move(5, 5);
      await still(page, "updates-error");
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await updatesFixture(page, { statusCode: 403 });
      await page.goto("/installation/updates");
      await expect(
        page.getByRole("heading", { name: "This page was not found" }),
      )
        .toBeVisible();
      // The no-access title reads as a title, as on Usage.
      await expect(
        page.locator("[data-ui-component='emptyState']"),
      ).toHaveAttribute("data-title-style", "heading");
      await expect(page.getByRole("link", { name: "Updates" })).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-forbidden");
    });
  });
}
