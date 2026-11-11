import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkFinalVersion,
  type Clock,
  type CommandOutput,
  type CommandRunner,
  containmentGuard,
  type DeployConfig,
  DeployConfigError,
  deploymentMessage,
  type Deps,
  DISPATCHER_POINTER,
  DRAIN_POINTER,
  extractDeploymentId,
  parseDeployConfig,
  parseDeploymentList,
  redactLine,
  runRollout,
  SERVICE_ORDER,
  type ServiceName,
} from "../../scripts/deploy/railway-deploy.ts";

const TOKEN = "ghs_unit_test_token_value";
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const NEWER = "c".repeat(40);
/** GitHub lists at most this many files for a whole comparison. */
const GITHUB_COMPARE_FILES_CAP = 300;
const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const IDS: Record<ServiceName, string> = {
  inngest: "33333333-3333-4333-8333-333333333333",
  api: "44444444-4444-4444-8444-444444444444",
  dispatcher: "55555555-5555-4555-8555-555555555555",
  web: "66666666-6666-4666-8666-666666666666",
};
const SERVICE_BY_ID = new Map(
  Object.entries(IDS).map(([name, id]) => [id, name as ServiceName]),
);

function config(overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    sha: SHA,
    repository: "MarkTripoli/bakery",
    githubToken: TOKEN,
    qaUrl: "https://bakery.marktrip.dev",
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    services: ["api", "dispatcher", "web"],
    serviceIds: IDS,
    force: false,
    pollIntervalMs: 15_000,
    stallTimeoutMs: 35 * 60_000,
    rolloutTimeoutMs: 120 * 60_000,
    livenessDelayMs: 120_000,
    readyAttempts: 3,
    readyIntervalMs: 15_000,
    ...overrides,
  };
}

function fakeClock(): Clock & { elapsed(): number } {
  let now = Date.parse("2026-10-21T12:00:00.000Z");
  const start = now;
  return {
    now: () => now,
    sleep: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
    elapsed: () => now - start,
  };
}

const ok = (stdout = ""): CommandOutput => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom", code = 1): CommandOutput => ({
  code,
  stdout: "",
  stderr,
});
const jsonLines = (...lines: unknown[]) =>
  lines.map((line) => JSON.stringify(line)).join("\n");

interface Call {
  command: string;
  args: readonly string[];
  stdin?: string;
}
interface World {
  /**
   * Version served by /health/ready; undefined = curl fails. By default QA
   * serves the old build until the api upload and the new SHA after.
   */
  health: (state: { apiUp: boolean }) => string | undefined;
  /** Compare answer; `ok(status)` is wrapped into the GitHub JSON shape. */
  compare: (base: string, head: string) => CommandOutput;
  /**
   * Files changed between two commits. The compare mock lists them the way
   * GitHub does: on page 1 only, capped at 300, absent on later pages.
   */
  changedFiles: (base: string, head: string) => unknown[];
  /** Makes the files-listing compare calls fail (the status call still works). */
  filesFail: boolean;
  /** Answers the files-listing compare call without a `files` key. */
  filesOmitted: boolean;
  /** deployment status by service, polled per call index. */
  statuses: Partial<Record<ServiceName, (poll: number) => string>>;
  upStdout: (service: ServiceName) => string;
  upExit: Partial<Record<ServiceName, number>>;
  logs: (service: ServiceName, kind: string) => CommandOutput;
  listExit: Partial<Record<ServiceName, number>>;
  extraListed: Partial<Record<ServiceName, unknown[]>>;
  /**
   * `railway deployment list` answer for a service before this run uploaded to
   * it, given the version /health/ready reports. By default every service runs
   * the reported version.
   */
  current: (
    service: ServiceName,
    reported: string | undefined,
  ) => CommandOutput;
}

/** One `railway deployment list --json` item, in the recorded shape. */
function listedWithMessage(
  id: string,
  status: string,
  cliMessage: string,
  createdAt: string | undefined = "2026-10-21T10:00:00.000Z",
) {
  return { id, status, createdAt, meta: { cliMessage, reason: "deploy" } };
}
const listed = (
  id: string,
  status: string,
  sha: string,
  createdAt?: string,
) => listedWithMessage(id, status, deploymentMessage(sha), createdAt);
const listing = (...items: unknown[]): CommandOutput =>
  ok(JSON.stringify(items));

function deploymentIdFor(service: ServiceName): string {
  return `dep-${service}-0001`;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    health: ({ apiUp }) => (apiUp ? SHA : OLD),
    compare: (_base, head) => ok(head === "main" ? "ahead" : "behind"),
    changedFiles: () => [],
    filesFail: false,
    filesOmitted: false,
    statuses: {},
    upStdout: (service) =>
      JSON.stringify({
        deploymentId: deploymentIdFor(service),
        logsUrl: `https://railway.com/project/${PROJECT}/service/${
          IDS[service]
        }?id=${deploymentIdFor(service)}`,
      }),
    upExit: {},
    logs: () => ok(""),
    listExit: {},
    extraListed: {},
    current: (service, reported) =>
      listing(
        ...(reported === undefined
          ? []
          : [listed(`dep-${service}-prev`, "SUCCESS", reported)]),
      ),
    ...overrides,
  };
}

function harness(world: World, cfg: DeployConfig = config()) {
  const calls: Call[] = [];
  const log: string[] = [];
  const clock = fakeClock();
  const polls: Partial<Record<ServiceName, number>> = {};
  const uploaded = new Set<ServiceName>();
  let healthCalls = 0;
  const state = { apiUp: false };
  // `health` is evaluated lazily so a test can flip it after the deploys.
  const run: CommandRunner = (command, args, _timeout, stdin) => {
    calls.push({ command, args, stdin });
    if (command === "curl") {
      const url = String(args[args.length - 1]);
      const compare = /\/compare\/([^.]+)\.\.\.([^?]+)\?/.exec(url);
      if (compare) {
        assert(
          url.startsWith("https://api.github.com/repos/MarkTripoli/bakery/"),
        );
        // The token travels on stdin only, never in argv.
        assertEquals(stdin, `header = "Authorization: Bearer ${TOKEN}"\n`);
        assert(!args.join(" ").includes(TOKEN));
        const paging = /per_page=(\d+)(?:&page=(\d+))?$/.exec(url);
        assert(paging, `compare url without paging: ${url}`);
        if (compare[2] === SHA) {
          // Files listing: deployed...candidate. per_page and page paginate
          // COMMITS. `files` is on page 1 only (at most 300 entries for the
          // whole comparison) and absent on every later page.
          if (world.filesFail) {
            return Promise.resolve(fail("curl: (22) 502", 22));
          }
          const page = Number(paging[2] ?? 1);
          const body: Record<string, unknown> = {
            status: "ahead",
            commits: [],
          };
          if (page === 1 && !world.filesOmitted) {
            body.files = world.changedFiles(compare[1], compare[2]).slice(
              0,
              GITHUB_COMPARE_FILES_CAP,
            );
          }
          return Promise.resolve(ok(JSON.stringify(body)));
        }
        const answer = world.compare(compare[1], compare[2]);
        return Promise.resolve(
          answer.code === 0
            ? ok(JSON.stringify({ status: answer.stdout, commits: [] }))
            : answer,
        );
      }
      healthCalls += 1;
      const version = world.health(state);
      return Promise.resolve(
        version === undefined
          ? fail("curl: (22) The requested URL returned error: 503", 22)
          : ok(JSON.stringify({ service: "bakery", version })),
      );
    }
    const service = SERVICE_BY_ID.get(String(args[args.indexOf("-s") + 1]));
    if (command === "railway" && args[0] === "up" && service) {
      assert(args.includes("--detach") && args.includes("--json"));
      assertEquals(args[args.indexOf("-m") + 1], `main ${SHA}`);
      uploaded.add(service);
      if (service === "api") state.apiUp = true;
      const code = world.upExit[service] ?? 0;
      return Promise.resolve(
        code === 0 ? ok(world.upStdout(service)) : fail("upload failed", code),
      );
    }
    if (command === "railway" && args[0] === "deployment" && service) {
      const exit = world.listExit[service];
      if (exit) return Promise.resolve(fail("api error", exit));
      if (!uploaded.has(service)) {
        // The guard reads what each service runs before this run touches it.
        return Promise.resolve(world.current(service, world.health(state)));
      }
      polls[service] = (polls[service] ?? 0) + 1;
      const status = world.statuses[service]?.(polls[service]) ?? "SUCCESS";
      return Promise.resolve(ok(JSON.stringify([
        ...(world.extraListed[service] ?? []),
        {
          id: deploymentIdFor(service),
          status,
          createdAt: new Date(clock.now()).toISOString(),
          meta: { cliMessage: `main ${SHA}`, reason: "deploy" },
        },
      ])));
    }
    if (command === "railway" && args[0] === "logs" && service) {
      const kind = args.includes("--build") ? "build" : "deploy";
      // After an upload the logs are those of that upload; on a skip they are
      // those of the deployment the guard found current.
      assertEquals(
        args[1],
        uploaded.has(service)
          ? deploymentIdFor(service)
          : `dep-${service}-prev`,
      );
      return Promise.resolve(world.logs(service, kind));
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  const deps: Deps = { run, clock, log: (line) => log.push(line) };
  return {
    deps,
    calls,
    log,
    clock,
    polls,
    cfg,
    healthCalls: () => healthCalls,
    upOrder: () =>
      calls.filter((call) =>
        call.command === "railway" && call.args[0] === "up"
      )
        .map((call) =>
          SERVICE_BY_ID.get(String(call.args[call.args.indexOf("-s") + 1]))
        ),
  };
}

// --------------------------------------------------------------- id parse ---

// Recorded from the live bakery-qa project on 2026-10-25: `railway up --detach
// --json` and `railway deployment list --json` (railway 5.71.0). Ids are kept;
// the deployment list's `serviceManifest` is trimmed.
const REAL_UP_OUTPUT =
  '{"deploymentId":"21024b99-b2bb-4d7d-8a46-f2c482c80edf","logsUrl":"https://railway.com/project/398a4c9b-b42f-4a2e-8b77-07c0528e6b02/service/c9b701da-ff84-4f7c-bbbd-32633118d03c?id=21024b99-b2bb-4d7d-8a46-f2c482c80edf"}\n';
const REAL_DEPLOYMENT_LIST = JSON.stringify(
  [
    {
      id: "ca1d14fa-e087-4134-b72d-f134e802edd9",
      status: "SUCCESS",
      createdAt: "2026-10-26T00:48:26.068Z",
      meta: {
        buildOnly: false,
        cliCaller: "skill:use-railway@1.7.0",
        cliMessage: "candidate c977a902722fe27a7383d00dff7f9b89a06a652b",
        duration: 3,
        logsV2: true,
        reason: "redeploy",
        runtime: "V2",
        serviceManifest: { deploy: { restartPolicyType: "ON_FAILURE" } },
      },
    },
    {
      id: "21024b99-b2bb-4d7d-8a46-f2c482c80edf",
      status: "FAILED",
      createdAt: "2026-10-26T00:43:26.053Z",
      meta: {
        buildOnly: false,
        cliCaller: "skill:use-railway@1.7.0",
        cliMessage: "candidate c977a902722fe27a7383d00dff7f9b89a06a652b",
        logsV2: true,
        reason: "deploy",
        runtime: "V2",
      },
    },
  ],
  null,
  2,
);

Deno.test("extractDeploymentId reads the deployment id from the real up --detach --json output", () => {
  assertEquals(
    extractDeploymentId(REAL_UP_OUTPUT),
    "21024b99-b2bb-4d7d-8a46-f2c482c80edf",
  );
});

Deno.test("extractDeploymentId also tolerates alternative shapes", () => {
  assertEquals(
    extractDeploymentId(
      jsonLines({ message: "Indexing" }, { deployment_id: "dep-snake-case-1" }),
    ),
    "dep-snake-case-1",
  );
  assertEquals(
    extractDeploymentId(
      JSON.stringify({ deployment: { id: "dep-nested-0001" } }),
    ),
    "dep-nested-0001",
  );
  assertEquals(
    extractDeploymentId(
      jsonLines({ deploymentId: "dep-same-0001" }, {
        deploymentId: "dep-same-0001",
      }),
    ),
    "dep-same-0001",
  );
});

Deno.test("extractDeploymentId refuses bare ids, two ids, bad shapes and non JSON", () => {
  assertEquals(
    extractDeploymentId(JSON.stringify({ id: "dep-bare-0001" })),
    undefined,
  );
  assertEquals(
    extractDeploymentId(
      jsonLines({ deploymentId: "dep-one-00001" }, {
        deploymentId: "dep-two-00001",
      }),
    ),
    undefined,
  );
  assertEquals(
    extractDeploymentId(JSON.stringify({ deploymentId: "x y;rm" })),
    undefined,
  );
  assertEquals(
    extractDeploymentId(JSON.stringify({ deploymentId: 7 })),
    undefined,
  );
  assertEquals(extractDeploymentId("Uploading..."), undefined);
  assertEquals(extractDeploymentId(""), undefined);
});

Deno.test("parseDeploymentList reads the message from meta.cliMessage in the real list", () => {
  const cliMessage = "candidate c977a902722fe27a7383d00dff7f9b89a06a652b";
  assertEquals(parseDeploymentList(REAL_DEPLOYMENT_LIST), [
    {
      id: "ca1d14fa-e087-4134-b72d-f134e802edd9",
      status: "SUCCESS",
      createdAt: "2026-10-26T00:48:26.068Z",
      message: cliMessage,
    },
    {
      id: "21024b99-b2bb-4d7d-8a46-f2c482c80edf",
      status: "FAILED",
      createdAt: "2026-10-26T00:43:26.053Z",
      message: cliMessage,
    },
  ]);
});

Deno.test("parseDeploymentList prefers meta.cliMessage and tolerates other shapes", () => {
  const item = {
    id: "d1",
    status: "success",
    createdAt: "2026-10-21T12:00:00Z",
    meta: { commitMessage: "main x" },
  };
  assertEquals(parseDeploymentList(JSON.stringify([item])), [{
    id: "d1",
    status: "SUCCESS",
    createdAt: "2026-10-21T12:00:00Z",
    message: "main x",
  }]);
  assertEquals(
    parseDeploymentList(JSON.stringify({ deployments: [item] })).length,
    1,
  );
  assertEquals(
    parseDeploymentList(
      JSON.stringify([{
        ...item,
        message: "top level",
        meta: { cliMessage: "main cli", commitMessage: "main commit" },
      }]),
    )[0].message,
    "main cli",
  );
  assertEquals(parseDeploymentList("not json"), []);
});

// --------------------------------------------------------- id fallback ---

Deno.test("up without an id falls back to exactly one message match", async () => {
  const world = makeWorld({ upStdout: () => "Deployment started" });
  const { deps, cfg } = harness(world, config({ services: ["api"] }));
  const result = await runRollout(deps, cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(result.deployed, ["api"]);
});

Deno.test("fallback ignores other messages and deployments created before the upload", async () => {
  const world = makeWorld({
    upStdout: () => "",
    extraListed: {
      api: [
        {
          id: "dep-old-message-1",
          status: "SUCCESS",
          createdAt: "2026-10-21T12:00:00Z",
          meta: { cliMessage: "main other" },
        },
        {
          id: "dep-old-time-0001",
          status: "SUCCESS",
          createdAt: "2026-10-20T12:00:00Z",
          meta: { cliMessage: `main ${SHA}` },
        },
      ],
    },
  });
  const { deps, cfg } = harness(world, config({ services: ["api"] }));
  assertEquals((await runRollout(deps, cfg)).exitCode, 0);
});

Deno.test("fallback fails with zero matches", async () => {
  const world = makeWorld({ upStdout: () => "" });
  const base = harness(world, config({ services: ["api"] }));
  const run = base.deps.run;
  base.deps.run = (command, args, timeout, stdin) =>
    command === "railway" && args[0] === "deployment"
      ? Promise.resolve(ok("[]"))
      : run(command, args, timeout, stdin);
  const result = await runRollout(base.deps, base.cfg);
  assertEquals(result.exitCode, 1);
  assert(result.message.startsWith("DEPLOYMENT_ID_NOT_FOUND"));
  assertEquals(base.polls.api, undefined);
});

Deno.test("fallback fails with two matches instead of guessing", async () => {
  const world = makeWorld({
    upStdout: () => "",
    extraListed: {
      api: [{
        id: "dep-twin-000001",
        status: "BUILDING",
        createdAt: new Date(Date.parse("2026-10-21T12:00:30Z")).toISOString(),
        meta: { cliMessage: `main ${SHA}` },
      }],
    },
  });
  const { deps, cfg } = harness(world, config({ services: ["api"] }));
  const result = await runRollout(deps, cfg);
  assertEquals(result.exitCode, 1);
  assert(result.message.startsWith("DEPLOYMENT_ID_AMBIGUOUS"));
});

Deno.test("two ids in up output fall back instead of picking one", async () => {
  const world = makeWorld({
    upStdout: () =>
      jsonLines({ deploymentId: "dep-one-00001" }, {
        deploymentId: "dep-two-00001",
      }),
  });
  const { deps, cfg, log } = harness(world, config({ services: ["api"] }));
  assertEquals((await runRollout(deps, cfg)).exitCode, 0);
  assert(log.some((line) => line.includes("matching by message")));
});

Deno.test("a failed upload stops before polling", async () => {
  const world = makeWorld({ upExit: { api: 1 } });
  const harnessed = harness(world);
  const result = await runRollout(harnessed.deps, harnessed.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(result.message, "UPLOAD_FAILED: api");
  assertEquals(harnessed.polls.api, undefined);
  assertEquals(harnessed.upOrder(), ["api"]);
});

// ----------------------------------------------------------------- order ---

Deno.test("services deploy api, dispatcher, web in order and then verify", async () => {
  const world = makeWorld({
    statuses: { api: (poll) => (poll < 3 ? "BUILDING" : "SUCCESS") },
  });
  const h = harness(world);
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(h.upOrder(), ["api", "dispatcher", "web"]);
  assertEquals(result.deployed, ["api", "dispatcher", "web"]);
  assertEquals(h.polls.api, 3);
  for (const call of h.calls.filter((c) => c.args[0] === "up")) {
    assertEquals(call.args[call.args.indexOf("-p") + 1], PROJECT);
    assertEquals(call.args[call.args.indexOf("-e") + 1], ENVIRONMENT);
  }
});

Deno.test("every in-progress status keeps the poll going until SUCCESS", async () => {
  const sequence = ["INITIALIZING", "BUILDING", "DEPLOYING", "SUCCESS"];
  const h = harness(
    makeWorld({
      statuses: {
        api: (poll) => sequence[Math.min(poll, sequence.length) - 1],
      },
    }),
    config({ services: ["api"] }),
  );
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.polls.api, sequence.length);
});

Deno.test("inngest is first when requested and the order never follows input order", async () => {
  const cfg = config({ services: SERVICE_ORDER });
  const h = harness(makeWorld(), cfg);
  assertEquals((await runRollout(h.deps, cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["inngest", "api", "dispatcher", "web"]);
});

// ------------------------------------------------------- failure handling ---

for (
  const status of ["FAILED", "CRASHED", "REMOVING", "REMOVED", "SKIPPED"]
) {
  Deno.test(`api ${status} aborts the rollout before dispatcher and web`, async () => {
    const world = makeWorld({
      statuses: { api: () => status },
      logs: () => ok(jsonLines({ message: "pre-deploy command failed" })),
    });
    const h = harness(world);
    const result = await runRollout(h.deps, h.cfg);
    assertEquals(result.exitCode, 1);
    // Fails on the first poll, not after the 25 minute timeout.
    assertEquals(h.polls.api, 1);
    assertEquals(h.upOrder(), ["api"]);
    assertEquals(result.deployed, []);
    assert(
      h.log.some((line) => line.includes("not deployed: api, dispatcher, web")),
    );
    assert(
      h.log.some((line) => line.includes("api | pre-deploy command failed")),
    );
    // Only the guard read /health/ready: no final version check ran.
    assertEquals(h.healthCalls(), 1);
  });
}

Deno.test("a failed dispatcher keeps web on the old build", async () => {
  const h = harness(makeWorld({ statuses: { dispatcher: () => "CRASHED" } }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(h.upOrder(), ["api", "dispatcher"]);
  assertEquals(result.deployed, ["api"]);
});

Deno.test("a drain marker in the logs prints the runbook pointer", async () => {
  const world = makeWorld({
    statuses: { api: () => "FAILED" },
    logs: (_service, kind) =>
      kind === "build" ? ok("") : ok(jsonLines(
        { message: "bootstrap ok" },
        {
          message:
            "error: APPLICATION_DATABASE_DRAIN_REQUIRED bakery_app sessions=2",
        },
      )),
  });
  const h = harness(world);
  await runRollout(h.deps, h.cfg);
  assert(h.log.includes(DRAIN_POINTER));
  assert(DRAIN_POINTER.endsWith("learnings/railway-qa-migration-drain.xml"));
});

Deno.test("the drain marker is found in build logs too", async () => {
  const world = makeWorld({
    statuses: { api: () => "FAILED" },
    logs: (_service, kind) =>
      kind === "build" ? ok(`APPLICATION_DATABASE_DRAIN_REQUIRED`) : ok(""),
  });
  const h = harness(world);
  await runRollout(h.deps, h.cfg);
  assert(h.log.includes(DRAIN_POINTER));
});

Deno.test("no drain pointer without the marker", async () => {
  const world = makeWorld({
    statuses: { api: () => "FAILED" },
    logs: () => ok(jsonLines({ message: "migration 0042 failed" })),
  });
  const h = harness(world);
  await runRollout(h.deps, h.cfg);
  assert(!h.log.includes(DRAIN_POINTER));
});

Deno.test("a deployment stuck on one status times out after 35 minutes with bounded polling", async () => {
  const h = harness(makeWorld({ statuses: { api: () => "DEPLOYING" } }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(h.clock.elapsed(), 35 * 60_000);
  assertEquals(h.polls.api, 35 * 4 + 1);
  assertEquals(h.upOrder(), ["api"]);
  assert(
    h.log.some((line) =>
      line.includes(
        "TIMEOUT after 35 min without progress (last status DEPLOYING)",
      )
    ),
  );
});

Deno.test("a deployment id missing from the list keeps polling until the stall timeout", async () => {
  const world = makeWorld();
  const h = harness(world);
  const run = h.deps.run;
  h.deps.run = (command, args, timeout, stdin) =>
    command === "railway" && args[0] === "deployment"
      ? Promise.resolve(ok("[]"))
      : run(command, args, timeout, stdin);
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(h.clock.elapsed(), 35 * 60_000);
  assert(
    h.log.some((line) => line.includes("(last status UNKNOWN)")),
  );
});

// Regression: run 40735281134 (2026-10-28) reported `web TIMEOUT after 25 min
// (last status DEPLOYING)` eleven minutes before Railway promoted that same
// deployment, because the bound was the deployment's total duration. A slow
// build queue is not a failure, so a deployment that keeps changing status
// must be allowed to finish however long the queue takes.
Deno.test("a slow but progressing deployment is not failed by the stall bound", async () => {
  // Each status lasts 30 minutes: under the old 25 minute total bound this
  // failed in the first status, and the whole rollout runs 90 minutes.
  const perStatus = 30 * 4; // polls at the 15s interval
  const sequence = ["INITIALIZING", "BUILDING", "DEPLOYING", "SUCCESS"];
  const h = harness(
    makeWorld({
      statuses: {
        api: (poll) =>
          sequence[Math.min(Math.floor((poll - 1) / perStatus), 3)],
      },
    }),
    config({ services: ["api"] }),
  );
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(result.deployed, ["api"]);
  assert(
    h.clock.elapsed() > 35 * 60_000,
    `expected the wait to outlast one stall budget, got ${h.clock.elapsed()}ms`,
  );
  assert(!h.log.some((line) => line.includes("TIMEOUT")));
});

Deno.test("the rollout cap is shared by every service and reports itself", async () => {
  const h = harness(
    makeWorld({ statuses: { api: () => "DEPLOYING" } }),
    config({
      services: ["api"],
      // Below the stall budget, so the cap is what fires.
      rolloutTimeoutMs: 10 * 60_000,
    }),
  );
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(h.clock.elapsed(), 10 * 60_000);
  assert(
    h.log.some((line) =>
      line.includes("ROLLOUT TIMEOUT after 10 min (last status DEPLOYING)")
    ),
  );
});

Deno.test("repeated list failures fail the service without waiting for the timeout", async () => {
  const h = harness(makeWorld({ listExit: { api: 1 } }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assert(h.clock.elapsed() < 5 * 60_000);
});

Deno.test("failure tails are redacted and cannot start a workflow command", async () => {
  const world = makeWorld({
    statuses: { api: () => "FAILED" },
    logs: (_service, kind) =>
      kind === "build" ? ok("") : ok(jsonLines(
        {
          message:
            "connect postgresql://bakery:hunter2hunter2@db.internal:5432/bakery",
        },
        { message: "BETTER_AUTH_SECRET=abc123secretvalue" },
        { message: "::set-output name=x::y" },
        { message: "key " + "Z".repeat(60) },
        { message: "at commit " + SHA },
      )),
  });
  const h = harness(world);
  await runRollout(h.deps, h.cfg);
  const text = h.log.join("\n");
  assert(!text.includes("hunter2"));
  assert(!text.includes("abc123secretvalue"));
  assert(!text.includes("ZZZZZZZZZZ"));
  assert(text.includes(`at commit ${SHA}`));
  assert(!h.log.some((line) => line.startsWith("api | ::")));
  assert(!h.log.some((line) => line.startsWith("::set-output")));
});

Deno.test("redactLine strips escapes and truncates", () => {
  assertEquals(redactLine("\u001b[31mred\u001b[0m"), "red");
  assert(redactLine("x".repeat(1000)).length < 420);
  assertEquals(redactLine("::error::fake"), ": :error::fake");
});

// -------------------------------------------------------------- liveness ---

Deno.test("the dispatcher is checked at least two minutes after it went live", async () => {
  const h = harness(makeWorld());
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  const dispatcherCalls = h.calls.filter((call) =>
    call.args.includes(IDS.dispatcher)
  );
  const logCall = dispatcherCalls.find((call) => call.args[0] === "logs");
  assert(logCall);
  assert(logCall.args.includes("--since") && logCall.args.includes("2m"));
  // Web goes live instantly in the fake, so the whole wait is the liveness delay.
  assertEquals(h.clock.elapsed(), 120_000);
});

Deno.test("a dispatcher that is no longer SUCCESS fails with the recovery pointer", async () => {
  const h = harness(makeWorld({
    statuses: { dispatcher: (poll) => (poll === 1 ? "SUCCESS" : "CRASHED") },
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  // The rollout wording is pinned: two minutes have passed since SUCCESS.
  assertEquals(
    result.message,
    "DISPATCHER_NOT_ALIVE: deployment dep-dispatcher-0001 is CRASHED two minutes after SUCCESS",
  );
  assert(h.log.includes(DISPATCHER_POINTER));
});

Deno.test("an error log with a restart marker fails the dispatcher check", async () => {
  const world = makeWorld({
    logs: (service) =>
      service === "dispatcher"
        ? ok(jsonLines(
          { message: "Starting Container", severity: "info" },
          { message: "process exited with code 1", severity: "error" },
        ))
        : ok(""),
  });
  const h = harness(world);
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(result.message, "DISPATCHER_RESTARTING");
  assert(h.log.includes(DISPATCHER_POINTER));
});

Deno.test("error lines without a restart marker and restart text at info level pass", async () => {
  const world = makeWorld({
    logs: (service) =>
      service === "dispatcher"
        ? ok(jsonLines(
          { message: "outbox lease lost", severity: "error" },
          {
            message: "restart of worker lease",
            attributes: [{ key: "level", value: "info" }],
          },
        ))
        : ok(""),
  });
  const h = harness(world);
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
});

// ---------------------------------------------------------- final version ---

Deno.test("the final version must equal the SHA", async () => {
  const h = harness(makeWorld({ health: () => OLD }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assert(result.message.startsWith("VERSION_MISMATCH"));
  assertEquals(h.healthCalls(), 1 + h.cfg.readyAttempts);
});

Deno.test("the final version check retries until the new API answers", async () => {
  let reads = 0;
  const h = harness(
    makeWorld({
      health: () => {
        reads += 1;
        if (reads === 1) return OLD;
        return reads < 4 ? undefined : SHA;
      },
    }),
    config({ readyAttempts: 5 }),
  );
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(reads, 4);
});

Deno.test("checkFinalVersion fails when QA stays unreachable", async () => {
  const h = harness(makeWorld({ health: () => undefined }));
  await assertRejects(
    () => checkFinalVersion(h.deps, h.cfg),
    Error,
    "VERSION_MISMATCH",
  );
});

// -------------------------------------------------------- containment guard ---

interface GuardRow {
  name: string;
  deployed: string | undefined;
  compare: CommandOutput;
  expect: "skip" | "deploy" | "throw";
  compared?: boolean;
}
const guardTable: GuardRow[] = [
  {
    name: "deployed equals the SHA",
    deployed: SHA,
    compare: fail(),
    expect: "skip",
    compared: false,
  },
  {
    name: "compare identical",
    deployed: OLD,
    compare: ok("identical"),
    expect: "skip",
  },
  {
    name: "deployed is ahead (contains the SHA)",
    deployed: NEWER,
    compare: ok("ahead"),
    expect: "skip",
  },
  {
    name: "deployed is behind the SHA",
    deployed: OLD,
    compare: ok("behind"),
    expect: "deploy",
  },
  {
    name: "deployed diverged from the SHA",
    deployed: OLD,
    compare: ok("diverged"),
    expect: "deploy",
  },
  {
    name: "QA unreachable",
    deployed: undefined,
    compare: fail(),
    expect: "deploy",
    compared: false,
  },
  {
    name: "version is not a SHA",
    deployed: "0.0.0-dev",
    compare: fail(),
    expect: "deploy",
    compared: false,
  },
  {
    name: "version is an abbreviated SHA",
    deployed: "a".repeat(12),
    compare: fail(),
    expect: "deploy",
    compared: false,
  },
  {
    name: "deployed commit unknown to GitHub",
    deployed: OLD,
    compare: fail("curl: (22) The requested URL returned error: 404"),
    expect: "deploy",
  },
  {
    name: "GitHub rate limited",
    deployed: OLD,
    compare: fail("curl: (22) The requested URL returned error: 403"),
    expect: "throw",
  },
  {
    name: "unexpected compare output",
    deployed: OLD,
    compare: ok("weird"),
    expect: "throw",
  },
];
for (const row of guardTable) {
  Deno.test(`containment guard: ${row.name}`, async () => {
    let compared = false;
    const h = harness(makeWorld({
      health: () => row.deployed,
      compare: () => {
        compared = true;
        return row.compare;
      },
    }));
    if (row.expect === "throw") {
      await assertRejects(
        () => containmentGuard(h.deps, h.cfg),
        Error,
        "COMPARE_UNAVAILABLE",
      );
    } else {
      assertEquals((await containmentGuard(h.deps, h.cfg)).action, row.expect);
    }
    if (row.compared !== undefined) assertEquals(compared, row.compared);
    if (row.expect === "deploy" || row.expect === "skip") {
      // The comparison is SHA...deployed so "ahead" means deployed contains SHA.
      const gh = h.calls.find((call) =>
        call.command === "curl" &&
        String(call.args.at(-1)).includes("/compare/")
      );
      if (gh) {
        assert(
          String(gh.args.at(-1)).includes(
            `/compare/${SHA}...${row.deployed}?`,
          ),
        );
      }
    }
  });
}

Deno.test("a skipped rollout deploys nothing and exits 0", async () => {
  const h = harness(makeWorld({
    health: () => NEWER,
    compare: (_base, head) => ok(head === "main" ? "ahead" : "ahead"),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assert(result.skipped);
  assertEquals(h.upOrder(), []);
  assert(h.log.some((line) => line.startsWith("::notice::QA deploy skipped")));
});

// ------------------------------------- rerun after a partly failed rollout ---

/** Calls of one railway verb (`up`, `deployment`) aimed at one service. */
const callsTo = (calls: readonly Call[], verb: string, service: ServiceName) =>
  calls.filter((call) =>
    call.command === "railway" && call.args[0] === verb &&
    call.args.includes(IDS[service])
  );
const uploads = (calls: readonly Call[]) =>
  calls.filter((call) => call.command === "railway" && call.args[0] === "up");

Deno.test("the upload message and the one the guard matches share a format", () => {
  assertEquals(deploymentMessage(SHA), `main ${SHA}`);
});

Deno.test("a rerun of the same SHA after a failed dispatcher deploys dispatcher and web, not api", async () => {
  // Run 1: the api deploys and serves the SHA, the dispatcher deployment fails,
  // web is never uploaded.
  const first = harness(
    makeWorld({ statuses: { dispatcher: () => "FAILED" } }),
  );
  const failed = await runRollout(first.deps, first.cfg);
  assertEquals(failed.exitCode, 1);
  assertEquals(first.upOrder(), ["api", "dispatcher"]);

  // Run 2, same SHA: /health/ready (the api) already reports it, but the
  // dispatcher's newest SUCCESS is still the old build and web never moved.
  const second = harness(makeWorld({
    health: () => SHA,
    current: (service) =>
      service === "dispatcher"
        ? listing(
          listed(
            "dep-dispatcher-new",
            "FAILED",
            SHA,
            "2026-10-21T11:00:00.000Z",
          ),
          listed("dep-dispatcher-old", "SUCCESS", OLD),
        )
        : listing(listed(`dep-${service}-old`, "SUCCESS", OLD)),
  }));
  const rerun = await runRollout(second.deps, second.cfg);
  assertEquals(rerun.exitCode, 0);
  assertEquals(rerun.skipped, false);
  assertEquals(rerun.deployed, ["dispatcher", "web"]);
  assertEquals(second.upOrder(), ["dispatcher", "web"]);
  assertEquals(callsTo(second.calls, "up", "api").length, 0);
  // The api is proven by /health/ready; inngest is not requested.
  assertEquals(callsTo(second.calls, "deployment", "inngest").length, 0);
  assert(
    second.log.some((line) =>
      line.startsWith("containment guard: deploy (the api reports this SHA") &&
      line.includes("dispatcher (latest SUCCESS deployment is main " + OLD) &&
      line.includes("web (latest SUCCESS deployment is main " + OLD)
    ),
  );
  assert(second.log.some((line) => line.includes("dispatcher still SUCCESS")));
  assert(second.log.includes(`/health/ready reports ${SHA}`));
});

const RESTARTING = ok(
  jsonLines({ message: "process exited with code 1", severity: "error" }),
);
const logCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.command === "railway" && call.args[0] === "logs");

Deno.test("when every service runs the reported SHA and the dispatcher is healthy the rerun skips", async () => {
  const h = harness(makeWorld({ health: () => SHA }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(result.skipped, true);
  assertEquals(result.deployed, []);
  assertEquals(uploads(h.calls).length, 0);
  // The guard looked at dispatcher and web, and trusted /health/ready for api.
  assertEquals(callsTo(h.calls, "deployment", "web").length, 1);
  assertEquals(callsTo(h.calls, "deployment", "api").length, 0);
  // One dispatcher log read, on the deployment the guard found current, with
  // no two minute wait.
  const reads = logCalls(h.calls);
  assertEquals(reads.length, 1);
  assertEquals(reads[0].args[1], "dep-dispatcher-prev");
  assert(reads[0].args.includes(IDS.dispatcher));
  assertEquals(h.clock.elapsed(), 0);
  assert(h.log.some((line) => line.startsWith("::notice::QA deploy skipped")));
});

Deno.test("a rerun does not turn green after a failed dispatcher liveness check", async () => {
  // Run 1: every upload succeeds, then the dispatcher is found restarting.
  const first = harness(makeWorld({
    logs: (service) => (service === "dispatcher" ? RESTARTING : ok("")),
  }));
  const failed = await runRollout(first.deps, first.cfg);
  assertEquals(failed.exitCode, 1);
  assertEquals(failed.message, "DISPATCHER_RESTARTING");
  assertEquals(first.upOrder(), ["api", "dispatcher", "web"]);

  // Run 2, same SHA: all three services show it, the dispatcher still restarts.
  const second = harness(makeWorld({
    health: () => SHA,
    logs: (service) => (service === "dispatcher" ? RESTARTING : ok("")),
  }));
  const rerun = await runRollout(second.deps, second.cfg);
  assertEquals(rerun.exitCode, 1);
  assertEquals(rerun.skipped, false);
  assertEquals(rerun.message, "DISPATCHER_RESTARTING");
  assertEquals(uploads(second.calls).length, 0);
  assert(second.log.includes(DISPATCHER_POINTER));
  assert(
    !second.log.some((line) => line.startsWith("::notice::QA deploy skipped")),
  );
});

Deno.test("all current but the dispatcher logs are unavailable: exit 1, no upload", async () => {
  const h = harness(makeWorld({
    health: () => SHA,
    logs: () => fail("logs api down"),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(result.message, "DISPATCHER_LOGS_UNAVAILABLE");
  assertEquals(uploads(h.calls).length, 0);
  assertEquals(logCalls(h.calls).length, 1);
});

Deno.test("on a skip, an unreadable dispatcher list names that cause, not two minutes", async () => {
  // The guard's list read works; the liveness check's second one fails.
  let dispatcherLists = 0;
  const h = harness(makeWorld({
    health: () => SHA,
    current: (service, reported) => {
      if (service === "dispatcher") {
        dispatcherLists += 1;
        if (dispatcherLists > 1) return fail("api error");
      }
      return listing(listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA));
    },
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(dispatcherLists, 2);
  assertEquals(result.exitCode, 1);
  assertEquals(result.skipped, false);
  assertEquals(
    result.message,
    "DISPATCHER_NOT_ALIVE: deployment list unreadable on skip",
  );
  assert(!result.message.includes("two minutes"));
  assertEquals(uploads(h.calls).length, 0);
  assertEquals(logCalls(h.calls).length, 0);
  assert(h.log.includes(DISPATCHER_POINTER));
});

Deno.test("on a skip, a dispatcher that is no longer SUCCESS names its status, not two minutes", async () => {
  let dispatcherLists = 0;
  const h = harness(makeWorld({
    health: () => SHA,
    current: (service, reported) => {
      if (service === "dispatcher") {
        dispatcherLists += 1;
        if (dispatcherLists > 1) {
          return listing(
            listed("dep-dispatcher-prev", "CRASHED", reported ?? SHA),
          );
        }
      }
      return listing(listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA));
    },
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(
    result.message,
    "DISPATCHER_NOT_ALIVE: deployment dep-dispatcher-prev is CRASHED on skip",
  );
  assert(!result.message.includes("two minutes"));
  assertEquals(uploads(h.calls).length, 0);
});

Deno.test("a descendant on every service with a restarting dispatcher fails instead of skipping", async () => {
  const h = harness(makeWorld({
    health: () => NEWER,
    compare: () => ok("ahead"),
    logs: (service) => (service === "dispatcher" ? RESTARTING : ok("")),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(result.message, "DISPATCHER_RESTARTING");
  assertEquals(uploads(h.calls).length, 0);
});

// Same two SUCCESS records, in both list orders. `current` is the newest one.
for (
  const row of [
    { name: "newest is the SHA", newestSha: SHA, olderSha: OLD, lags: false },
    {
      name: "newest is the old build",
      newestSha: OLD,
      olderSha: SHA,
      lags: true,
    },
  ]
) {
  for (const order of ["newest first", "oldest first"] as const) {
    Deno.test(`web with two SUCCESS records, ${row.name}, listed ${order}`, async () => {
      const newest = listed(
        "dep-web-new",
        "SUCCESS",
        row.newestSha,
        "2026-10-21T11:00:00.000Z",
      );
      const older = listed(
        "dep-web-older",
        "SUCCESS",
        row.olderSha,
        "2026-10-21T10:00:00.000Z",
      );
      const h = harness(makeWorld({
        health: () => SHA,
        current: (service, reported) =>
          service === "web"
            ? listing(
              ...(order === "newest first" ? [newest, older] : [older, newest]),
            )
            : listing(
              listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA),
            ),
      }));
      const result = await runRollout(h.deps, h.cfg);
      assertEquals(result.exitCode, 0);
      // An older SUCCESS for the SHA cannot make a service current when a newer
      // SUCCESS is for another build, and the reverse.
      assertEquals(h.upOrder(), row.lags ? ["web"] : []);
      assertEquals(result.skipped, !row.lags);
    });
  }
}

Deno.test("a SUCCESS for another SHA with the same first 12 characters counts as lagging", async () => {
  const lookalike = SHA.slice(0, 12) + "b".repeat(28);
  assertEquals(lookalike.length, 40);
  assert(lookalike !== SHA);
  const h = harness(makeWorld({
    health: () => SHA,
    current: (service, reported) =>
      service === "web"
        ? listing(listed("dep-web-lookalike", "SUCCESS", lookalike))
        : listing(listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA)),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(h.upOrder(), ["web"]);
  assert(
    h.log.some((line) =>
      line.includes(`web (latest SUCCESS deployment is main ${lookalike})`)
    ),
  );
});

Deno.test("a logged deployment message is redacted", async () => {
  const secret = "hunter2hunter2hunter2";
  const h = harness(makeWorld({
    health: () => SHA,
    current: (service, reported) =>
      service === "web"
        ? listing(
          listedWithMessage(
            "dep-web-secret",
            "SUCCESS",
            `\u001b[31mmain x password=${secret}\u0007 ::error::boom`,
          ),
        )
        : listing(listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA)),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(h.upOrder(), ["web"]);
  const guardLine = h.log.find((line) =>
    line.startsWith("containment guard: deploy")
  );
  assert(guardLine);
  assert(guardLine.includes("password=***"));
  assert(!guardLine.includes(secret));
  assert([...guardLine].every((char) => char.charCodeAt(0) >= 0x20));
  assert(!h.log.some((line) => line.includes(secret)));
});

// A SUCCESS record whose date cannot be read has no provable place in the
// order, so the service is treated as lagging whichever way the list is sorted.
for (
  const row of [
    {
      name: "a single undated SUCCESS for the SHA",
      records: () => [{
        ...listed("dep-web-undated", "SUCCESS", SHA),
        createdAt: undefined,
      }],
    },
    {
      name: "an undated SUCCESS for the SHA listed before a dated older one",
      records: () => [
        { ...listed("dep-web-undated", "SUCCESS", SHA), createdAt: undefined },
        listed("dep-web-dated", "SUCCESS", OLD, "2026-10-21T10:00:00.000Z"),
      ],
    },
    {
      name: "an undated SUCCESS for the SHA listed after a dated one",
      records: () => [
        listed("dep-web-dated", "SUCCESS", OLD, "2026-10-21T10:00:00.000Z"),
        { ...listed("dep-web-undated", "SUCCESS", SHA), createdAt: undefined },
      ],
    },
    {
      name: "a SUCCESS with an unparsable date",
      records: () => [listed("dep-web-bad-date", "SUCCESS", SHA, "yesterday")],
    },
  ]
) {
  Deno.test(`${row.name} counts as lagging`, async () => {
    const h = harness(makeWorld({
      health: () => SHA,
      current: (service, reported) =>
        service === "web"
          ? listing(...row.records())
          : listing(listed(`dep-${service}-prev`, "SUCCESS", reported ?? SHA)),
    }));
    const result = await runRollout(h.deps, h.cfg);
    assertEquals(result.exitCode, 0);
    assertEquals(h.upOrder(), ["web"]);
    assert(
      h.log.some((line) =>
        line.startsWith("containment guard: deploy") &&
        line.includes("web (undated SUCCESS deployment)")
      ),
    );
  });
}

Deno.test("a requested inngest that lags is deployed with the other laggards only", async () => {
  const cfg = config({ services: SERVICE_ORDER });
  const h = harness(
    makeWorld({
      health: () => SHA,
      current: (service, reported) =>
        listing(
          listed(
            `dep-${service}`,
            "SUCCESS",
            service === "inngest" ? OLD : (reported ?? SHA),
          ),
        ),
    }),
    cfg,
  );
  const result = await runRollout(h.deps, cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(h.upOrder(), ["inngest"]);
  assertEquals(result.deployed, ["inngest"]);
});

Deno.test("a descendant deployed with a lagging service fails and uploads nothing", async () => {
  const h = harness(makeWorld({
    health: () => NEWER,
    compare: () => ok("ahead"),
    current: (service) =>
      listing(
        listed(`dep-${service}`, "SUCCESS", service === "web" ? SHA : NEWER),
      ),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assertEquals(result.skipped, false);
  assert(result.message.startsWith("DEPLOYED_SERVICES_STALE"));
  assertEquals(uploads(h.calls).length, 0);
  const error = h.log.find((line) =>
    line.startsWith("::error::QA deploy failed: DEPLOYED_SERVICES_STALE")
  );
  assert(error);
  assert(error.includes(`QA reports ${NEWER}, a descendant of ${SHA}`));
  assert(error.includes("web (latest SUCCESS deployment is main " + SHA));
  assert(!error.includes("dispatcher ("));
  assert(error.includes("rerun the deploy for the newer SHA"));
  assert(error.includes("--force"));
});

Deno.test("a descendant deployed on every service still skips", async () => {
  const h = harness(makeWorld({
    health: () => NEWER,
    compare: () => ok("ahead"),
  }));
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(result.skipped, true);
  assertEquals(uploads(h.calls).length, 0);
});

const unreadableLists: ReadonlyArray<
  { name: string; answer: CommandOutput; why: string }
> = [
  {
    name: "a failing list command",
    answer: fail("api error", 1),
    why: "deployment list unreadable",
  },
  {
    name: "a list that is not JSON",
    answer: ok("Error: not logged in"),
    why: "no deployments listed",
  },
  { name: "an empty list", answer: ok("[]"), why: "no deployments listed" },
];
for (const row of unreadableLists) {
  Deno.test(`${row.name} for the same SHA deploys the services it cannot prove`, async () => {
    const h = harness(
      makeWorld({ health: () => SHA, current: () => row.answer }),
    );
    const result = await runRollout(h.deps, h.cfg);
    assertEquals(result.exitCode, 0);
    assertEquals(result.skipped, false);
    assertEquals(h.upOrder(), ["dispatcher", "web"]);
    assert(
      h.log.some((line) =>
        line.startsWith("containment guard: deploy") &&
        line.includes(`dispatcher (${row.why})`) &&
        line.includes(`web (${row.why})`)
      ),
    );
  });

  Deno.test(`${row.name} for a descendant fails instead of deploying the older SHA`, async () => {
    const h = harness(makeWorld({
      health: () => NEWER,
      compare: () => ok("ahead"),
      current: () => row.answer,
    }));
    const result = await runRollout(h.deps, h.cfg);
    assertEquals(result.exitCode, 1);
    assert(result.message.startsWith("DEPLOYED_SERVICES_STALE"));
    assert(result.message.includes(row.why));
    assertEquals(uploads(h.calls).length, 0);
  });
}

Deno.test("--force bypasses the guard", async () => {
  const cfg = config({ force: true });
  const h = harness(makeWorld({ health: () => NEWER }), cfg);
  // End check reads NEWER, so the rollout reports a mismatch after deploying.
  const result = await runRollout(h.deps, cfg);
  assertEquals(h.upOrder(), ["api", "dispatcher", "web"]);
  assertEquals(result.exitCode, 1);
  assert(h.log.some((line) => line.includes("bypassed by --force")));
});

Deno.test("a SHA that is not on main is refused before any deploy", async () => {
  for (const status of ["behind", "diverged", undefined]) {
    const h = harness(makeWorld({
      compare: (_base, head) =>
        head === "main"
          ? status === undefined
            ? fail("curl: (22) The requested URL returned error: 404")
            : ok(status)
          : ok("behind"),
    }));
    const result = await runRollout(h.deps, h.cfg);
    assertEquals(result.exitCode, 1);
    assert(result.message.startsWith("SHA_NOT_ON_MAIN"));
    assertEquals(h.upOrder(), []);
    assertEquals(h.healthCalls(), 0);
  }
});

// ----------------------------------------------------------------- config ---

const environment: Record<string, string> = {
  RAILWAY_TOKEN: "token-value",
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "MarkTripoli/bakery",
  QA_URL: "https://bakery.marktrip.dev",
  RAILWAY_QA_PROJECT_ID: PROJECT,
  RAILWAY_QA_ENVIRONMENT_ID: ENVIRONMENT,
  RAILWAY_QA_API_SERVICE_ID: IDS.api,
  RAILWAY_QA_DISPATCHER_SERVICE_ID: IDS.dispatcher,
  RAILWAY_QA_WEB_SERVICE_ID: IDS.web,
  RAILWAY_QA_INNGEST_SERVICE_ID: IDS.inngest,
};
const parse = (
  args: string[],
  overrides: Record<string, string | undefined> = {},
) =>
  parseDeployConfig(
    args,
    (name) => name in overrides ? overrides[name] : environment[name],
  );

Deno.test("parseDeployConfig builds the canonical service list", () => {
  const plain = parse(["--sha", SHA]);
  assertEquals(plain.services, ["api", "dispatcher", "web"]);
  assertEquals(plain.force, false);
  assertEquals(plain.qaUrl, "https://bakery.marktrip.dev");
  const full = parse(["--sha", SHA, "--include-inngest", "--force"]);
  assertEquals(full.services, ["inngest", "api", "dispatcher", "web"]);
  assertEquals(full.force, true);
  assertEquals(full.stallTimeoutMs, 35 * 60_000);
  assertEquals(full.rolloutTimeoutMs, 120 * 60_000);
  assertEquals(full.pollIntervalMs, 15_000);
  assertEquals(full.livenessDelayMs, 120_000);
  // The whole rollout shares one cap, so four services cannot multiply it past
  // the workflow's own timeout-minutes.
  assert(
    full.rolloutTimeoutMs >= full.stallTimeoutMs,
    "the rollout cap must leave room for at least one stalled service",
  );
});

Deno.test("parseDeployConfig rejects unsafe or incomplete input", () => {
  const bad: Array<[string[], Record<string, string | undefined>]> = [
    [[], {}],
    [["--sha", "HEAD"], {}],
    [["--sha", SHA.toUpperCase()], {}],
    [["--sha", SHA, "--unknown"], {}],
    [["--sha", SHA], { RAILWAY_TOKEN: undefined }],
    [["--sha", SHA], { GITHUB_TOKEN: undefined }],
    [["--sha", SHA], { GITHUB_TOKEN: 'x"\ninjected' }],
    [["--sha", SHA], { RAILWAY_QA_PROJECT_ID: "--help" }],
    [["--sha", SHA], { RAILWAY_QA_API_SERVICE_ID: "api" }],
    [["--sha", SHA, "--include-inngest"], {
      RAILWAY_QA_INNGEST_SERVICE_ID: undefined,
    }],
    [["--sha", SHA], { QA_URL: "http://qa.example.com" }],
    [["--sha", SHA], { QA_URL: "https://qa.example.com/path" }],
    [["--sha", SHA], { QA_URL: "https://user:pw@qa.example.com" }],
    [["--sha", SHA], { QA_URL: undefined }],
    [["--sha", SHA], { GITHUB_REPOSITORY: "a/../b" }],
    [["--sha", SHA], { GITHUB_REPOSITORY: undefined }],
  ];
  for (const [args, overrides] of bad) {
    let thrown: unknown;
    try {
      parse(args, overrides);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof DeployConfigError,
      `${args.join(" ")} ${JSON.stringify(overrides)}`,
    );
  }
});

Deno.test("the inngest service id is not required unless inngest is requested", () => {
  const config = parse(["--sha", SHA], {
    RAILWAY_QA_INNGEST_SERVICE_ID: undefined,
  });
  assertEquals(config.serviceIds.inngest, undefined);
});

Deno.test("a configured inngest id is kept without the flag, a malformed one is refused", () => {
  const kept = parse(["--sha", SHA]);
  assertEquals(kept.services, ["api", "dispatcher", "web"]);
  assertEquals(kept.serviceIds.inngest, IDS.inngest);
  let thrown: unknown;
  try {
    parse(["--sha", SHA], { RAILWAY_QA_INNGEST_SERVICE_ID: "inngest" });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof DeployConfigError);
});

// ------------------------------------------------- inngest auto-include ---

const inngestFiles = (...names: string[]) =>
  names.map((filename) => ({ filename }));

Deno.test("a change under infra/railway/inngest* deploys inngest first without the flag", async () => {
  const h = harness(
    makeWorld({
      changedFiles: () =>
        inngestFiles("README.md", "infra/railway/inngest-start.sh"),
    }),
  );
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 0);
  assertEquals(h.upOrder(), ["inngest", "api", "dispatcher", "web"]);
  assert(h.log.some((line) => line.startsWith("including inngest:")));
});

Deno.test("inngest.Dockerfile and a rename away from it both count", async () => {
  for (
    const files of [
      [{ filename: "infra/railway/inngest.Dockerfile" }],
      [{
        filename: "infra/other/moved.Dockerfile",
        previous_filename: "infra/railway/inngest.Dockerfile",
      }],
    ]
  ) {
    const h = harness(makeWorld({ changedFiles: () => files }));
    assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
    assertEquals(h.upOrder()[0], "inngest");
  }
});

Deno.test("unrelated changes leave inngest alone", async () => {
  const h = harness(
    makeWorld({
      changedFiles: () =>
        inngestFiles("apps/server/src/main.ts", "infra/railway/Caddyfile"),
    }),
  );
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["api", "dispatcher", "web"]);
});

const unrelatedFiles = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => ({ filename: `docs/${index}.md` }),
  );

/** Compare requests for the files listing, deployed...candidate. */
const filesRequests = (calls: readonly Call[]) =>
  calls.filter((call) =>
    call.command === "curl" &&
    String(call.args.at(-1)).includes(`/compare/${OLD}...${SHA}?`)
  );

Deno.test("an inngest file among 150 unrelated files is found on the one files page", async () => {
  const h = harness(makeWorld({
    changedFiles: () => [
      ...unrelatedFiles(150),
      { filename: "infra/railway/inngest-start.sh" },
    ],
  }));
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["inngest", "api", "dispatcher", "web"]);
  const requests = filesRequests(h.calls);
  assertEquals(requests.length, 1);
  assert(String(requests[0].args.at(-1)).endsWith("?per_page=1&page=1"));
});

Deno.test("299 unrelated files, one under GitHub's cap, are a complete list", async () => {
  const h = harness(makeWorld({
    changedFiles: () => unrelatedFiles(GITHUB_COMPARE_FILES_CAP - 1),
  }));
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["api", "dispatcher", "web"]);
  assert(!h.log.some((line) => line.startsWith("including inngest:")));
  assertEquals(filesRequests(h.calls).length, 1);
});

Deno.test("150 unrelated files leave inngest alone and upload nothing for it", async () => {
  const h = harness(makeWorld({ changedFiles: () => unrelatedFiles(150) }));
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["api", "dispatcher", "web"]);
  assert(!h.log.some((line) => line.startsWith("including inngest:")));
  assertEquals(filesRequests(h.calls).length, 1);
});

Deno.test("an unreadable, missing or truncated file list is treated as changed", async () => {
  const failing = harness(makeWorld({ filesFail: true }));
  assertEquals((await runRollout(failing.deps, failing.cfg)).exitCode, 0);
  assertEquals(failing.upOrder()[0], "inngest");

  const omitted = harness(makeWorld({ filesOmitted: true }));
  assertEquals((await runRollout(omitted.deps, omitted.cfg)).exitCode, 0);
  assertEquals(omitted.upOrder()[0], "inngest");

  // Exactly GitHub's cap: the list may be cut short, so nothing is proven.
  const capped = harness(makeWorld({
    changedFiles: () => unrelatedFiles(GITHUB_COMPARE_FILES_CAP),
  }));
  assertEquals((await runRollout(capped.deps, capped.cfg)).exitCode, 0);
  assertEquals(capped.upOrder()[0], "inngest");

  // Past the cap the Inngest file is cut off the list, and the result is still unknown.
  const beyond = harness(makeWorld({
    changedFiles: () => [
      ...unrelatedFiles(GITHUB_COMPARE_FILES_CAP + 50),
      { filename: "infra/railway/inngest-start.sh" },
    ],
  }));
  assertEquals((await runRollout(beyond.deps, beyond.cfg)).exitCode, 0);
  assertEquals(beyond.upOrder()[0], "inngest");
  assertEquals(filesRequests(beyond.calls).length, 1);
});

Deno.test("a needed inngest redeploy without a configured service id fails before any upload", async () => {
  const h = harness(
    makeWorld({
      changedFiles: () => inngestFiles("infra/railway/inngest.Dockerfile"),
    }),
    config({
      serviceIds: { api: IDS.api, dispatcher: IDS.dispatcher, web: IDS.web },
    }),
  );
  const result = await runRollout(h.deps, h.cfg);
  assertEquals(result.exitCode, 1);
  assert(result.message.startsWith("INNGEST_SERVICE_ID_MISSING"));
  assertEquals(h.upOrder(), []);
});

Deno.test("an explicit inngest request does not repeat the file comparison", async () => {
  const h = harness(
    makeWorld({ filesFail: true }),
    config({ services: ["inngest", "api", "dispatcher", "web"] }),
  );
  assertEquals((await runRollout(h.deps, h.cfg)).exitCode, 0);
  assertEquals(h.upOrder(), ["inngest", "api", "dispatcher", "web"]);
  assertEquals(filesRequests(h.calls).length, 0);
});
