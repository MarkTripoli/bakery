import { expect, type Page, test } from "@playwright/test";
import {
  adminMachinesFixture,
  MACHINE_ID,
} from "./helpers/machines-fixture.ts";

const MIN_TARGET = 44;
const INTERACTIVE = [
  "a[href]",
  "button",
  "select",
  "input:not([type=hidden])",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=combobox]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=menuitem]",
  "[role=option]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type Target = {
  readonly label: string;
  readonly width: number;
  readonly height: number;
};

/** Every visible, enabled interactive element in the document with its box. */
async function measureTargets(page: Page): Promise<Target[]> {
  return await page.locator(INTERACTIVE).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const html = element as HTMLElement;
      if (html.closest("[inert],[aria-hidden=true]")) return [];
      // The skip link is clipped to a pixel until it has keyboard focus; it is
      // never a tap target, and skip-link.spec.ts holds its own contract.
      if (html.matches(".bakery-app-shell__skip-link")) return [];
      if ((html as HTMLButtonElement).disabled) return [];
      const style = getComputedStyle(html);
      if (style.visibility === "hidden" || style.display === "none") return [];
      // A radio or checkbox inside a label is tapped through the label: the
      // card or row around it is the target, not the 16 px input.
      const tapped = html.matches("input[type=radio],input[type=checkbox]")
        ? html.closest("label") ?? html
        : html;
      const box = tapped.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      const name = html.getAttribute("aria-label") ??
        html.textContent?.trim().slice(0, 40) ?? "";
      return [{
        label: `${html.tagName.toLowerCase()}#${html.id || "-"} "${name}"`,
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
      }];
    })
  );
}

function undersized(targets: readonly Target[]): Target[] {
  return targets.filter((target) =>
    target.width < MIN_TARGET || target.height < MIN_TARGET
  );
}

test.describe("machines touch targets on a coarse phone", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "coarse phone only");
    await adminMachinesFixture(page);
  });

  test("the phone project emulates a 390 px coarse pointer", async ({ page }) => {
    await page.goto("/machines");
    const media = await page.evaluate(() => ({
      width: innerWidth,
      coarse: matchMedia("(pointer: coarse)").matches,
    }));
    expect(media).toEqual({ width: 390, coarse: true });
  });

  test("every /machines target is at least 44 by 44", async ({ page }) => {
    await page.goto("/machines");
    await expect(page.getByRole("list", { name: "Machines" })).toBeVisible();
    // A setup that was left, with its two buttons.
    await expect(page.getByTestId("machines-finishing-setup")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Get new settings for touch-target-pending",
      }),
    ).toBeVisible();
    const toggle = page.getByRole("button", { name: "Open navigation" });
    await expect(toggle).toBeVisible();

    const targets = await measureTargets(page);
    // The menu button, Add machine, the one machine's action and the two of the
    // unfinished setup: enough to know the page was really measured.
    expect(targets.length).toBeGreaterThanOrEqual(5);
    expect(undersized(targets)).toEqual([]);
  });

  test("every add-a-machine wizard target is at least 44 by 44, on each step", async ({ page }) => {
    await page.goto("/machines/new");
    await expect(page.getByText("Step 1 of 3 · Name and system")).toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
    await page.getByLabel("Name").fill("touch-target-new");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 2 of 3 · Coding agent")).toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("touch-target-enrollment-token-0001"))
      .toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
  });

  test("every /machines/$machineId target is at least 44 by 44", async ({ page }) => {
    await page.goto(`/machines/${MACHINE_ID}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await expect(page.getByText("No failed checks reported.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" }))
      .toBeVisible();

    const targets = await measureTargets(page);
    expect(targets.length).toBeGreaterThan(3);
    expect(undersized(targets)).toEqual([]);
  });

  test("revoked detail with failed blockers keeps 44 by 44 targets", async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await adminMachinesFixture(page, { status: "revoked", blockersFail: true });
    await page.goto(`/machines/${MACHINE_ID}`);
    const detail = page.getByTestId("machine-detail-page");
    // A retired machine has one action, in its banner.
    await expect(detail.getByRole("button", { name: "Set up again" }))
      .toBeVisible();
    await expect(detail.getByRole("button", { name: "Retry" }).first())
      .toBeVisible();

    expect(undersized(await measureTargets(page))).toEqual([]);
  });

  test("the open navigation drawer keeps 44 by 44 targets", async ({ page }) => {
    await page.goto(`/machines/${MACHINE_ID}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const targets = await page.getByRole("dialog").locator(INTERACTIVE)
      .evaluateAll((elements) =>
        elements.flatMap((element) => {
          const box = element.getBoundingClientRect();
          return box.width === 0 || box.height === 0 ? [] : [{
            label: `${element.tagName.toLowerCase()} "${
              element.textContent?.trim().slice(0, 40) ?? ""
            }"`,
            width: Math.round(box.width * 100) / 100,
            height: Math.round(box.height * 100) / 100,
          }];
        })
      );
    expect(targets.length).toBeGreaterThan(3);
    expect(undersized(targets)).toEqual([]);
  });
});
