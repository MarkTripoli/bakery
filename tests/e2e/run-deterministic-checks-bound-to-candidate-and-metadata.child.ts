import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { assertCandidateChecksSatisfied } from "../../apps/server/src/modules/delivery/verdict.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
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
  TERMINAL_RUN_STATUSES,
  until,
} from "../helpers/durable-core/preset-stack.ts";
import {
  type DurableCoreStack,
  upDurableCoreStack,
} from "../helpers/durable-core/stack.ts";
import {
  FORGED_OUTPUT,
  git,
  listWorktrees,
  PROOF_COMMANDS,
} from "../helpers/deterministic-checks/e2e-candidate.ts";
import { recordAndRejudge } from "../helpers/deterministic-checks/e2e-rejudge.ts";
import { ownedSystemdUnitOutput } from "../helpers/owned-process-group.ts";
import {
  appDatabaseUrl,
  call,
  callJson,
  onboardObservedRepository,
  publishCheckWorkflow,
  publishOrganizationRules,
  startCheckRun,
} from "../helpers/deterministic-checks/e2e-world.ts";

/**
 * Real-process proof of candidate-bound checks. The stack is the compose server, Postgres,
 * Inngest and the dispatcher; the worker is the production worker process
 * started by its production launcher (`bash scripts/run-worker.sh`, as compose
 * and the deploy script do) with a coding-harness repository configured, which
 * is what makes it advertise `quality.check`. The `pnpm --filter @bakery/worker
 * start` wrapper cannot be used: its `env -i` list carries no harness setting. A run of a
 * published workflow lists four commands of the fixed profile and the proof
 * reads the result back over HTTP.
 *
 * Substituted step, stated once: the onboarding inspection of the profile.
 * The compose server has no trusted-repository mapping and cannot read a host
 * repository, so `repository.inspect` runs through the same server routes and
 * handlers mounted in this process against the stack's database, with the test
 * playing the inspecting worker (tests/helpers/deterministic-checks/e2e-world.ts).
 * Everything after it is real: profile admission, workflow publication, run
 * admission and pinning, the claim, the production worker, artifact upload,
 * the result route and its verification, the check_runs rows and the HTTP read.
 * The metadata rows and the staleness re-judgement call the delivery service
 * directly over the stack's database. The production caller of the command
 * checks is `evaluateReviewedChecks` (issue #94), which judges them when a
 * review is recorded; the merge gate `evaluateDeliveryCandidate` has no
 * production caller until the merge consumer (#97), and neither have the
 * metadata checks until a run has a pull request. No live GitHub reader exists
 * (G3 stays open).
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const startedAt = Date.now();

/** Timestamped progress line, so a timeout names the step it was stuck in. */
function progress(step: string): void {
  console.error(
    `checks-e2e +${Math.round((Date.now() - startedAt) / 1000)}s ${step}`,
  );
}

type CheckRunItem = {
  id: string;
  runId: string;
  runStepId: string | null;
  checkId: string;
  kind: string;
  ruleKey: string | null;
  headSha: string;
  baseSha: string | null;
  profileDigest: string | null;
  policyDigest: string;
  subjectDigest: string;
  checkerDigest: string | null;
  result: string;
  reason: string;
  exitCode: number | null;
  durationMs: number | null;
  outputDigest: string | null;
  evidenceVersionId: string | null;
};

type Page = { items: CheckRunItem[]; nextCursor: string | null };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function waitForRun(
  stack: DurableCoreStack,
  organizationId: string,
  runId: string,
  worker: Parameters<typeof assertWorkerRunning>[0],
): Promise<string> {
  try {
    return await until(`run ${runId} terminal`, 150_000, async () => {
      const rows = await stack.psql<{ status: string }>(
        `select status from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [organizationId, runId],
      );
      const status = rows[0]?.status;
      return status !== undefined && TERMINAL_RUN_STATUSES.includes(status)
        ? status
        : undefined;
    }, () => assertWorkerRunning(worker));
  } catch (error) {
    const state = await stack.psql(
      `select step.step_key, step.status, step.error, job.status as job_status,
              job.requirements
         from bakery.run_steps step
         left join bakery.jobs job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
        where step.organization_id = $1 and step.run_id = $2`,
      [organizationId, runId],
    );
    const hosts = await stack.psql(
      `select name, capabilities, status from bakery.worker_hosts
        where organization_id = $1`,
      [organizationId],
    );
    throw new Error(
      `${(error as Error).message}:${JSON.stringify({ state, hosts })}\n${
        ownedSystemdUnitOutput(worker.unit).slice(-4000)
      }`,
    );
  }
}

async function listAll(client: Parameters<typeof call>[0], runId: string) {
  const items: CheckRunItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `limit=3${
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
    }`;
    const page: Page = await callJson<Page>(
      client,
      "GET",
      `/v1/runs/${runId}/checks?${query}`,
      200,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null && pages < 10);
  return { items, pages };
}

Deno.test({
  name:
    "a real worker runs the profile's fixed checks and the server records only what it can verify",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let stack: DurableCoreStack | undefined;
    let lease:
      | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
      | undefined;
    let worker: Awaited<ReturnType<typeof launchPresetWorker>> | undefined;
    let workerStateDir: string | undefined;
    const scratch = await Deno.makeTempDir({ prefix: "bakery-checks-e2e-" });
    const operator = `${scratch}/operator`;
    const authSource = `${scratch}/codex-auth`;
    try {
      stack = await upDurableCoreStack("checks");
      progress("stack up");
      await waitForEngineFunctionRegistration(stack);
      const clients = await authenticatedClients(stack);
      const { organizationId, principalId } = clients.identity;
      progress("signed in");

      const observed = await onboardObservedRepository(
        stack,
        { organizationId, principalId },
        operator,
      );
      const { candidate } = observed;
      progress("profile observed and candidate committed");
      await publishOrganizationRules(clients.producer, organizationId);
      const workflowId = await publishCheckWorkflow(
        clients.producer,
        candidate.headSha,
      );

      // A placeholder auth source: the Codex adapter wraps the executor but
      // this proof never runs a model action.
      await Deno.mkdir(authSource, { mode: 0o700 });
      await Deno.writeTextFile(
        `${authSource}/auth.json`,
        '{"note":"placeholder for the e2e proof, not a credential"}\n',
      );
      progress("rules and workflow published");
      lease = await provisionDelegatedCgroupV2("bakery-checks-e2e-");
      const world: PresetWorld = {
        clients,
        organizationId,
        applicationId: observed.applicationId,
        repositoryId: observed.repositoryId,
        repositoryProfileId: observed.profileId,
      };
      worker = await launchPresetWorker(stack, world, {
        cgroupRoot: lease.root,
        launcher: "run-worker",
        capabilities: ["git", "shell", "browser"],
        environment: {
          BAKERY_CODEX_HARNESS: "1",
          BAKERY_CODEX_HARNESS_REPOSITORY: candidate.repository,
          BAKERY_CODEX_HARNESS_EXECUTABLE: "/usr/bin/true",
          BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: "30000",
          BAKERY_CODEX_AUTH_SOURCE_DIR: authSource,
        },
      });
      workerStateDir = worker.stateDir;
      progress("worker launched");

      const run = await startCheckRun(
        stack,
        clients.producer,
        observed,
        workflowId,
      );
      progress("run started");
      const status = await waitForRun(
        stack,
        organizationId,
        run.runId,
        worker,
      );
      progress(`run ${status}`);
      const stepRows = await stack.psql<
        {
          status: string;
          output: Record<string, unknown> | null;
          error: unknown;
        }
      >(
        `select status, output, error from bakery.run_steps
          where organization_id = $1 and id = $2`,
        [organizationId, run.stepId],
      );
      const step = stepRows[0]!;
      assertEquals(
        [status, step.status],
        ["completed", "completed"],
        JSON.stringify(step.error),
      );

      // 1. One row per check over the real HTTP read.
      const first = await callJson<Page>(
        clients.consumer,
        "GET",
        `/v1/runs/${run.runId}/checks`,
        200,
      );
      assertEquals(first.items.length, PROOF_COMMANDS.length);
      assertEquals(first.nextCursor, null);
      const profileRows = await stack.psql<{ digest: string }>(
        `select digest from bakery.repository_profiles
          where organization_id = $1 and id = $2`,
        [organizationId, observed.profileId],
      );
      const policyDigests = new Set<string>();
      const subjects = new Set<string>();
      const byCheck = new Map(first.items.map((item) => [item.checkId, item]));
      assertEquals(byCheck.size, PROOF_COMMANDS.length);
      for (const command of PROOF_COMMANDS) {
        const row = byCheck.get(command.id);
        assert(row, `no row for ${command.id}`);
        assertEquals(
          [row.result, row.reason, row.exitCode],
          [
            command.expect.result,
            command.expect.reason,
            command.expect.exitCode,
          ],
          `${command.id}`,
        );
        assertEquals(row.kind, "command");
        assertEquals(row.runId, run.runId);
        assertEquals(row.runStepId, run.stepId);
        // Bound to the candidate head and the profile's inspected base.
        assertEquals(row.headSha, candidate.headSha);
        assertEquals(row.baseSha, candidate.baseSha);
        assertEquals(row.profileDigest, profileRows[0]!.digest);
        assertEquals(
          row.ruleKey,
          command.id === "pass" ? "code.magicNumbers" : null,
        );
        assert(UUID.test(row.id));
        assert(typeof row.evidenceVersionId === "string");
        assert(UUID.test(row.evidenceVersionId));
        assert(row.outputDigest !== null && SHA256.test(row.outputDigest));
        assert(SHA256.test(row.subjectDigest));
        assert(row.checkerDigest !== null && SHA256.test(row.checkerDigest));
        policyDigests.add(row.policyDigest);
        subjects.add(row.subjectDigest);
      }
      assertEquals(policyDigests.size, 1);
      assertEquals(subjects.size, PROOF_COMMANDS.length);

      // 2. The step output is the server-verified verdict, not the forged one.
      const output = step.output!;
      const failedIds = ["fail", "forge", "absent"].map((id) =>
        byCheck.get(id)!.id
      );
      assertEquals(output.allRequired, false);
      assertEquals(
        [...(output.failedCheckIds as string[])].sort(),
        [...failedIds].sort(),
      );
      assertEquals(
        [...(output.checkRunIds as string[])].sort(),
        first.items.map(({ id }) => id).sort(),
      );
      assertEquals(output.headSha, candidate.headSha);
      assertEquals(output.baseSha, candidate.baseSha);
      assertEquals(output.policyDigest, [...policyDigests][0]);
      assert(
        !(output.failedCheckIds as string[]).includes(byCheck.get("pass")!.id),
      );

      // 3. Evidence: retained bytes match their digest; the forged text is
      // evidence only and the command is recorded as failed.
      for (const command of PROOF_COMMANDS) {
        const row = byCheck.get(command.id)!;
        const response = await call(
          clients.consumer,
          "GET",
          `/v1/artifact-versions/${row.evidenceVersionId}/content`,
        );
        assertEquals(response.status, 200, command.id);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertEquals(await sha256Hex(bytes), row.outputDigest);
        const evidence = JSON.parse(new TextDecoder().decode(bytes)) as Record<
          string,
          unknown
        >;
        assertEquals(evidence.schema, "bakery.check-evidence/v1");
        assertEquals(evidence.checkId, command.id);
        assertEquals(evidence.headSha, candidate.headSha);
        assertEquals(evidence.result, command.expect.result);
        assertEquals(evidence.exitCode, command.expect.exitCode);
        if (command.id === "forge") {
          assert(String(evidence.stdout).includes(FORGED_OUTPUT));
          assertEquals(row.result, "failed");
        }
        if (command.id === "fail") {
          assert(String(evidence.stderr).includes("unit tests failed"));
        }
      }
      const provenance = await stack.psql<
        { job_id: string; attempt_id: string; fence: string; n: string }
      >(
        `select job_id, attempt_id, fence::text, count(*) over () as n
           from bakery.check_runs
          where organization_id = $1 and run_id = $2`,
        [organizationId, run.runId],
      );
      assertEquals(provenance.length, PROOF_COMMANDS.length);
      assertEquals(
        new Set(provenance.map(({ attempt_id }) => attempt_id)).size,
        1,
      );
      const artifacts = await stack.psql<
        { artifact_type: string; name: string }
      >(
        `select artifact.artifact_type, artifact.name
           from bakery.artifact_versions version
           join bakery.artifacts artifact
             on artifact.organization_id = version.organization_id
            and artifact.id = version.artifact_id
          where version.organization_id = $1 and version.id = any($2::uuid[])`,
        [
          organizationId,
          first.items.map(({ evidenceVersionId }) => evidenceVersionId),
        ],
      );
      assertEquals(artifacts.length, PROOF_COMMANDS.length);
      for (const artifact of artifacts) {
        assertEquals(artifact.artifact_type, "check");
        assert(
          artifact.name.startsWith(
            `check-${provenance[0]!.job_id}-${provenance[0]!.fence}-`,
          ),
          artifact.name,
        );
      }
      const audits = await stack.psql<{ count: string }>(
        `select count(*) from bakery.audit_events
          where organization_id = $1 and operation = 'delivery.checkRuns.record'`,
        [organizationId],
      );
      assertEquals(Number(audits[0]!.count), 1);

      // 4. Nothing is left behind: the scratch repository lists only its own
      // worktree, the attempt root is gone and the repository is still clean.
      assertEquals(await listWorktrees(candidate.repository), [
        candidate.repository,
      ]);
      const leftovers: string[] = [];
      try {
        for await (const entry of Deno.readDir(`${worker.stateDir}/checks`)) {
          leftovers.push(entry.name);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      assertEquals(leftovers, []);
      assertEquals(
        await git(["status", "--porcelain"], candidate.repository),
        "",
      );
      assertEquals(
        await git(["rev-parse", "HEAD"], candidate.repository),
        candidate.headSha,
      );

      progress("http rows, output, evidence and cleanup asserted");
      // 5. The delivery gate over the real rows: the forged pass does not
      // pass, and exactly the affected checks go stale when one part changes.
      const jobs = await stack.psql<{ input: unknown }>(
        `select input from bakery.jobs
          where organization_id = $1 and run_step_id = $2`,
        [organizationId, run.stepId],
      );
      assertEquals(jobs.length, 1);
      const appPg = openPgDatabase(appDatabaseUrl(stack));
      let rejudged;
      try {
        rejudged = await recordAndRejudge({
          appPg,
          organizationId,
          runId: run.runId,
          jobInput: jobs[0]!.input,
        });
      } finally {
        await closePgDatabase(appPg);
      }
      const { scenarios } = rejudged;
      const everyKey = rejudged.requirements.map(({ kind, checkId }) =>
        `${kind}:${checkId}`
      );
      const metadataKeys = [
        "merge_message:commits.semantic",
        "title:changeRequest.semanticTitle",
        "description:changeRequest.description",
      ];
      assertEquals(rejudged.metadataRows.length, metadataKeys.length);
      // The fixed policy and the bound magic rule both name `pass`; the merged
      // list has one requirement per check.
      assertEquals(new Set(everyKey).size, everyKey.length);
      assertEquals(
        [...everyKey].sort(),
        [
          "command:pass",
          "command:fail",
          "command:forge",
          "command:absent",
          ...metadataKeys,
        ].sort(),
      );

      const current = scenarios.current!;
      assertEquals(current.verdict.evaluations.length, everyKey.length);
      assertEquals(current.stale, []);
      assertEquals(current.blocked, true);
      assertEquals(current.statuses, {
        "command:pass": "passed",
        "command:fail": "failed",
        "command:forge": "failed",
        "command:absent": "unavailable",
        "merge_message:commits.semantic": "passed",
        "title:changeRequest.semanticTitle": "passed",
        "description:changeRequest.description": "passed",
      });
      assertEquals(
        current.verdict.blockedChecks.map(({ requirement }) =>
          requirement.checkId
        ).sort(),
        ["absent", "fail", "forge"],
      );
      const blocked = (() => {
        try {
          assertCandidateChecksSatisfied(current.verdict);
        } catch (error) {
          return error;
        }
        return null;
      })();
      assert(blocked instanceof StandardError);
      assertEquals(blocked.code, "STATE_CONFLICT");
      assertEquals(blocked.params?.reason, "delivery_checks_blocked");

      const expectStale = (
        name: string,
        keys: readonly string[],
        part: string,
      ) => {
        const scenario = scenarios[name]!;
        assertEquals([...scenario.stale].sort(), [...keys].sort(), name);
        for (const key of keys) {
          assert(scenario.changed[key]!.includes(part), `${name} ${key}`);
        }
        for (const key of everyKey) {
          if (!keys.includes(key)) {
            assertEquals(
              scenario.statuses[key],
              current.statuses[key],
              `${name} must leave ${key} alone`,
            );
          }
        }
        assertEquals(scenario.blocked, true);
      };
      // Same head, changed text: only the check that judged that text moves.
      expectStale("title", ["title:changeRequest.semanticTitle"], "title");
      expectStale("body", ["description:changeRequest.description"], "body");
      expectStale(
        "mergeMessage",
        ["merge_message:commits.semantic"],
        "merge_message",
      );
      // A different head or base invalidates every recorded pass: the command
      // that passed and the three metadata checks. A row that did not pass
      // keeps its own status, so the failed and unavailable checks stay
      // visible, and every required check still blocks.
      const passedKeys = ["command:pass", ...metadataKeys];
      for (
        const [name, part] of [["head", "head"], ["base", "base"]] as const
      ) {
        expectStale(name, passedKeys, part);
        const moved = scenarios[name]!;
        assertEquals(moved.statuses["command:fail"], "failed", name);
        assertEquals(moved.statuses["command:forge"], "failed", name);
        assertEquals(moved.statuses["command:absent"], "unavailable", name);
        assertEquals(moved.verdict.blockedChecks.length, everyKey.length, name);
      }
      // A changed command or rule entry moves only the check that enforces it.
      expectStale("commandSubject", ["command:pass"], "subject");
      expectStale(
        "ruleSubject",
        ["title:changeRequest.semanticTitle"],
        "subject",
      );

      progress("delivery gate and staleness asserted");
      // 6. The HTTP read now lists command and metadata rows and pages them.
      const all = await listAll(clients.consumer, run.runId);
      assertEquals(
        all.items.length,
        PROOF_COMMANDS.length + metadataKeys.length,
      );
      assert(all.pages >= 3, "the list should need several pages of three");
      assertEquals(
        new Set(all.items.map(({ id }) => id)).size,
        all.items.length,
      );
      const metadata = all.items.filter(({ kind }) => kind !== "command");
      assertEquals(metadata.length, metadataKeys.length);
      for (const row of metadata) {
        assertEquals([row.result, row.reason], ["passed", "verified"]);
        assertEquals(row.runStepId, null);
        assertEquals(row.headSha, candidate.headSha);
      }
      assertEquals(
        (await call(
          clients.consumer,
          "GET",
          `/v1/runs/${crypto.randomUUID()}/checks`,
        )).status,
        404,
      );
      const signedOut = await stack.fetch(
        new Request(`${stack.origin}/v1/runs/${run.runId}/checks`, {
          headers: { "Bakery-Organization-Id": organizationId },
        }),
      );
      assertEquals(signedOut.status, 401);
      await signedOut.body?.cancel();
      assertNotEquals(all.items.length, 0);

      await stopPresetWorker(worker);
      worker = undefined;
      console.log(JSON.stringify({
        evidence: "DETERMINISTIC_CHECKS_E2E_CONFIRMED",
        composeProject: stack.project,
        runId: run.runId,
        headSha: candidate.headSha,
        baseSha: candidate.baseSha,
        results: Object.fromEntries(
          first.items.map(({ checkId, result, reason }) => [
            checkId,
            `${result}/${reason}`,
          ]),
        ),
        allRequired: output.allRequired,
        staleByChange: Object.fromEntries(
          Object.entries(scenarios).map(([name, scenario]) => [
            name,
            scenario.stale.length,
          ]),
        ),
        substitutedStep: "repository.inspect plays the worker in-process",
        productionWorkerCommand: "bash apps/worker/scripts/run-worker.sh",
      }));
      await lease.release();
      lease = undefined;
      await stack.down();
      stack = undefined;
    } finally {
      if (worker) await stopPresetWorker(worker).catch(() => undefined);
      await lease?.release().catch(() => undefined);
      await stack?.down().catch(() => undefined);
      await removePaths([scratch, ...(workerStateDir ? [workerStateDir] : [])]);
    }
  },
});
