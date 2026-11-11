import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Removes the built preview bundle that playwright.config.ts created. */
export default function globalTeardown(): void {
  if (!process.env.CI && process.env.BAKERY_WEB_PREVIEW !== "1") return;
  const port = process.env.BAKERY_WEB_PORT || "5173";
  rmSync(
    join(process.env.RUNNER_TEMP || tmpdir(), `bakery-web-shell-${port}`),
    { recursive: true, force: true },
  );
}
