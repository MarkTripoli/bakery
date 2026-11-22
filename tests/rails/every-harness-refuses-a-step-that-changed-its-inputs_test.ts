/**
 * The refusal belongs to the step, not to one adapter.
 *
 * A step's inputs are sealed before it starts and compared with the index after
 * it exits. That comparison is the actual enforcement — the modes are a barrier
 * against a mistake, not against a decision, because the harness runs as the
 * same user. If the check lived inside a single adapter it would be a property
 * of that harness, and a step run through another one would publish an answer
 * built on bytes nobody pinned.
 *
 * These rails pin the shape rather than the behaviour of each adapter: the call
 * sits directly after the cancellation check, so nothing is published for work
 * somebody stopped and nothing is published for a step that rewrote its inputs,
 * and it appears once per entry point in every harness.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";

const RAILS_DIR = new URL(".", import.meta.url).pathname;
const HARNESSES = ["claude-harness.ts", "codex-harness.ts", "pi-harness.ts"];

/** The two entry points each harness serves: bounded tasks and freeform work. */
const ENTRY_POINTS = 2;

function sourcePath(name: string): string {
  return join(RAILS_DIR, "../../apps/worker/src", name);
}

Deno.test("every harness asks the context check exactly once per entry point", async () => {
  for (const harness of HARNESSES) {
    const source = await Deno.readTextFile(sourcePath(harness));
    const calls = source.match(/await contextTamperingRefusal\(context\)/g) ??
      [];
    assertEquals(
      calls.length,
      ENTRY_POINTS,
      `${harness} checks the context ${calls.length} times`,
    );
  }
});

Deno.test("the check runs after the cancellation check and before publishing", async () => {
  for (const harness of HARNESSES) {
    const source = await Deno.readTextFile(sourcePath(harness));
    const cancel =
      "if (signal.aborted) return harnessCanceledOutcome(run.teardown);";
    const check = "const tampering = await contextTamperingRefusal(context);";
    const refusal = "if (tampering !== null) return tampering;";
    let at = source.indexOf(cancel);
    let seen = 0;
    while (at !== -1) {
      const rest = source.slice(at + cancel.length);
      const afterCancel = rest.indexOf(check);
      // Directly after the cancellation check, with only a comment between, so a
      // later refactor cannot move the check past a publish and still pass.
      assertEquals(
        rest.slice(0, afterCancel).replace(/\/\/[^\n]*\n/g, "").trim(),
        "",
        `${harness}: the context check is not the next statement after cancellation`,
      );
      assertStringIncludes(
        rest.slice(afterCancel, afterCancel + 400),
        refusal,
        `${harness}: the check is not turned into a refusal`,
      );
      seen += 1;
      at = source.indexOf(cancel, at + cancel.length);
    }
    assertEquals(seen, ENTRY_POINTS, `${harness} has ${seen} entry points`);
  }
});

Deno.test("a tampered step earns a refusal that says why, and is not retried", async () => {
  const source = await Deno.readTextFile(
    join(RAILS_DIR, "../../apps/worker/src/harness-context.ts"),
  );
  // The refusal names the path and the reason, and it is not retryable: the
  // bytes on disk are not what admission pinned, so running the step again
  // would ask the same question of a tree nobody can vouch for.
  assertStringIncludes(source, '"HARNESS_CONTEXT_TAMPERED"');
  assertStringIncludes(source, "changed its own pinned inputs");
  assertStringIncludes(source, "Its output was not accepted.");
  const refusal = source.slice(source.indexOf("contextTamperingRefusal"));
  assertStringIncludes(refusal.slice(0, 800), "409");
  assertStringIncludes(refusal.slice(0, 800), "false");
});
