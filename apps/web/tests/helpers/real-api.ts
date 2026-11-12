import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect as baseExpect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

/**
 * Helpers for the real-API browser journeys: a Deno child runs the real
 * Bakery app on a real test database and the page's requests are forwarded to
 * it unchanged (see tests/helpers/*-server.child.ts).
 */

/**
 * Every page in these journeys is a hard load of the unbundled Vite dev server
 * followed by reads through the real API, which takes several seconds on a
 * shared, loaded host and exceeds the default 5 s `expect` timeout. The
 * assertions are unchanged; they wait longer, and a holding one returns at once.
 */
export const expect = baseExpect.configure({ timeout: 20_000 });

/** What every child prints on its first line, plus whatever it adds. */
export type ChildServer = {
  readonly apiUrl: string;
  readonly controlUrl: string;
  readonly publicOrigin: string;
  readonly adminCookie: string;
  readonly developerCookie: string;
  readonly organizationId: string;
};

/** Starts the Deno child at `script` (repo-relative) and waits for its JSON line. */
export async function startChild<T extends ChildServer>(
  script: string,
): Promise<{ readonly child: ChildProcess; readonly server: T }> {
  const root = new URL("../../../../", import.meta.url);
  const child = spawn("deno", [
    "run",
    "--allow-all",
    "--config",
    fileURLToPath(new URL("deno.json", root)),
    fileURLToPath(new URL(script, root)),
  ], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const lines = createInterface({ input: child.stdout! });
  const server = await new Promise<T>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
    lines.on("line", (line) => {
      if (line.startsWith("{")) resolve(JSON.parse(line) as T);
    });
  });
  return { child, server };
}

/** Closes the child's stdin so it cleans up what it seeded, and waits for it. */
export async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin?.end();
  await exited;
}

/** Calls the child's control URL: GET without a body, POST with one. */
export async function control<T>(
  server: ChildServer,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `${server.controlUrl}${path}`,
    body === undefined
      ? undefined
      : { method: "POST", body: JSON.stringify(body) },
  );
  baseExpect(response.ok, path).toBe(true);
  return await response.json() as T;
}

/** Bakery's API through the child, as the person owning `cookie`; never mocked. */
export async function forwardToApi(
  page: Page,
  baseURL: string,
  server: ChildServer,
  cookie: string,
) {
  const forward = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await route.fetch({
      url: `${server.apiUrl}${url.pathname}${url.search}`,
      // The API's CSRF check expects its own public origin.
      headers: {
        ...request.headers(),
        cookie,
        ...(request.headers().origin ? { origin: server.publicOrigin } : {}),
      },
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  };
  await page.route(`${baseURL}/v1/**`, forward);
  await page.route(`${baseURL}/api/**`, forward);
}

const evidenceDirectory = process.env.BAKERY_EVIDENCE_DIR;
/** `dark` or `light`: capture the stills under that color scheme (default: the browser's). */
const evidenceScheme = process.env.BAKERY_EVIDENCE_SCHEME === "dark"
  ? "dark"
  : process.env.BAKERY_EVIDENCE_SCHEME === "light"
  ? "light"
  : null;
const EVIDENCE_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/**
 * Saves `<name>--desktop.png` and `<name>--mobile.png` of the page as it is
 * (full page) when `BAKERY_EVIDENCE_DIR` is set; otherwise does nothing.
 * `mask` hides what must not be published.
 */
export async function shot(page: Page, name: string, mask: Locator[] = []) {
  if (!evidenceDirectory) return;
  if (evidenceScheme) await page.emulateMedia({ colorScheme: evidenceScheme });
  const original = page.viewportSize();
  for (const { name: viewport, ...size } of EVIDENCE_VIEWPORTS) {
    await page.setViewportSize(size);
    // One frame, so the responsive layout has settled at the new size.
    await page.evaluate(() =>
      new Promise((resolve) => requestAnimationFrame(resolve))
    );
    await page.screenshot({
      path: join(evidenceDirectory, `${name}--${viewport}.png`),
      fullPage: true,
      mask,
      maskColor: "#9ca3af",
    });
  }
  if (original) await page.setViewportSize(original);
}
