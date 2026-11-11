import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Route,
} from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { shot, type StorageState } from "./real-run-observation.ts";

/**
 * Page helpers of the M1 journey spec. Every selector, role and
 * label here is lifted from a spec that already drives the same screen against
 * the real API: `task-conversation-real-api.spec.ts` (conversation, plan
 * revision, question, approval), `task-run-control-real-api.spec.ts` (Start
 * run, run controls), `fixed-coding-journey-browser.mjs` (run steps and
 * status) and `machines-real-api.spec.ts` (Machines).
 *
 * The only network interception in the journey is in this file, in two
 * helpers, and neither fakes a response: `loseResponseOnce` lets the server
 * commit one request and then aborts the response on the way back
 * (`fixed-coding-journey-browser.mjs:115-150`), and `abortReads` aborts reads
 * so a second page cannot learn about a newer plan revision
 * (`task-conversation-real-api.spec.ts:254-263`). No route fulfills a
 * response, rewrites a request or intercepts a WebSocket.
 */

export const DESKTOP = { width: 1440, height: 1000 } as const;
export const PHONE = { width: 390, height: 844 } as const;

// ---- conversation ---------------------------------------------------------------
export const conversationRegion = (page: Page) =>
  page.getByRole("region", { name: "Conversation", exact: true });
export const messageBox = (page: Page) =>
  page.getByRole("textbox", { name: "Message this task" });
export const sendButton = (page: Page) =>
  page.getByRole("button", { name: "Send", exact: true });
export const planRegion = (page: Page) =>
  page.locator('[data-ui-region="plan-revision"]');
export const approve = (page: Page, revision: number) =>
  page.getByRole("button", {
    name: `Approve revision ${revision}`,
    exact: true,
  });
export const startRunButton = (page: Page) =>
  page.getByRole("button", { name: "Start run", exact: true });
export const questionCard = (page: Page) =>
  page.locator('[data-ui-component="questionCard"]');

/** Sends one message with the given intent (task-conversation-real-api:99). */
export async function say(
  page: Page,
  intent: "Discuss" | "Ask agent",
  body: string,
) {
  await page.getByLabel(intent, { exact: true }).check({ force: true });
  await messageBox(page).fill(body);
  await sendButton(page).click();
}

/**
 * Answers the open question card: the radio option whose accessible name
 * matches `prefer` when there is one, else the first option, else the
 * free-text field. It asserts the radio really is checked, and reports whether
 * the preferred option existed, so the evidence never claims a preference the
 * card did not honor.
 */
export async function answerQuestion(
  page: Page,
  prefer: RegExp,
  textAnswer: string,
): Promise<
  {
    id: string | null;
    prompt: string;
    answer: string;
    preferredMatched: boolean;
  }
> {
  const card = questionCard(page).first();
  const id = await card.getAttribute("data-question-id");
  const prompt = ((await card.locator("h2, h3, [role=heading]").first()
    .textContent().catch(() => null)) ?? (await card.textContent()) ?? "")
    .trim().slice(0, 400);
  const options = card.getByRole("radio");
  const count = await options.count();
  let answer = textAnswer;
  let preferredMatched = false;
  if (count > 0) {
    // The radio is an <input> with no text of its own: match its accessible name.
    const preferred = card.getByRole("radio", { name: prefer });
    preferredMatched = (await preferred.count()) > 0;
    const target = preferredMatched ? preferred.first() : options.first();
    // The enclosing <label> names the option. A string passed to `evaluate`
    // is not called as a function (live run, stage B: it returned undefined),
    // so read the label through the DOM tree with a locator.
    const enclosingLabel = target.locator("xpath=ancestor::label").first();
    answer = ((await enclosingLabel.count()) > 0
      ? await enclosingLabel.textContent()
      : null)?.trim() ?? (await target.getAttribute("value")) ?? "";
    await target.check({ force: true });
    await expect(target).toBeChecked();
  } else {
    await card.getByLabel("Your answer").fill(textAnswer);
  }
  await card.getByRole("button", { name: "Send answer" }).click();
  return { id, prompt, answer, preferredMatched };
}

// ---- run page ---------------------------------------------------------------------
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  canceling: "Canceling",
  canceled: "Canceled",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
};
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"];

export const runSteps = (page: Page) =>
  page.getByRole("list", { name: "Run steps" });
export const stepRow = (page: Page, title: string) =>
  runSteps(page).getByRole("listitem").filter({ hasText: title });
export const runStatus = (page: Page) =>
  page.getByRole("status", { name: "Run updates" });
export const controlButton = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
export const runTerminalEntries = (page: Page) =>
  runSteps(page).getByRole("listitem").filter({
    hasText: /Run (completed|failed|canceled)/,
  });

// ---- the composer ---------------------------------------------------------------
/** Fills the New task form for a fixed coding run (fixed-coding-journey-browser:77). */
export async function fillComposer(
  page: Page,
  repositoryId: string,
  title: string,
  description: string,
) {
  const form = page.getByRole("form", { name: "New task" });
  await form.getByRole("combobox", { name: /^Repository/ }).selectOption(
    repositoryId,
  );
  await expect(page.getByRole("radio", { name: /Fixed coding/ })).toBeChecked({
    timeout: 30_000,
  });
  await form.getByRole("textbox", { name: /^Title/ }).fill(title);
  await form.getByRole("textbox", { name: /^Description/ }).fill(description);
  return form;
}

// ---- interception that never fakes a response -----------------------------------
/**
 * Lets the server commit the first matching request, then aborts the response
 * so the browser sees a network failure: a lost response, never a lost request.
 */
export async function loseResponseOnce(
  page: Page,
  urlGlob: string,
  method: string,
) {
  let lost = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== method || lost > 0) {
      return route.continue();
    }
    lost += 1;
    await route.fetch();
    await route.abort("failed");
  };
  await page.route(urlGlob, handler);
  return {
    lostResponses: () => lost,
    restore: () => page.unroute(urlGlob, handler),
  };
}

/** Aborts matching reads so this page keeps showing what it last learned. */
export async function abortReads(
  page: Page,
  matches: (url: URL) => boolean,
) {
  const handler = (route: Route) => route.abort();
  await page.route(matches, handler);
  return { restore: () => page.unroute(matches, handler) };
}

// ---- sessions and screenshots ----------------------------------------------------
const ORGANIZATION_KEY = "bakery.organization.lastSelected.v1";
const THEME_KEY = "bakery.theme.v1";

/**
 * Playwright `recordVideo` for one phase: the clip lands under
 * `<BAKERY_M1_SHOTS>/video/<label>/` and is written when the context closes.
 * The project-level `video` option does not reach contexts a spec creates
 * itself, so each phase opts in by label. P3 never does: its page shows the
 * one-time worker setup key.
 */
export function recordVideoFor(
  label: string,
  size: { width: number; height: number } = DESKTOP,
) {
  const directory = process.env.BAKERY_M1_SHOTS;
  return directory
    ? { recordVideo: { dir: `${directory}/video/${label}`, size } }
    : {};
}

/** A new browser context carrying the signed-in session. */
export async function sessionContext(
  browser: Browser,
  session: StorageState,
  organizationId: string,
  options: {
    viewport?: { width: number; height: number };
    colorScheme?: "light" | "dark";
    theme?: "system" | "light" | "dark";
    phone?: boolean;
    /** Record a video of this context under this label (see recordVideoFor). */
    video?: string;
  } = {},
): Promise<BrowserContext> {
  const phone = options.phone === true;
  const context = await browser.newContext({
    storageState: session,
    viewport: options.viewport ?? DESKTOP,
    ...(options.video
      ? recordVideoFor(options.video, options.viewport ?? DESKTOP)
      : {}),
    ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.addInitScript(
    ({ organization, theme, themeKey, organizationKey }) => {
      localStorage.setItem(organizationKey, organization);
      if (theme) localStorage.setItem(themeKey, theme);
    },
    {
      organization: organizationId,
      theme: options.theme ?? null,
      themeKey: THEME_KEY,
      organizationKey: ORGANIZATION_KEY,
    },
  );
  return context;
}

/**
 * Desktop and phone, light and dark screenshots of one signed-in route
 * (`shootAll` in `real-run-observation.ts` does the same for the run page).
 */
export async function shootRoute(
  directory: string,
  browser: Browser,
  session: StorageState,
  organizationId: string,
  path: string,
  prefix: string,
  ready: (page: Page) => Promise<unknown>,
) {
  if (!directory) return;
  const viewports = [
    { name: "desktop", viewport: DESKTOP, phone: false },
    { name: "phone", viewport: PHONE, phone: true },
  ];
  for (const { name, viewport, phone } of viewports) {
    for (const theme of ["light", "dark"] as const) {
      const context = await sessionContext(browser, session, organizationId, {
        viewport,
        colorScheme: theme,
        theme,
        phone,
      });
      try {
        const page = await context.newPage();
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await ready(page);
        await shot(directory, page, `${prefix}-${name}-${theme}`);
      } finally {
        await context.close();
      }
    }
  }
}

/** The same four screenshots of a route that needs no session (`/setup`). */
export async function shootAnonymous(
  directory: string,
  browser: Browser,
  path: string,
  prefix: string,
  ready: (page: Page) => Promise<unknown>,
) {
  if (!directory) return;
  for (
    const [name, viewport, phone] of [
      ["desktop", DESKTOP, false],
      ["phone", PHONE, true],
    ] as const
  ) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        hasTouch: phone,
        isMobile: phone,
        locale: "en-US",
        timezoneId: "UTC",
      });
      try {
        await context.addInitScript(
          ({ selected, themeKey }) => localStorage.setItem(themeKey, selected),
          { selected: theme, themeKey: THEME_KEY },
        );
        const page = await context.newPage();
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await ready(page);
        await shot(directory, page, `${prefix}-${name}-${theme}`);
      } finally {
        await context.close();
      }
    }
  }
}

// ---- accessibility and layout ---------------------------------------------------
/** No axe violation on the current screen (real data, as the FS26 specs do). */
export async function axeClean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map((violation: { id: string; help: string }) =>
      `${violation.id}: ${violation.help}`
    ),
    `axe violations on ${label}`,
  ).toEqual([]);
}

/**
 * The document is not wider than the window (320 px and 200% zoom checks).
 * String expressions: the type check has no DOM library, and the page
 * evaluates them in the browser.
 */
export async function noHorizontalScroll(page: Page): Promise<boolean> {
  return await page.evaluate(
    "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1",
  ) as boolean;
}

/** The longest CSS transition in the main region, in seconds. */
export async function longestTransition(page: Page): Promise<number> {
  return await page.evaluate(
    `Math.max(0, ...[...document.querySelectorAll("main *")].map((element) => parseFloat(getComputedStyle(element).transitionDuration)))`,
  ) as number;
}
