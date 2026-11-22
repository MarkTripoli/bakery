import { expect, type Page, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import {
  IDS,
  LONG_NAME,
  type Seen,
  skillsFixture,
} from "./helpers/skills-fixture.ts";

registerPageHealth(test);

const LIST = "/library?tab=skills";
const skillPage = (id: string) => `/library/skills/${id}`;

/** Slice 1 is read only: no request but a read ever leaves the page. */
function expectReadsOnly(seen: readonly Seen[]) {
  expect(seen.filter((entry) => entry.method !== "GET")).toEqual([]);
}

/** The rows of the list, in order: a table row on a wide screen, a list row on a phone. */
const rows = (page: Page) => page.locator("[data-skill]");

/** The Skills tab and one skill (#74 slice 1, UX revision 3). */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900, phone: false },
    { name: "phone", width: 390, height: 844, phone: true },
  ]
) {
  test.describe(`${viewport.name}: skills`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    const choose = async (page: Page, label: string, value: string) => {
      if (viewport.phone) {
        await page.getByLabel("Show").selectOption(value);
      } else {
        await page.getByRole("radio", { name: label }).click();
        await expect(page.getByRole("radio", { name: label })).toBeChecked();
      }
    };

    test("All lists every skill with who it belongs to, its version and its badges", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(LIST);
      await expect(page.getByRole("tab", { name: "Skills" }))
        .toHaveAttribute("aria-selected", "true");
      const tabs = await page.getByRole("tab").allTextContents();
      expect(tabs.map((tab) => tab.trim())).toEqual([
        "Workflows",
        "Agents",
        "Skills",
        "Memory",
        "Evaluations",
      ]);
      await expect(rows(page)).toHaveCount(7);
      const house = rows(page).filter({ hasText: "House style" });
      // Private and draft are said once, in plain words, not again as a badge.
      await expect(house.getByText(/Yours/)).toBeVisible();
      await expect(house.getByText("Private", { exact: true })).toHaveCount(0);
      const scratch = rows(page).filter({ hasText: "Scratch idea" });
      await expect(scratch.getByText(/No version yet/)).toBeVisible();
      await expect(scratch.getByText("Draft only")).toHaveCount(0);
      await expect(
        rows(page).filter({ hasText: "Old checklist" }).getByText("Turned off"),
      ).toBeVisible();
      await expect(
        rows(page).filter({ hasText: "Old checklist" }).getByText("Turned off"),
      ).toBeVisible();
      if (viewport.phone) {
        await expect(
          house.getByText("Yours · Version 2 · changed yesterday"),
        ).toBeVisible();
        await expect(
          rows(page).filter({ hasText: "Writing guide" }).getByText(
            "Shared by Bakery · Version 3 · changed Oct 23, 2026",
          ),
        ).toBeVisible();
        await expect(
          rows(page).filter({ hasText: "Release notes" }).getByText(
            "Organization · Version 1 · changed 3 hours ago",
          ),
        ).toBeVisible();
      } else {
        await expect(page.getByRole("columnheader")).toHaveText([
          "Name",
          "Belongs to",
          "Version in use",
          "Changed",
        ]);
        await expect(house.getByText("Yours")).toBeVisible();
        await expect(house.getByText("Version 2")).toBeVisible();
        await expect(house.getByText("yesterday")).toBeVisible();
        await expect(
          rows(page).filter({ hasText: "Writing guide" }).getByText(
            "Shared by Bakery",
          ),
        ).toBeVisible();
      }
      await expect(page.getByText("Only mine")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /New skill|Make a copy/ }))
        .toHaveCount(0);
      await expect(page.getByRole("searchbox", { name: "Find a skill" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "library-skills-all");
      expect(seen.find((entry) => entry.path === "/v1/skills")?.search)
        .not.toContain("scope=");
      expectReadsOnly(seen);
    });

    test("Private filters by scope and keeps it in the URL", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(7);
      await choose(page, "Private", "personal");
      await expect(page).toHaveURL(/scope=personal/);
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).filter({ hasText: "Release notes" }))
        .toHaveCount(0);
      expect(
        seen.some((entry) =>
          entry.path === "/v1/skills" && entry.search.includes("scope=personal")
        ),
      ).toBe(true);
      await page.reload();
      await expect(rows(page)).toHaveCount(3);
      await page.mouse.move(700, 700);
      await still(page, "library-skills-private");
      expectReadsOnly(seen);
    });

    test("a filter with no skills says so in one plain sentence, with no button", async ({ page }) => {
      const { seen } = await skillsFixture(page, {
        emptyScopes: ["organization"],
      });
      await page.goto(`${LIST}&scope=organization`);
      await expect(page.getByText("No organization skills yet")).toBeVisible();
      await expect(
        page.getByText(
          "Skills everyone in the organization can use will be listed here.",
        ),
      ).toBeVisible();
      await expect(
        page.getByTestId("library-skills").getByRole("button"),
      ).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "library-skills-empty-filter");
      expectReadsOnly(seen);
    });

    test("a search that finds nothing offers Clear search", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(7);
      await page.getByRole("searchbox", { name: "Find a skill" }).fill("zebra");
      await expect(page).toHaveURL(/q=zebra/);
      await expect(page.getByText("No skill matches “zebra”.")).toBeVisible();
      expect(
        seen.some((entry) =>
          entry.path === "/v1/skills" && entry.search.includes("q=zebra")
        ),
      ).toBe(true);
      await page.mouse.move(700, 700);
      await still(page, "library-skills-search-empty");
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(rows(page)).toHaveCount(7);
      await expect(page).not.toHaveURL(/q=/);
      await page.getByRole("searchbox", { name: "Find a skill" }).fill("style");
      await expect(rows(page)).toHaveCount(1);
      expectReadsOnly(seen);
    });

    test("a list that did not load says so and can be tried again", async ({ page }) => {
      await skillsFixture(page, { listStatus: 500 });
      await page.goto(LIST);
      await expect(page.getByText("The skills did not load.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "library-skills-error");
    });

    test("Load more reads the next 25 and shows no total", async ({ page }) => {
      const { seen } = await skillsFixture(page, { extra: 25 });
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(25);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(rows(page)).toHaveCount(32);
      await expect(page.getByRole("button", { name: "Load more" }))
        .toHaveCount(0);
      expectReadsOnly(seen);
    });

    test("a row opens its skill from the keyboard", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(LIST);
      const opener = page.getByRole("button", { name: /House style/ });
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(skillPage(IDS.houseStyle)));
      await expect(
        page.getByRole("heading", { name: "House style", level: 1 }),
      ).toBeVisible();
      expectReadsOnly(seen);
    });

    test("a long name wraps and keeps its badges beside it", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(LIST);
      const row = rows(page).filter({ hasText: LONG_NAME });
      await expect(row).toBeVisible();
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.goto(skillPage(IDS.longName));
      await expect(page.getByRole("heading", { name: LONG_NAME, level: 1 }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "skill-long-name");
    });

    test("a private skill: its files, versions, who can use it and the skill it was copied from", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(skillPage(IDS.houseStyle));
      await expect(
        page.getByRole("heading", { name: "House style", level: 1 }),
      ).toBeVisible();
      await expect(page.getByText("Private", { exact: true }).first())
        .toBeVisible();
      const files = page.getByTestId("skill-files");
      await expect(files.getByText("Instructions file")).toBeVisible();
      await expect(files.getByText("SKILL.md")).toBeVisible();
      await expect(files.getByText("2 kB · text/markdown")).toBeVisible();
      await expect(files.getByText("Other files")).toBeVisible();
      await expect(files.getByText("scripts/check.sh")).toBeVisible();
      await expect(files.getByText("1.3 MB · text/x-shellscript"))
        .toBeVisible();
      const versions = page.getByTestId("skill-versions");
      await expect(versions.locator("[data-version]")).toHaveCount(3);
      const inUse = versions.locator("[data-version]").filter({
        hasText: "In use",
      });
      await expect(inUse).toHaveCount(1);
      await expect(inUse.getByText("Version 2")).toBeVisible();
      await expect(
        inUse.getByText(/^Published · .* · Fingerprint 2222abcdef01$/),
      )
        .toBeVisible();
      await expect(
        page.getByTestId("skill-used-by").getByText(
          "Nothing uses this skill yet.",
        ),
      ).toBeVisible();
      const access = page.getByTestId("skill-access");
      await expect(
        access.getByText(
          "Only you can open this skill. These shared workflows are allowed to use it.",
        ),
      ).toBeVisible();
      await expect(access.getByText("Weekly digest")).toBeVisible();
      await expect(
        access.getByText(
          "Step “Draft the digest” · version 2 of this skill · since Nov 18, 2026",
        ),
      ).toBeVisible();
      await expect(access.getByRole("button")).toHaveCount(0);
      // The original's name is a link to its page, in the same sentence.
      const origin = page.getByTestId("skill-origin");
      await expect(origin).toContainText(
        "Copied from Writing guide, version 1",
      );
      await expect(origin.getByRole("link", { name: "Writing guide" }))
        .toHaveAttribute("href", `${skillPage(IDS.writingGuide)}`);
      await origin.getByRole("link", { name: "Writing guide" }).click();
      await expect(page).toHaveURL(new RegExp(skillPage(IDS.writingGuide)));
      await expect(
        page.getByRole("button", {
          name: /Stop|Edit|Check for updates|Make a copy/,
        }),
      )
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "skill-private");
      expectReadsOnly(seen);
    });

    test("an organization skill: its description, what uses it in two groups, written here", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(skillPage(IDS.releaseNotes));
      await expect(
        page.getByRole("heading", { name: "Release notes", level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Writes the release notes from the merged pull requests.",
        ),
      ).toBeVisible();
      const usedBy = page.getByTestId("skill-used-by");
      await expect(usedBy.getByText("Agents")).toBeVisible();
      // Each row says which version of this skill it pins.
      await expect(usedBy.getByText("Reviewer, version 4 · uses version 1"))
        .toBeVisible();
      await expect(usedBy.getByText("Workflows")).toBeVisible();
      await expect(
        usedBy.getByText("Nightly build, version 7 · uses versions 1 and 2"),
      ).toBeVisible();
      await expect(usedBy.getByText("Release, version 2 · uses version 1"))
        .toBeVisible();
      await expect(page.getByTestId("skill-access")).toHaveCount(0);
      await expect(page.getByTestId("skill-origin").getByText("Written here"))
        .toBeVisible();
      await expect(page.getByTestId("skill-files").getByText("Other files"))
        .toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "skill-organization");
      expect(seen.some((entry) => entry.path.endsWith("/use-grants"))).toBe(
        false,
      );
      expectReadsOnly(seen);
    });

    test("a skill shared by Bakery names its source and licence", async ({ page }) => {
      const { seen } = await skillsFixture(page);
      await page.goto(skillPage(IDS.writingGuide));
      await expect(
        page.getByRole("heading", { name: "Writing guide", level: 1 }),
      ).toBeVisible();
      await expect(page.getByText("Shared by Bakery").first()).toBeVisible();
      const origin = page.getByTestId("skill-origin");
      await expect(origin.getByText("Git repository: Bakery skills"))
        .toBeVisible();
      await expect(
        origin.getByText("https://github.com/example/bakery-skills.git"),
      ).toBeVisible();
      await expect(origin.getByText("Publisher")).toBeVisible();
      await expect(origin.getByText("Last checked")).toBeVisible();
      // The licence is said once, in Where it came from, as the source says it.
      await expect(origin.getByText("MIT", { exact: true })).toBeVisible();
      await expect(page.getByTestId("skill-files").getByText("MIT"))
        .toHaveCount(0);
      await expect(
        page.getByTestId("skill-versions").getByText(
          "Version 2: Spring release",
        ),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "skill-shared-by-bakery");
      expectReadsOnly(seen);
    });

    test("a skill with no source says its own licence in Files, since no other card does", async ({ page }) => {
      await skillsFixture(page, {
        ownLicenses: { [IDS.releaseNotes]: "Apache-2.0" },
      });
      await page.goto(skillPage(IDS.releaseNotes));
      const files = page.getByTestId("skill-files");
      await expect(files.getByText("Licence", { exact: true })).toBeVisible();
      await expect(files.getByText("Apache-2.0", { exact: true }))
        .toBeVisible();
    });

    test("a licence that differs from its source's is said in Files too, and each says its own", async ({ page }) => {
      await skillsFixture(page, {
        ownLicenses: { [IDS.writingGuide]: "Apache-2.0" },
      });
      await page.goto(skillPage(IDS.writingGuide));
      await expect(
        page.getByTestId("skill-files").getByText("Apache-2.0", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByTestId("skill-origin").getByText("MIT", { exact: true }),
      ).toBeVisible();
    });

    test("a copy of a skill the reader cannot open says another skill", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(skillPage(IDS.toneOfVoice));
      await expect(
        page.getByTestId("skill-origin").getByText(
          "Copied from another skill",
        ),
      ).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "skill-copied-unknown");
    });

    test("a skill with no version in use lists no files and is turned off when it is", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(skillPage(IDS.scratch));
      await expect(
        page.getByTestId("skill-files").getByText(
          "No version is in use yet, so there are no files to list.",
        ),
      ).toBeVisible();
      await page.goto(skillPage(IDS.oldChecklist));
      await expect(page.getByText("Turned off")).toBeVisible();
    });

    test("who can use it is hidden when the server refuses it; a card that fails says so", async ({ page }) => {
      await skillsFixture(page, { grantsStatus: 403, usedByStatus: 500 });
      await page.goto(skillPage(IDS.houseStyle));
      await expect(
        page.getByRole("heading", { name: "House style", level: 1 }),
      ).toBeVisible();
      const usedBy = page.getByTestId("skill-used-by");
      await expect(usedBy.getByText("What uses this skill did not load."))
        .toBeVisible();
      await expect(usedBy.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await expect(page.getByTestId("skill-access")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "skill-card-error");
    });

    test("a skill that is not there says so and leads back", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(skillPage(IDS.missing));
      await expect(page.getByText("This skill is not here")).toBeVisible();
      await page.getByRole("button", { name: "Back to Skills" }).click();
      await expect(page).toHaveURL(/tab=skills/);
    });

    test("the filter and search share one row on a wide screen and stack on a phone", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(7);
      const search =
        (await page.getByPlaceholder("Find a skill").boundingBox())!;
      const filter = (await (viewport.phone
        ? page.getByLabel("Show")
        : page.getByRole("group", { name: "Show" })).boundingBox())!;
      if (viewport.phone) {
        // Stacked: the search sits under the filter, both the page's width.
        expect(search.y).toBeGreaterThan(filter.y + filter.height - 1);
      } else {
        // One row: they overlap vertically, the filter at its own width and the
        // search about 280px wide at the end.
        expect(search.y).toBeLessThan(filter.y + filter.height);
        expect(filter.y).toBeLessThan(search.y + search.height);
        expect(search.x).toBeGreaterThan(filter.x + filter.width);
        expect(search.width).toBeGreaterThan(240);
        expect(search.width).toBeLessThan(330);
        expect(filter.width).toBeLessThan(600);
      }
    });

    test("every cell of a table row sits on one text line, with or without a badge", async ({ page }) => {
      test.skip(viewport.phone, "The phone shows rows, not a table.");
      await skillsFixture(page);
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(7);
      for (const name of ["House style", "Old checklist"]) {
        const tops = await rows(page).filter({ hasText: name }).locator("td")
          .evaluateAll((cells) =>
            cells.map((cell) => {
              const walker = document.createTreeWalker(
                cell,
                NodeFilter.SHOW_TEXT,
              );
              let node = walker.nextNode();
              while (node && (node.textContent ?? "").trim() === "") {
                node = walker.nextNode();
              }
              const range = document.createRange();
              range.selectNodeContents(node!);
              return range.getBoundingClientRect().top;
            })
          );
        expect(tops).toHaveLength(4);
        for (const top of tops) {
          expect(Math.abs(top - tops[0])).toBeLessThan(1);
        }
      }
    });

    test("the phone list draws one rule between rows, not two", async ({ page }) => {
      test.skip(!viewport.phone, "A table has its own rules.");
      await skillsFixture(page);
      await page.goto(LIST);
      await expect(rows(page)).toHaveCount(7);
      const rules = await rows(page).evaluateAll((items) =>
        items.map((item) => ({
          top: getComputedStyle(item).borderBlockStartWidth,
          bottom: getComputedStyle(item).borderBlockEndWidth,
        }))
      );
      // Every row has its top rule; only the last has a bottom rule, so two
      // rules never touch between rows.
      for (const rule of rules) {
        expect(rule.top).not.toBe("0px");
      }
      for (const rule of rules.slice(0, -1)) {
        expect(rule.bottom).toBe("0px");
      }
      expect(rules.at(-1)!.bottom).not.toBe("0px");
    });

    test("the Library tab strip shows that it scrolls and keeps the selected tab in view", async ({ page }) => {
      await skillsFixture(page);
      const list = page.getByRole("tablist", { name: "Library sections" });
      const selectedInView = () =>
        list.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const tab = element.querySelector(
            '[role="tab"][aria-selected="true"]',
          )!
            .getBoundingClientRect();
          return tab.left >= box.left - 1 && tab.right <= box.right + 1;
        });
      const pageScroll = () =>
        page.evaluate(() => globalThis.scrollY);
      // The tab the page opens on is fully inside the strip; a fade shows only
      // on a side that has more tabs, and never when every tab fits.
      for (
        const [tab, left, right] of [
          ["skills", false, true],
          ["evaluations", true, false],
          ["workflows", false, true],
        ] as const
      ) {
        await page.goto(`/library?tab=${tab}`);
        await expect.poll(selectedInView).toBe(true);
        if (viewport.phone) {
          if (left) {
            await expect(list).toHaveAttribute("data-fade-left", "true");
          } else await expect(list).not.toHaveAttribute("data-fade-left", /.*/);
          if (right) {
            await expect(list).toHaveAttribute("data-fade-right", "true");
          } else {await expect(list).not.toHaveAttribute(
              "data-fade-right",
              /.*/,
            );}
          await page.mouse.move(700, 700);
          // Only the strip: the other tabs' lists are not stubbed in this spec.
          await still(page, `library-tabs-${tab}`, list.locator("xpath=.."));
        } else {
          await expect(list).not.toHaveAttribute("data-fade-left", /.*/);
          await expect(list).not.toHaveAttribute("data-fade-right", /.*/);
        }
      }
      // Arrow keys keep working, and the page itself never moves sideways or down.
      await page.goto("/library?tab=skills");
      await page.getByRole("tab", { name: "Skills" }).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Evaluations" }))
        .toHaveAttribute("aria-selected", "true");
      await expect.poll(selectedInView).toBe(true);
      expect(await pageScroll()).toBe(0);
    });

    test("the Library lede names the skills it now holds", async ({ page }) => {
      await skillsFixture(page);
      await page.goto(LIST);
      await expect(
        page.getByText(
          "The workflows, agents, skills and remembered facts Bakery uses to do work.",
        ),
      ).toBeVisible();
    });
  });
}
