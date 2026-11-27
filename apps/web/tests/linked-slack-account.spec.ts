import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

type Link = Record<string, unknown>;

const NOT_LINKED = {
  connection: "working",
  state: "not_linked",
  workspaceName: "Acme Engineering",
};
const LINKED = {
  ...NOT_LINKED,
  state: "linked",
  linkedAt: "2026-11-12T10:00:00.000Z",
};
const AUTHORIZE = "/slack-sign-in-stand-in";

async function security(
  page: Page,
  { link, role = "admin", query = "" }: {
    readonly link: Link;
    readonly role?: string;
    readonly query?: string;
  },
) {
  await mockAuthenticatedSession(page);
  const server = { link, reads: 0, unlinks: 0, starts: 0 };
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill({
        json: {
          organizationId: MOCK_ORGANIZATION_ID,
          role,
          capabilities: [],
        },
      }),
  );
  await page.route("**/v1/me/slack-link", (route) => {
    if (route.request().method() === "DELETE") {
      server.unlinks += 1;
      server.link = NOT_LINKED;
    } else server.reads += 1;
    return route.fulfill({ json: server.link });
  });
  await page.route("**/v1/me/slack-link/attempts", (route) => {
    server.starts += 1;
    return route.fulfill({
      status: 201,
      json: {
        authorizationUrl: new URL(AUTHORIZE, route.request().url()).href,
        expiresAt: "2026-11-12T10:15:00.000Z",
      },
    });
  });
  await page.goto(`/settings/security${query}`);
  await expect(page.getByTestId("security-hub")).toBeVisible();
  return server;
}

const section = (page: Page) => page.getByTestId("linked-accounts");

test("an unlinked member is sent to Slack's sign-in address", async ({ page }) => {
  const server = await security(page, { link: NOT_LINKED });
  await expect(section(page)).toContainText(
    "Not linked. Link it to approve work and message agents from Slack as yourself.",
  );
  await still(page, "slack-link-not-linked");
  await section(page).getByRole("button", { name: "Link Slack" }).click();
  await expect(page).toHaveURL(new RegExp(`${AUTHORIZE}$`));
  expect(server.starts).toBe(1);
});

test("coming back linked says so, and unlinking asks first", async ({ page }) => {
  const server = await security(page, {
    link: LINKED,
    query: "?slackLink=linked#slack",
  });
  await expect(section(page).getByRole("status")).toContainText(
    "Slack is linked. You can now approve work and message agents from Slack.",
  );
  await expect(section(page)).toContainText(
    "Linked to Acme Engineering on Nov 12, 2026.",
  );
  await still(page, "slack-link-linked");
  await section(page).getByRole("button", { name: "Unlink Slack" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Unlink Slack?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(server.unlinks).toBe(0);
  await still(page, "slack-link-unlink-dialog");
  await dialog.getByRole("button", { name: "Unlink" }).click();
  await expect(section(page)).toContainText("Slack is unlinked.");
  await expect(section(page).getByRole("button", { name: "Link Slack" }))
    .toBeVisible();
  expect(server.unlinks).toBe(1);
});

test("the result is said once, so a reload cannot contradict the row", async ({ page }) => {
  await security(page, { link: LINKED, query: "?slackLink=linked#slack" });
  await expect(section(page).getByRole("status")).toContainText(
    "Slack is linked.",
  );
  await expect(page).toHaveURL(/\/settings\/security#slack$/);
  await expect(section(page).getByRole("status")).toContainText(
    "Slack is linked.",
  );
  await section(page).getByRole("button", { name: "Unlink Slack" }).click();
  await page.getByRole("alertdialog", { name: "Unlink Slack?" })
    .getByRole("button", { name: "Unlink" }).click();
  await expect(section(page)).toContainText("Slack is unlinked.");
  await page.reload();
  await expect(section(page).getByRole("button", { name: "Link Slack" }))
    .toBeVisible();
  await expect(section(page)).not.toContainText("Slack is linked.");
});

for (
  const [result, sentence] of [
    ["link_refused", "already linked to another member of Fixture Org"],
    [
      "wrong_workspace",
      "Sign in to Acme Engineering and try again.",
    ],
    ["expired", "That attempt ran out of time. Start again."],
  ] as const
) {
  test(`the return result ${result} is explained`, async ({ page }) => {
    await security(page, {
      link: NOT_LINKED,
      query: `?slackLink=${result}#slack`,
    });
    await expect(section(page)).toContainText(sentence);
  });
}

test("an administrator is shown where to fix a connection that is not working", async ({ page }) => {
  await security(page, {
    link: { connection: "not_working", state: "not_linked" },
  });
  await expect(section(page)).toContainText(
    "Slack is disconnected for Fixture Org right now, so there is nothing to link.",
  );
  await expect(
    section(page).getByRole("link", { name: "Open Slack in Integrations" }),
  ).toBeVisible();
  await expect(section(page).getByRole("button")).toHaveCount(0);
  await still(page, "slack-link-disconnected");
});

test("a developer is told Slack is not connected, with nothing to press", async ({ page }) => {
  await security(page, {
    link: { connection: "none", state: "not_linked" },
    role: "developer",
  });
  await expect(section(page)).toContainText(
    "Fixture Org has not connected Slack, so there is nothing to link yet.",
  );
  await expect(section(page).getByRole("link")).toHaveCount(0);
});

test("a link an administrator removed says when", async ({ page }) => {
  await security(page, {
    link: {
      ...NOT_LINKED,
      state: "removed_by_admin",
      removedAt: "2026-11-20T10:00:00.000Z",
    },
  });
  await expect(section(page)).toContainText(
    "An administrator removed this link on Nov 20, 2026. Link again to act from Slack.",
  );
});

test("a viewer can link too, and is offered no integrations link", async ({ page }) => {
  await security(page, { link: NOT_LINKED, role: "viewer" });
  await expect(section(page).getByRole("button", { name: "Link Slack" }))
    .toBeVisible();
  await expect(section(page).getByRole("link")).toHaveCount(0);
});
