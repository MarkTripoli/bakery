/**
 * Proves the web server under test can actually reach its API before any spec
 * runs.
 *
 * Why this exists: the suite body checks `main h1`, so a web server whose
 * `/v1` proxy points at nothing renders no heading and every page test fails
 * with a first-render timeout. That reads as flakiness and was reported as
 * worker contention, but it reproduces at `--workers=1` — it is a misconfigured
 * base URL, and the failure message named the locator rather than the cause.
 * Failing here instead puts the real cause in the log once, before 700 tests.
 *
 * It probes exactly what a spec needs: the API answers *through the web
 * server's proxy*. A direct server check would miss the port mismatch that
 * causes this, because the server can be perfectly healthy on a port the web
 * server is not proxying.
 */

/** The base URL the suite will use, matching `use.baseURL` in the config. */
function baseUrl(): string {
  return process.env.BASE_URL ??
    `http://127.0.0.1:${process.env.BAKERY_WEB_PORT || "5173"}`;
}

/** A bootstrapped-installation read that every page render depends on. */
const PROBE_PATH = "/v1/installation/status";

/** How long to wait for a cold dev server to answer a first proxy request. */
const PROBE_TIMEOUT_MS = 20_000;

export default async function globalSetup(): Promise<void> {
  const origin = baseUrl();
  const url = `${origin}${PROBE_PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `The web server at ${origin} did not answer ${PROBE_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        `Every page test would fail on its first render instead. Start the ` +
        `stack (scripts/dev/compose-up.sh) and point BAKERY_SERVER_PORT at it.`,
    );
  }
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(
    `The web server at ${origin} could not reach its API: ${PROBE_PATH} ` +
      `answered ${response.status}.\n${body.slice(0, 400)}\n` +
      `The page cannot render without it, so every page test would fail on ` +
      `its first render. Check BAKERY_SERVER_PORT matches the running server.`,
  );
}
