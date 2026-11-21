import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { storageFixture } from "./helpers/storage-fixture.ts";

registerPageHealth(test);

const GB = 1024 ** 3;

/** The Storage settings page (#448): how full storage is, and the limits and retention. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: storage settings`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("an Admin sees how full storage is and every limit", async ({ page }) => {
      await storageFixture(page);
      await page.goto("/organization/storage");
      await expect(page.getByRole("heading", { name: "Storage", level: 1 }))
        .toBeVisible();
      const used = page.getByTestId("storage-used");
      await expect(used.getByText("78.2 GB of 100 GB")).toBeVisible();
      await expect(used.getByText("Nearly full")).toBeVisible();
      const meter = page.getByRole("meter", { name: "Storage used" });
      await expect(meter).toHaveAttribute(
        "aria-valuetext",
        "78.2 GB of 100 GB, 78% used",
      );
      await expect(used.getByText(/The marks show 75%/)).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Organization", exact: true }),
      ).toHaveValue("100");
      await expect(
        page.getByRole("textbox", { name: "Each project", exact: true }),
      ).toHaveValue("50");
      await expect(
        page.getByRole("textbox", {
          name: "Each personal folder",
          exact: true,
        }),
      ).toHaveValue("10");
      await expect(
        page.getByRole("textbox", { name: "Largest single file", exact: true }),
      ).toHaveValue("5");
      await expect(
        page.getByRole("textbox", {
          name: "Versions kept per file",
          exact: true,
        }),
      ).toHaveValue("20");
      await expect(
        page.getByRole("textbox", { name: "Days in the trash", exact: true }),
      ).toHaveValue("30");
      await expect(
        page.getByRole("textbox", {
          name: "Days in scratch folders",
          exact: true,
        }),
      ).toHaveValue(
        "30",
      );
      // Nothing is changed yet, so there is nothing to save.
      await expect(page.getByRole("button", { name: "Save changes" }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage");
    });

    test("saving sends every limit with the version the page read", async ({ page }) => {
      const seen = await storageFixture(page);
      await page.goto("/organization/storage");
      await page.getByRole("textbox", { name: "Organization", exact: true })
        .fill("200");
      await page.getByRole("textbox", {
        name: "Days in the trash",
        exact: true,
      }).fill("45");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Storage settings saved.")).toBeVisible();
      expect(seen.puts).toHaveLength(1);
      expect(seen.puts[0].ifMatch).toBe('"v3"');
      expect(seen.puts[0].key).not.toBeNull();
      expect(seen.puts[0].body).toEqual({
        workingVersionsKept: 20,
        trashRetentionDays: 45,
        scratchRetentionDays: 30,
        maxFileBytes: 5 * GB,
        organizationQuotaBytes: 200 * GB,
        projectQuotaBytes: 50 * GB,
        personalQuotaBytes: 10 * GB,
        stepWriteBytes: 2 * GB,
        stepWriteFiles: 2000,
      });
      // The meter now reads against the new limit.
      await expect(
        page.getByTestId("storage-used").getByText("78.2 GB of 200 GB"),
      )
        .toBeVisible();
      await expect(page.getByTestId("storage-used").getByText("Room to spare"))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-saved");
    });

    test("the agent step limits are edited in megabytes and a count, and an empty box saves the default", async ({ page }) => {
      const seen = await storageFixture(page);
      await page.goto("/organization/storage");
      await expect(page.getByRole("heading", { name: "Agent steps" }))
        .toBeVisible();
      const bytes = page.getByRole("textbox", {
        name: "Most a step may write",
        exact: true,
      });
      const files = page.getByRole("textbox", {
        name: "Most files a step may write",
        exact: true,
      });
      await expect(bytes).toHaveValue("2048");
      await expect(files).toHaveValue("2000");
      await bytes.fill("0");
      await bytes.blur();
      await expect(page.getByText("Enter a whole number above 0."))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-agent-error");
      await bytes.fill("512");
      await files.fill("");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Storage settings saved.")).toBeVisible();
      expect(seen.puts[0].body).toMatchObject({
        stepWriteBytes: 512 * 1024 * 1024,
        stepWriteFiles: 2000,
      });
    });

    test("an emptied step limit box shows the word Default, not a number that looks typed", async ({ page }) => {
      await storageFixture(page);
      await page.goto("/organization/storage");
      const bytes = page.getByRole("textbox", {
        name: "Most a step may write",
        exact: true,
      });
      const files = page.getByRole("textbox", {
        name: "Most files a step may write",
        exact: true,
      });
      await bytes.fill("");
      await files.fill("");
      await expect(bytes).toHaveAttribute("placeholder", "Default");
      await expect(files).toHaveAttribute("placeholder", "Default");
      await expect(bytes).toHaveValue("");
      await bytes.scrollIntoViewIfNeeded();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-agent-emptied");
    });

    test("the first save of an organization on the defaults sends no If-Match", async ({ page }) => {
      const seen = await storageFixture(page, { version: 0 });
      await page.goto("/organization/storage");
      await page.getByRole("textbox", {
        name: "Days in scratch folders",
        exact: true,
      }).fill("14");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Storage settings saved.")).toBeVisible();
      expect(seen.puts[0].ifMatch).toBeNull();
    });

    test("a wrong number is named under its field and nothing is sent", async ({ page }) => {
      const seen = await storageFixture(page);
      await page.goto("/organization/storage");
      await page.getByRole("textbox", {
        name: "Largest single file",
        exact: true,
      }).fill("9");
      await page.getByRole("textbox", {
        name: "Days in the trash",
        exact: true,
      }).fill("abc");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("At most 5 GB.")).toBeVisible();
      await expect(page.getByText("Enter a whole number from 1 to 3,650."))
        .toBeVisible();
      // Save moves focus to the first field in error.
      await expect(
        page.getByRole("textbox", { name: "Largest single file", exact: true }),
      ).toBeFocused();
      expect(seen.puts).toHaveLength(0);
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-errors");
    });

    test("a limit below what is stored is allowed and warned about", async ({ page }) => {
      const seen = await storageFixture(page);
      await page.goto("/organization/storage");
      await page.getByRole("textbox", { name: "Organization", exact: true })
        .fill("50");
      await expect(
        page.getByText(/This is below what is stored now \(78.2 GB\)/),
      )
        .toBeVisible();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Storage settings saved.")).toBeVisible();
      expect(seen.puts[0].body.organizationQuotaBytes).toBe(50 * GB);
      await expect(
        page.getByTestId("storage-used").getByText("New files paused"),
      )
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-paused");
    });

    test("reset fills the defaults and saves nothing", async ({ page }) => {
      const seen = await storageFixture(page);
      await page.goto("/organization/storage");
      await page.getByRole("textbox", { name: "Organization", exact: true })
        .fill("300");
      await page.getByRole("button", { name: "Reset to Bakery's defaults" })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Organization", exact: true }),
      ).toHaveValue("100");
      await expect(
        page.getByRole("textbox", { name: "Each project", exact: true }),
      ).toHaveValue("50");
      await expect(
        page.getByRole("textbox", {
          name: "Each personal folder",
          exact: true,
        }),
      ).toHaveValue("10");
      await expect(
        page.getByRole("textbox", { name: "Largest single file", exact: true }),
      ).toHaveValue("5");
      await expect(
        page.getByRole("textbox", {
          name: "Versions kept per file",
          exact: true,
        }),
      ).toHaveValue("20");
      await expect(
        page.getByRole("textbox", { name: "Days in the trash", exact: true }),
      ).toHaveValue("30");
      expect(seen.puts).toHaveLength(0);
    });

    test("someone else saved first: the change is not applied", async ({ page }) => {
      const seen = await storageFixture(page, { putStatus: 412 });
      await page.goto("/organization/storage");
      await page.getByRole("textbox", {
        name: "Days in the trash",
        exact: true,
      }).fill("60");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
      expect(seen.puts).toHaveLength(1);
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-conflict");
    });

    test("a member who is not an Admin reads the same values with no controls", async ({ page }) => {
      await storageFixture(page, { role: "developer", usedGb: 42 });
      await page.goto("/organization/storage");
      const limits = page.getByTestId("storage-limits-readonly");
      await expect(limits.getByText("100 GB")).toBeVisible();
      await expect(page.getByText("2 GB", { exact: true })).toBeVisible();
      await expect(page.getByText("2,000 files")).toBeVisible();
      await expect(
        page.getByText("Only an organization Admin can change these."),
      )
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Save changes" }))
        .toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Organization", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByTestId("storage-used").getByText("Room to spare"))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "organization-storage-readonly");
    });
  });
}
