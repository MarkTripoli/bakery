import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  findingFingerprint,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_LOOP_LIMITS,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  parseReviewReport,
  verifyReviewReport,
} from "../../../apps/server/src/modules/delivery/review-report.ts";
import { REVIEWER_FAULTS } from "../../../apps/worker/src/reviewer.ts";
import {
  assembleReviewReport,
  REVIEW_LINE_MAX,
  type ReviewerFinding,
  ReviewerModelOutputSchema,
} from "../../../apps/worker/src/review-report.ts";
import { createScriptedHarnessExecutor } from "../../../apps/worker/src/scripted-harness.ts";
import { recordingPublisher } from "../deterministic-checks/runner-fixture.ts";
import {
  answer,
  assertCleanedUp,
  exists,
  modelFinding,
  withReview,
} from "./worker-reviewer-cases.ts";
import {
  candidateRepository,
  completed,
  disposeRepository,
  faultOf,
  recordingInner,
  reviewAssignment,
  reviewProfile,
} from "./worker-fixtures.ts";

/**
 * Cases for the report the worker builds from a reviewer model's answer (issue
 * #94, review of Phase 5 finding F1). The server verifier is the rule: every
 * report the worker sends, for any answer a model can give, must pass
 * `verifyReviewReport`, hold no text Postgres `jsonb` would refuse, and never
 * lose a finding to a rule it breaks. Each case runs the finished report
 * through the server's own `parseReviewReport` and `verifyReviewReport`.
 */

const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

function reportTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({ name: `report: ${name}`, ...SANITIZERS, fn });
}

type Pins = {
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
};

/** The sub-reason the server refuses a report for, or null when it accepts it. */
function serverRefusal(report: unknown, pins: Pins): string | null {
  try {
    verifyReviewReport(parseReviewReport(report), pins, {
      maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
      resultByteBudget: REVIEW_LOOP_LIMITS.resultByteBudget,
    });
    return null;
  } catch (error) {
    assert(error instanceof StandardError, String(error));
    return String(error.params?.subReason);
  }
}

/** What a `jsonb` insert needs: every string well-formed and free of U+0000. */
function assertStorable(value: unknown, where = "report"): void {
  if (typeof value === "string") {
    assert(value.isWellFormed(), `${where} holds a lone surrogate`);
    assertFalse(value.includes("\u0000"), `${where} holds U+0000`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertStorable(item, `${where}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertStorable(item, `${where}.${key}`);
    }
  }
}

type WireFinding = {
  fingerprint: string;
  severity: string;
  blocking: boolean;
  path: string;
  line: number | null;
  detail: string;
};

function findingsOf(report: Record<string, unknown>): WireFinding[] {
  return report.findings as WireFinding[];
}

/** Accepted by the server and safe to store. */
function assertSendable(report: Record<string, unknown>, pins: Pins): void {
  assertEquals(serverRefusal(report, pins), null);
  assertStorable(report);
}

/** Runs one reviewer review over `findings` and returns its report and pins. */
async function reviewedReport(
  findings: readonly unknown[],
  check: (
    report: Record<string, unknown>,
    pins: Pins,
  ) => void | Promise<void>,
): Promise<void> {
  await withReview(answer(findings), async ({ rig, review }) => {
    const report = completed(
      await review.execute(
        reviewAssignment(rig.repository, rig.profile),
        new AbortController().signal,
      ),
    );
    const pins = {
      headSha: rig.repository.revision,
      baseSha: rig.profile.baseSha,
      policyDigest: rig.profile.policyDigest,
    };
    assertSendable(report, pins);
    await check(report, pins);
    await assertCleanedUp(rig);
  });
}

const DIRECT_IDENTITY = {
  sessionId: "00000000-0000-4000-8000-0000000000c3",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
};

/** Findings handed straight to the assembly, as an unvalidated caller could. */
function directFinding(overrides: Record<string, unknown> = {}) {
  return {
    ...modelFinding({ path: "src/feature.ts" }),
    ...overrides,
  } as unknown as ReviewerFinding;
}

/** Small deterministic generator (mulberry32) so a failing seed can be rerun. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function registerWorkerReportCases(): void {
  reportTest(
    "a line past the int4 maximum is sent as null and every other valid line is kept",
    () => {
      const lines: ReadonlyArray<readonly [number | null, number | null]> = [
        [1, 1],
        [REVIEW_LINE_MAX, REVIEW_LINE_MAX],
        [REVIEW_LINE_MAX + 1, null],
        [3_000_000_000, null],
        [Number.MAX_SAFE_INTEGER, null],
        [null, null],
      ];
      return reviewedReport(
        lines.map(([line], index) =>
          modelFinding({
            severity: "minor",
            path: `src/line-${index}.ts`,
            title: `Line case ${index}`,
            line,
          })
        ),
        (report) => {
          const findings = findingsOf(report);
          assertEquals(findings.length, lines.length);
          lines.forEach(([, expected], index) => {
            const sent = findings.find((finding) =>
              finding.path === `src/line-${index}.ts`
            );
            assertEquals(sent?.line, expected, `line case ${index}`);
          });
        },
      );
    },
  );

  reportTest(
    "a line that is not a positive integer is still refused with the whole answer",
    async () => {
      for (const line of [0, -1, 1.5, 1e300]) {
        await withReview(
          answer([modelFinding({ line })]),
          async ({ rig, review }) => {
            const fault = faultOf(
              await review.execute(
                reviewAssignment(rig.repository, rig.profile),
                new AbortController().signal,
              ),
            );
            assertEquals(fault.code, REVIEWER_FAULTS.outputInvalid, `${line}`);
            assertEquals(fault.retryable, false);
          },
        );
      }
    },
  );

  reportTest(
    "a blank path or detail, or one holding NUL, refuses the whole answer",
    async () => {
      const bad: Record<string, string> = {
        spaces: "   ",
        "other whitespace": " ﻿\t\n ",
        nul: "ab\u0000cd",
      };
      for (const field of ["path", "detail"] as const) {
        for (const [name, value] of Object.entries(bad)) {
          // A valid blocker sits beside the bad finding: the answer must fail
          // as a whole, never come back as the blocker alone or as a clean report.
          await withReview(
            answer([
              modelFinding({ severity: "blocker" }),
              modelFinding({
                severity: "minor",
                title: "The bad one",
                [field]: value,
              }),
            ]),
            async ({ rig, fake, review }) => {
              const outcome = await review.execute(
                reviewAssignment(rig.repository, rig.profile),
                new AbortController().signal,
              );
              assertEquals(outcome.status, "failed", `${field} ${name}`);
              const fault = faultOf(outcome);
              assertEquals(
                fault.code,
                REVIEWER_FAULTS.outputInvalid,
                `${field} ${name}`,
              );
              assertEquals(fault.retryable, false);
              assertEquals(fault.status, 502);
              assert(await exists(fake.ranPath), "the CLI never ran");
              await assertCleanedUp(rig);
            },
          );
        }
      }
    },
  );

  reportTest(
    "the model schema refuses every blank or NUL path and detail and keeps visible text",
    () => {
      const parse = (overrides: Record<string, unknown>) =>
        ReviewerModelOutputSchema.safeParse({
          findings: [modelFinding(overrides)],
        }).success;
      const blanks = [
        " ",
        "\t",
        "\n",
        "\r\n",
        " ",
        " ",
        "   ",
        "  ",
        " ",
        " ",
        "　",
        "﻿",
        "  ﻿\t ",
      ];
      const nuls = ["\u0000", "a\u0000", "\u0000b", "a\u0000b"];
      for (const field of ["path", "detail"]) {
        for (const text of [...blanks, ...nuls]) {
          assertFalse(
            parse({ [field]: text }),
            `${field} ${JSON.stringify(text)}`,
          );
        }
        // Visible text stays, whatever surrounds it (zero-width space is visible
        // to the server's trim() too, so both sides agree).
        for (const text of [" a ", "​", "\ud800", "日本語", "😀"]) {
          assert(parse({ [field]: text }), `${field} ${JSON.stringify(text)}`);
        }
      }
    },
  );

  reportTest(
    "lone surrogates in a path or detail are replaced before fingerprinting and storage",
    () =>
      reviewedReport(
        [
          modelFinding({
            severity: "blocker",
            path: "src/\ud800broken.ts",
            detail: "lone high \ud83d, lone low \udc00, end \ud800",
            title: "Surrogates",
          }),
          // The same issue reported with the replacement character already in
          // place is the same finding: the fingerprint is computed after the fix.
          modelFinding({
            severity: "minor",
            path: "src/\ufffdbroken.ts",
            detail: "the same issue",
            title: "Surrogates",
          }),
          modelFinding({
            severity: "note",
            path: "src/pair.ts",
            detail: "a real pair 😀 stays",
            title: "Pair",
          }),
        ],
        async (report) => {
          const findings = findingsOf(report);
          assertEquals(findings.length, 2);
          assertEquals(findings[0].path, "src/\ufffdbroken.ts");
          assertEquals(
            findings[0].detail,
            "lone high \ufffd, lone low \ufffd, end \ufffd",
          );
          assertEquals(findings[0].severity, "blocker");
          assertEquals(
            findings[0].fingerprint,
            await findingFingerprint({
              path: "src/\ufffdbroken.ts",
              category: "correctness",
              title: "Surrogates",
            }),
          );
          assertEquals(findings[1].detail, "a real pair 😀 stays");
        },
      ),
  );

  reportTest(
    "byte trimming cuts on code point boundaries and never leaves a blank detail",
    () => {
      const shapes = [
        // Starts with whitespace: cut at 120 code points it would be all blank.
        " ".repeat(125) + "😀".repeat(187),
        // A lone high surrogate exactly where the cut falls.
        "w".repeat(119) + "\ud83d" + "v".repeat(300),
        // Pairs everywhere: an odd cut in code units would split one.
        "😀".repeat(250),
      ];
      const findings = Array.from({ length: 24 }, (_, index) =>
        modelFinding({
          severity: "minor",
          title: `Trim ${index}`,
          path: `src/trim-${index}.ts`,
          detail: shapes[index % shapes.length],
        }));
      return reviewedReport(findings, (report) => {
        const sent = findingsOf(report);
        assert(sent.length > 0);
        // The budget forced a cut: at least one detail got shorter.
        assert(
          sent.some((finding) =>
            [...finding.detail].length < 250 &&
            finding.detail.trim().length > 0
          ),
          "nothing was trimmed",
        );
        for (const finding of sent) {
          assert(finding.detail.isWellFormed());
          assert(finding.detail.trim().length > 0, "blank detail");
          assertEquals(finding.detail, finding.detail.trim());
          assert(finding.detail.length <= REVIEW_FINDING_DETAIL_MAX_LENGTH);
        }
      });
    },
  );

  reportTest(
    "a path with a leading ./ or padding is normalised and still passes the server",
    () =>
      reviewedReport(
        [
          modelFinding({ path: "  ./././src/feature.ts  ", severity: "minor" }),
          modelFinding({
            path: "./",
            title: "Whole repository",
            severity: "note",
          }),
        ],
        (report) => {
          const paths = findingsOf(report).map((finding) => finding.path);
          assertEquals(paths, ["src/feature.ts", "./"]);
        },
      ),
  );

  reportTest(
    "path and detail are bounded in UTF-16 code units like the server, emoji included",
    async () => {
      const astral = (count: number, tail = "") =>
        "\u{1F600}".repeat(count) + tail;
      const parse = (overrides: Record<string, unknown>) =>
        ReviewerModelOutputSchema.safeParse({
          findings: [modelFinding(overrides)],
        }).success;
      // The model schema agrees with the server at the boundary.
      assert(parse({ path: astral(100) }), "100 emoji is 200 units");
      assertFalse(parse({ path: astral(101) }), "101 emoji is 202 units");
      assertFalse(parse({ path: astral(100, "a") }), "201 units");
      assert(parse({ path: astral(99, "ab") }), "200 units");
      assert(parse({ detail: astral(250) }), "250 emoji is 500 units");
      assertFalse(parse({ detail: astral(251) }), "251 emoji is 502 units");
      assertFalse(parse({ detail: astral(250, "a") }), "501 units");
      assert(parse({ detail: astral(249, "ab") }), "500 units");

      // At the boundary the report reaches the server whole and valid.
      await reviewedReport(
        [
          modelFinding({
            severity: "blocker",
            path: astral(100),
            detail: astral(250),
          }),
        ],
        (report) => {
          const [sent] = findingsOf(report);
          assertEquals(sent.path.length, REVIEW_FINDING_PATH_MAX_LENGTH);
          assertEquals(sent.detail.length, REVIEW_FINDING_DETAIL_MAX_LENGTH);
        },
      );

      // One unit past it, the whole answer is refused at the schema with the
      // same outcome as any other over-long text, never sent and never cut.
      for (
        const overrides of [
          { path: astral(101) },
          { detail: astral(251) },
        ]
      ) {
        await withReview(
          answer([
            modelFinding({ severity: "blocker" }),
            modelFinding({
              ...overrides,
              title: "Too long",
            }),
          ]),
          async ({ rig, review }) => {
            const fault = faultOf(
              await review.execute(
                reviewAssignment(rig.repository, rig.profile),
                new AbortController().signal,
              ),
            );
            assertEquals(fault.code, REVIEWER_FAULTS.outputInvalid);
            assertEquals(fault.retryable, false);
            assertEquals(fault.status, 502);
          },
        );
      }
    },
  );

  reportTest(
    "an assembly given unvalidated findings refuses any it cannot send and drops none",
    async () => {
      const refused: Record<string, ReviewerFinding[]> = {
        "a blank path": [directFinding({ path: "   " })],
        "a NUL path": [directFinding({ path: "a\u0000b" })],
        "a blank detail": [directFinding({ detail: " \t" })],
        "a NUL detail": [directFinding({ detail: "x\u0000" })],
        "a path past the bound": [
          directFinding({
            path: "p".repeat(REVIEW_FINDING_PATH_MAX_LENGTH + 1),
          }),
        ],
        "a detail past the bound": [
          directFinding({
            detail: "d".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH + 1),
          }),
        ],
        // A valid blocker does not carry an unusable note along: the answer fails.
        "a blocker beside a blank note": [
          directFinding({ severity: "blocker" }),
          directFinding({ severity: "note", title: "Other", path: " " }),
        ],
        // The unusable finding is a less severe duplicate of a usable one.
        "a blank duplicate that would collapse": [
          directFinding({ severity: "blocker" }),
          directFinding({ severity: "note", detail: "  " }),
        ],
      };
      for (const [name, findings] of Object.entries(refused)) {
        assertEquals(
          (await assembleReviewReport(DIRECT_IDENTITY, findings)).status,
          "invalid",
          name,
        );
      }
      // Lines of every shape: null unless an integer from 1 to the int4 maximum.
      for (
        const [line, expected] of [
          [0, null],
          [-4, null],
          [1.5, null],
          [Number.NaN, null],
          [Number.POSITIVE_INFINITY, null],
          [REVIEW_LINE_MAX + 1, null],
          [REVIEW_LINE_MAX, REVIEW_LINE_MAX],
          [7, 7],
        ] as const
      ) {
        const assembled = await assembleReviewReport(DIRECT_IDENTITY, [
          directFinding({ line }),
        ]);
        assert(assembled.status === "ok", `line ${line}`);
        const report = assembled.report as unknown as Record<string, unknown>;
        assertEquals(findingsOf(report)[0].line, expected, `line ${line}`);
        assertSendable(report, DIRECT_IDENTITY);
      }
    },
  );

  reportTest(
    "the assembly itself counts UTF-16 units: astral text 101 and 251 characters long is refused when handed in directly",
    async () => {
      // The model schema already refuses these answers, so production never
      // hands them in. The assembly keeps its own bound anyway (the review of
      // Phase 5, F9): without these direct cases a code-point count in its
      // place would go unnoticed.
      const astral = (count: number, tail = "") =>
        "\u{1F600}".repeat(count) + tail;
      const refused: Record<string, ReviewerFinding[]> = {
        "an astral path of 101 characters, 202 units": [
          directFinding({ path: astral(101) }),
        ],
        "an astral path of 100 characters and one more unit": [
          directFinding({ path: astral(100, "a") }),
        ],
        "an astral detail of 251 characters, 502 units": [
          directFinding({ detail: astral(251) }),
        ],
        "an astral detail of 250 characters and one more unit": [
          directFinding({ detail: astral(250, "a") }),
        ],
        "a blocker beside an astral path of 101 characters": [
          directFinding({ severity: "blocker" }),
          directFinding({
            severity: "note",
            title: "Long path",
            path: astral(101),
          }),
        ],
        "a blocker beside an astral detail of 251 characters": [
          directFinding({ severity: "blocker" }),
          directFinding({
            severity: "note",
            title: "Long detail",
            detail: astral(251),
          }),
        ],
      };
      for (const [name, findings] of Object.entries(refused)) {
        assertEquals(
          (await assembleReviewReport(DIRECT_IDENTITY, findings)).status,
          "invalid",
          name,
        );
      }
      // The same text one character shorter is exactly at the bound and sent.
      const atBound = await assembleReviewReport(DIRECT_IDENTITY, [
        directFinding({
          severity: "blocker",
          path: astral(100),
          detail: astral(250),
        }),
      ]);
      assert(
        atBound.status === "ok",
        "100 and 250 characters are at the bound",
      );
      const report = atBound.report as unknown as Record<string, unknown>;
      assertEquals(findingsOf(report)[0].path.length, 200);
      assertEquals(findingsOf(report)[0].detail.length, 500);
      assertSendable(report, DIRECT_IDENTITY);
      // Each astral character is two units: 99 of them plus two ASCII
      // characters is 200 units and sent, plus three is 201 and refused.
      const nearly = await assembleReviewReport(DIRECT_IDENTITY, [
        directFinding({ path: astral(99, "ab") }),
      ]);
      assert(nearly.status === "ok", "99 astral and two units is 200 units");
      assertEquals(
        (await assembleReviewReport(DIRECT_IDENTITY, [
          directFinding({ path: astral(99, "abc") }),
        ])).status,
        "invalid",
      );
    },
  );

  reportTest(
    "any answer the model schema accepts becomes a report the server accepts",
    async () => {
      const random = generator(0x94f1);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(random() * items.length)];
      const plain = [
        "src/a.ts",
        "é",
        "日本",
        "Retry",
        "x".repeat(37),
        "a:12",
        "😀".repeat(30),
        "😀",
      ];
      const nasty = [
        " ",
        "\t",
        "\n",
        " ",
        "﻿",
        "​",
        "\u0000",
        "\ud800",
        "\udc00",
        "\ud83d",
        "😀",
        "./",
        "..",
      ];
      const text = (maxParts: number): string => {
        let value = "";
        const parts = 1 + Math.floor(random() * maxParts);
        for (let index = 0; index < parts; index++) {
          value += random() < 0.75 ? pick(plain) : pick(nasty);
        }
        return value;
      };
      const lines = [
        null,
        1,
        42,
        REVIEW_LINE_MAX,
        REVIEW_LINE_MAX + 1,
        3_000_000_000,
        Number.MAX_SAFE_INTEGER,
        0,
        -1,
        1.5,
      ];
      let accepted = 0;
      let reports = 0;
      for (let round = 0; round < 600; round++) {
        const findings = Array.from(
          { length: 1 + Math.floor(random() * 4) },
          () => ({
            severity: pick(["blocker", "major", "minor", "note"]),
            category: text(2),
            title: text(3),
            path: text(4),
            line: pick(lines),
            detail: random() < 0.15
              ? text(40).repeat(1 + Math.floor(random() * 6))
              : text(8),
          }),
        );
        const parsed = ReviewerModelOutputSchema.safeParse({ findings });
        if (!parsed.success) continue;
        accepted++;
        const assembled = await assembleReviewReport(
          DIRECT_IDENTITY,
          parsed.data.findings,
        );
        // A schema-valid answer is never unrepresentable: the schema bounds
        // path and detail in UTF-16 code units, the unit the server and the
        // assembly count, so the two agree on what a usable finding is. Astral
        // text (see `plain` below) is what makes the units differ from code
        // points, so the fuzz includes it.
        assert(
          assembled.status === "ok" || assembled.status === "findings_limit",
          `round ${round}: ${assembled.status}`,
        );
        if (assembled.status !== "ok") continue;
        reports++;
        assertSendable(
          assembled.report as unknown as Record<string, unknown>,
          DIRECT_IDENTITY,
        );
      }
      assert(accepted >= 120, `only ${accepted} answers passed the schema`);
      assert(reports >= 120, `only ${reports} reports were built`);
    },
  );

  async function scriptedVerdict(
    verdict: unknown,
  ): Promise<
    {
      outcome: Awaited<
        ReturnType<ReturnType<typeof createScriptedHarnessExecutor>["execute"]>
      >;
      pins: Pins;
    }
  > {
    const repository = await candidateRepository();
    try {
      const dir = join(repository.aux, "scripted");
      await Deno.mkdir(dir);
      const profile = await reviewProfile({ baseSha: repository.baseSha });
      const scripted = createScriptedHarnessExecutor({
        dir,
        inner: recordingInner(),
        publishFor: recordingPublisher().publishFor,
      });
      const assignment = reviewAssignment(repository, profile);
      await Deno.writeTextFile(
        join(dir, `${assignment.jobId}.review.json`),
        JSON.stringify(verdict),
      );
      await Deno.writeTextFile(join(dir, `${assignment.jobId}.release`), "");
      return {
        outcome: await scripted.execute(
          assignment,
          new AbortController().signal,
        ),
        pins: {
          headSha: repository.revision,
          baseSha: profile.baseSha,
          policyDigest: profile.policyDigest,
        },
      };
    } finally {
      await disposeRepository(repository);
    }
  }

  reportTest(
    "the scripted reviewer shares the assembly: usable verdicts pass the server, unusable ones fail",
    async () => {
      const usable = await scriptedVerdict({
        findings: [
          modelFinding({
            severity: "blocker",
            line: 3_000_000_000,
            path: "src/\ud800.ts",
            detail: "lone \udc00 surrogate",
          }),
          modelFinding({
            severity: "minor",
            title: "Whole file",
            line: REVIEW_LINE_MAX,
          }),
        ],
      });
      const report = completed(usable.outcome);
      assertSendable(report, usable.pins);
      const findings = findingsOf(report);
      assertEquals(findings.map((finding) => finding.line), [
        null,
        REVIEW_LINE_MAX,
      ]);
      assertEquals(findings[0].path, "src/\ufffd.ts");

      const unusable: Record<string, unknown[]> = {
        "a blank path": [modelFinding({ path: "  \t " })],
        "a blank detail": [modelFinding({ detail: " " })],
        "a NUL path": [modelFinding({ path: "a\u0000" })],
        "a NUL detail": [modelFinding({ detail: "\u0000" })],
        // The rest of the answer is fine; the bad finding still refuses it all.
        "a bad finding beside a blocker": [
          modelFinding({ severity: "blocker" }),
          modelFinding({ title: "Bad", detail: "a\u0000b" }),
        ],
      };
      for (const [name, findings] of Object.entries(unusable)) {
        const { outcome } = await scriptedVerdict({ findings });
        assertEquals(outcome.status, "failed", name);
        assertEquals(
          faultOf(outcome).code,
          "SCRIPTED_HARNESS_REVIEW_INVALID",
          name,
        );
      }
    },
  );
}
