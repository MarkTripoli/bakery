import { expect, test } from "@playwright/test";
import {
  AGENT_NO_PERSON_VERSIONS,
  filesFixture,
  TREE,
} from "./helpers/files-fixture.ts";
import { uuid } from "./helpers/issues-fixture.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";

registerPageHealth(test);

/** The files browser (#445): folders, a file's details, its versions and uses. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: files`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the top of the tree lists the folders with what each holds", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files");
      await expect(page.getByRole("heading", { name: "Files", level: 1 }))
        .toBeVisible();
      const files = page.getByTestId("files-page");
      await expect(files.getByRole("link", { name: "Projects", exact: true }))
        .toBeVisible();
      await expect(files.getByRole("link", { name: "Shared", exact: true }))
        .toBeVisible();
      await expect(files.getByRole("link", { name: "Library", exact: true }))
        .toBeVisible();
      await expect(files.getByRole("link", { name: "Your files" }))
        .toBeVisible();
      await expect(page.getByText(
        "Each project's documents, run outputs, workspaces and reference files.",
      )).toBeVisible();
      await expect(page.getByText(
        "Your own uploads and scratch files. Only you can see them.",
      )).toBeVisible();
      if (viewport.name === "desktop") {
        // The rail lists Files, and marks it as the page the person is on.
        await expect(
          page.locator('nav.bakery-application-rail a[aria-current="page"]'),
        ).toHaveText("Files");
      }
      await page.mouse.move(700, 700);
      await still(page, "files-top");
    });

    test("a folder lists its folders first, then its files, with kind, size and date", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await expect(page.getByRole("link", { name: "docs" })).toBeVisible();
      const plan = page.locator(`[data-entry-id="${uuid(40)}"]`);
      await expect(plan).toContainText("Plan");
      await expect(plan).toContainText("4.1 KB");
      // A file with no kind shows a dash, not an empty cell.
      await expect(page.locator(`[data-entry-id="${uuid(41)}"]`))
        .toContainText("—");
      await expect(page.locator(`[data-entry-id="${uuid(41)}"]`))
        .toContainText("3.2 MB");
      if (viewport.name === "phone") {
        // A phone has a link back to the parent, not the whole trail.
        await expect(page.getByRole("link", { name: "Back to Projects" }))
          .toBeVisible();
      } else {
        await expect(
          page.getByRole("navigation", { name: "Folder path" }),
        ).toContainText("web-app");
      }
      await page.mouse.move(700, 700);
      await still(page, "files-folder");
    });

    test("opening a folder from the top goes down the breadcrumb", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files");
      const files = page.getByTestId("files-page");
      await files.getByRole("link", { name: "projects" }).click();
      await expect(page).toHaveURL(/\/files\/projects$/);
      await files.getByRole("link", { name: "web-app" }).last().click();
      await expect(page).toHaveURL(/\/files\/projects\/web-app$/);
      await expect(page.getByRole("link", { name: "plan.md" })).toBeVisible();
    });

    test("a path that is not a folder says it was not found, and Go to Files goes back", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/nowhere");
      await expect(page.getByText("This folder was not found")).toBeVisible();
      await page.getByRole("button", { name: "Go to Files" }).click();
      await expect(page).toHaveURL(/\/files$/);
    });

    test("an empty folder says so", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app/docs");
      await expect(page.getByText("This folder is empty")).toBeVisible();
    });

    test("a folder that fails to load offers Try again", async ({ page }) => {
      await filesFixture(page, { entriesFail: true });
      await page.goto("/files/projects/web-app");
      await expect(page.getByText("This folder did not load.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
    });

    test("Load more adds the next page of a long folder", async ({ page }) => {
      await filesFixture(page, { pageSize: 2 });
      await page.goto("/files/projects/web-app");
      await expect(page.getByRole("link", { name: "demo.mp4" })).toHaveCount(0);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.getByRole("link", { name: "demo.mp4" })).toBeVisible();
    });

    test("a link to a file past the first page opens its details", async ({ page }) => {
      await filesFixture(page, { pageSize: 2 });
      // plan.md is the fourth entry, so it is on the second page of two.
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      await expect(page.getByTestId("file-details")).toContainText(
        "/projects/web-app/plan.md",
      );
    });

    test("a link to a file that is not in the folder says so", async ({ page }) => {
      await filesFixture(page, { pageSize: 2 });
      await page.goto(`/files/projects/web-app?file=${uuid(99)}`);
      await expect(page.getByText(/That file is not in this folder/))
        .toBeVisible();
      await expect(page.getByTestId("file-details")).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "files-file-missing");
    });

    test("a folder is found however long the list it sits in", async ({ page }) => {
      await filesFixture(page, { pageSize: 1 });
      await page.goto("/files/projects/web-app/media");
      await expect(page.getByRole("link", { name: "broken.md" }))
        .toBeVisible();
      await expect(page.getByText(/This folder was not found|not found/i))
        .toHaveCount(0);
    });

    test("a folder is found past twenty pages of its parent's list", async ({ page }) => {
      // Twenty-five folders sort ahead of web-app, one entry per page: the walk
      // must read more than twenty pages of /projects to reach it.
      const tree = [
        ...TREE,
        ...Array.from({ length: 25 }, (_, index) => ({
          id: 2000 + index,
          parent: 10,
          path: `/projects/a-${String(index).padStart(3, "0")}`,
          name: `a-${String(index).padStart(3, "0")}`,
          kind: "folder" as const,
        })),
      ];
      const { seen } = await filesFixture(page, { tree, pageSize: 1 });
      await page.goto("/files/projects/web-app/media");
      await expect(page.getByRole("link", { name: "broken.md" }))
        .toBeVisible();
      await expect(page.getByText("This folder was not found")).toHaveCount(0);
      expect(seen.entries.filter((id) => id === uuid(10)).length)
        .toBeGreaterThan(20);
    });

    test("a file link whose next page fails shows the error, not a search that never ends", async ({ page }) => {
      await filesFixture(page, { pageSize: 2, failAfterFirstPage: true });
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      await expect(page.getByText("This folder did not load.")).toBeVisible();
      await expect(page.getByText("Finding that file…")).toHaveCount(0);
    });

    test("selecting a file opens its details, then Versions and Used by", async ({ page }) => {
      const { seen } = await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await page.getByRole("link", { name: "plan.md" }).click();
      await expect(page).toHaveURL(new RegExp(`file=${uuid(40)}`));
      const panel = page.getByTestId("file-details");
      await expect(panel).toContainText("/projects/web-app/plan.md");
      await expect(panel).toContainText("text/markdown");
      await expect(panel).toContainText(
        "plan, a step of Fix the login redirect",
      );
      await page.mouse.move(700, 700);
      await still(page, "files-details");
      await page.getByRole("tab", { name: "Versions" }).click();
      await expect(page).toHaveURL(/tab=versions/);
      await expect(panel).toContainText("Version 2");
      await expect(panel).toContainText("Current");
      await expect(panel).toContainText("Ana Reyes");
      await expect(panel).toContainText(
        "Every version of a record is kept until its retention ends.",
      );
      await page.getByRole("tab", { name: "Used by" }).click();
      await expect(panel).toContainText("Fix the login redirect");
      await expect(panel).toContainText("used version 2");
      expect(seen.uses).toBeGreaterThan(0);
      await (viewport.name === "phone"
        ? page.getByRole("link", { name: "Back to web-app" })
        : page.getByRole("button", { name: "Close" })).click();
      await expect(page).not.toHaveURL(/file=/);
      await expect(page.getByTestId("file-details")).toHaveCount(0);
    });

    test("the preview shows the current text, and an older version says it is not the current one", async ({ page }) => {
      const { seen } = await filesFixture(page);
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      await expect(page.getByText("The current plan: fix the redirect"))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-preview");
      await page.getByRole("tab", { name: "Versions" }).click();
      await page.getByRole("button", { name: "Show version 1" }).click();
      await expect(page).toHaveURL(/version=1/);
      await expect(page.getByText("The first draft of the plan."))
        .toBeVisible();
      await expect(page.getByText(
        /You are looking at version 1 of 2, saved .* It is not the current version\./,
      )).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Download this version" }),
      ).toBeVisible();
      expect(seen.contents).toContain("1");
      await page.mouse.move(700, 700);
      await still(page, "files-older-version");
      await page.getByRole("button", { name: "Back to current" }).click();
      await expect(page).not.toHaveURL(/version=/);
      await expect(page.getByText("The current plan: fix the redirect"))
        .toBeVisible();
    });

    test("a version in the address opens that version", async ({ page }) => {
      await filesFixture(page);
      await page.goto(
        `/files/projects/web-app?file=${uuid(40)}&tab=versions&version=1`,
      );
      await expect(page.getByText("The first draft of the plan."))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Back to current" }))
        .toBeVisible();
    });

    test("searching a folder lists the matching files, and a hit opens in its folder", async ({ page }) => {
      const { seen } = await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await page.getByRole("searchbox", { name: "Search files by name" })
        .fill("plan");
      const results = page.getByTestId("files-results");
      await expect(results.getByRole("link", { name: "plan.md" }))
        .toBeVisible();
      await expect(results.getByRole("link", { name: "demo.mp4" }))
        .toHaveCount(0);
      await expect(page).toHaveURL(/q=plan/);
      expect(
        seen.searches.some((query) =>
          query.includes("path=%2Fprojects%2Fweb-app")
        ),
      )
        .toBe(true);
      await page.mouse.move(700, 700);
      await still(page, "files-search");
      await results.getByRole("link", { name: "plan.md" }).click();
      await expect(page).toHaveURL(new RegExp(`file=${uuid(40)}`));
      await expect(page).not.toHaveURL(/q=/);
      await expect(page.getByTestId("file-details")).toContainText("plan.md");
    });

    test("the file type filter narrows a search, and Clear search goes back to the folder", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app");
      await page.getByLabel("File type").selectOption("video");
      const results = page.getByTestId("files-results");
      await expect(results.getByRole("link", { name: "demo.mp4" }))
        .toBeVisible();
      await expect(results.getByRole("link", { name: "plan.md" }))
        .toHaveCount(0);
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(page.getByTestId("files-results")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "docs" })).toBeVisible();
    });

    test("All files searches beyond the folder, and no match says so", async ({ page }) => {
      const { seen } = await filesFixture(page);
      await page.goto("/files/projects/api");
      await page.getByLabel("Where").selectOption("all");
      await page.getByRole("searchbox", { name: "Search files by name" })
        .fill("plan");
      await expect(
        page.getByTestId("files-results").getByRole("link", {
          name: "plan.md",
        }),
      ).toBeVisible();
      expect(seen.searches.at(-1)).not.toContain("path=");
      await page.getByRole("searchbox", { name: "Search files by name" })
        .fill("zzzz");
      await expect(page.getByText("Nothing matches")).toBeVisible();
    });

    test("a link to a saved version opens its file in its folder at that version", async ({ page }) => {
      await filesFixture(page);
      await page.goto(`/files/versions/${uuid(501)}`);
      await expect(page).toHaveURL(/\/files\/projects\/web-app\?/);
      await expect(page).toHaveURL(/version=1/);
      await expect(page).toHaveURL(new RegExp(`file=${uuid(40)}`));
      await expect(page.getByText("The first draft of the plan."))
        .toBeVisible();
    });

    test("a link to the current version opens the file without a version", async ({ page }) => {
      await filesFixture(page);
      await page.goto(`/files/versions/${uuid(502)}`);
      await expect(page).toHaveURL(new RegExp(`file=${uuid(40)}`));
      await expect(page).not.toHaveURL(/version=/);
      await expect(page.getByText("The current plan: fix the redirect"))
        .toBeVisible();
    });

    test("a version that is not found says so", async ({ page }) => {
      await filesFixture(page);
      await page.goto(`/files/versions/${uuid(999)}`);
      await expect(page.getByText("This version was not found")).toBeVisible();
      await page.getByRole("button", { name: "Go to Files" }).click();
      await expect(page).toHaveURL(/\/files$/);
    });

    test("each kind of preview has its state", async ({ page }) => {
      await filesFixture(page);
      const open = async (id: number) => {
        await page.goto(`/files/projects/web-app/media?file=${uuid(id)}`);
        await expect(page.getByTestId("file-details")).toBeVisible();
      };
      await open(43);
      await expect(page.getByRole("img", { name: "Image: diagram.png" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-preview-image");
      await open(42);
      await expect(page.getByText(/too large to preview \(4\.8 MB\)/))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-preview-too-large");
      await page.goto(`/files/projects/web-app?file=${uuid(41)}`);
      await expect(page.getByText("No preview for this kind of file."))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-preview-none");
      await open(45);
      await expect(page.getByText("The preview did not load.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Try again" }))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "files-preview-failed");
    });

    test("a file whose contents were removed says so and offers no Download", async ({ page }) => {
      await filesFixture(page, {
        versions: [{
          revision: 1,
          isCurrent: true,
          sizeBytes: 300,
          contentRemoved: true,
          makerKind: "person",
          makerName: "Ana Reyes",
        }],
      });
      await page.goto(`/files/projects/web-app/media?file=${uuid(44)}`);
      await expect(page.getByText(/The contents were removed on/))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Download" }))
        .toHaveCount(0);
      // Nothing waits on a person, so the notice is not in the warning tone.
      await expect(
        page.getByTestId("file-details").locator('[data-variant="warning"]'),
      ).toHaveCount(0);
      await page.mouse.move(700, 700);
      await still(page, "files-preview-removed");
    });

    test("a name is the strongest text in its row, and a long path keeps Close at the top right", async ({ page }) => {
      await filesFixture(page);
      await page.goto("/files/projects/web-app/media");
      const link = page.getByTestId("files-page").getByRole("link", {
        name: "diagram.png",
      });
      await expect(link).toBeVisible();
      const style = await link.evaluate((element) => {
        const heading = document.querySelector("h1");
        return {
          color: getComputedStyle(element).color,
          weight: getComputedStyle(element).fontWeight,
          body: heading === null ? "" : getComputedStyle(heading).color,
        };
      });
      expect(style.color).toBe(style.body);
      expect(style.weight).toBe("500");
      await link.click();
      const panel = page.getByTestId("file-details");
      await expect(panel).toBeVisible();
      await page.getByRole("tab", { name: "Details" }).click();
      // The tabs add no rule of their own under the last row.
      await expect(page.locator(".ui-tabs")).toHaveCSS(
        "border-bottom-width",
        "0px",
      );
      if (viewport.name === "desktop") {
        const close = await panel.getByRole("button", { name: "Close" })
          .boundingBox();
        const heading = await panel.getByRole("heading", {
          name: "diagram.png",
        }).boundingBox();
        expect(close).not.toBeNull();
        expect(heading).not.toBeNull();
        expect(Math.abs(close!.y - heading!.y)).toBeLessThan(16);
      }
    });

    test("a document opens on its artifact page, and its maker links to the work item", async ({ page }) => {
      await filesFixture(page);
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      const panel = page.getByTestId("file-details");
      await expect(
        panel.getByRole("link", { name: "Open Fix the login redirect" }),
      )
        .toHaveAttribute("href", `/tasks/${uuid(602)}`);
      await panel.getByRole("button", { name: "Open", exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`/tasks/${uuid(602)}/artifacts/${uuid(700)}`),
      );
    });

    test("a version an agent wrote names the agent and the person, with an Agent badge", async ({ page }) => {
      await filesFixture(page, {
        versions: [
          {
            revision: 2,
            isCurrent: true,
            sizeBytes: 4200,
            makerKind: "agent",
            makerName: "Ana Reyes",
            agentName: "Reviewer",
          },
          {
            revision: 1,
            isCurrent: false,
            sizeBytes: 3900,
            makerKind: "person",
            makerName: "Ana Reyes",
          },
        ],
      });
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      const panel = page.getByTestId("file-details");
      // Never the person's own: the agent, and whose access it used.
      await expect(panel).toContainText(
        "Reviewer, an agent working for Ana Reyes",
      );
      await expect(panel).toContainText(
        "Written with Ana Reyes's access to this folder.",
      );
      await page.getByRole("tab", { name: "Versions" }).click();
      await expect(
        panel.getByRole("button", {
          name: "Show version 2, written by an agent",
        }),
      ).toBeVisible();
      await expect(panel.getByRole("button", { name: "Show version 1" }))
        .toBeVisible();
      await expect(panel.getByText("Agent", { exact: true })).toHaveCount(1);
      await expect(panel).toContainText(
        "Reviewer, an agent working for Ana Reyes",
      );
    });

    test("an agent version with no person recorded never names one", async ({ page }) => {
      await filesFixture(page, { versions: AGENT_NO_PERSON_VERSIONS });
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      const panel = page.getByTestId("file-details");
      await expect(panel).toContainText("Reviewer, an agent");
      await expect(panel).toContainText(
        "Whose access it used was not recorded.",
      );
      await expect(panel).not.toContainText("Not recorded");
      await expect(panel).not.toContainText("working for");
      await page.getByRole("tab", { name: "Versions" }).click();
      await expect(panel).toContainText("An agent");
      await expect(panel.getByText("Agent", { exact: true })).toHaveCount(2);
    });

    test("a version a step wrote carries the Agent badge, a person's does not", async ({ page }) => {
      await filesFixture(page);
      await page.goto(
        `/files/projects/web-app?file=${uuid(40)}&tab=versions`,
      );
      const panel = page.getByTestId("file-details");
      await expect(
        panel.getByRole("button", {
          name: "Show version 2, written by an agent",
        }),
      ).toBeVisible();
      await expect(panel.getByRole("button", { name: "Show version 1" }))
        .toBeVisible();
      await expect(panel.getByText("Agent", { exact: true })).toHaveCount(1);
    });

    test("the agent help tip explains the line below without a session", async ({ page }) => {
      await filesFixture(page);
      await page.goto(
        `/files/projects/web-app?file=${uuid(40)}&tab=versions`,
      );
      const panel = page.getByTestId("file-details");
      await panel.getByRole("button", { name: "About agent versions" }).click();
      await expect(page.getByRole("tooltip")).toHaveText(
        "An agent wrote this version. The line below names the agent and whose access it used.",
      );
    });

    test("the version being viewed is marked in the list", async ({ page }) => {
      await filesFixture(page);
      await page.goto(
        `/files/projects/web-app?file=${uuid(40)}&tab=versions&version=1`,
      );
      await expect(page.getByTestId("file-details").getByText("Viewing"))
        .toBeVisible();
    });

    test("on a phone a file is a page of its own, with Copy path under More", async ({ page }) => {
      test.skip(viewport.name !== "phone");
      await filesFixture(page);
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      await expect(page.getByTestId("file-details")).toBeVisible();
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Files", level: 1 }))
        .toHaveCount(0);
      await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Copy path" }))
        .toHaveCount(0);
      await page.getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("navigation", { name: "More actions" }))
        .toBeVisible();
      await page.getByRole("link", { name: "Back to web-app" }).click();
      await expect(page).not.toHaveURL(/file=/);
      await expect(page.getByRole("searchbox")).toBeVisible();
    });

    test("on a phone a search hit labels its values", async ({ page }) => {
      test.skip(viewport.name !== "phone");
      await filesFixture(page);
      await page.goto("/files/projects/web-app?q=plan");
      const hit = page.locator(`[data-hit-path="/projects/web-app/plan.md"]`);
      await expect(hit).toContainText("Where: /projects/web-app");
      await expect(hit).toContainText("Kind: Plan");
      await expect(hit).toContainText("Made by: Ana Reyes");
      await expect(hit).toContainText("Size: 4.1 KB");
      await page.mouse.move(700, 700);
      await still(page, "files-search-rows");
    });

    test("on a desktop the button says Copy path", async ({ page }) => {
      test.skip(viewport.name !== "desktop");
      await filesFixture(page);
      await page.goto(`/files/projects/web-app?file=${uuid(40)}`);
      await expect(
        page.getByTestId("file-details").getByRole("button", {
          name: /Copy the path of plan\.md/,
        }),
      ).toHaveText("Copy path");
    });

    test("a file nothing has used says so", async ({ page }) => {
      await filesFixture(page, { uses: [] });
      await page.goto(`/files/projects/web-app?file=${uuid(40)}&tab=uses`);
      await expect(page.getByText("Nothing has used this file yet"))
        .toBeVisible();
    });
  });
}
