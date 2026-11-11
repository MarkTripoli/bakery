import { assertEquals } from "@std/assert";
import {
  authenticatedClients,
  waitForEngineFunctionRegistration,
} from "../helpers/durable-core/engine-admission.ts";
import {
  assertWorkerRunning,
  launchPresetWorker,
  type PresetWorld,
  provisionDelegatedCgroupV2,
  removePaths,
  stopPresetWorker,
  until,
} from "../helpers/durable-core/preset-stack.ts";
import {
  type DurableCoreStack,
  upDurableCoreStack,
} from "../helpers/durable-core/stack.ts";
import {
  git,
  listWorktrees,
  LOOP_COMMANDS,
} from "../helpers/review-repair/e2e-candidate.ts";
import {
  cleanSeed,
  repairThenProceed,
  repeatedBlocker,
  reviewerUnavailable,
  type ScenarioContext,
} from "../helpers/review-repair/e2e-scenarios.ts";
import {
  onboardLoopRepository,
  seedLoopAgents,
  SubstituteWorker,
} from "../helpers/review-repair/e2e-world.ts";

/**
 * Real-process proof for issue #94. The stack is the compose server, Postgres,
 * Inngest and the dispatcher. The worker is the production worker process
 * started by its production launcher (`bash scripts/run-worker.sh`, as compose
 * and the deploy script do) with a coding-harness repository configured, which
 * is what makes it advertise `quality.check`. It is enrolled with the
 * capabilities git, shell and browser only, so it claims `task.brief` and
 * `quality.check` and can never claim a model-backed job.
 *
 * Substituted steps, stated once:
 * - The onboarding inspection of the profile (`repository.inspect`) runs
 *   through the same server routes mounted in this process against the stack's
 *   database, with the test playing the inspecting worker (the #83 technique).
 * - The model-backed jobs `harness.implement`, `harness.repair` and
 *   `review.independent` are answered by a substitute worker in this process
 *   (tests/helpers/review-repair/e2e-world.ts). It speaks the real worker
 *   protocol to the compose server over HTTP, so claims, leases, results, the
 *   result hooks and the engine are all production code. What it replaces is
 *   the model: it reports the commits and the findings a script names. The
 *   review report is built by the production worker module the Claude reviewer
 *   uses. No Claude, Codex or Pi run happened; the live cases stay open (G3).
 *
 * Everything else is real: profile admission, run admission and pinning, the
 * brief, the fixed checks run by the production worker against real commits,
 * the check rows, the review finalizer, the delivery decisions, the appended
 * repair iterations and stop gate, the engine, and the HTTP reads.
 */

const startedAt = Date.now();

/** Timestamped progress line, so a timeout names the step it was stuck in. */
function progress(step: string): void {
  console.error(
    `review-e2e +${Math.round((Date.now() - startedAt) / 1000)}s ${step}`,
  );
}

Deno.test({
  name:
    "a real worker runs the checks and the server records and decides the review and repair loop",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let stack: DurableCoreStack | undefined;
    let lease:
      | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
      | undefined;
    let production: Awaited<ReturnType<typeof launchPresetWorker>> | undefined;
    let substitute: SubstituteWorker | undefined;
    let workerStateDir: string | undefined;
    const scratch = await Deno.makeTempDir({ prefix: "bakery-review-e2e-" });
    const operator = `${scratch}/operator`;
    const authSource = `${scratch}/codex-auth`;
    try {
      stack = await upDurableCoreStack("review-loop");
      progress("stack up");
      await waitForEngineFunctionRegistration(stack);
      const clients = await authenticatedClients(stack);
      const { organizationId, principalId } = clients.identity;
      progress("signed in");

      const agents = await seedLoopAgents(stack, clients);
      const repository = await onboardLoopRepository(
        stack,
        { organizationId, principalId },
        operator,
        agents,
      );
      const { commits } = repository;
      progress("agents funded, profile observed, commits created");

      // A placeholder auth source: the Codex adapter wraps the executor but
      // this proof never runs a model action in the production worker.
      await Deno.mkdir(authSource, { mode: 0o700 });
      await Deno.writeTextFile(
        `${authSource}/auth.json`,
        '{"note":"placeholder for the e2e proof, not a credential"}\n',
      );
      lease = await provisionDelegatedCgroupV2("bakery-review-e2e-");
      const world: PresetWorld = {
        clients,
        organizationId,
        applicationId: repository.applicationId,
        repositoryId: repository.repositoryId,
        repositoryProfileId: repository.profileId,
      };
      const productionCapabilities = ["git", "shell", "browser"];
      production = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
        launcher: "run-worker",
        // No model, web or reviewer: this process claims quality.check and
        // task.brief only, so the substitute below cannot race it.
        capabilities: productionCapabilities,
        environment: {
          BAKERY_CODEX_HARNESS: "1",
          BAKERY_CODEX_HARNESS_REPOSITORY: commits.repository,
          BAKERY_CODEX_HARNESS_EXECUTABLE: "/usr/bin/true",
          BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: "30000",
          BAKERY_CODEX_AUTH_SOURCE_DIR: authSource,
        },
      });
      workerStateDir = production.stateDir;
      progress("production worker launched");

      const substituteCapabilities = [
        "git",
        "shell",
        "web",
        "model",
        "reviewer",
      ];
      substitute = await SubstituteWorker.register(
        stack,
        clients,
        substituteCapabilities,
      );
      // The production worker registers itself a moment after it starts. Its
      // host holds none of the capabilities of a model job.
      const productionName = production.name;
      const productionHost = await until(
        "production worker registered",
        60_000,
        async () =>
          (await stack!.psql<{ capabilities: string[] }>(
            `select capabilities from bakery.worker_hosts
              where organization_id = $1 and name = $2`,
            [organizationId, productionName],
          ))[0],
        () => assertWorkerRunning(production!),
      );
      assertEquals(
        [...productionHost.capabilities].sort(),
        [...productionCapabilities].sort(),
      );
      progress("substitute worker registered");

      const context: ScenarioContext = {
        stack,
        organizationId,
        worker: substitute,
        production,
        clients,
        repository,
        progress,
      };
      const scenarios = [];
      for (
        const scenario of [
          repairThenProceed,
          cleanSeed,
          repeatedBlocker,
          reviewerUnavailable,
        ]
      ) {
        scenarios.push(await scenario(context));
        progress(`scenario done: ${scenarios.at(-1)!.scenario}`);
      }

      // Nothing is left behind: the operator repository lists only its own
      // worktree, no attempt root remains and it is still clean on its tip.
      assertEquals(await listWorktrees(commits.repository), [
        commits.repository,
      ]);
      const leftovers: string[] = [];
      try {
        for await (
          const entry of Deno.readDir(`${production.stateDir}/checks`)
        ) {
          leftovers.push(entry.name);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      assertEquals(leftovers, []);
      assertEquals(
        await git(["status", "--porcelain"], commits.repository),
        "",
      );
      assertEquals(
        await git(["rev-parse", "HEAD"], commits.repository),
        commits.followUp,
      );

      substitute.stop();
      substitute = undefined;
      await stopPresetWorker(production);
      production = undefined;
      console.log(JSON.stringify({
        evidence: "REVIEW_REPAIR_E2E_CONFIRMED",
        composeProject: stack.project,
        commits: {
          base: commits.base,
          broken: commits.broken,
          fixed: commits.fixed,
          followUp: commits.followUp,
        },
        checkCommands: LOOP_COMMANDS.map(({ id, mode }) => `${id}:${mode}`),
        scenarios,
        substitutedSteps: [
          "repository.inspect plays the worker in-process",
          "harness.implement, harness.repair and review.independent are answered by a scripted substitute worker over the real worker protocol; no model ran",
        ],
        realSteps: [
          "task.brief and quality.check run by the production worker",
          "review finalizer, delivery decisions, appended iterations and stop gate on the compose server",
        ],
        productionWorkerCommand: "bash apps/worker/scripts/run-worker.sh",
        productionWorkerCapabilities: productionCapabilities,
        substituteWorkerCapabilities: substituteCapabilities,
        liveReviewerRun: "not run: no credentials; G3 cases stay open",
      }));
      await lease.release();
      lease = undefined;
      await stack.down();
      stack = undefined;
    } finally {
      substitute?.stop();
      if (production) await stopPresetWorker(production).catch(() => undefined);
      await lease?.release().catch(() => undefined);
      await stack?.down().catch(() => undefined);
      await removePaths([scratch, ...(workerStateDir ? [workerStateDir] : [])]);
    }
  },
});
