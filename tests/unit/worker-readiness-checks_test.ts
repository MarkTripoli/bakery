import { assert, assertEquals, assertFalse } from "@std/assert";
import { syntheticAuthSource } from "../helpers/harness-auth.ts";
import {
  claudeAuthSourceAvailable,
  createClaudeHarnessExecutor,
} from "../../apps/worker/src/claude-harness.ts";
import { createScriptedHarnessExecutor } from "../../apps/worker/src/scripted-harness.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { HARNESS_WORKTREE_DIRTY_REASON } from "../../apps/worker/src/harness-common.ts";
import { prepareScratchRepository } from "../helpers/harness.ts";
import { createReviewerExecutor } from "../../apps/worker/src/reviewer.ts";
import {
  disposeRig,
  fakeClaude,
  initLine,
  recordingInner,
  resultLine,
  reviewerRig,
} from "../helpers/review-repair/worker-fixtures.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import {
  MAX_HEARTBEAT_INTERVAL_MS,
  readWorkerConfig,
  readWorkerLaunchPermissions,
} from "../../apps/worker/src/config.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import { READINESS_REFRESH_MS } from "../../apps/worker/src/supervisor-readiness.ts";
import type { WorkerInventoryCheck } from "../../apps/worker/src/types.ts";
import {
  fastSleep,
  openRecoveryState,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
  WorkerApiClient,
} from "../helpers/worker-execution/recovery-support.ts";

const NO_SANITIZE = { sanitizeResources: false, sanitizeOps: false } as const;

async function withDirectory<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir({ prefix: "bakery-readiness-" });
  try {
    return await work(directory);
  } finally {
    await Deno.chmod(directory, 0o700).catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("claude auth predicate: regular credentials file is available", () =>
  withDirectory(async (directory) => {
    await Deno.writeTextFile(`${directory}/.credentials.json`, "{}");
    assert(await claudeAuthSourceAvailable(directory));
  }));

Deno.test("claude auth predicate: missing source is unavailable, not a throw", async () => {
  assertFalse(await claudeAuthSourceAvailable("/nonexistent/bakery-claude"));
  await withDirectory(async (directory) => {
    assertFalse(await claudeAuthSourceAvailable(directory));
  });
});

Deno.test("claude auth predicate: symlink and non-file entries are unavailable", () =>
  withDirectory(async (directory) => {
    await Deno.writeTextFile(`${directory}/real.json`, "{}");
    await Deno.symlink(
      `${directory}/real.json`,
      `${directory}/.credentials.json`,
    );
    assertFalse(await claudeAuthSourceAvailable(directory));
    await Deno.remove(`${directory}/.credentials.json`);
    await Deno.mkdir(`${directory}/.credentials.json`);
    assertFalse(await claudeAuthSourceAvailable(directory));
  }));

Deno.test("claude auth predicate: an unreadable directory is unavailable, not a throw", () =>
  withDirectory(async (directory) => {
    const inner = `${directory}/locked`;
    await Deno.mkdir(inner);
    await Deno.writeTextFile(`${inner}/.credentials.json`, "{}");
    await Deno.chmod(inner, 0o000);
    if (Deno.uid() === 0) return; // root bypasses directory modes
    assertFalse(await claudeAuthSourceAvailable(inner));
  }));

Deno.test("claude harness reports capability:model from the auth predicate with a path-free reason", () =>
  withDirectory(async (directory) => {
    const executor = createClaudeHarnessExecutor({
      publishFor: () => {
        throw new Error("UNUSED");
      },
      repositoryFor: () => directory,
      authSourceDir: directory,
    });
    const missing = await executor.readinessChecks!();
    assertEquals(missing.length, 1);
    assertEquals(missing[0].checkId, "capability:model");
    assertEquals(missing[0].status, "fail");
    assertFalse((missing[0].reason ?? "").includes(directory));
    assert(Number.isFinite(Date.parse(missing[0].observedAt)));

    await Deno.writeTextFile(`${directory}/.credentials.json`, "{}");
    const present = await executor.readinessChecks!();
    assertEquals(present[0].status, "pass");
    assertEquals(present[0].reason, undefined);
  }));

Deno.test("wrapping executors delegate readiness checks; claude with an unavailable auth source adds a failing model check", async () => {
  const delegated: WorkerInventoryCheck = {
    checkId: "capability:other",
    checkVersion: "1",
    status: "pass",
    observedAt: new Date().toISOString(),
  };
  const inner: WorkerExecutor = {
    execute: () => Promise.reject(new Error("UNUSED")),
    readinessChecks: () => Promise.resolve([delegated]),
  };
  const scripted = createScriptedHarnessExecutor({
    dir: "/tmp/unused",
    inner,
    publishFor: () => {
      throw new Error("UNUSED");
    },
  });
  assertEquals(await scripted.readinessChecks!(), [delegated]);
  const claude = createClaudeHarnessExecutor({
    publishFor: () => {
      throw new Error("UNUSED");
    },
    repositoryFor: () => "/tmp/unused",
    authSourceDir: "/nonexistent/bakery-claude-auth",
    inner: scripted,
  });
  const claudeChecks = await claude.readinessChecks!();
  assertEquals(claudeChecks.length, 2);
  assertEquals(claudeChecks[0], delegated);
  assertEquals(claudeChecks[1].checkId, "capability:model");
  assertEquals(claudeChecks[1].status, "fail");
});

Deno.test("config: heartbeat interval is capped at 20 s and the auth dir reaches the grants", () => {
  const base = {
    BAKERY_ENV: "development",
    BAKERY_SERVER_URL: "http://127.0.0.1:8000",
    BAKERY_WORKER_CAPABILITIES: "model",
    HOME: "/home/example",
  };
  assertEquals(MAX_HEARTBEAT_INTERVAL_MS, 20_000);
  assertEquals(readWorkerConfig(base).heartbeatIntervalMs, 15_000);
  assertEquals(
    readWorkerConfig({ ...base, BAKERY_WORKER_HEARTBEAT_MS: "20000" })
      .heartbeatIntervalMs,
    20_000,
  );
  let rejected = false;
  try {
    readWorkerConfig({ ...base, BAKERY_WORKER_HEARTBEAT_MS: "20001" });
  } catch {
    rejected = true;
  }
  assert(rejected);

  const claude = {
    ...base,
    BAKERY_CLAUDE_HARNESS: "1",
    BAKERY_CLAUDE_HARNESS_REPOSITORY: "/srv/repo",
  };
  assertEquals(
    readWorkerConfig(claude).claudeAuthSourceDir,
    "/home/example/.claude",
  );
  const override = { ...claude, BAKERY_CLAUDE_AUTH_SOURCE_DIR: "/srv/claude" };
  assertEquals(readWorkerConfig(override).claudeAuthSourceDir, "/srv/claude");
  const grants = readWorkerLaunchPermissions(override, "/repo");
  assert(grants.read.includes("/srv/claude"));
  assertFalse(grants.read.includes("/home/example/.claude"));
  assertEquals(readWorkerConfig(base).claudeAuthSourceDir, undefined);
});

type Harness = {
  supervisor: WorkerSupervisor;
  events: string[];
  reports: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  heartbeats: () => number;
  clock: { value: number };
};

async function startHarness(
  directory: string,
  options: {
    checks: () => WorkerInventoryCheck[] | Promise<WorkerInventoryCheck[]>;
    revision: () => number;
    inventory: (
      body: Record<string, unknown>,
      attempt: number,
    ) => Response;
    stopWhen: (harness: Harness) => boolean;
    capabilities?: string[];
  },
): Promise<Harness> {
  const { registrationStore, spool } = await openRecoveryState(directory);
  const workerHostId = crypto.randomUUID();
  await registrationStore.saveRegistered("credential", {
    workerHostId,
    principalId: crypto.randomUUID(),
    status: "registered",
    registrationGeneration: 7,
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  });
  const events: string[] = [];
  const reports: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  let heartbeatCount = 0;
  const clock = { value: 1_000 };
  const holder: { current?: Harness } = {};
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/heartbeat")) {
        heartbeatCount++;
        events.push("heartbeat");
        const response = protocolResponse({
          workerHostId,
          status: "accepted",
          receivedAt: new Date().toISOString(),
          pendingCommands: [],
          commandAcks: [],
          workerSessionId: crypto.randomUUID(),
          workerSessionGeneration: "1",
          serverTime: new Date().toISOString(),
          inventoryRevision: options.revision(),
        });
        queueMicrotask(() => {
          if (holder.current && options.stopWhen(holder.current)) {
            holder.current.supervisor.requestStop("TEST_COMPLETE");
          }
        });
        return Promise.resolve(response);
      }
      if (path.endsWith("/inventory")) {
        const body = JSON.parse(String(init?.body));
        reports.push(body);
        events.push("inventory");
        return Promise.resolve(options.inventory(body, reports.length));
      }
      if (path.endsWith("/claims")) {
        claims.push(JSON.parse(String(init?.body)));
        events.push("claim");
        return Promise.resolve(protocolEmptyResponse({ status: 204 }));
      }
      return Promise.reject(new Error(`UNEXPECTED_WORKER_PATH:${path}`));
    },
  });
  const executor: WorkerExecutor = {
    execute: () => Promise.reject(new Error("UNUSED")),
    readinessChecks: () => Promise.resolve(options.checks()),
  };
  const supervisor = new WorkerSupervisor({
    config: {
      ...supervisorConfig(directory),
      capabilities: options.capabilities ?? ["model", "shell"],
    },
    client,
    registrationStore,
    spool,
    executor,
    sleep: fastSleep,
    monotonicNow: () => clock.value,
  });
  const harness: Harness = {
    supervisor,
    events,
    reports,
    claims,
    heartbeats: () => heartbeatCount,
    clock,
  };
  holder.current = harness;
  await supervisor.run();
  return harness;
}

function check(
  checkId: string,
  status: WorkerInventoryCheck["status"],
): WorkerInventoryCheck {
  return {
    checkId,
    checkVersion: "test-1",
    status,
    ...(status === "fail" ? { reason: "Fixed safe reason." } : {}),
    observedAt: new Date().toISOString(),
  };
}

function receipt(inventoryRevision: number, replayed = false): Response {
  return protocolResponse({
    inventoryRevision,
    readinessRevision: 1,
    acceptedComponents: 0,
    acceptedChecks: 1,
    replayed,
  });
}

Deno.test({
  name:
    "supervisor holds claims until a report for the current revision is accepted",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      const harness = await startHarness(directory, {
        checks: () => [check("capability:model", "pass")],
        revision: () => 3,
        // First report is rejected (retryable); the second is accepted.
        inventory: (_body, attempt) =>
          attempt === 1
            ? protocolResponse(
              { code: "SERVICE_UNAVAILABLE", retryable: true },
              { status: 503 },
            )
            : receipt(3),
        stopWhen: (state) => state.claims.length >= 1,
      });
      const firstClaim = harness.events.indexOf("claim");
      assert(firstClaim > 0, "a claim happened");
      const acceptedReports = harness.events.slice(0, firstClaim).filter((
        event,
      ) => event === "inventory").length;
      assertEquals(acceptedReports, 2, "claim only after the retried report");
      assertEquals(harness.reports[0].expectedInventoryRevision, 3);
      assertEquals(harness.reports[0].hostGeneration, 7);
      assertEquals(harness.reports[0].components, []);
      assertEquals(harness.reports.length >= 2, true);
      assert(harness.reports[0].reportId !== harness.reports[1].reportId);
    }),
});

Deno.test({
  name: "supervisor never requests a capability whose local check fails",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      const harness = await startHarness(directory, {
        checks: () => [
          check("capability:model", "fail"),
          check("capability:not-configured", "fail"),
        ],
        revision: () => 1,
        inventory: () => receipt(1),
        stopWhen: (state) => state.claims.length >= 1,
      });
      assertEquals(harness.claims[0].capabilities, ["shell"]);
      // Only checks for configured capabilities are reported.
      assertEquals(
        (harness.reports[0].checks as WorkerInventoryCheck[]).map((c) =>
          c.checkId
        ),
        ["capability:model"],
      );
    }),
});

Deno.test({
  name:
    "supervisor reports on change and refreshes every 150 s, not every heartbeat",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      let status: WorkerInventoryCheck["status"] = "pass";
      let revision = 2;
      let step = 0;
      const harness = await startHarness(directory, {
        checks: () => [check("capability:model", status)],
        revision: () => revision,
        inventory: (body) => receipt(Number(body.expectedInventoryRevision)),
        stopWhen: (state) => {
          const beats = state.heartbeats();
          // Advance the scenario after each stable stretch of heartbeats.
          if (beats === 6 && step === 0) {
            step = 1;
            state.clock.value += READINESS_REFRESH_MS - 1;
          } else if (beats === 12 && step === 1) {
            step = 2;
            state.clock.value += 1; // exactly the refresh interval
          } else if (beats === 18 && step === 2) {
            step = 3;
            status = "fail";
          } else if (beats === 24 && step === 3) {
            step = 4;
            revision = 3;
          }
          return beats >= 30;
        },
      });
      // 1 first report, 2 after the 150 s refresh, 3 on status change,
      // 4 on revision change. No report on the stable heartbeats between.
      assertEquals(harness.reports.length, 4);
      const revisions = harness.reports.map((r) => r.expectedInventoryRevision);
      assertEquals(revisions, [2, 2, 2, 3]);
      const statuses = harness.reports.map((r) =>
        (r.checks as WorkerInventoryCheck[])[0].status
      );
      assertEquals(statuses, ["pass", "pass", "fail", "fail"]);
    }),
});

Deno.test({
  name:
    "supervisor re-bases on STATE_CONFLICT using the next heartbeat revision",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      let revision = 5;
      const harness = await startHarness(directory, {
        checks: () => [check("capability:model", "pass")],
        revision: () => revision,
        inventory: (body, attempt) => {
          if (attempt === 1) {
            // Another writer bumped the revision between heartbeat and report.
            revision = 6;
            return protocolResponse(
              { code: "STATE_CONFLICT", retryable: false },
              { status: 409 },
            );
          }
          return receipt(Number(body.expectedInventoryRevision));
        },
        stopWhen: (state) => state.claims.length >= 1,
      });
      assertEquals(harness.reports[0].expectedInventoryRevision, 5);
      assertEquals(harness.reports[1].expectedInventoryRevision, 6);
      const firstClaim = harness.events.indexOf("claim");
      assertEquals(
        harness.events.slice(0, firstClaim).filter((e) => e === "inventory")
          .length,
        2,
      );
    }),
});

Deno.test({
  name:
    "a dirty harness clone reports a needs-attention git check and drops git from claims",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      const scratch = await prepareScratchRepository("bakery-readiness-dirty-");
      await Deno.mkdir(`${scratch.dir}/state`, { recursive: true });
      await Deno.writeTextFile(`${scratch.dir}/untracked-work.txt`, "kept\n");
      const codex = createCodexHarnessExecutor({
        publishFor: () => {
          throw new Error("UNUSED");
        },
        repositoryFor: () => scratch.dir,
        repository: scratch.dir,
        stateDir: `${scratch.dir}/state`,
        authSourceDir: syntheticAuthSource("auth.json"),
        codexExecutable: `${scratch.dir}/fake-codex`,
      });
      const harness = await startHarness(directory, {
        checks: () => codex.readinessChecks!(),
        revision: () => 1,
        inventory: () => receipt(1),
        capabilities: ["git", "model"],
        stopWhen: (state) => state.claims.length >= 1,
      });
      const reported = harness.reports[0].checks as WorkerInventoryCheck[];
      assertEquals(reported.length, 1);
      assertEquals(reported[0].checkId, "capability:git");
      assertEquals(reported[0].status, "fail");
      assertEquals(reported[0].reason, HARNESS_WORKTREE_DIRTY_REASON);
      assertFalse((reported[0].reason ?? "").includes(scratch.dir));
      assertEquals(harness.claims[0].capabilities, ["model"]);
    }),
});

/**
 * Claims of a host that runs the independent reviewer: `reviewer` is requested
 * only when it is enrolled and its readiness check passes, so a host that
 * cannot review never asks for a review job (issue #94).
 */
async function reviewerClaims(
  capabilities: string[],
  options: { credentials: boolean; cli: boolean },
): Promise<{ reported: WorkerInventoryCheck[]; claimed: unknown }> {
  const rig = await reviewerRig();
  try {
    const fake = await fakeClaude(rig.repository.aux, [
      initLine(),
      resultLine({ structured_output: { findings: [] } }),
    ]);
    if (!options.credentials) {
      await Deno.remove(`${rig.authDir}/.credentials.json`);
    }
    const reviewer = createReviewerExecutor({
      inner: recordingInner(),
      repository: rig.repository.dir,
      stateDir: rig.stateDir,
      claude: {
        authSourceDir: rig.authDir,
        claudeExecutable: options.cli
          ? fake.executable
          : `${rig.repository.aux}/no-such-claude`,
      },
    });
    return await withDirectory(async (directory) => {
      const harness = await startHarness(directory, {
        checks: () => reviewer.readinessChecks!(),
        revision: () => 1,
        inventory: () => receipt(1),
        capabilities,
        stopWhen: (state) => state.claims.length >= 1,
      });
      return {
        reported: (harness.reports[0]?.checks ?? []) as WorkerInventoryCheck[],
        claimed: harness.claims[0].capabilities,
      };
    });
  } finally {
    await disposeRig(rig);
  }
}

Deno.test({
  name:
    "an enrolled reviewer with a runnable CLI and a credential requests the reviewer capability",
  ...NO_SANITIZE,
  fn: async () => {
    const { reported, claimed } = await reviewerClaims(
      ["model", "reviewer"],
      { credentials: true, cli: true },
    );
    assertEquals(reported.map((c) => [c.checkId, c.status]), [
      ["capability:reviewer", "pass"],
    ]);
    assertEquals(claimed, ["model", "reviewer"]);
  },
});

Deno.test({
  name:
    "a reviewer host without a credential or a CLI stops requesting the reviewer capability",
  ...NO_SANITIZE,
  fn: async () => {
    for (
      const options of [
        { credentials: false, cli: true },
        { credentials: true, cli: false },
      ]
    ) {
      const { reported, claimed } = await reviewerClaims(
        ["model", "reviewer"],
        options,
      );
      assertEquals(reported[0].checkId, "capability:reviewer");
      assertEquals(reported[0].status, "fail");
      assertFalse((reported[0].reason ?? "").includes("/"));
      assertEquals(claimed, ["model"]);
    }
  },
});

Deno.test({
  name:
    "a host that does not enroll reviewer never requests it, whatever its executor can do",
  ...NO_SANITIZE,
  fn: async () => {
    const { claimed } = await reviewerClaims(
      ["model", "git"],
      { credentials: true, cli: true },
    );
    assertEquals(claimed, ["model", "git"]);
  },
});
