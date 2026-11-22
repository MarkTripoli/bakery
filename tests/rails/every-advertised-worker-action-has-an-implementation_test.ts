import { assert, assertEquals } from "@std/assert";
import { COORDINATOR_TURN_ACTION } from "../../packages/contracts/src/coordinator-turn.ts";
import { CLAUDE_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/claude-harness.ts";
import { CODEX_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/codex-harness.ts";
import { PI_HARNESS_SUPPORTED_ACTIONS } from "../../apps/worker/src/pi-harness.ts";
import { NATIVE_SUPPORTED_ACTIONS } from "../../apps/worker/src/executor.ts";
import { HARNESS_REPAIR_ACTION } from "../../apps/worker/src/harness-common.ts";
import { FREEFORM_ACTION } from "../../apps/worker/src/harness-freeform.ts";
import { RPI_FREEFORM_ACTIONS } from "../../apps/worker/src/harness-rpi.ts";
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

/**
 * Actions in the table that no worker implements yet, each owned by the open v1
 * issue that will build it. Remove one when it is implemented. A new
 * unimplemented action must name its owning issue here, so none is left
 * advertised without someone to build it.
 */
const ADVERTISED_WITHOUT_WORKER: Readonly<Record<string, string>> = {
  "mcp.discover": "#441",
  "session.call": "#436",
  "session.tools": "#436",
};

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
    ...RPI_FREEFORM_ACTIONS,
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
    Object.keys(ADVERTISED_WITHOUT_WORKER).sort(),
    "the worker actions with no implementation changed; implement the new one, or take an implemented one off the list",
  );
  for (const [action, owner] of Object.entries(ADVERTISED_WITHOUT_WORKER)) {
    assert(
      /^#[1-9]\d*$/.test(owner),
      `${action} must name the open issue that owns it, like #24; got "${owner}"`,
    );
  }
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

Deno.test("rpi.design and rpi.plan are advertised by all three coding harnesses", async () => {
  // Each executor adds them to its supported actions beside freeform.
  for (const file of ["claude-harness", "codex-harness", "pi-harness"]) {
    const text = await Deno.readTextFile(
      new URL(`apps/worker/src/${file}.ts`, root),
    );
    assert(
      /supportedActions: \[[^\]]*\.\.\.RPI_FREEFORM_ACTIONS/s.test(text),
      `${file} does not advertise the RPI actions`,
    );
  }
});

Deno.test("every coding harness is given the design tool from the worker's enrolled capabilities", async () => {
  // rpi.design is advertised by all three harnesses; without this wiring it is
  // advertised and always refused. Each constructor in main.ts must pass it.
  const main = await Deno.readTextFile(
    new URL("apps/worker/src/main.ts", root),
  );
  const wired = main.match(
    /designToolAvailable: designToolAvailableFrom\(config\.capabilities\)/g,
  ) ?? [];
  const constructors = main.match(
    /create(Claude|Codex|Pi)HarnessExecutor\(\{/g,
  ) ?? [];
  assertEquals(constructors.length, 3);
  assertEquals(wired.length, constructors.length);
});
