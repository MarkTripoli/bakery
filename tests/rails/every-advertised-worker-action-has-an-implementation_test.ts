import { assert, assertEquals } from "@std/assert";
import { COORDINATOR_TURN_ACTION } from "../../packages/contracts/src/coordinator-turn.ts";
import { CLAUDE_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/claude-harness.ts";
import { CODEX_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/codex-harness.ts";
import { PI_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/pi-harness.ts";
import { NATIVE_SUPPORTED_ACTIONS } from "../../apps/worker/src/executor.ts";
import { HARNESS_REPAIR_ACTION } from "../../apps/worker/src/harness-common.ts";
import { FREEFORM_ACTION } from "../../apps/worker/src/harness-freeform.ts";
import { REVIEW_ACTION } from "../../apps/worker/src/reviewer.ts";
import {
  EVALUATION_CHECK_ACTION,
  EVALUATION_SCORE_ACTION,
} from "../../apps/worker/src/evaluation-executor.ts";

/**
 * The worker action table is what a worker may be asked to run. An action that
 * is in the table and that no worker implements is a promise the runtime
 * breaks: a job for it is claimable by nobody. This rail lists what a worker
 * implements and pins the rest by name, so adding an action to the table
 * without an implementation fails here, and so does implementing one of the
 * pinned actions without taking it off the list.
 */

const root = new URL("../../", import.meta.url);

/** Actions in the table that no worker implements yet. Remove one when it is. */
const ADVERTISED_WITHOUT_WORKER = [
  "mcp.discover",
  "rpi.design",
  "session.call",
  "session.tools",
];

/** Named by string because the worker declares them inline rather than exporting them. */
const INLINE_ACTIONS = [
  "quality.check",
  "repository.inspect",
  "secret.identity.read",
  "task.brief",
];

Deno.test("every worker action in the table is implemented or pinned as not yet", async () => {
  const spec = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/transport-schemas.json", root),
    ),
  ) as { workerActions: Record<string, unknown> };
  const implemented = new Set<string>([
    ...CLAUDE_HARNESS_SUPPORTED_ACTIONS,
    ...CODEX_HARNESS_SUPPORTED_ACTIONS,
    ...PI_HARNESS_SUPPORTED_ACTIONS,
    ...NATIVE_SUPPORTED_ACTIONS,
    HARNESS_REPAIR_ACTION,
    FREEFORM_ACTION,
    REVIEW_ACTION,
    EVALUATION_CHECK_ACTION,
    EVALUATION_SCORE_ACTION,
    COORDINATOR_TURN_ACTION,
    ...INLINE_ACTIONS,
  ]);
  const without = Object.keys(spec.workerActions).filter((action) =>
    !implemented.has(action)
  ).sort();
  assertEquals(
    without,
    ADVERTISED_WITHOUT_WORKER,
    "the worker actions with no implementation changed; implement the new one, or take an implemented one off the list",
  );
});

Deno.test("an action the rail takes on trust by name is still named in the worker", async () => {
  let text = "";
  for await (const entry of Deno.readDir(new URL("apps/worker/src/", root))) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      text += await Deno.readTextFile(
        new URL(`apps/worker/src/${entry.name}`, root),
      );
    }
  }
  for (const action of INLINE_ACTIONS) {
    assert(
      text.includes(`"${action}"`),
      `${action} is no longer named in apps/worker/src, so the rail cannot trust it`,
    );
  }
});

Deno.test("agent.freeform is advertised by all three coding harnesses", async () => {
  // The supported-action constants list the edit actions; freeform is added by
  // each executor, so read the executors' source rather than the constants.
  for (const file of ["claude-harness", "codex-harness", "pi-harness"]) {
    const text = await Deno.readTextFile(
      new URL(`apps/worker/src/${file}.ts`, root),
    );
    assert(
      /supportedActions: \[[^\]]*FREEFORM_ACTION/s.test(text),
      `${file} does not advertise agent.freeform`,
    );
  }
});
