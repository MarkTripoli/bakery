import { expect, type Page, test } from "@playwright/test";
import {
  adminMachinesFixture,
  MACHINE_ID,
} from "./helpers/machines-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * Machines is a main-rail destination, so its pages use the frame Work uses
 * (design-ux, #70 C2): no settings list beside the page, a "Workspace" crumb
 * trail, Machines selected in the main rail, no "Settings sections" control on
 * a phone, the list and the machine page across the frame's width and the
 * wizard in its readable column.
 */

const PAGES = [
  {
    path: "/machines",
    testId: "machines-page",
    crumbs: ["Workspace", "Machines"],
    wide: true,
  },
  {
    path: "/machines/new",
    testId: "machine-wizard",
    crumbs: ["Workspace", "Machines", "Add a machine"],
    wide: false,
  },
  {
    path: `/machines/${MACHINE_ID}`,
    testId: "machine-detail-page",
    crumbs: ["Workspace", "Machines", "touch-target-host"],
    wide: true,
  },
] as const;

async function crumbs(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(nav).toBeVisible();
  return await nav.locator("li, a, span[aria-current]").evaluateAll((nodes) => {
    const seen: string[] = [];
    for (const node of nodes) {
      const text = (node.textContent ?? "").trim();
      if (text && !seen.includes(text)) seen.push(text);
    }
    return seen;
  });
}

for (const entry of PAGES) {
  test.describe(`${entry.path} frame`, () => {
    test.beforeEach(async ({ page }) => {
      await adminMachinesFixture(page);
    });

    test("has no settings list, a Workspace trail, Machines selected, one main landmark", async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.getByTestId(entry.testId)).toBeVisible();
      await expect(page.locator(".bakery-section-navigation")).toHaveCount(0);
      await expect(page.getByText("Settings sections")).toHaveCount(0);
      const phone = (page.viewportSize()?.width ?? 0) < 744;
      if (phone) {
        // A phone's top bar carries the destination's name, not a trail.
        await expect(page.getByRole("navigation", { name: "Breadcrumb" }))
          .toHaveCount(0);
        await expect(
          page.getByRole("banner").getByText("Machines", { exact: true }),
        )
          .toBeVisible();
      } else {
        expect(await crumbs(page)).toEqual([...entry.crumbs]);
      }
      await expect(page.getByRole("main")).toHaveCount(1);
      // Machines is the selected item of the main rail on desktop; on a phone
      // the rail is behind the menu, so the title says where the person is.
      if ((page.viewportSize()?.width ?? 0) >= 1024) {
        await expect(
          page.getByRole("link", { name: "Machines", exact: true }).first(),
        ).toHaveAttribute("aria-current", "page");
      }
    });

    test("uses the width the page needs: the list and machine page the frame, the wizard its column", async ({ page }) => {
      await page.goto(entry.path);
      const content = page.getByTestId(entry.testId);
      await expect(content).toBeVisible();
      const width = (await content.boundingBox())!.width;
      const frame = (await page.getByRole("main").boundingBox())!.width;
      if (entry.wide) {
        // The whole frame less the page gutters (a phone has no room to spare).
        expect(width).toBeGreaterThan(Math.min(780, frame - 48));
        expect(width).toBeLessThanOrEqual(frame);
      } else {
        expect(width).toBeLessThanOrEqual(760);
      }
    });
  });
}

test.describe("Machines frame, evidence", () => {
  test("the list, the wizard's first step and a machine page", async ({ page }) => {
    await adminMachinesFixture(page);
    await page.goto("/machines");
    await expect(page.getByTestId("machines-page")).toBeVisible();
    await shot(page, "machines-frame-list");
    await page.goto("/machines/new");
    await expect(page.getByTestId("machine-wizard")).toBeVisible();
    await shot(page, "machines-frame-wizard");
    await page.goto(`/machines/${MACHINE_ID}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await shot(page, "machines-frame-machine");
  });
});
