import { expect, type FrameLocator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import {
  coarseTargetCheck,
  detailInertnessIssues,
  renderedContainmentIssues,
  runtimeAssertions,
  runtimeGlobalQuery,
  servedBuildIdentityIssues,
  storyUrl,
  // deno-lint-ignore no-sloppy-imports
} from "../scripts/capture-stories.mjs";

export {
  coarseTargetCheck,
  detailInertnessIssues,
  renderedContainmentIssues,
  runtimeAssertions,
  servedBuildIdentityIssues,
  storyUrl,
};

export const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:6006";
export const catalog = JSON.parse(
  await readFile(
    new URL(
      "../../../docs/technical-design/ui-baselines/components.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  entries: Array<{
    id: string;
    storyTitle: string;
    states?: string[];
    variants?: string[];
  }>;
};
export const tokenManifest = JSON.parse(
  await readFile(
    new URL(
      "../../../docs/technical-design/ui-baselines/tokens.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  roles: Array<{
    cssVariable: string;
    values: { light?: string; dark?: string };
  }>;
};
export const runtime = JSON.parse(
  await readFile(
    new URL(
      "../../../docs/technical-design/ui-baselines/runtime-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  contexts: Record<string, {
    viewport: { width: number; height: number };
    dpr: number;
    theme: "light" | "dark";
    storedPreference: "system" | "light" | "dark";
    pointer: "fine" | "coarse";
    locale: "en-US" | "en-XA";
    direction: "ltr" | "rtl";
    timezone: string;
    reducedMotion: "no-preference" | "reduce";
    zoom: 1 | 2;
  }>;
  cases: Array<{
    catalogId: string;
    id: string;
    requiredCaseId: string;
    storyId: string;
    context: string;
    assertions?: string[];
    args?: Record<string, string>;
    paperBaselineId?: string;
  }>;
};

type StoryIndexEntry = { id: string; title: string; type: string };

export async function canonicalStories(page: Page) {
  const response = await page.request.get("/index.json");
  expect(response.ok()).toBe(true);
  const index = await response.json() as {
    entries: Record<string, StoryIndexEntry>;
  };
  const titles = new Set(catalog.entries.map((entry) => entry.storyTitle));
  return Object.values(index.entries).filter((entry) =>
    entry.type === "story" && titles.has(entry.title)
  );
}

/**
 * Opens a story and waits for its specimen on the shared specimen budget.
 * A miss names the story and what the preview showed instead (Storybook's
 * body state, its error text, failed requests), so a flake is diagnosable.
 */
export async function openStory(page: Page, id: string, path: string) {
  const failed: string[] = [];
  const onFailed = (
    request: { url(): string; failure(): { errorText: string } | null },
  ) =>
    failed.push(
      `${request.failure()?.errorText ?? "failed"} ${
        new URL(request.url()).pathname
      }`,
    );
  page.on("requestfailed", onFailed);
  try {
    await page.goto(path);
    try {
      // The shared specimen wait, including its one reload for a preview
      // bundle that never arrived; only then is the miss a failure.
      return await waitForSpecimen(page);
    } catch (error) {
      const preview = await page.evaluate(() => ({
        state: document.body.className.split(/\s+/).filter((name) =>
          name.startsWith("sb-show-")
        ),
        error: document.querySelector("#error-message")?.textContent?.slice(
          0,
          200,
        ) ?? null,
        root: document.querySelector("#storybook-root")?.childElementCount ??
          null,
      })).catch(() => null);
      throw new Error(
        `STORYBOOK_STORY_NOT_RENDERED:${
          JSON.stringify({ id, preview, failed: failed.slice(0, 8) })
        }`,
        { cause: error },
      );
    }
  } finally {
    page.off("requestfailed", onFailed);
  }
}

export function storyPath(id: string) {
  return `/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`;
}

export function runtimeStoryPath(
  id: string,
  context: typeof runtime.contexts[string],
) {
  const viewportMode = context.zoom === 2
    ? "zoom-200"
    : context.viewport.width <= 390
    ? "narrow"
    : context.viewport.width < 1280
    ? "pane"
    : "desktop";
  const globals = [
    `theme:${context.storedPreference}`,
    `direction:${context.direction}`,
    `locale:${context.locale === "en-XA" ? "pseudo" : context.locale}`,
    `pointer:${context.pointer}`,
    `reducedMotion:${context.reducedMotion}`,
    `viewportMode:${viewportMode}`,
  ].join(";");
  return `${storyPath(id)}&globals=${encodeURIComponent(globals)}`;
}

// Storybook mounts the specimen after `load`, so every navigation races the
// first render. The catalog loops walk all 77 stories in sequence while the
// other workers do the same, which is where that race lands, and `expect`'s
// 5 s default is shorter than the budget this harness has always used for the
// very same element. One shared wait keeps them from drifting apart again.
export const specimenTimeout = 30_000;

export async function waitForSpecimen(scope: Page | FrameLocator) {
  const specimen = scope.locator(".storybook-story");
  try {
    await specimen.waitFor({ state: "visible", timeout: specimenTimeout });
    return specimen;
  } catch (error) {
    // A preview bundle that never arrives — `net::ERR_NETWORK_CHANGED` on a
    // saturated host — leaves the iframe blank for good, so no budget helps
    // and only a fresh request can. Recover once, loudly: a story that is
    // genuinely broken fails the second wait exactly as it failed the first.
    if (!("reload" in scope)) throw error;
    console.warn(`specimen never mounted at ${scope.url()}; reloading once`);
    await scope.reload();
    await specimen.waitFor({ state: "visible", timeout: specimenTimeout });
    return specimen;
  }
}

export async function openByTitle(
  page: Page,
  title: string,
  globals?: string,
) {
  const stories = await canonicalStories(page);
  const story = stories.find((entry) => entry.title === title);
  if (!story) throw new Error(`missing Storybook story ${title}`);
  await page.goto(
    `${storyPath(story.id)}${
      globals ? `&globals=${encodeURIComponent(globals)}` : ""
    }`,
  );
  await waitForSpecimen(page);
}

export async function analyzeAxe(page: Page) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await new AxeBuilder({ page }).include("body").analyze();
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Axe is already running")) throw error;
      await page.waitForTimeout(100);
    }
  }
  throw lastError;
}

export async function openRuntimeFixture(
  page: Page,
  storyId: string,
  contextId: string,
  assertions: string[],
  args?: Record<string, string>,
) {
  const context = runtime.contexts[contextId];
  const runtimeCase = {
    id: `fixture.${assertions.join("-")}`,
    args,
    storyId,
    context: contextId,
    assertions,
  };
  await page.setViewportSize(context.viewport);
  await page.emulateMedia({
    colorScheme: context.theme,
    reducedMotion: context.reducedMotion,
  });
  await page.addInitScript(({ preference }) => {
    localStorage.setItem("bakery.theme.v1", preference);
  }, { preference: context.storedPreference });
  expect(runtimeGlobalQuery(context)).toContain(
    `direction:${context.direction}`,
  );
  await page.goto(storyUrl(baseURL, runtimeCase, context), {
    waitUntil: "networkidle",
  });
  await waitForSpecimen(page);
  await page.evaluate(async () => await document.fonts.ready);
  return { context, runtimeCase };
}
