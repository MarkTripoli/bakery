import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import {
  findingFingerprint,
  REVIEW_LOOP_LIMITS,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  createReviewerExecutor,
  REVIEW_ACTION,
  REVIEWER_CHECK_ID,
  REVIEWER_FAULTS,
  type ReviewerLimits,
} from "../../../apps/worker/src/reviewer.ts";
import { gitText } from "../harness.ts";
import { SYNTHETIC_CLAUDE_CREDENTIALS } from "../harness-auth.ts";
import {
  extraWorktrees,
  survives,
  waitFor,
} from "../deterministic-checks/runner-fixture.ts";
import {
  type CandidatePrepare,
  completed,
  disposeRig,
  fakeClaude,
  faultOf,
  initLine,
  leftoverReviews,
  legacyProfile,
  resultLine,
  reviewAssignment,
  reviewerOver,
  type ReviewerRig,
  reviewerRig,
  reviewProfile,
} from "./worker-fixtures.ts";

/**
 * Cases for the worker `review.independent` executor (issue #94), run against
 * fake `claude` executables that replay recorded stream shapes. They prove the
 * worker's own behavior: argv, worktree, parsing, trimming, faults and
 * cleanup. They cannot prove what the real CLI or a real model does.
 */

const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

export function reviewerTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name: `reviewer: ${name}`, ...SANITIZERS, fn });
}

export type ModelFinding = {
  severity: string;
  category: string;
  title: string;
  path: string;
  line: number | null;
  detail: string;
};

export function modelFinding(
  overrides: Partial<ModelFinding> = {},
): ModelFinding {
  return {
    severity: "major",
    category: "correctness",
    title: "Retry loop never stops",
    path: "src/feature.ts",
    line: 1,
    detail: "The loop keeps retrying when the provider keeps failing.",
    ...overrides,
  };
}

export function answer(
  findings: readonly unknown[],
  extra: Record<string, unknown> = {},
): string[] {
  return [
    initLine(),
    resultLine({
      result: "I read the diff and the files.",
      structured_output: { findings },
      ...extra,
    }),
  ];
}

/** Runs one review over a fresh rig and always disposes the rig. */
export async function withReview<T>(
  stream: readonly string[],
  run: (context: {
    rig: ReviewerRig;
    fake: Awaited<ReturnType<typeof fakeClaude>>;
    review: ReturnType<typeof reviewerOver>;
  }) => Promise<T>,
  options: {
    middle?: string;
    exitCode?: number;
    files?: Record<string, string>;
    prepare?: CandidatePrepare;
    /** Overrides of the reviewer's code-owned limits. */
    limits?: Partial<ReviewerLimits>;
    /** Base commit the profile pins instead of the repository's own base. */
    baseSha?: string;
  } = {},
): Promise<T> {
  const rig = await reviewerRig(
    options.files,
    options.prepare,
    options.baseSha,
  );
  try {
    const fake = await fakeClaude(rig.repository.aux, stream, options);
    return await run({
      rig,
      fake,
      review: reviewerOver(
        rig,
        fake.executable,
        options.limits === undefined ? {} : { limits: options.limits },
      ),
    });
  } finally {
    await disposeRig(rig);
  }
}

export async function assertCleanedUp(rig: ReviewerRig): Promise<void> {
  assertEquals(await leftoverReviews(rig.stateDir), [], "attempt root left");
  assertEquals(
    await extraWorktrees(rig.repository.dir),
    [],
    "worktree record left",
  );
  assertEquals(
    await gitText(rig.repository.dir, ["status", "--porcelain"]),
    "",
    "the operator repository was touched",
  );
  assertEquals(
    await gitText(rig.repository.dir, ["rev-parse", "HEAD"]),
    rig.repository.revision,
  );
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function registerWorkerReviewerCases(): void {
  reviewerTest(
    "a valid answer becomes a ReviewOutput bound to the job and the assigned session",
    () =>
      withReview(
        answer([
          modelFinding({
            severity: "minor",
            title: "Naming",
            category: "style",
          }),
          modelFinding(),
          modelFinding({
            severity: "note",
            title: "Doc",
            category: "docs",
            line: null,
          }),
        ]),
        async ({ rig, fake, review }) => {
          const assignment = reviewAssignment(rig.repository, rig.profile);
          const outcome = await review.execute(
            assignment,
            new AbortController().signal,
          );
          const report = workerActionOutputSchema(REVIEW_ACTION).parse(
            completed(outcome),
          ) as Record<string, unknown>;
          // Identity comes from the job, never from the CLI or the model.
          assertEquals(report.sessionId, assignment.agentSessionId);
          assert(!JSON.stringify(report).includes("0000000000a1"));
          assertEquals(report.headSha, rig.repository.revision);
          assertEquals(report.baseSha, rig.profile.baseSha);
          assertEquals(report.policyDigest, rig.profile.policyDigest);
          const findings = report.findings as Array<Record<string, unknown>>;
          assertEquals(findings.map((f) => f.severity), [
            "major",
            "minor",
            "note",
          ]);
          assertEquals(findings.map((f) => f.blocking), [true, false, false]);
          assertEquals(report.blockingFindings, 1);
          assertEquals(
            findings[0].fingerprint,
            await findingFingerprint({
              path: "src/feature.ts",
              category: "correctness",
              title: "Retry loop never stops",
            }),
          );
          for (const f of findings) {
            assert(/^[0-9a-f]{64}$/.test(f.fingerprint as string));
          }
          assertEquals(review.inner.calls, []);
          await assertCleanedUp(rig);
          assert(await exists(fake.ranPath));
        },
      ),
  );

  reviewerTest(
    "the CLI runs read-only in a detached worktree at the revision with an isolated config",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const assignment = reviewAssignment(rig.repository, rig.profile);
        const outcome = await review.execute(
          assignment,
          new AbortController().signal,
        );
        assertEquals(completed(outcome).findings, []);
        // The worktree: a fresh directory under the reviews root, at the revision.
        const cwd = (await Deno.readTextFile(fake.cwdPath)).trim();
        assertEquals(
          cwd,
          join(
            rig.stateDir,
            "reviews",
            assignment.attemptId,
            "worktree",
          ),
        );
        assertEquals(
          (await Deno.readTextFile(fake.headPath)).trim(),
          rig.repository.revision,
        );
        // HOME and the config directory live inside the attempt root.
        const root = join(rig.stateDir, "reviews", assignment.attemptId);
        assertEquals(
          (await Deno.readTextFile(fake.homePath)).trim(),
          join(root, "home"),
        );
        assertEquals(
          (await Deno.readTextFile(fake.configPath)).trim(),
          join(root, "config"),
        );
        assertEquals(
          (await Deno.readTextFile(fake.configListPath)).trim(),
          ".credentials.json",
        );
        // The hardened, read-only argv.
        const args = (await Deno.readTextFile(fake.argsPath)).split("\n");
        for (
          const required of [
            "-p",
            "--restricted",
            "--strict-mcp-config",
            "--verbose",
          ]
        ) assert(args.includes(required), required);
        const after = (flag: string) => args[args.indexOf(flag) + 1];
        assertEquals(after("--output-format"), "stream-json");
        assertEquals(after("--tools"), "Read,Glob,Grep");
        assertEquals(after("--allowedTools"), "Read,Glob,Grep");
        assertEquals(after("--permission-prompts"), "none");
        assertEquals(after("--model"), "claude-opus-5-5");
        const schema = JSON.parse(after("--json-schema"));
        assert(schema.properties.findings);
        assertEquals(schema.additionalProperties, false);
        assertFalse(args.includes("--add-dir"));
        assertFalse(args.includes("--resume"));
        for (const forbidden of ["Edit", "Write", "Bash"]) {
          assertFalse(args.join(" ").includes(forbidden), forbidden);
        }
        // The credential copy is denied to the model's file tools.
        const rest = args.slice(args.indexOf("--disallowedTools") + 1);
        const denied = rest.slice(
          0,
          rest.findIndex((arg) => arg.startsWith("--")),
        );
        assertEquals(denied.map((rule) => rule.split("(")[0]), [
          "Read",
          "Glob",
          "Grep",
        ]);
        assert(denied.every((rule) => rule.includes("/config/**)")));
        assert(denied.every((rule) => rule.includes("(//")));
        await assertCleanedUp(rig);
      }),
  );

  reviewerTest(
    "the prompt carries the diff from the base to the revision, the evidence ids and no credential",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const evidence = [crypto.randomUUID(), crypto.randomUUID()];
        await review.execute(
          reviewAssignment(rig.repository, rig.profile, {}, { evidence }),
          new AbortController().signal,
        );
        const prompt = await Deno.readTextFile(fake.promptPath);
        assertStringIncludes(prompt, rig.repository.baseSha);
        assertStringIncludes(prompt, rig.repository.revision);
        assertStringIncludes(prompt, "+export const feature = () => 42;");
        assertStringIncludes(prompt, "src/feature.ts");
        for (const id of evidence) assertStringIncludes(prompt, id);
        assertStringIncludes(prompt, "untrusted");
        assertFalse(prompt.includes("SYNTHETIC-access"));
        const args = await Deno.readTextFile(fake.argsPath);
        assertFalse(args.includes("SYNTHETIC-access"));
        assertFalse(args.includes(prompt.slice(0, 40)));
      }),
  );

  reviewerTest(
    "a diff past the size cap is cut and the prompt says so",
    () =>
      withReview(
        answer([]),
        async ({ rig, fake, review }) => {
          const outcome = await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          );
          assertEquals(completed(outcome).findings, []);
          const prompt = await Deno.readTextFile(fake.promptPath);
          assertStringIncludes(prompt, "cut at the size limit");
          assertStringIncludes(prompt, '"diffTruncated": true');
          assert(prompt.length < 200_000, `prompt is ${prompt.length}`);
        },
        { files: { "big.txt": "x".repeat(400_000) + "\n" } },
      ),
  );

  reviewerTest(
    "a candidate with no change against the base reviews as empty",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const outcome = await review.execute(
          reviewAssignment(rig.repository, rig.profile, {}, {
            revision: rig.repository.baseSha,
          }),
          new AbortController().signal,
        );
        assertEquals(completed(outcome).headSha, rig.repository.baseSha);
        assertStringIncludes(
          await Deno.readTextFile(fake.promptPath),
          "no changes against the base commit",
        );
      }),
  );

  reviewerTest(
    "duplicate fingerprints collapse to the most severe finding and paths lose a leading ./",
    () =>
      withReview(
        answer([
          modelFinding({ severity: "minor", path: "./src/feature.ts" }),
          modelFinding({
            severity: "blocker",
            title: "  retry   LOOP never stops ",
            category: "Correctness",
            line: 7,
          }),
          modelFinding({ severity: "note", path: "src/feature.ts" }),
        ]),
        async ({ rig, review }) => {
          const report = completed(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          const findings = report.findings as Array<Record<string, unknown>>;
          assertEquals(findings.length, 1);
          assertEquals(findings[0].severity, "blocker");
          assertEquals(findings[0].blocking, true);
          assertEquals(findings[0].line, 7);
          assertEquals(findings[0].path, "src/feature.ts");
          assertEquals(report.blockingFindings, 1);
        },
      ),
  );

  reviewerTest(
    "prose in the result text does not matter when structured output is present",
    () =>
      withReview(
        [
          initLine(),
          resultLine({
            result: `Here is my review:\n${
              JSON.stringify({ findings: [modelFinding({ severity: "note" })] })
            }\nHope that helps!`,
            structured_output: { findings: [modelFinding()] },
          }),
        ],
        async ({ rig, review }) => {
          const report = completed(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          // Only the structured object counts, never the prose around any JSON.
          assertEquals(
            (report.findings as Array<{ severity: string }>).map((f) =>
              f.severity
            ),
            ["major"],
          );
        },
      ),
  );

  reviewerTest(
    "prose around JSON with no structured output is refused, a bare fenced object is not",
    () =>
      withReview(
        [
          initLine(),
          resultLine({
            result: `Here is my review:\n${
              JSON.stringify({ findings: [modelFinding()] })
            }\nHope that helps!`,
          }),
        ],
        async ({ rig, review }) => {
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.outputInvalid);
          assertEquals(fault.retryable, false);
          await assertCleanedUp(rig);
        },
      ).then(() =>
        withReview(
          [
            initLine(),
            resultLine({
              result: "```json\n" +
                JSON.stringify({ findings: [modelFinding()] }) + "\n```",
            }),
          ],
          async ({ rig, review }) => {
            const report = completed(
              await review.execute(
                reviewAssignment(rig.repository, rig.profile),
                new AbortController().signal,
              ),
            );
            assertEquals((report.findings as unknown[]).length, 1);
          },
        )
      ),
  );

  reviewerTest(
    "a reviewer that writes into the worktree faults REVIEWER_WROTE_FILES",
    async () => {
      for (
        const middle of [
          "echo drift > injected.txt",
          "echo drift >> notes.txt",
          "mkdir -p src && echo x > src/extra.ts",
        ]
      ) {
        await withReview(
          answer([modelFinding()]),
          async ({ rig, review }) => {
            const fault = faultOf(
              await review.execute(
                reviewAssignment(rig.repository, rig.profile),
                new AbortController().signal,
              ),
            );
            assertEquals(fault.code, REVIEWER_FAULTS.wroteFiles, middle);
            assertEquals(fault.retryable, false);
            await assertCleanedUp(rig);
          },
          { middle },
        );
      }
    },
  );

  reviewerTest(
    "findings past the caps are trimmed by the shared rule and the report still validates",
    () =>
      withReview(
        answer([
          ...Array.from({ length: 20 }, (_, index) =>
            modelFinding({
              severity: "blocker",
              title: `Blocker ${index}`,
              detail: "b".repeat(500),
            })),
          ...Array.from({ length: 60 }, (_, index) =>
            modelFinding({
              severity: index % 2 === 0 ? "minor" : "note",
              title: `Advisory ${index}`,
              detail: "n".repeat(500),
            })),
        ]),
        async ({ rig, review }) => {
          const report = completed(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          workerActionOutputSchema(REVIEW_ACTION).parse(report);
          const findings = report.findings as Array<
            { severity: string; blocking: boolean }
          >;
          assert(findings.length <= REVIEW_LOOP_LIMITS.maxFindings);
          assert(
            serializedBytes(report) <= REVIEW_LOOP_LIMITS.resultByteBudget,
            `report is ${serializedBytes(report)} bytes`,
          );
          // No blocker is ever dropped; advisory findings absorb the trimming.
          assertEquals(findings.filter((f) => f.blocking).length, 20);
          assertEquals(report.blockingFindings, 20);
          assertEquals(
            findings.slice(0, 20).every((f) => f.severity === "blocker"),
            true,
          );
        },
      ),
  );

  reviewerTest(
    "more blocking findings than a report may carry fault REVIEWER_FINDINGS_LIMIT",
    () =>
      withReview(
        answer(
          Array.from(
            { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
            (_, index) =>
              modelFinding({ severity: "blocker", title: `Blocker ${index}` }),
          ),
        ),
        async ({ rig, review }) => {
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.findingsLimit);
          assertEquals(fault.retryable, false);
          await assertCleanedUp(rig);
        },
      ),
  );

  reviewerTest(
    "an answer past the model cap or off the schema faults REVIEWER_OUTPUT_INVALID",
    async () => {
      const tooMany = Array.from(
        { length: 101 },
        (_, index) =>
          modelFinding({ severity: "note", title: `Note ${index}` }),
      );
      const cases: Record<string, readonly string[]> = {
        "more than 100 findings": answer(tooMany),
        "unknown severity": answer([modelFinding({ severity: "critical" })]),
        "detail past 500 characters": answer([
          modelFinding({ detail: "d".repeat(501) }),
        ]),
        "empty detail": answer([modelFinding({ detail: "" })]),
        "line zero": answer([modelFinding({ line: 0 })]),
        "empty path": answer([modelFinding({ path: "" })]),
        "missing field": answer([{ severity: "major", path: "a", line: 1 }]),
        "a claimed approval beside the findings": [
          initLine(),
          resultLine({
            structured_output: { findings: [], approved: true },
          }),
        ],
        "an extra key on a finding": answer([
          { ...modelFinding(), blocking: false },
        ]),
        "findings not an array": [
          initLine(),
          resultLine({ structured_output: { findings: "none" } }),
        ],
        "no structured output": [initLine(), resultLine({})],
        "non-JSON text": [
          initLine(),
          resultLine({ result: "Looks fine to me." }),
        ],
        "no result record": [initLine()],
        "a truncated record": [initLine(), '{"type":"result","subtype":"succ'],
        "malformed JSON line": [initLine(), "{not json"],
        "two result records": [
          initLine(),
          resultLine({ structured_output: { findings: [] } }),
          resultLine({ structured_output: { findings: [] } }),
        ],
      };
      for (const [name, stream] of Object.entries(cases)) {
        await withReview(stream, async ({ rig, review }) => {
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.outputInvalid, name);
          assertEquals(fault.retryable, false, name);
          await assertCleanedUp(rig);
        });
      }
    },
  );

  reviewerTest(
    "a finding that carries a credential is never reported",
    () =>
      withReview(
        answer([
          modelFinding({
            detail:
              `Token sk-ant-oat01-SYNTHETIC-access-0123456789abcdef is in ${"src/feature.ts"}.`,
          }),
        ]),
        async ({ rig, review }) => {
          assertStringIncludes(
            SYNTHETIC_CLAUDE_CREDENTIALS,
            "SYNTHETIC-access-0123456789abcdef",
          );
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.outputInvalid);
          assertFalse(JSON.stringify(fault).includes("SYNTHETIC-access"));
        },
      ),
  );

  reviewerTest(
    "a run past its time limit is a retryable REVIEWER_UNAVAILABLE and its process group dies",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]), {
          middle: "sleep 30",
        });
        const review = reviewerOver(rig, fake.executable, {
          claude: {
            authSourceDir: rig.authDir,
            claudeExecutable: fake.executable,
            timeLimitMs: 500,
          },
        });
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          ),
        );
        assertEquals(fault.code, REVIEWER_FAULTS.unavailable);
        assertEquals(fault.retryable, true);
        assertEquals(fault.status, 503);
        const pid = (await Deno.readTextFile(fake.pidPath)).trim();
        assertFalse(await survives(pid), "the reviewer process survived");
        await assertCleanedUp(rig);
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "a missing or unreadable credential never starts the CLI",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]));
        const missing = await Deno.makeTempDir({ dir: rig.repository.aux });
        for (const authSourceDir of [missing, join(missing, "absent")]) {
          const review = reviewerOver(rig, fake.executable, {
            claude: { authSourceDir, claudeExecutable: fake.executable },
          });
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.unavailable);
          assertEquals(fault.retryable, true);
          assertEquals(fault.status, 503);
          assertFalse(JSON.stringify(fault).includes(missing));
        }
        // A symlinked credential file is not a credential.
        await Deno.symlink(
          join(rig.authDir, ".credentials.json"),
          join(missing, ".credentials.json"),
        );
        const linked = reviewerOver(rig, fake.executable, {
          claude: { authSourceDir: missing, claudeExecutable: fake.executable },
        });
        assertEquals(
          faultOf(
            await linked.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          ).code,
          REVIEWER_FAULTS.unavailable,
        );
        assertFalse(await exists(fake.ranPath), "the CLI started");
        await assertCleanedUp(rig);
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "a CLI that is not installed is a retryable REVIEWER_UNAVAILABLE",
    async () => {
      const rig = await reviewerRig();
      try {
        const review = reviewerOver(
          rig,
          join(rig.repository.aux, "no-such-claude"),
        );
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile),
            new AbortController().signal,
          ),
        );
        assertEquals(fault.code, REVIEWER_FAULTS.unavailable);
        assertEquals(fault.retryable, true);
        assertStringIncludes(String(fault.detail), "not runnable");
        await assertCleanedUp(rig);
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "quota, a credential rejection and a failed run are retryable REVIEWER_UNAVAILABLE",
    async () => {
      const failure = (extra: Record<string, unknown>) =>
        resultLine({
          subtype: "error_during_execution",
          is_error: true,
          ...extra,
        });
      const cases: Record<
        string,
        { stream: string[]; exitCode: number; detail: string }
      > = {
        quota: {
          stream: [
            initLine(),
            JSON.stringify({
              type: "rate_limit_event",
              rate_limit_info: {
                status: "rejected",
                rateLimitType: "five_hour",
              },
            }),
            failure({}),
          ],
          exitCode: 1,
          detail: "quota",
        },
        "quota with a zero exit": {
          stream: [
            initLine(),
            JSON.stringify({ type: "assistant", error: "rate_limit" }),
            failure({}),
          ],
          exitCode: 0,
          detail: "quota",
        },
        credentials: {
          stream: [
            initLine(),
            failure({ result: "Not logged in. Please run /login" }),
          ],
          exitCode: 1,
          detail: "credentials",
        },
        "a failed run": {
          stream: [initLine(), failure({ result: "internal error" })],
          exitCode: 1,
          detail: "failure result",
        },
        "a nonzero exit with no stream": {
          stream: [],
          exitCode: 2,
          detail: "exited with code 2",
        },
      };
      for (const [name, spec] of Object.entries(cases)) {
        await withReview(spec.stream, async ({ rig, review }) => {
          const fault = faultOf(
            await review.execute(
              reviewAssignment(rig.repository, rig.profile),
              new AbortController().signal,
            ),
          );
          assertEquals(fault.code, REVIEWER_FAULTS.unavailable, name);
          assertEquals(fault.retryable, true, name);
          assertStringIncludes(String(fault.detail), spec.detail);
          await assertCleanedUp(rig);
        }, { exitCode: spec.exitCode });
      }
    },
  );

  reviewerTest(
    "an unreachable revision faults before any model starts",
    () =>
      withReview(answer([]), async ({ rig, fake, review }) => {
        const fault = faultOf(
          await review.execute(
            reviewAssignment(rig.repository, rig.profile, {}, {
              revision: "f".repeat(40),
            }),
            new AbortController().signal,
          ),
        );
        assertEquals(fault.code, REVIEWER_FAULTS.revisionUnavailable);
        assertEquals(fault.retryable, false);
        assertFalse(await exists(fake.ranPath));
        await assertCleanedUp(rig);
      }),
  );

  reviewerTest(
    "input the reviewer cannot trust is refused before any model starts",
    async () => {
      await withReview(answer([]), async ({ rig, fake, review }) => {
        const signal = new AbortController().signal;
        const refused = async (
          assignment: ReturnType<typeof reviewAssignment>,
          code: string,
        ) => {
          const fault = faultOf(await review.execute(assignment, signal));
          assertEquals(fault.code, code);
          assertEquals(fault.retryable, false);
        };
        // No server-created session to report under.
        await refused(
          reviewAssignment(rig.repository, rig.profile, {
            agentSessionId: undefined,
          }),
          REVIEWER_FAULTS.inputInvalid,
        );
        // A review never resumes anything.
        await refused(
          reviewAssignment(rig.repository, rig.profile, {
            currentCheckpoints: [{ nativeSessionId: crypto.randomUUID() }],
          } as never),
          REVIEWER_FAULTS.inputInvalid,
        );
        // The revision is a full lowercase SHA; git never sees an option or a name.
        for (
          const revision of [
            `--output=${rig.repository.aux}/injected${"x".repeat(8)}`.slice(
              0,
              40,
            ),
            "HEAD".padEnd(40, "0"),
            rig.repository.revision.toUpperCase(),
          ]
        ) {
          assertEquals(revision.length, 40);
          await refused(
            reviewAssignment(rig.repository, rig.profile, {}, { revision }),
            REVIEWER_FAULTS.inputInvalid,
          );
        }
        assertFalse(await exists(`${rig.repository.aux}/injected`));
        // An implement-shaped or empty-evidence input is not a review input.
        await refused(
          reviewAssignment(rig.repository, rig.profile, {}, { evidence: [] }),
          REVIEWER_FAULTS.inputInvalid,
        );
        await refused(
          reviewAssignment(rig.repository, rig.profile, {}, {
            revision: "HEAD",
          }),
          REVIEWER_FAULTS.inputInvalid,
        );
        await refused(
          reviewAssignment(rig.repository, rig.profile, {}, {
            planArtifact: crypto.randomUUID(),
          }),
          REVIEWER_FAULTS.inputInvalid,
        );
        // No fixed policy and pinned base to judge the candidate against.
        await refused(
          reviewAssignment(rig.repository, await legacyProfile()),
          REVIEWER_FAULTS.policyMissing,
        );
        assertFalse(await exists(fake.ranPath));
        // A profile that does not allow review evidence is rejected outright.
        const noReview = await reviewProfile({
          baseSha: rig.repository.baseSha,
          allowedEffects: ["repository_revision", "evidence_only"],
        });
        await assertRejects(
          () =>
            review.execute(
              reviewAssignment(rig.repository, noReview),
              signal,
            ),
          Error,
          "FIXED_REPOSITORY_POLICY_REJECTED",
        );
        // The reviewer runs no skills.
        await assertRejects(
          async () =>
            await review.execute(
              reviewAssignment(rig.repository, rig.profile, {
                skillRefs: [{ skillId: crypto.randomUUID() }],
              } as never),
              signal,
            ),
          Error,
          "PREPARED_SKILL_ROOTS_UNSUPPORTED:review.independent",
        );
        assertFalse(await exists(fake.ranPath));
        await assertCleanedUp(rig);
      });
    },
  );

  reviewerTest(
    "cancellation stops the CLI and removes the worktree and attempt root",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]), {
          middle: "sleep 30",
        });
        const review = reviewerOver(rig, fake.executable);
        const controller = new AbortController();
        const running = review.execute(
          reviewAssignment(rig.repository, rig.profile),
          controller.signal,
        );
        await waitFor(() => exists(fake.pidPath), "the reviewer to start");
        controller.abort();
        const outcome = await running;
        assertEquals(outcome.status, "canceled");
        const pid = (await Deno.readTextFile(fake.pidPath)).trim();
        assertFalse(await survives(pid), "the reviewer process survived");
        await assertCleanedUp(rig);
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "other actions go to the wrapped executor and the reviewer is advertised",
    () =>
      withReview(answer([]), async ({ rig, review }) => {
        assertEquals(review.supportedActions, [
          "harness.implement",
          "review.independent",
        ]);
        const outcome = await review.execute(
          reviewAssignment(rig.repository, rig.profile, {
            action: "harness.implement",
          }),
          new AbortController().signal,
        );
        assertEquals(outcome.status, "completed");
        assertEquals(review.inner.calls, ["harness.implement"]);
        assertEquals(
          await review.credentialRedactionSecrets!(
            reviewAssignment(rig.repository, rig.profile, {
              action: "harness.implement",
            }),
          ),
          [],
        );
        // The review's own redaction secrets are the credential file's tokens.
        const secrets = await review.credentialRedactionSecrets!(
          reviewAssignment(rig.repository, rig.profile),
        );
        assert(secrets.some((secret) => secret.includes("SYNTHETIC-access")));
      }),
  );

  reviewerTest(
    "readiness reports capability:reviewer from the credential file and a runnable CLI",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]));
        const options = { limits: { readinessOkMs: 0, readinessFailMs: 0 } };
        const ready = await reviewerOver(rig, fake.executable, options)
          .readinessChecks!();
        assertEquals(ready.length, 1);
        assertEquals(ready[0].checkId, REVIEWER_CHECK_ID);
        assertEquals(ready[0].status, "pass");
        assertEquals(ready[0].reason, undefined);
        assert(Number.isFinite(Date.parse(ready[0].observedAt)));

        const noCredential = await reviewerOver(rig, fake.executable, {
          ...options,
          claude: {
            authSourceDir: join(rig.repository.aux, "absent"),
            claudeExecutable: fake.executable,
          },
        }).readinessChecks!();
        assertEquals(noCredential[0].status, "fail");
        assertFalse(
          (noCredential[0].reason ?? "").includes(rig.repository.aux),
        );

        const noCli = await reviewerOver(
          rig,
          join(rig.repository.aux, "no-such-claude"),
          options,
        ).readinessChecks!();
        assertEquals(noCli[0].status, "fail");
        assertStringIncludes(noCli[0].reason ?? "", "CLI");
        assertFalse((noCli[0].reason ?? "").includes(rig.repository.aux));
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "readiness keeps the CLI probe for a while and delegates the wrapped checks",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]));
        const inner = {
          supportedActions: ["harness.implement"],
          execute: () => Promise.reject(new Error("UNUSED")),
          readinessChecks: () =>
            Promise.resolve([{
              checkId: "capability:model",
              checkVersion: "1",
              status: "pass" as const,
              observedAt: new Date().toISOString(),
            }, {
              checkId: REVIEWER_CHECK_ID,
              checkVersion: "stale",
              status: "pass" as const,
              observedAt: new Date().toISOString(),
            }]),
        };
        const review = createReviewerExecutor({
          inner,
          repository: rig.repository.dir,
          stateDir: rig.stateDir,
          claude: {
            authSourceDir: rig.authDir,
            claudeExecutable: fake.executable,
          },
        });
        const first = await review.readinessChecks!();
        assertEquals(first.map((c) => c.checkId), [
          "capability:model",
          REVIEWER_CHECK_ID,
        ]);
        assertEquals(first[1].checkVersion, "reviewer-1");
        // The CLI vanishes, but the probe answer is still fresh: no new process.
        await Deno.remove(fake.executable);
        assertEquals((await review.readinessChecks!())[1].status, "pass");
        // The credential file is read every time.
        await Deno.remove(join(rig.authDir, ".credentials.json"));
        assertEquals((await review.readinessChecks!())[1].status, "fail");
      } finally {
        await disposeRig(rig);
      }
    },
  );

  reviewerTest(
    "startup removes attempt roots and worktree records a crashed worker left",
    async () => {
      const rig = await reviewerRig();
      try {
        const fake = await fakeClaude(rig.repository.aux, answer([]));
        const stale = join(rig.stateDir, "reviews", crypto.randomUUID());
        await Deno.mkdir(join(stale, "locked"), { recursive: true });
        await Deno.chmod(join(stale, "locked"), 0o000);
        const review = reviewerOver(rig, fake.executable);
        await review.initialize!();
        assertEquals(await leftoverReviews(rig.stateDir), []);
      } finally {
        await disposeRig(rig);
      }
    },
  );
}
