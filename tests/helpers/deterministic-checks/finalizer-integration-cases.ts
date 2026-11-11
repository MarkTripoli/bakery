import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  boundRuleEntries,
  deriveCheckPins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import {
  adminRequest,
  closeWorkerScope,
  createWorkerScope,
  problemCode,
  type WorkerScope,
} from "../worker-execution.ts";
import { withWorkerFixture } from "../worker-execution/scenarios.ts";
import {
  type CheckCommand,
  DEFAULT_COMMANDS,
  organizationCheckRunCount,
  seedCheckScenario,
} from "./finalizer-fixture.ts";
import { effectiveEntries, magicRuleEntry } from "./identity-fixture.ts";
import { BASE_SHA, HEAD_SHA } from "./observations.ts";

/**
 * Functional cases for the `quality.check` finalizer through the real worker
 * result route and real Postgres: what a valid report records, how each
 * outcome is told apart, and who may read the rows back. Forgery cases live in
 * the security lane.
 */

const MAGIC_COMMANDS: readonly CheckCommand[] = [
  ...DEFAULT_COMMANDS,
  { id: "magic.numbers", argv: ["deno", "lint"], mode: "require" },
];

/**
 * Opens a worker fixture for a case that records check rows. The shared
 * teardown (`closeWorkerOrganization`) deletes an organization's check rows
 * before its artifact versions, so a case needs no clearing of its own.
 */
export async function withCheckFixture<T>(
  work: Parameters<typeof withWorkerFixture<T>>[0],
): Promise<T> {
  return await withWorkerFixture(work);
}

export function registerFinalizerIntegrationCases(): void {
  Deno.test("a valid report records one row per command with server-derived identities and stores the step output", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report, evidence } = await scenario.honest({ lint: "fail" });
      const before = await scenario.state();
      const key = crypto.randomUUID();
      const response = await scenario.post(report, key);
      assertEquals(response.status, 200, await response.clone().text());
      const ack = await response.text();
      contractSchemas.WorkerAck.parse(JSON.parse(ack));

      const rows = await scenario.rows();
      assertEquals(rows.map((row) => row.check_id), ["unit", "lint", "format"]);
      assertEquals(
        rows.map((row) => row.id),
        report.observations.map((observation) => observation.checkRunId),
      );
      const expectedPolicy = await sha256Hex(canonicalJson({
        fixedPolicyDigest: scenario.context.fixedPolicyDigest,
        trustedCheckerConfigDigest: scenario.context.trustedCheckerConfigDigest,
        entriesDigest: await sha256Hex(canonicalJson([])),
      }));
      for (const [index, row] of rows.entries()) {
        const command = DEFAULT_COMMANDS[index]!;
        assertEquals(row.organization_id, scenario.organizationId);
        assertEquals(row.run_id, scenario.job.runId);
        assertEquals(row.run_step_id, scenario.job.runStepId);
        assertEquals(row.job_id, scenario.job.jobId);
        assertEquals(row.attempt_id, scenario.assignment.attemptId);
        assertEquals(row.fence, scenario.assignment.fence);
        assertEquals(row.kind, "command");
        assertEquals(row.rule_key, null);
        assertEquals(row.head_sha, HEAD_SHA);
        assertEquals(row.base_sha, BASE_SHA);
        assertEquals(row.profile_digest, scenario.context.digest);
        assertEquals(
          row.checker_digest,
          scenario.context.trustedCheckerConfigDigest,
        );
        assertEquals(row.policy_digest, expectedPolicy);
        assertEquals(
          row.subject_digest,
          await sha256Hex(canonicalJson({
            command: { id: command.id, argv: command.argv },
            ruleEntryDigest: null,
          })),
        );
        assertEquals(row.evidence_version_id, evidence[index]!.versionId);
        assertEquals(row.output_digest, evidence[index]!.sha256);
        assertEquals(row.title_digest, null);
        assertEquals(row.body_digest, null);
      }
      assertEquals(
        rows.map((row) => [row.result, row.reason, row.exit_code]),
        [["passed", "verified", 0], ["failed", "exit_nonzero", 1], [
          "passed",
          "verified",
          0,
        ]],
      );
      // A failed warn command does not block: the verdict the worker echoed is
      // the one the server derived, and it is what the step stored.
      assertEquals(report.allRequired, true);
      const after = await scenario.state();
      assertEquals(after.step.status, "completed");
      assertEquals(after.step.output, report);
      assertEquals(after.job.status, "completed");
      assertNotEquals(after.step.output, before.step.output);
      assertEquals(await scenario.audits(), 1);
      assertEquals(await scenario.deniedAudits(), []);
    });
  });

  Deno.test("a replayed valid result answers 200 again without recording twice, and a different payload at that sequence is refused", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report } = await scenario.honest({ lint: "fail" });
      const key = crypto.randomUUID();
      const first = await scenario.post(report, key);
      assertEquals(first.status, 200, await first.clone().text());
      assertEquals(first.headers.get("Idempotent-Replayed"), null);
      const ack = await first.text();
      const rows = await scenario.rows();
      const stored = await scenario.state();
      assertEquals(rows.length, 3);
      assertEquals(await scenario.audits(), 1);

      // The same request again is the worker retrying after a lost response:
      // the saved acknowledgement comes back and nothing is written twice.
      const replay = await scenario.post(report, key);
      assertEquals(replay.status, 200, await replay.clone().text());
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(await replay.text(), ack);
      assertEquals(await scenario.rows(), rows);
      assertEquals(await scenario.audits(), 1);
      assertEquals(await scenario.deniedAudits(), []);
      assertEquals(await scenario.state(), stored);

      // A different payload at the same sequence is a conflicting retry,
      // whether it reuses the key or brings a new one.
      const changed = { ...report, allRequired: !report.allRequired };
      for (const retryKey of [key, crypto.randomUUID()]) {
        const conflict = await scenario.post(changed, retryKey);
        assertEquals(conflict.status, 422);
        assertEquals(
          await problemCode(conflict),
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
        );
      }
      assertEquals(await scenario.rows(), rows);
      assertEquals(await scenario.audits(), 1);
      assertEquals(await scenario.deniedAudits(), []);
      assertEquals(await scenario.state(), stored);
    });
  });

  Deno.test("a failed required command is recorded as failed and the stored verdict names its row", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report } = await scenario.honest({ unit: "fail" });
      assertEquals(report.allRequired, false);
      assertEquals(report.failedCheckIds, [report.observations[0]!.checkRunId]);
      assertEquals((await scenario.post(report)).status, 200);
      const rows = await scenario.rows();
      assertEquals(rows[0]!.result, "failed");
      assertEquals((await scenario.state()).step.output, report);
    });
  });

  Deno.test("failed and unavailable outcomes stay distinct, with their reasons, and a bound rule is recorded with the command", async () => {
    await withCheckFixture(async (fixture) => {
      const rules = [magicRuleEntry("code.magicNumbers", "magic.numbers")];
      const scenario = await seedCheckScenario(fixture, {
        commands: MAGIC_COMMANDS,
        rules,
      });
      assertEquals(
        scenario.pins.commands.map((pin) => pin.ruleKey),
        [null, null, null, "code.magicNumbers"],
      );
      const { report } = await scenario.honest({
        unit: "signal",
        lint: "deadline",
        format: "tool_missing",
        "magic.numbers": "unsupported_checker",
      });
      assertEquals((await scenario.post(report)).status, 200);
      const rows = await scenario.rows();
      assertEquals(
        rows.map((
          row,
        ) => [row.check_id, row.result, row.reason, row.exit_code]),
        [
          ["unit", "failed", "signal", null],
          ["lint", "failed", "deadline", null],
          ["format", "unavailable", "tool_missing", null],
          ["magic.numbers", "unavailable", "unsupported_checker", null],
        ],
      );
      assertEquals(rows[3]!.rule_key, "code.magicNumbers");
      assertEquals(rows[2]!.duration_ms, 0);
      // The pinned entries are part of the policy digest, so a rule-bound run
      // records a different policy than a run without rules.
      const plain = await seedCheckScenario(fixture, {
        commands: MAGIC_COMMANDS,
      });
      assertNotEquals(plain.pins.policyDigest, scenario.pins.policyDigest);
      assertNotEquals(
        plain.pins.commands[3]!.subjectDigest,
        scenario.pins.commands[3]!.subjectDigest,
      );
      assertEquals(
        scenario.pins.commands.slice(0, 3).map((pin) => pin.subjectDigest),
        plain.pins.commands.slice(0, 3).map((pin) => pin.subjectDigest),
      );
    });
  });

  Deno.test("a command the worker skipped is recorded unavailable with reason skipped, never failed", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      // The required command was skipped: the delivery stays blocked.
      const { report } = await scenario.honest({
        unit: "skipped",
        lint: "skipped",
        format: "pass",
      });
      assertEquals(report.allRequired, false);
      assertEquals(report.failedCheckIds, [report.checkRunIds[0]]);
      const response = await scenario.post(report);
      assertEquals(response.status, 200, await response.clone().text());
      const rows = await scenario.rows();
      assertEquals(
        rows.map((
          row,
        ) => [
          row.check_id,
          row.result,
          row.reason,
          row.exit_code,
          row.duration_ms,
        ]),
        [
          ["unit", "unavailable", "skipped", null, 0],
          ["lint", "unavailable", "skipped", null, 0],
          ["format", "passed", "verified", 0, 40],
        ],
      );
    });
  });

  Deno.test("two enabled rules bound to one command record it unavailable as an ambiguous binding with no rule key", async () => {
    await withCheckFixture(async (fixture) => {
      const commands: CheckCommand[] = [
        { id: "unit", argv: ["pnpm", "test:unit"], mode: "require" },
        { id: "magic.shared", argv: ["deno", "lint"], mode: "require" },
      ];
      const rules = [
        magicRuleEntry("code.magicNumbers", "magic.shared"),
        magicRuleEntry("code.magicStrings", "magic.shared"),
      ];
      const scenario = await seedCheckScenario(fixture, { commands, rules });
      const pin = scenario.pins.commands[1]!;
      assertEquals([pin.ruleKey, pin.ambiguous], [null, true]);
      const entries = await effectiveEntries(rules);
      assertEquals(boundRuleEntries(entries, "magic.shared").length, 2);
      const { report } = await scenario.honest({ "magic.shared": "ambiguous" });
      assertEquals(report.allRequired, false);
      assertEquals((await scenario.post(report)).status, 200);
      const row = (await scenario.rows())[1]!;
      assertEquals(
        [row.result, row.reason, row.rule_key],
        ["unavailable", "rule_binding_ambiguous", null],
      );
    });
  });

  Deno.test("an unreachable revision is recorded for every command, one with two bound rules included, and blocks the verdict", async () => {
    await withCheckFixture(async (fixture) => {
      const commands: CheckCommand[] = [
        { id: "unit", argv: ["pnpm", "test:unit"], mode: "require" },
        { id: "magic.shared", argv: ["deno", "lint"], mode: "require" },
      ];
      const rules = [
        magicRuleEntry("code.magicNumbers", "magic.shared"),
        magicRuleEntry("code.magicStrings", "magic.shared"),
      ];
      const scenario = await seedCheckScenario(fixture, { commands, rules });
      const { report } = await scenario.honest({
        unit: "revision_unavailable",
        "magic.shared": "revision_unavailable",
      });
      assertEquals(report.allRequired, false);
      const response = await scenario.post(report);
      assertEquals(response.status, 200, await response.clone().text());
      assertEquals(
        (await scenario.rows()).map((
          row,
        ) => [row.check_id, row.result, row.reason, row.rule_key]),
        [
          ["unit", "unavailable", "revision_unavailable", null],
          ["magic.shared", "unavailable", "revision_unavailable", null],
        ],
      );
    });
  });

  Deno.test("recorded rows are readable only inside their organization and run", async () => {
    await withCheckFixture(async (fixture) => {
      const first = await seedCheckScenario(fixture);
      const second = await seedCheckScenario(fixture);
      assertEquals(
        (await first.post((await first.honest()).report)).status,
        200,
      );
      assertEquals(
        (await second.post((await second.honest({ unit: "fail" })).report))
          .status,
        200,
      );
      // The same administrator owns a second organization; membership of both
      // organizations must not let one organization read the other's rows.
      const foreign = await createWorkerScope(
        fixture,
        "b1002-foreign",
        fixture,
      );
      try {
        const list = async (runId: string, scope: WorkerScope = fixture) =>
          await adminRequest(fixture, `/v1/runs/${runId}/checks`, undefined, {
            method: "GET",
            scope,
          });
        const own = await list(first.job.runId);
        assertEquals(own.status, 200);
        const body = await own.json() as { items: Array<{ id: string }> };
        assertEquals(
          body.items.map((item) => item.id).sort(),
          (await first.rows()).map((row) => row.id).sort(),
        );
        // Another run of the same organization shows only its own rows.
        const other = await (await list(second.job.runId)).json() as {
          items: Array<{ id: string; result: string }>;
        };
        assertEquals(other.items.length, 3);
        assert(
          other.items.every((item) =>
            !body.items.some((mine) => mine.id === item.id)
          ),
        );
        assertEquals(
          other.items.filter((item) => item.result === "failed").length,
          1,
        );
        // The run belongs to the first organization only: asked for in the
        // second one it does not exist, whoever asks.
        for (const response of [await list(first.job.runId, foreign)]) {
          assertEquals(response.status, 404);
          assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND");
        }
        assertEquals(
          await organizationCheckRunCount(fixture, foreign.organizationId),
          0,
        );
      } finally {
        await closeWorkerScope(fixture, foreign);
      }
    });
  });

  Deno.test("the pins the finalizer derives equal an independent derivation of the stored job", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const pins = await deriveCheckPins({
        repositoryId: scenario.context.repositoryId,
        revision: HEAD_SHA,
        checks: ["unit", "format"],
        repositoryProfile: scenario.context,
      });
      assertEquals(pins.checks, ["unit", "format"]);
      assertEquals(pins.commands.map((pin) => pin.mode), ["require", "guide"]);
      assertEquals(pins.profileDigest, scenario.context.digest);
      assertEquals(pins.headSha, HEAD_SHA);
      assertEquals(pins.baseSha, BASE_SHA);
    });
  });
}
