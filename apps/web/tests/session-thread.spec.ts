import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

// #405: the agent thread's rules, checked in the browser against the fixture,
// one test per rule of the binding design.

async function open(page: Page, state: string) {
  await mockAuthenticatedSession(page);
  await page.goto(`/__fixtures__/session-thread/${state}`);
  await expect(page.locator('[data-ui-component="sessionThread"]')).toBeVisible(
    {
      timeout: 15_000,
    },
  );
}

test("a turn's work folds under a counts-only summary that is a real button", async ({ page }) => {
  await open(page, "running");
  const summaries = page.locator(".ui-session-thread__summary");
  // The newest turn of a running session opens, and so does any turn with a failure.
  const newest = summaries.last();
  await expect(newest).toHaveAttribute("aria-expanded", "true");
  await expect(newest).toHaveText(/\d+ steps?, \d+ files? changed/);
  // The chevron is part of the control, at its start, with its own space below
  // the message above it.
  const box = await newest.boundingBox();
  const above = await page.locator(".ui-session-thread__turn").last()
    .locator(".ui-conversation-message").boundingBox();
  expect(box!.y - (above!.y + above!.height)).toBeGreaterThanOrEqual(8);
  await newest.click();
  await expect(newest).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.locator(".ui-session-thread__turn").last().locator(
      ".ui-activity-line",
    ),
  ).toHaveCount(0);
  await newest.click();
  await expect(newest).toHaveAttribute("aria-expanded", "true");
});

test("a failed step opens itself, shows its output and is not red alone", async ({ page }) => {
  await open(page, "running");
  const failed = page.locator('.ui-activity-line[data-tone="danger"]').first();
  await expect(failed).toBeVisible();
  // A different icon from a step that went well, and text in the full ink.
  const colors = await page.evaluate(() => {
    const ink = (element: Element | null) =>
      element ? getComputedStyle(element).color : "";
    return {
      failed: ink(
        document.querySelector(
          '.ui-activity-line[data-tone="danger"] .ui-activity-line__row',
        ),
      ),
      ok: ink(
        document.querySelector(
          '.ui-activity-line[data-tone="neutral"] .ui-activity-line__row',
        ),
      ),
    };
  });
  expect(colors.failed).not.toBe(colors.ok);
  const shapes = await page.evaluate(() => {
    const shape = (selector: string) =>
      document.querySelector(`${selector} .ui-activity-line__icon svg`)
        ?.innerHTML ?? "";
    return {
      failed: shape('.ui-activity-line[data-tone="danger"]'),
      ok: shape('.ui-activity-line[data-tone="neutral"]'),
    };
  });
  expect(shapes.failed).not.toBe("");
  expect(shapes.failed).not.toBe(shapes.ok);
  // The output of the failure is open and capped at 240px, scrolling inside.
  const output = page.locator(".ui-session-thread__terminal").first();
  await expect(output).toBeVisible();
  const height = await output.evaluate((node) =>
    node.getBoundingClientRect().height
  );
  expect(height).toBeLessThanOrEqual(240);
});

test("usage ends the turn as fine print, formatted, with no icon and no time", async ({ page }) => {
  await open(page, "running");
  const usage = page.locator(".ui-session-thread__usage");
  await expect(usage).toHaveText("1,240 tokens in, 860 out, $0.0042");
  await expect(usage.locator("svg")).toHaveCount(0);
  await expect(usage.locator("time")).toHaveCount(0);
});

test("every time shares one right-hand edge, and a path never wraps", async ({ page }) => {
  await open(page, "running");
  const edges = await page.locator(".ui-activity-line__time").evaluateAll(
    (nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().right)),
  );
  expect(edges.length).toBeGreaterThan(3);
  expect(new Set(edges).size, JSON.stringify(edges)).toBe(1);
  const path = page.locator(".ui-session-path").first();
  const height = await path.evaluate((node) =>
    node.getBoundingClientRect().height
  );
  expect(height).toBeLessThan(28);
});

test("names and paths are monospace, left to right and not translated", async ({ page }) => {
  await open(page, "running");
  const attributes = await page.locator(".ui-session-path").first().evaluate(
    (node) => ({
      dir: node.getAttribute("dir"),
      translate: node.getAttribute("translate"),
      title: node.getAttribute("title"),
    }),
  );
  expect(attributes).toEqual({
    dir: "ltr",
    translate: "no",
    title: "apps/server/src/modules/upload/retry.ts",
  });
  const family = await page.locator(".ui-activity-line .ui-data-text").first()
    .evaluate((node) => getComputedStyle(node).fontFamily);
  expect(family.toLowerCase()).toContain("mono");
});

test("every line is at least 28px tall, and the author's name is a label, not a heading", async ({ page }) => {
  await open(page, "running");
  const heights = await page.locator(".ui-activity-line__row").evaluateAll(
    (nodes) => nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(28);
  const weight = await page.locator(
    '.ui-conversation-message[data-appearance="plain"] strong',
  ).first().evaluate((node) => getComputedStyle(node).fontWeight);
  expect(weight).toBe("500");
});

test("only a person's message is boxed", async ({ page }) => {
  await open(page, "running");
  const borders = await page.locator(
    ".ui-session-thread .ui-conversation-message",
  )
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        kind: node.getAttribute("data-variant"),
        width: getComputedStyle(node).borderTopWidth,
      }))
    );
  for (const entry of borders) {
    expect(entry.width, entry.kind ?? "").toBe(
      entry.kind === "person" ? "1px" : "0px",
    );
  }
});

test("J and K move between messages, Enter folds the work, End jumps to the latest", async ({ page }) => {
  await open(page, "running");
  const first = page.locator(".ui-session-thread__summary").first();
  await first.focus();
  await page.keyboard.press("j");
  const focused = () =>
    page.evaluate(() =>
      document.activeElement?.getAttribute("data-turn") ?? ""
    );
  const afterJ = await focused();
  expect(afterJ).not.toBe("");
  await page.keyboard.press("k");
  const afterK = await focused();
  expect(afterK).not.toBe(afterJ);
  // Enter on a focused message folds or opens its work.
  const turn = page.locator(`[data-turn="${afterK}"]`);
  const summary = turn.locator(".ui-session-thread__summary");
  if (await summary.count()) {
    const before = await summary.getAttribute("aria-expanded");
    await page.keyboard.press("Enter");
    await expect(summary).not.toHaveAttribute("aria-expanded", before ?? "");
  }
  await page.keyboard.press("End");
  const last = await page.locator("[data-turn]").last().getAttribute(
    "data-turn",
  );
  expect(await focused()).toBe(last);
});

test("past 30 lines a turn shows the first 30 and Show N more", async ({ page }) => {
  await open(page, "wide");
  const turn = page.locator(".ui-session-thread__turn").nth(1);
  await expect(turn.locator(".ui-activity-line")).toHaveCount(30);
  const more = turn.getByRole("button", { name: "Show 12 more" });
  await expect(more).toBeVisible();
  await more.click();
  await expect(turn.locator(".ui-activity-line")).toHaveCount(42);
  await expect(more).toHaveCount(0);
});

test("a redacted line explains itself and is not a guess", async ({ page }) => {
  await open(page, "wide");
  await page.getByRole("button", { name: "Show 12 more" }).click();
  const redacted = page.getByText("Hidden by the redaction policy");
  await expect(redacted).toBeVisible();
  await redacted.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "The content is not stored for display.",
  );
});

test("the now line is the only live region, and it names what is running", async ({ page }) => {
  await open(page, "running");
  await expect(
    page.locator(
      ".ui-session-thread [aria-live]:not([data-ui-component=sessionNowLine])",
    ),
  ).toHaveCount(0);
  const now = page.locator('[data-ui-component="sessionNowLine"]');
  await expect(now).toHaveCount(1);
  await expect(now).toHaveAttribute("role", "status");
  await expect(now).toContainText("Running run_tests…");
  // The elapsed time at the edge is never announced.
  await expect(now.locator(".ui-session-now__elapsed")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
});

test("a failed session says so once, in the now line, and has no second row", async ({ page }) => {
  await open(page, "failed");
  const now = page.locator('[data-ui-component="sessionNowLine"]');
  await expect(now).toContainText("Session failed.");
  await expect(now).toContainText("The signing key expired on 2026-11-02.");
  await expect(page.getByText("Session failed", { exact: false })).toHaveCount(
    1,
  );
  await expect(page.locator(".ui-session-thread__end")).toHaveCount(0);
});

test(
  "there is no bar above the thread, and the shortcuts button takes no height",
  async ({ page }, testInfo) => {
    await open(page, "running");
    await expect(page.locator(".ui-session-thread__bar")).toHaveCount(0);
    const gap = await page.evaluate(() => {
      const thread = document.querySelector(".ui-session-thread")!
        .getBoundingClientRect();
      const first = document.querySelector(".ui-session-thread__turn")!
        .getBoundingClientRect();
      const help = document.querySelector(".ui-session-thread__help")!
        .getBoundingClientRect();
      return {
        top: first.top - thread.top,
        helpRight: help.right,
        threadRight: thread.right,
      };
    });
    // The first message starts at the thread's own top, and the button sits at its end corner.
    expect(gap.top).toBeLessThanOrEqual(1);
    if (testInfo.project.name === "mobile") {
      // A touch screen has no keys, and a tooltip cannot be opened there.
      await expect(page.locator(".ui-session-thread__help")).toBeHidden();
      return;
    }
    expect(Math.abs(gap.helpRight - gap.threadRight)).toBeLessThanOrEqual(1);
  },
);

test("the message box, the times and the thread share one right-hand edge", async ({ page }) => {
  await open(page, "running");
  const edges = await page.evaluate(() => {
    const right = (selector: string) =>
      Math.round(
        document.querySelector(selector)!.getBoundingClientRect().right,
      );
    return [
      right(".ui-conversation-message[data-appearance=card]"),
      right(".ui-activity-line__row"),
      right(".ui-session-thread"),
    ];
  });
  expect(new Set(edges).size, JSON.stringify(edges)).toBe(1);
});

test("a lost connection offers Try now and keeps the thread", async ({ page }) => {
  await open(page, "lost");
  const now = page.locator('[data-ui-component="sessionNowLine"]');
  await expect(now).toContainText(
    "Connection lost. Reconnecting… Last update 2 min ago.",
  );
  await expect(now.getByRole("button", { name: "Try now" })).toBeVisible();
  // Centred on its line, not hanging below it.
  const centres = await now.evaluate((node) => {
    const mid = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return [
      mid(node.querySelector(".ui-session-now__text")!),
      mid(node.querySelector("button")!),
    ];
  });
  expect(Math.abs(centres[0] - centres[1])).toBeLessThanOrEqual(2);
  await expect(page.locator(".ui-session-thread__turn").first()).toBeVisible();
});

test("a finished session folds to one line per message and ends in a completed row", async ({ page }) => {
  await open(page, "finished");
  for (
    const summary of await page.locator(".ui-session-thread__summary").all()
  ) {
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  }
  await expect(page.locator(".ui-session-thread__end")).toHaveAttribute(
    "data-outcome",
    "completed",
  );
  await expect(page.locator('[data-ui-component="sessionNowLine"]'))
    .toHaveCount(0);
});

test("the loading, empty and error states say what to do", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.goto("/__fixtures__/session-thread/loading");
  await expect(page.locator('[data-ui-component="skeleton"]').first())
    .toBeVisible({
      timeout: 15_000,
    });
  await page.goto("/__fixtures__/session-thread/empty");
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  await expect(
    page.getByText(
      "Messages and the agent's work appear here as the session runs.",
    ),
  ).toBeVisible();
  await page.goto("/__fixtures__/session-thread/error");
  await expect(page.getByText("This session could not load.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the shimmer stops under reduced motion and the ellipsis stays", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "running");
  const text = page.locator(".ui-session-now__text");
  const animation = await text.evaluate((node) =>
    getComputedStyle(node).animationName
  );
  expect(animation).toBe("none");
  await expect(text).toContainText("…");
});
