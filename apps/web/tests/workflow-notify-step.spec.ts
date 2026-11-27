import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import {
  DANA,
  DESIGNERS,
  field,
  lastCard,
  savedInput,
  type Step,
  stepEditor,
} from "./helpers/step-editor.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

const DESIGN: Step = { id: "design", uses: "rpi.design" };

test.describe("workflow editor: Notify", () => {
  test("a new Notify step tells the starter and does not wait", async ({ page }) => {
    const server = await stepEditor(page);
    await page.getByRole("button", { name: /Add a step after/ }).last().click();
    const picker = page.getByTestId("step-picker");
    await expect(picker.locator("[data-pick-step='people.tag']"))
      .toContainText("Tell someone, or ask them, and carry on.");
    await picker.locator("[data-pick-step='people.tag']").click();
    await expect(field(page, "Who is asked")).toHaveValue("run:starter");
    await expect(page.getByRole("switch", { name: "Wait for an answer" }))
      .toBeDisabled();
    await expect(page.getByRole("switch", { name: "If nobody answers" }))
      .toHaveCount(0);
    await expect(lastCard(page)).toContainText(
      "Tells the person who started the run · does not wait",
    );
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toEqual({
        recipientRunRole: "starter",
        intent: "fyi",
      });
    await still(page, "notify-new");
  });

  test("a waiting review asks a group, then one more, and is saved as the engine reads it", async ({ page }) => {
    const server = await stepEditor(page, {
      steps: [DESIGN, {
        id: "ask",
        uses: "people.tag",
        with: { recipientRunRole: "starter", intent: "fyi" },
      }],
    });
    await page.locator("[data-card='ask']").click();
    await field(page, "Who is asked").selectOption(`group:${DESIGNERS}`);
    await field(page, "What they need to do").selectOption("review");
    await expect(page.getByText("Choose the document to review.").first())
      .toBeVisible();
    await field(page, "Works from").selectOption("design");
    await page.getByRole("switch", { name: "Wait for an answer" }).check();
    await page.getByRole("switch", { name: "If nobody answers" }).check();
    await expect(
      page.getByText("Choose who is asked next, or turn this off.").first(),
    ).toBeVisible();
    await field(page, "Ask").selectOption(`group:${DESIGNERS}`);
    await expect(
      page.getByText("Choose someone different from the first person asked.")
        .first(),
    ).toBeVisible();
    await field(page, "Ask").selectOption(`person:${DANA}`);
    await field(page, "After").selectOption("4");
    await expect(page.locator("[data-card='ask']")).toContainText(
      "Asks Design reviewers to review · then Dana Okafor after 4 hours",
    );
    await expect(page.getByText("If still nobody answers after 7 days"))
      .toBeVisible();
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toEqual({
        recipientGroupId: DESIGNERS,
        intent: "review",
        artifactVersionId: "$step.design.artifact.versionId",
        wait: true,
        ifNobodyAnswers: { afterHours: 4, recipientId: DANA },
      });
    await still(page, "notify-waiting");
    await page.getByRole("switch", { name: "If nobody answers" }).uncheck();
    await page.getByRole("switch", { name: "If nobody answers" }).check();
    await expect(field(page, "Ask")).toHaveValue(`person:${DANA}`);
  });

  test("an administrator is not told they lack access while it is being read", async ({ page }) => {
    let answer: () => void = () => {};
    const held = new Promise<void>((release) => (answer = release));
    await stepEditor(page);
    await page.route(
      "**/v1/organizations/*/effective-access",
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    await page.reload();
    await expect(page.locator("[data-card='start']")).toBeVisible();
    const note = page.getByText(
      "Only organization administrators can change workflows.",
    );
    await expect(note).toHaveCount(0);
    answer();
    await expect(page.getByRole("button", { name: "Publish", exact: true }))
      .toBeVisible();
    await expect(note).toHaveCount(0);
  });

  const asking = (input: Record<string, unknown>): Step => ({
    id: "ask",
    uses: "people.tag",
    with: { recipientRunRole: "starter", intent: "fyi", ...input },
  });
  const waitingReview = (next: Record<string, unknown>) =>
    asking({
      intent: "review",
      artifactVersionId: "$step.design.artifact.versionId",
      wait: true,
      ifNobodyAnswers: next,
    });

  test("a note with dollar signs survives a reload and other changes", async ({ page }) => {
    const server = await stepEditor(page, { steps: [asking({})] });
    await page.locator("[data-card='ask']").click();
    const note = page.getByRole("textbox", { name: "Note (optional)" });
    await note.fill("Costs $5 per seat, yes");
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toMatchObject({
        note: "Costs $5 per seat, yes",
      });
    await page.reload();
    await page.locator("[data-card='ask']").click();
    await expect(note).toHaveValue("Costs $5 per seat, yes");
    await note.fill("$5 each");
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toMatchObject({
        note: { $literal: "$5 each" },
      });
    await field(page, "Who is asked").selectOption(`person:${DANA}`);
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toMatchObject({
        recipientId: DANA,
        note: { $literal: "$5 each" },
      });
    await expect(note).toHaveValue("$5 each");
  });

  test("an unfinished second ask is still on, and still a problem, after a reload", async ({ page }) => {
    const server = await stepEditor(page, {
      steps: [DESIGN, waitingReview({ afterHours: 24, recipientId: DANA })],
    });
    await page.locator("[data-card='ask']").click();
    await field(page, "Ask").selectOption("");
    await expect.poll(() => savedInput(server.saves.at(-1), "people.tag"))
      .toMatchObject({
        ifNobodyAnswers: { afterHours: 24 },
      });
    await page.reload();
    await page.locator("[data-card='ask']").click();
    await expect(page.getByRole("switch", { name: "If nobody answers" }))
      .toBeChecked();
    await expect(
      page.getByText("Choose who is asked next, or turn this off.").first(),
    ).toBeVisible();
  });

  test("the second person is remembered after selecting another step", async ({ page }) => {
    await stepEditor(page, {
      steps: [DESIGN, waitingReview({ afterHours: 4, recipientId: DANA })],
    });
    await page.locator("[data-card='ask']").click();
    const nobody = page.getByRole("switch", { name: "If nobody answers" });
    await nobody.uncheck();
    await page.locator("[data-card='design']").click();
    await expect(nobody).toHaveCount(0);
    await page.locator("[data-card='ask']").click();
    await nobody.check();
    await expect(field(page, "Ask")).toHaveValue(`person:${DANA}`);
    await expect(field(page, "After")).toHaveValue("4");
  });

  test("while groups are read, a saved group is not called gone", async ({ page }) => {
    let answer: () => void = () => {};
    const held = new Promise<void>((release) => (answer = release));
    await stepEditor(page, {
      steps: [asking({
        recipientRunRole: undefined,
        recipientGroupId: DESIGNERS,
      })],
    });
    await page.route((url) => url.pathname === "/v1/groups", async (route) => {
      await held;
      await route.fallback();
    });
    await page.reload();
    await page.locator("[data-card='ask']").click();
    await expect(page.getByTestId("notify-fields"))
      .toContainText("Loading people and groups…");
    await expect(page.getByText("no longer exists")).toHaveCount(0);
    await expect(page.locator("[data-card='ask']"))
      .not.toContainText("no longer exists");
    await still(page, "notify-loading");
    answer();
    await expect(page.locator("[data-card='ask']"))
      .toContainText("Tells Design reviewers · does not wait");
  });

  for (
    const [name, input, sentence] of [
      [
        "a deleted group",
        { recipientGroupId: "55555555-5555-4555-8555-555555555555" },
        "This group no longer exists. The step will fail until you choose someone else.",
      ],
      [
        "an empty role",
        { recipientRoleKey: "developer" },
        "Developers has no members. The step will fail until someone is added or you choose someone else.",
      ],
      [
        "a person who left",
        { recipientId: "66666666-6666-4666-8666-666666666666" },
        "This person no longer exists. Until you choose someone else, the workflow's owner is asked.",
      ],
    ] as const
  ) {
    test(`${name} is warned about without blocking publish`, async ({ page }) => {
      await stepEditor(page, {
        steps: [asking({ recipientRunRole: undefined, ...input })],
      });
      await page.locator("[data-card='ask']").click();
      await expect(page.getByTestId("notify-fields")).toContainText(sentence);
      if (name === "a deleted group") {
        await expect(page.locator("[data-card='ask']"))
          .toContainText("Tells a group that no longer exists");
      }
      await expect(page.locator("[data-card='ask']"))
        .not.toContainText("Needs setup");
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(
        page.getByRole("alertdialog").getByRole("button", {
          name: "Publish and use",
        }),
      ).toBeEnabled();
      await still(page, `notify-warning-${name.split(" ").at(-1)}`);
    });
  }

  test("a step written with a document id stays in code", async ({ page }) => {
    await stepEditor(page, {
      steps: [{
        id: "ask",
        uses: "people.tag",
        with: {
          recipientRunRole: "starter",
          intent: "review",
          artifactVersionId: DESIGNERS,
        },
      }],
    });
    await page.locator("[data-card='ask']").click();
    await expect(
      page.getByText(
        "This part of the workflow is written in code. You cannot change it here.",
      ),
    ).toBeVisible();
    await expect(field(page, "Who is asked")).toHaveCount(0);
  });
});
