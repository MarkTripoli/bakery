import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";
import { submitUntilAccepted } from "./helpers/api-retry.ts";
import { laneBudgetMs } from "./helpers/lane-budget.ts";

const enabled = process.env.BAKERY_REAL_API === "1";
const ADMIN_EMAIL = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase() ||
  "browser-admin@example.test";
const ADMIN_PASSWORD = process.env.BAKERY_REAL_PASSWORD ||
  "Browser-Admin-Passw0rd-1";
const TEAMMATE_EMAIL = "collab-dana@example.test";
const TEAMMATE_NAME = "Dana Teammate";

const helper = (name: string) =>
  fileURLToPath(new URL(`../../../tests/helpers/${name}.ts`, import.meta.url));

function deno(file: string, args: string[], env: Record<string, string> = {}) {
  const output = execFileSync("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-net",
    helper(file),
    ...args,
  ], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "null") as unknown;
}

const documentSchema = z.object({
  organizationId: z.string().uuid().describe(
    "The organization of the seeded document",
  ),
  taskId: z.string().uuid().describe("The task the seeded document belongs to"),
  artifactId: z.string().uuid().describe("The seeded document"),
  versionId: z.string().uuid().describe("The first published version"),
  text: z.string().describe("The text of the first version"),
}).describe("The seeded document the two people edit");

const memberSchema = z.object({
  cookieName: z.string().describe("The session cookie's name"),
  cookieValue: z.string().describe("The signed session cookie's value"),
}).describe("The seeded teammate's live session");

const versionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid().describe("The version's id"),
      revision: z.number().describe("The version's number"),
    }).passthrough().describe("One published version of the document"),
  ).describe("Every published version of the document"),
}).describe("The document's versions");

const documentText = (editor: Locator) =>
  editor.evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    for (
      const label of copy.querySelectorAll(".ui-document-editor__caret-label")
    ) {
      label.remove();
    }
    return [...copy.querySelectorAll(".cm-line")]
      .map((line) => line.textContent ?? "").join("\n");
  });

const editorOf = (page: Page) =>
  page.getByRole("textbox", { name: "Document text" });

async function openEditor(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
  await page.getByTestId("artifact-edit-toggle").click();
  const editor = editorOf(page);
  await expect(editor).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible();
  return editor;
}

test.describe("collaborative documents against the real API", () => {
  test.skip(!enabled, "needs the real API stack (BAKERY_REAL_API=1)");

  test("two people converge on one text, and a publish keeps its cutoff", async ({ browser, baseURL }) => {
    test.setTimeout(laneBudgetMs(180_000));
    const origin = new URL(baseURL!).origin;
    deno("web-auth-seed", [ADMIN_EMAIL], {
      WEB_AUTH_SEED_PASSWORD: ADMIN_PASSWORD,
    });
    const seeded = documentSchema.parse(
      deno("web-document-seed", [ADMIN_EMAIL]),
    );
    const member = memberSchema.parse(
      deno("web-member-seed", [ADMIN_EMAIL, TEAMMATE_EMAIL, TEAMMATE_NAME]),
    );
    const path = `/tasks/${seeded.taskId}/artifacts/${seeded.artifactId}`;

    const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const admin = await adminContext.newPage();
    await admin.goto("/sign-in");
    await submitUntilAccepted(admin, "/api/auth/sign-in/email", async () => {
      await admin.getByLabel("Email").fill(ADMIN_EMAIL);
      await admin.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
      await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    });
    await expect(admin).toHaveURL("/");
    const teammateContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await teammateContext.addCookies([{
      name: member.cookieName,
      value: member.cookieValue,
      url: origin,
    }]);
    const teammate = await teammateContext.newPage();
    const adminName =
      (await (await admin.request.get("/v1/me/profile")).json() as {
        name: string;
      }).name;

    try {
      const adminEditor = await openEditor(admin, path);
      const teammateEditor = await openEditor(teammate, path);

      await expect(
        admin.getByRole("group", { name: "People in this document" }),
      )
        .toContainText(TEAMMATE_NAME);
      await expect(
        teammate.getByRole("group", { name: "People in this document" }),
      ).toContainText(adminName);

      await adminEditor.click();
      await admin.keyboard.press("Control+End");
      await teammateEditor.click();
      await teammate.keyboard.press("Control+Home");
      await Promise.all([
        admin.keyboard.insertText(" [admin]"),
        teammate.keyboard.insertText("[dana] "),
      ]);
      for (const editor of [adminEditor, teammateEditor]) {
        await expect(editor).toContainText("[dana] ");
        await expect(editor).toContainText("[admin]");
      }
      const adminText = await documentText(adminEditor);
      await expect.poll(() => documentText(teammateEditor)).toBe(adminText);
      await expect(admin.getByText("All changes saved")).toBeVisible();
      await expect(teammate.getByText("All changes saved")).toBeVisible();
      const converged = adminText;

      await teammateEditor.click();
      await teammate.keyboard.press("Control+End");
      await admin.getByTestId("artifact-publish").click();
      const dialog = admin.getByRole("alertdialog");
      await expect(dialog.getByRole("button", { name: "Publish version 2" }))
        .toBeEnabled();
      await Promise.all([
        dialog.getByRole("button", { name: "Publish version 2" }).click(),
        teammate.keyboard.insertText(" [late]"),
      ]);

      const headers = {
        "bakery-organization-id": seeded.organizationId,
        origin,
      };
      let versions = versionsSchema.parse({ items: [] });
      await expect.poll(async () => {
        const response = await admin.request.get(
          `/v1/artifacts/${seeded.artifactId}/versions`,
          { headers },
        );
        versions = versionsSchema.parse(await response.json());
        return versions.items.length;
      }, { timeout: 30_000 }).toBe(2);
      const byRevision = new Map(
        versions.items.map((version) => [version.revision, version.id]),
      );
      const read = async (versionId: string) =>
        await (await admin.request.get(
          `/v1/artifact-versions/${versionId}/content`,
          { headers },
        )).text();

      expect(await read(byRevision.get(1)!)).toBe(seeded.text);
      const published = await read(byRevision.get(2)!);
      expect([converged, converged + " [late]"]).toContain(published);
    } finally {
      await adminContext.close();
      await teammateContext.close();
    }
  });
});
