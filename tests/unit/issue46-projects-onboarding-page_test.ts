import { assertEquals } from "@std/assert";
import { runCursorPageRequest } from "../../apps/web/src/pages/projects-onboarding/cursor-page-request.ts";

Deno.test("cursor reset discards stale page results, errors and completion while the new scope is loading", async () => {
  for (const staleOutcome of ["success", "error"] as const) {
    const oldPage = Promise.withResolvers<readonly string[]>();
    const newPage = Promise.withResolvers<readonly string[]>();
    const guard = { generation: 0, inFlight: false };
    const view = {
      rows: [] as string[],
      error: false,
      loading: true,
      completions: 0,
    };
    const append = (rows: readonly string[]) => {
      view.rows.push(...rows);
    };
    const failed = () => {
      view.error = true;
    };
    const complete = () => {
      view.loading = false;
      view.completions += 1;
    };
    const staleRequest = runCursorPageRequest(
      guard,
      () => oldPage.promise,
      append,
      failed,
      complete,
    );

    // The hook advances this generation on organization/session/repository or first-page changes.
    guard.generation += 1;
    guard.inFlight = false;
    const currentRequest = runCursorPageRequest(
      guard,
      () => newPage.promise,
      append,
      failed,
      complete,
    );
    if (staleOutcome === "success") oldPage.resolve(["foreign-repository"]);
    else oldPage.reject(new Error("old organization is unavailable"));
    await staleRequest;

    assertEquals(view, {
      rows: [],
      error: false,
      loading: true,
      completions: 0,
    });
    assertEquals(guard.inFlight, true);
    newPage.resolve(["authorized-repository"]);
    await currentRequest;
    assertEquals(view, {
      rows: ["authorized-repository"],
      error: false,
      loading: false,
      completions: 1,
    });
    assertEquals(guard.inFlight, false);
  }
});
