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
  /** An update is running: the launcher has paused work. */
  updatePaused?: boolean;
  /** The saved choice for what happens when an update fails; "go_back" when absent. */
  policy?: "go_back" | "ask";
  /** The updates status answer waits for this, so the loading state shows. */
  hold?: Promise<void>;
};

async function updatesFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const failure = options.failure === undefined ? HISTORY[0] : options.failure;
  const state = { failure, dismissed: [] as string[] };
  const settings = {
    registrationMode: "invitation",
    organizationCreationPolicy: "installation_admins",
    updateFailurePolicy: options.policy ?? "go_back",
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
        updatePaused: options.updatePaused ?? false,
        release: RUNNING,
      }),
    }));
  await page.route(
    (url) => url.pathname === "/v1/installation/updates/status",
    async (route) => {
      await options.hold;
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
      // The held count is said once, in its section: never in the notice.
      await expect.poll(() => said(notice)).not.toContain("held");
      await expect(notice.getByRole("button", { name: /^See / }))
        .toHaveCount(0);
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("4f2a9c1e · since");
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("Healthy");
      await expect.poll(() => said(page.locator("[data-fact='previous']")))
        .toMatch(/9b81d3f0 · ran .+ to /);
      await expect.poll(() => said(page.locator("[data-fact='started']")))
        .toContain("bakery-release deploy");
      await expect(
        page.getByRole("heading", { name: "Held outside actions" }),
      ).toBeVisible();
      // The held section sits right under the facts, above the policy.
      const heldBox = (await page.locator("[data-section='held']")
        .boundingBox())!;
      const policyBox = (await page.locator("[data-section='policy']")
        .boundingBox())!;
      expect(heldBox.y).toBeLessThan(policyBox.y);
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
        // The notice's button sits on its own row under the text, across the width.
        expect(actionBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
        expect(actionBox.width).toBeGreaterThan(noticeBox.width * 0.6);
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

    test("not healthy after a stay decision: one notice, both commands, no Dismiss", async ({ page }) => {
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
      const notice = page.locator("[data-notice='not-healthy']");
      await expect.poll(() => said(notice)).toContain(
        "Bakery's health check fails",
      );
      await expect.poll(() => said(notice)).toContain(
        "Bakery answers, but 4f2a9c1e is not healthy. On the server, run bakery-release status.",
      );
      await expect.poll(() => said(notice)).toMatch(
        /ana chose to stay on it\. To go back, run bakery-release rollback\./,
      );
      // One notice slot: the stay notice is not drawn beside it, and nothing here is dismissed.
      await expect(page.locator("[data-failure]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Dismiss" }))
        .toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(1);
      await expect.poll(() => said(page.locator("[data-fact='running']")))
        .toContain("Not healthy");
      await expect.poll(() => said(page.locator("[data-fact='running']"))).not
        .toContain("since");
      await expect.poll(() => said(page.locator("[data-fact='previous']")))
        .toMatch(/9b81d3f0 · ran until /);
      await page.mouse.move(5, 5);
      await still(page, "updates-stayed-not-healthy");
    });

    test("not healthy with no failure to explain: the health notice alone", async ({ page }) => {
      await updatesFixture(page, { failure: null, healthy: false });
      await page.goto("/installation/updates");
      const notice = page.locator("[data-notice='not-healthy']");
      await expect.poll(() => said(notice)).toContain(
        "Bakery answers, but 4f2a9c1e is not healthy. On the server, run bakery-release status.",
      );
      await expect.poll(() => said(notice)).not.toContain("chose to stay");
      await expect(page.getByRole("button", { name: "Dismiss" }))
        .toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-not-healthy");
    });

    test("a stay decision on a healthy release is a notice that can be dismissed", async ({ page }) => {
      await updatesFixture(page, {
        failure: event(4, "decided_stay", {
          by: "ana",
          from: RUNNING,
          to: KEPT,
        }),
      });
      await page.goto("/installation/updates");
      const notice = page.locator("[data-failure='decided_stay']");
      await expect.poll(() => said(notice)).toContain(
        "ana chose on the server to stay on it. To go back, run bakery-release rollback on the server.",
      );
      await expect(page.locator("[data-notice='not-healthy']"))
        .toHaveCount(0);
      await expect(notice.getByRole("button", { name: "Dismiss" }))
        .toBeVisible();
      await page.mouse.move(5, 5);
      await still(page, "updates-stayed-healthy");
    });

    for (
      const kind of [
        {
          name: "chose to go back",
          failure: event(6, "decided_go_back", {
            by: "ana",
            from: NEWER,
            to: KEPT,
          }),
          attribute: "decided_go_back",
          title: "The update to c3e5a7b9 did not go through",
          body:
            "the new version did not become ready. Bakery waited, and ana chose to go back to 9b81d3f0 on the server.",
          still: "updates-decided-go-back",
        },
        {
          name: "was interrupted",
          failure: event(8, "interrupted", { from: NEWER, to: KEPT }),
          attribute: "interrupted",
          title: "The switch to c3e5a7b9 was interrupted",
          body:
            "the switch did not finish. bakery-release recover put 9b81d3f0 back.",
          still: "updates-interrupted",
        },
        {
          name: "stayed with nobody to ask",
          failure: event(7, "decided_stay", { from: RUNNING, to: KEPT }),
          attribute: "decided_stay",
          title: "Bakery is running 4f2a9c1e, which did not become ready",
          body:
            "no one could be asked, so Bakery stayed on it. To go back, run bakery-release rollback on the server.",
          still: "updates-stayed-nobody",
        },
      ]
    ) {
      test(`the notice for an update that ${kind.name}`, async ({ page }) => {
        await updatesFixture(page, { failure: kind.failure });
        await page.goto("/installation/updates");
        const notice = page.locator(`[data-failure='${kind.attribute}']`);
        await expect.poll(() => said(notice)).toContain(kind.title);
        await expect.poll(() => said(notice)).toContain(kind.body);
        await expect(notice.getByRole("button", { name: "Dismiss" }))
          .toBeVisible();
        await page.mouse.move(5, 5);
        await still(page, kind.still);
      });
    }

    test("the policy saves the whole settings with its version, and says when someone else changed it", async ({ page }) => {
      const fixture = await updatesFixture(page, { failure: null });
      await page.goto("/installation/updates");
      const save = page.getByRole("button", { name: "Save" });
      await expect(page.getByRole("radio", { name: "Go back by itself" }))
        .toBeChecked();
      // Nothing to save, so no Save is drawn.
      await expect(save).toHaveCount(0);
      await page.getByRole("radio", { name: "Stop and ask" }).check();
      await expect(save).toBeEnabled();
      const saveBox = (await save.boundingBox())!;
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-changed");
      await save.click();
      const policy = page.locator("[data-section='policy']");
      const savedToast = policy.locator("[data-result='saved']");
      await expect(savedToast).toHaveText(
        /Saved\. It applies from the next update\./,
      );
      // The answer to Save takes the button's place, inside the section.
      const savedBox = (await savedToast.boundingBox())!;
      expect(Math.abs(savedBox.y - saveBox.y)).toBeLessThan(40);
      expect(fixture.writes).toEqual([{
        body: {
          registrationMode: "invitation",
          organizationCreationPolicy: "installation_admins",
          updateFailurePolicy: "ask",
        },
        ifMatch: '"v3"',
      }]);
      await expect(save).toHaveCount(0);
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
      expect(Math.abs(conflictBox.y - saveBox.y)).toBeLessThan(80);
      // Changing the choice clears the saved message.
      await expect(savedToast).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-conflict");
    });

    test("one held action is named in the singular", async ({ page }) => {
      await updatesFixture(page, { held: 1 });
      await page.goto("/installation/updates");
      const notice = page.locator("[data-failure='went_back']");
      await expect.poll(() => said(notice)).not.toContain("held");
      await expect(notice.getByRole("button", { name: /^See / }))
        .toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Held outside actions" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "It may or may not have happened. Bakery never sends it again; it is checked first.",
        ),
      ).toBeVisible();
      await page.mouse.move(5, 5);
      await still(page, "updates-held-one");
    });

    test("held after a restore: the choice is plain text, with the way out, and the hold is said once", async ({ page }) => {
      await updatesFixture(page, { failure: null, restoreHeld: true });
      await page.goto("/installation/updates");
      const policy = page.locator("[data-section='policy']");
      const row = policy.locator("[data-policy-locked='held']");
      await expect.poll(() => said(row)).toContain("Go back by itself");
      await expect.poll(() => said(row)).toContain(
        "Bakery returns to the version that was running and resumes work.",
      );
      await expect(row.getByRole("button", { name: "Finish the restore" }))
        .toBeVisible();
      await expect.poll(() => said(policy)).toContain(
        "You can change this after the restore is finished.",
      );
      // No radios, faded or not, and no second sentence about the hold.
      await expect(policy.getByRole("radio")).toHaveCount(0);
      await expect(policy.getByRole("radiogroup")).toHaveCount(0);
      await expect(page.getByText("Bakery is held after a restore"))
        .toHaveCount(1);
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-restore-held");
    });

    test("a release id is plain text with a card: the whole id and Copy, closed with Escape", async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"])
        .catch(() => {});
      await updatesFixture(page, { failure: null });
      await page.goto("/installation/updates");
      const running = page.locator("[data-fact='running']");
      const reference = running.locator("[data-ui-component='reference']");
      await expect(reference).toHaveAttribute("data-linked", "false");
      await expect.poll(() => said(reference)).toBe("4f2a9c1e");
      // No link: a release has no page.
      await expect(reference.getByRole("link")).toHaveCount(0);
      // Keyboard focus opens the card with the whole id; the next Tab is Copy.
      await page.keyboard.press("Tab");
      await reference.locator(".ui-reference__plain").focus();
      const card = reference.getByRole("group", { name: "Release" });
      await expect(card).toBeVisible();
      await expect.poll(() => said(card)).toContain(RUNNING);
      await page.keyboard.press("Tab");
      await expect(card.getByRole("button", { name: "Copy" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await page.mouse.move(5, 5);
      await reference.locator(".ui-reference__plain").focus();
      await still(page, "updates-release-card");
    });

    test("an update is running: the saved choice is plain text and the hint says when it unlocks", async ({ page }) => {
      await updatesFixture(page, {
        failure: null,
        updatePaused: true,
        policy: "ask",
      });
      await page.goto("/installation/updates");
      const policy = page.locator("[data-section='policy']");
      const row = policy.locator("[data-policy-locked='paused']");
      await expect.poll(() => said(row)).toContain("Stop and ask");
      await expect.poll(() => said(row)).toContain(
        "Bakery stays stopped until an administrator decides on the server. Work waits.",
      );
      // The other choice is not drawn, and there is no button: nothing to do but wait.
      await expect(row).not.toContainText("Go back by itself");
      await expect(row.getByRole("button")).toHaveCount(0);
      await expect.poll(() => said(policy)).toContain(
        "You can change this when the update ends.",
      );
      await expect(policy.getByRole("radio")).toHaveCount(0);
      await expect(page.getByText("An update is running")).toHaveCount(0);
      await expect(page.getByText("Bakery is about to be updated"))
        .toHaveCount(1);
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-policy-update-running");
    });

    test("while the page loads, rows stand in and it says it is loading", async ({ page }) => {
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      await updatesFixture(page, { hold });
      await page.goto("/installation/updates");
      const loading = page.getByLabel("Loading updates");
      await expect(loading).toBeVisible();
      await expect(loading).toHaveAttribute("aria-busy", "true");
      await page.mouse.move(5, 5);
      await still(page, "updates-loading");
      release();
      await expect(page.locator("[data-fact='running']")).toBeVisible();
      await expect(loading).toHaveCount(0);
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
      const titleX = (await page.getByRole("heading", {
        name: "Updates",
        level: 1,
      }).boundingBox())!.x;
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
      // Title and line start at the page column's edge, where Updates' title sits.
      const headline = (await page.getByRole("heading", {
        name: "This page was not found",
      }).boundingBox())!;
      const line = (await page.getByText(
        "It may not exist, or you may not have access to it.",
      ).boundingBox())!;
      expect(Math.abs(headline.x - titleX)).toBeLessThan(2);
      expect(Math.abs(line.x - titleX)).toBeLessThan(2);
      await expect(page.getByRole("link", { name: "Updates" })).toHaveCount(0);
      await page.mouse.move(5, 5);
      await still(page, "updates-forbidden");
    });
  });
}
