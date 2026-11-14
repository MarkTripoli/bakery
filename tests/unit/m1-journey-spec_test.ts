import { assert, assertEquals } from "@std/assert";

/**
 * Static guards on the M1 journey spec: the spec cannot be run
 * without the funded stack, so its "no mocks" and "fails closed" promises are
 * checked in the source. Comments are stripped before scanning.
 */

const root = new URL("../../apps/web/tests/", import.meta.url);

async function code(path: string): Promise<string> {
  const source = await Deno.readTextFile(new URL(path, root));
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) =>
    line.replace(/(^|[^:])\/\/.*$/, "$1")
  ).join("\n");
}

const specPath = "m1-journey-real.spec.ts";
const helperPaths = [
  "helpers/m1-api.ts",
  "helpers/m1-journey-ui.ts",
  "helpers/m1-stack-control.ts",
  "helpers/m1-stack-env.ts",
  "helpers/m1-task.ts",
];

Deno.test("the journey and its helpers fake no response and open no WebSocket route", async () => {
  for (const path of [specPath, ...helperPaths]) {
    const source = await code(path);
    assert(!/routeWebSocket/.test(source), `${path} routes a WebSocket`);
    assert(!/\.fulfill\(/.test(source), `${path} fulfills a response`);
    assert(!/\.continue\(\s*\{/.test(source), `${path} rewrites a request`);
    assert(
      !/\broute\.fetch\(\s*[^)\s]/.test(source),
      `${path} rewrites a fetch`,
    );
    assert(!/BAKERY_FS06_/.test(source), `${path} names an FS06 variable`);
  }
});

Deno.test("only two helpers in m1-journey-ui.ts intercept, and the spec itself never does", async () => {
  assertEquals((await code(specPath)).match(/\.route\(/g)?.length ?? 0, 0);
  for (const path of helperPaths) {
    const source = await code(path);
    const count = source.match(/\.route\(/g)?.length ?? 0;
    assertEquals(count, path === "helpers/m1-journey-ui.ts" ? 2 : 0, path);
  }
  const ui = await code("helpers/m1-journey-ui.ts");
  const holders = ui.split(/\n(?=export )/).filter((part) =>
    part.includes(".route(")
  );
  assertEquals(holders.length, 2);
  assert(
    holders.some((part) =>
      /^export async function loseResponseOnce/.test(part)
    ),
  );
  assert(
    holders.some((part) => /^export async function abortReads/.test(part)),
  );
  // The lost response is aborted on its way back and nothing else is faked.
  const lost = holders.find((part) => part.includes("loseResponseOnce"))!;
  assert(lost.includes('route.abort("failed")'));
  assert(
    holders.find((part) => part.includes("abortReads"))!.includes(
      "route.abort()",
    ),
  );
});

Deno.test("the first test refuses a scripted adapter and the funded steps check the cap", async () => {
  const source = await code(specPath);
  const tests = source.split(/\ntest\(/);
  // tests[0] is the preamble; tests[1] is the first test.
  assert(tests[1].includes("P0"));
  assert(tests[1].includes("BAKERY_SCRIPTED_COORDINATOR_DIR"));
  assert(tests[1].includes("BAKERY_WORKER_SCRIPTED_HARNESS_DIR"));
  assert(tests[1].includes("adapter-guards.json"));
  assert(source.includes('test.describe.configure({ mode: "serial" })'));
  assert(source.includes("M1_SPEND_CAP_REACHED"));
  assert(source.includes("BAKERY_M1_STOP_AFTER"));
  assert(source.includes("context.setOffline"));
  // One test per phase P0..P10, each with its own timeout.
  assertEquals(tests.length - 1, 11);
  for (let phase = 0; phase <= 10; phase++) {
    assert(
      tests.some((body) => body.startsWith(`"P${phase} `)),
      `missing test for P${phase}`,
    );
  }
  assertEquals(source.match(/test\.setTimeout\(BUDGET\.P\d+\)/g)?.length, 11);
});

/** The body of each `test("P<n> ...` block, by phase number. */
async function phases(): Promise<Map<number, string>> {
  const source = await code(specPath);
  const bodies = new Map<number, string>();
  for (const part of source.split(/\ntest\(/).slice(1)) {
    const match = /^"P(\d+) /.exec(part);
    if (match) bodies.set(Number(match[1]), part);
  }
  return bodies;
}

Deno.test("P4 reads the coordinator's model from the database, not from output streams (review F1)", async () => {
  const p4 = (await phases()).get(4)!;
  assert(p4.includes("coordinatorModels("));
  assert(!p4.includes("output-streams"), "coordinator turns have no stream");
  assert(p4.includes("M1_PROOF_MODEL"));
});

Deno.test("P6 checks the approved revision in the brief artifact, not in step inputs (review F2)", async () => {
  const p6 = (await phases()).get(6)!;
  assert(!p6.includes("JSON.stringify({ run, steps })"));
  assert(!p6.includes('"Approved plan (revision 2)"'));
  assert(p6.includes("task-brief-"));
  assert(p6.includes("checkBriefApprovedPlan("));
  assert(p6.includes("consumedByRunId"));
});

Deno.test("P6 counts decision requests and responses so a double decision can fail (review F5)", async () => {
  const p6 = (await phases()).get(6)!;
  assert(p6.includes('page.on("response"'));
  assert(p6.includes("/decision"));
  assert(!p6.includes("approveDecisionsOnMainTask"));
});

Deno.test("P10 reads the response of the path the expired decision used (review F3)", async () => {
  const p10 = (await phases()).get(10)!;
  assert(p10.includes("decideRefused("));
  assert(!/await decision;/.test(p10), "no bare wait on a page response");
});

Deno.test("P7 pins the named function and every run is checked against its own targets (review F6, F8)", async () => {
  const bodies = await phases();
  const p7 = bodies.get(7)!;
  assert(!p7.includes("toContain(M1_TASK_FUNCTION)"));
  assert(p7.includes("verifyDocCommentPatch("));
  assert(p7.includes("M1_RUN_TASKS.main"));
  assert(bodies.get(8)!.includes("M1_RUN_TASKS.faults"));
  assert(bodies.get(9)!.includes("M1_RUN_TASKS.cancel"));
  assert(bodies.get(9)!.includes("M1_RUN_TASKS.queued"));
  for (const phase of [8, 9]) {
    assert(
      !bodies.get(phase)!.includes("M1_TASK_DESCRIPTION"),
      `P${phase} must not reuse the main task text`,
    );
  }
});

Deno.test("the worker-resume hook has its own generous timeout (review F7)", async () => {
  const source = await code(specPath);
  const start = source.indexOf("test.afterAll(");
  assert(start >= 0);
  const hook = source.slice(start, source.indexOf("\n});", start));
  assert(
    hook.includes("test.setTimeout("),
    "afterAll needs an explicit timeout",
  );
});

Deno.test("screens that need no run are scanned before the first funded step (review F9)", async () => {
  const source = await code(specPath);
  const firstFunded = source.search(/\bawait fundedStep\(/);
  assert(firstFunded > 0);
  for (const label of ["/tasks/new", "/projects/onboarding", "/machines"]) {
    const at = source.indexOf(`axeClean(page, "${label}`);
    assert(at >= 0, `no axe scan of ${label}`);
    assert(at < firstFunded, `${label} is scanned after a funded step`);
  }
  const p7 = (await phases()).get(7)!;
  for (const label of ["/tasks/new", "/projects/onboarding", "/machines"]) {
    assert(!p7.includes(`"${label}`), `P7 repeats the scan of ${label}`);
  }
  assert(source.includes("completionCopyScope"));
  const helper = await code("helpers/real-run-observation.ts");
  assert(helper.includes("completionCopyScope"));
});

Deno.test("P1 asserts what /setup offers and records it (review F10)", async () => {
  const source = await code(specPath);
  const p1 = (await phases()).get(1)!;
  assert(p1.includes('getByRole("textbox")'));
  assert(p1.includes("toHaveCount(0)"));
  assert(!source.includes("setupOfferedAdminCreation: false"));
  assert(source.includes("setupOffered"));
});

Deno.test("the phase budgets add up to the documented journey budget (review F10)", async () => {
  const source = await code(specPath);
  const raw = await Deno.readTextFile(new URL(specPath, root));
  const block = /const BUDGET = \{([\s\S]*?)\} as const;/.exec(source)![1];
  const minutes = [...block.matchAll(/P\d+: (\d+) \* MINUTE/g)].map((m) =>
    Number(m[1])
  );
  assertEquals(minutes.length, 11);
  const sum = minutes.reduce((total, value) => total + value, 0);
  const documented = /Budgets total (\d+) minutes/.exec(raw);
  assert(documented, "the spec header states the budget total");
  assertEquals(sum, Number(documented![1]));
  assert(sum <= 240, `${sum} minutes is not a realistic journey`);
});

Deno.test("the question helper picks by accessible name and asserts the choice (review F4)", async () => {
  const ui = await code("helpers/m1-journey-ui.ts");
  assert(ui.includes('getByRole("radio", { name: prefer })'));
  assert(!/filter\(\{ hasText: prefer \}\)/.test(ui));
  assert(ui.includes("toBeChecked("));
  assert(ui.includes("preferredMatched"));
});

Deno.test("P6 expects the 200 replay and a 409 approval_decided for a conflicting decision (review F12)", async () => {
  const p6 = (await phases()).get(6)!;
  // The old assertion: any 4xx for an identical duplicate. The server returns
  // the stored approval with 200 (approvals.ts: answer_digest equal).
  assert(!/duplicate\.status\)?[\s\S]{0,40}toBeGreaterThanOrEqual/.test(p6));
  assert(!p6.includes("a duplicate approve is refused"));
  assert(p6.includes("checkDuplicateDecision("));
  assert(p6.includes('decision: "reject"'));
  assert(p6.includes("expectedVersion"));
  // Exactly one accepted decision from the page stays asserted.
  assert(p6.includes("at most one accepted decision from the page"));
});

Deno.test("P4 evidence says where the recorded coordinator model comes from (review F13)", async () => {
  const source = await code(specPath);
  const raw = await Deno.readTextFile(new URL(specPath, root));
  const p4 = (await phases()).get(4)!;
  assert(p4.includes("modelSource"));
  assert(
    source.includes(
      "equals the configured pin when the CLI init record carried no model",
    ),
  );
  // The comment above the assertion is honest about the fallback too.
  assert(/state\.model \?\? options\.model/.test(raw));
});

Deno.test("the brief poll has its own timeout well under the P6 budget (review F14)", async () => {
  const source = await code(specPath);
  const poll = /const BRIEF_POLL_TIMEOUT = (\d+) \* MINUTE;/.exec(source);
  assert(poll, "BRIEF_POLL_TIMEOUT is a named constant");
  const budget = /P6: (\d+) \* MINUTE/.exec(source)!;
  assert(Number(poll![1]) * 2 <= Number(budget[1]));
  const p6 = (await phases()).get(6)!;
  assert(p6.includes("timeout: BRIEF_POLL_TIMEOUT"));
  assert(
    !/timeout: 10 \* MINUTE, intervals: \[5_000\], message: "the brief artifact"/
      .test(p6),
  );
});

Deno.test("P3 waits for the machine's id before it reads it (live run, stage A)", async () => {
  const source = await code(specPath);
  const p3 = source.slice(
    source.indexOf("P3 worker"),
    source.indexOf("P4 plan"),
  );
  // The enrollment flips to Consumed on the worker's registration and names the
  // machine a moment later, so a single read at the flip is a race. The wizard
  // shows "<name> is connected." at the flip, enables its last button
  // ("Sign in to Claude Code") only once the machine is named, and that button
  // opens the machine's page: the id is read from that address, after the wait
  // for it.
  const connected = p3.indexOf("m1-claude-worker is connected.");
  const done = p3.indexOf('name: "Sign in to Claude Code"');
  const address = p3.search(/toHaveURL\(\s*\/\\\/machines\\\/\[0-9a-f\]\{8\}-/);
  const read = p3.indexOf("j.hostId =");
  assert(
    connected >= 0,
    "P3 must wait for the wizard to say the machine is connected",
  );
  assert(
    done > connected,
    "P3 must press the wizard's last button after it is connected",
  );
  assert(
    address > done,
    "P3 must wait for the machine's own address before it reads the host id",
  );
  assert(
    read > address,
    "the wait for the machine's address precedes the one-shot read of the host id",
  );
});

Deno.test("no locator.evaluate call passes a function as a string (live run, stage B: it returned undefined)", async () => {
  for (
    const path of [specPath, ...helperPaths, "helpers/real-run-observation.ts"]
  ) {
    const source = await code(path);
    assert(
      !/\.evaluate\(\s*\n?\s*["'`]\s*\(?\s*\w*\s*\)?\s*=>/.test(source),
      `${path} passes an arrow function to evaluate as a string`,
    );
  }
});

Deno.test("answerQuestion reads the chosen option's label through the DOM tree, not a string function", async () => {
  const source = await code("helpers/m1-journey-ui.ts");
  const body = source.slice(
    source.indexOf("export async function answerQuestion"),
    source.indexOf("// ---- run page"),
  );
  assert(
    /locator\(\s*["']xpath=ancestor::label["']\s*\)/.test(body),
    "answerQuestion must read the enclosing label with an xpath ancestor locator",
  );
});

Deno.test("every journey phase but P3 records a video, and P3 (the one-time setup key) never does", async () => {
  const source = await code(specPath);
  const phase = (from: string, to?: string) =>
    source.slice(
      source.indexOf(from),
      to === undefined ? undefined : source.indexOf(to),
    );
  const p3 = phase('test("P3 worker', 'test("P4 plan');
  assert(
    !/recordVideo|video:/.test(p3),
    "P3 must not record: its page shows the live worker setup key",
  );
  assert(/await open\(browser\);/.test(p3), "P3 opens an unrecorded context");
  for (
    const label of [
      "P1",
      "P2",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
      "P9",
      "P10",
      "P5-reopened",
    ]
  ) {
    assert(
      new RegExp(`(video: "${label}"|recordVideoFor\\("${label}"\\))`).test(
        source,
      ),
      `phase ${label} does not record a video`,
    );
  }
  const config = await Deno.readTextFile(
    new URL("../../apps/web/playwright.config.ts", import.meta.url),
  );
  assert(
    !/video:\s*\{/.test(config),
    "the project-level video option does not reach contexts the spec creates; use recordVideoFor",
  );
});
