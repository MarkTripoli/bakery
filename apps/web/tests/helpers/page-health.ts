import type { Page, TestType } from "@playwright/test";

const EVENT_CAP = 10;
const EVALUATE_BUDGET_MS = 2_000;

interface PageHealthEvents {
  pageErrors: string[];
  failedRequests: string[];
  consoleErrors: string[];
  crashes: string[];
  crashed: boolean;
}

function push(list: string[], entry: string): void {
  if (list.length < EVENT_CAP) list.push(entry);
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

/** Snapshot of the page, or why none could be taken. Never rejects. */
async function snapshot(page: Page, events: PageHealthEvents) {
  if (events.crashed) return { evaluated: false, reason: "crashed" };
  if (page.isClosed()) return { evaluated: false, reason: "closed" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const evaluation = page.evaluate(() => ({
    evaluated: true as const,
    path: location.pathname,
    readyState: document.readyState,
    mainH1Count: document.querySelectorAll("main h1").length,
    bodyText: document.body?.innerText.slice(0, 120) ?? "",
  }));
  // The loser of the race must not surface a later rejection as unhandled.
  evaluation.catch(() => undefined);
  const timeout = new Promise<{ evaluated: false; reason: string }>(
    (resolve) => {
      timer = setTimeout(
        () => resolve({ evaluated: false, reason: "timeout" }),
        EVALUATE_BUDGET_MS,
      );
    },
  );
  try {
    return await Promise.race([
      evaluation.catch(() => ({ evaluated: false, reason: "error" })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Registers file-level hooks that record page errors, failed requests,
 * console errors and crashes, and on an unexpected test status attach and log
 * one bounded `page-health` snapshot. Separates a slow first render from a
 * blank or stuck page. The afterEach never throws and waits at most 2 s.
 */
export function registerPageHealth(
  // deno-lint-ignore no-explicit-any
  test: TestType<any, any>,
): void {
  const events = new WeakMap<Page, PageHealthEvents>();
  test.beforeEach(({ page }) => {
    const recorded: PageHealthEvents = {
      pageErrors: [],
      failedRequests: [],
      consoleErrors: [],
      crashes: [],
      crashed: false,
    };
    events.set(page, recorded);
    page.on("pageerror", (error) => push(recorded.pageErrors, error.message));
    page.on("requestfailed", (request) =>
      push(
        recorded.failedRequests,
        `${urlPath(request.url())} ${request.failure()?.errorText ?? ""}`
          .trim(),
      ));
    page.on("console", (message) => {
      if (message.type() === "error") {
        push(recorded.consoleErrors, message.text().slice(0, 200));
      }
    });
    page.on("crash", () => {
      recorded.crashed = true;
      push(recorded.crashes, "crash");
    });
  });
  test.afterEach(async ({ page }, testInfo) => {
    try {
      if (testInfo.status === testInfo.expectedStatus) return;
      const recorded = events.get(page);
      if (!recorded) return;
      const body = JSON.stringify({
        test: testInfo.title,
        project: testInfo.project.name,
        status: testInfo.status,
        pageErrors: recorded.pageErrors,
        failedRequests: recorded.failedRequests,
        consoleErrors: recorded.consoleErrors,
        crashes: recorded.crashes,
        snapshot: await snapshot(page, recorded),
      });
      await testInfo.attach("page-health", {
        body,
        contentType: "application/json",
      });
      console.log(`page-health ${body}`);
    } catch {
      // Diagnostics must never fail or stall a test.
    }
  });
}
