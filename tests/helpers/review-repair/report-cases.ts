import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  fitFindingsToBudget,
  isBlockingSeverity,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_LOOP_LIMITS,
  REVIEW_SEVERITIES,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  parseReviewReport,
  REVIEW_REPORT_INVALID_REASON,
  REVIEW_REPORT_SUB_REASONS,
  type ReviewReport,
  type ReviewReportLimits,
  ReviewReportSchema,
  verifyReviewReport,
} from "../../../apps/server/src/modules/delivery/review-report.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  SHA256_C,
} from "../deterministic-checks/observations.ts";
import {
  finding,
  type FindingFixture,
  fingerprintOf,
  reviewOutput,
  worstCaseReviewOutput,
} from "./fixtures.ts";

/**
 * Cases for the server's reading of a `review.independent` report: the strict
 * parse, then the verification against the job's pins and the frozen limits.
 * Every rule has a rejection case with its own sub-reason, and the order the
 * rules run in is pinned, so a report with several defects is always refused
 * for the same one.
 */

const PINS = { headSha: HEAD_SHA, baseSha: BASE_SHA, policyDigest: SHA256_C };
const LIMITS: ReviewReportLimits = {
  maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
  resultByteBudget: REVIEW_LOOP_LIMITS.resultByteBudget,
};

type Refusal = {
  code: string | undefined;
  reason: unknown;
  subReason: unknown;
};

function refusalOf(work: () => void): Refusal | null {
  try {
    work();
  } catch (error) {
    assert(error instanceof StandardError, String(error));
    return {
      code: error.code,
      reason: error.params?.reason,
      subReason: error.params?.subReason,
    };
  }
  return null;
}

const invalid = (subReason: string): Refusal => ({
  code: "VALIDATION_FAILED",
  reason: REVIEW_REPORT_INVALID_REASON,
  subReason,
});

/** Parses then verifies, the way the finalizer does. */
function check(
  payload: unknown,
  limits: ReviewReportLimits = LIMITS,
): Refusal | null {
  return refusalOf(() =>
    verifyReviewReport(parseReviewReport(payload), PINS, limits)
  );
}

/** Verifies an already typed report, for values the strict parse cannot hold. */
function verifyTyped(
  report: unknown,
  limits: ReviewReportLimits = LIMITS,
): Refusal | null {
  return refusalOf(() =>
    verifyReviewReport(report as ReviewReport, PINS, limits)
  );
}

function manyFindings(count: number): FindingFixture[] {
  return Array.from(
    { length: count },
    (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
  );
}

type Defect = { name: string; payload: () => unknown; expected: Refusal };

/** Largest value of the `integer` (int4) column that stores a finding's line. */
const INT4_MAX = 2_147_483_647;

/**
 * Every UTF-16 code unit that `String.prototype.trim` strips, found by asking
 * the engine rather than from a hand-kept list: tab, line feed, vertical tab,
 * form feed, carriage return, space, U+00A0, U+1680, U+2000 to U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000 and U+FEFF.
 */
const TRIMMED_AWAY: readonly string[] = Array.from(
  { length: 0x10000 },
  (_, unit) => String.fromCharCode(unit),
).filter((character) => character.trim() === "");

/** The ones the verifier must certainly treat as blank, spelled out. */
const NAMED_BLANKS: ReadonlyArray<[name: string, text: string]> = [
  ["spaces", "   "],
  ["a single space", " "],
  ["a tab", "\t"],
  ["newlines", "\n\n"],
  ["a carriage return", "\r"],
  ["a vertical tab and a form feed", "\u000b\u000c"],
  ["tabs, newlines and spaces mixed", " \n\t \r\n "],
  ["a non-breaking space (U+00A0)", " "],
  ["non-breaking spaces mixed with spaces", "    "],
  ["an ogham space mark (U+1680)", " "],
  ["an en quad to a hair space (U+2000 to U+200A)", "   "],
  ["a line separator (U+2028)", " "],
  ["a paragraph separator (U+2029)", " "],
  ["a narrow no-break space (U+202F)", " "],
  ["a medium mathematical space (U+205F)", " "],
  ["an ideographic space (U+3000)", "　"],
  ["a byte order mark (U+FEFF)", "﻿"],
];

/** Text that must be refused as a path or detail whatever else is true. */
const NUL_TEXTS: ReadonlyArray<[name: string, text: string]> = [
  ["a lone NUL", "\u0000"],
  ["a NUL at the start", "\u0000text"],
  ["a NUL in the middle", "te\u0000xt"],
  ["a NUL at the end", "text\u0000"],
  ["a NUL between spaces", " \u0000 "],
];

/**
 * The contract's worst-case report with every line at the int4 maximum. The
 * shared fixture uses the largest safe integer, which the contract admits but
 * the verifier refuses as `line_invalid` before the byte budget these cases
 * are about is reached.
 */
function verifiableWorstCase(unit: string) {
  const worst = worstCaseReviewOutput(unit);
  return {
    ...worst,
    findings: worst.findings.map((entry) => ({ ...entry, line: INT4_MAX })),
  };
}

/** A finding whose path or detail is `text`. */
const withText = (
  field: "path" | "detail",
  text: string,
): Partial<FindingFixture> =>
  field === "path" ? { path: text } : { detail: text };

const blankDefects = (
  field: "path" | "detail",
  subReason: string,
): Defect[] => [
  ...NAMED_BLANKS.map(([name, text]): Defect => ({
    name: `a ${field} of ${name}`,
    payload: () => reviewOutput([finding(withText(field, text))]),
    expected: invalid(subReason),
  })),
  ...NUL_TEXTS.map(([name, text]): Defect => ({
    name: `a ${field} with ${name}`,
    payload: () => reviewOutput([finding(withText(field, text))]),
    expected: invalid(subReason),
  })),
];

const honestFindings = [
  finding({
    fingerprint: fingerprintOf(1),
    severity: "blocker",
    path: "src/service.ts",
    line: 12,
  }),
  finding({ fingerprint: fingerprintOf(2), severity: "major", line: null }),
  finding({ fingerprint: fingerprintOf(3), severity: "minor" }),
  finding({ fingerprint: fingerprintOf(4), severity: "note" }),
];

const shapeDefects: Defect[] = [
  ...[null, "report", 5, [], true].map((value): Defect => ({
    name: `a payload that is ${JSON.stringify(value)}`,
    payload: () => value,
    expected: invalid("shape"),
  })),
  {
    name: "an extra top-level field claiming approval",
    payload: () => ({ ...reviewOutput([]), approved: true }),
    expected: invalid("shape"),
  },
  ...[
    "reviewId",
    "sessionId",
    "headSha",
    "baseSha",
    "policyDigest",
    "findings",
    "blockingFindings",
  ].map((field): Defect => ({
    name: `a report without ${field}`,
    payload: () => {
      const report: Record<string, unknown> = { ...reviewOutput([]) };
      delete report[field];
      return report;
    },
    expected: invalid("shape"),
  })),
  {
    name: "a review id that is not a uuid",
    payload: () => reviewOutput([], { reviewId: "review-1" }),
    expected: invalid("shape"),
  },
  {
    name: "a session id that is not a uuid",
    payload: () => reviewOutput([], { sessionId: "session-1" }),
    expected: invalid("shape"),
  },
  {
    name: "a head that is a number",
    payload: () => reviewOutput([], { headSha: 5 }),
    expected: invalid("shape"),
  },
  {
    name: "findings that are an object",
    payload: () => reviewOutput([], { findings: {} }),
    expected: invalid("shape"),
  },
  {
    name: "findings that are null",
    payload: () => reviewOutput([], { findings: null }),
    expected: invalid("shape"),
  },
  {
    name: "a blocking count written as text",
    payload: () => reviewOutput([], { blockingFindings: "0" }),
    expected: invalid("shape"),
  },
  {
    name: "a fractional blocking count",
    payload: () => reviewOutput([], { blockingFindings: 0.5 }),
    expected: invalid("shape"),
  },
  {
    name: "a finding with an extra field",
    payload: () =>
      reviewOutput([], {
        findings: [{ ...finding(), resolved: true }],
        blockingFindings: 1,
      }),
    expected: invalid("shape"),
  },
  ...[
    "fingerprint",
    "severity",
    "blocking",
    "path",
    "line",
    "detail",
  ].map((field): Defect => ({
    name: `a finding without ${field}`,
    payload: () => {
      const entry: Record<string, unknown> = { ...finding() };
      delete entry[field];
      return reviewOutput([], { findings: [entry], blockingFindings: 1 });
    },
    expected: invalid("shape"),
  })),
  ...[
    ["a severity outside the vocabulary", { severity: "critical" }],
    ["a blocking flag written as text", { blocking: "true" }],
    ["a line written as text", { line: "12" }],
    ["a fractional line", { line: 1.5 }],
    ["a path that is a number", { path: 7 }],
    ["a detail that is null", { detail: null }],
    ["a fingerprint that is a number", { fingerprint: 1 }],
  ].map(([name, patch]): Defect => ({
    name: name as string,
    payload: () =>
      reviewOutput([], {
        findings: [{ ...finding(), ...(patch as object) }],
        blockingFindings: 1,
      }),
    expected: invalid("shape"),
  })),
];

const pinDefects: Defect[] = [
  {
    name: "a head other than the job's revision",
    payload: () => reviewOutput([], { headSha: "3".repeat(40) }),
    expected: invalid("head_mismatch"),
  },
  {
    name: "a head that is only a prefix of the revision",
    payload: () => reviewOutput([], { headSha: HEAD_SHA.slice(0, 39) }),
    expected: invalid("head_mismatch"),
  },
  {
    name: "a head with trailing whitespace",
    payload: () => reviewOutput([], { headSha: `${HEAD_SHA} ` }),
    expected: invalid("head_mismatch"),
  },
  {
    name: "a base other than the profile's inspected base",
    payload: () => reviewOutput([], { baseSha: "3".repeat(40) }),
    expected: invalid("base_mismatch"),
  },
  {
    name: "a policy digest other than the effective policy",
    payload: () => reviewOutput([], { policyDigest: "d".repeat(64) }),
    expected: invalid("policy_mismatch"),
  },
];

const findingDefects: Defect[] = [
  {
    name: "more findings than the limit",
    payload: () =>
      reviewOutput(manyFindings(REVIEW_LOOP_LIMITS.maxFindings + 1)),
    expected: invalid("findings_over_limit"),
  },
  ...[
    ["an upper-case fingerprint", fingerprintOf(255).toUpperCase()],
    ["a fingerprint one character short", "a".repeat(63)],
    ["a fingerprint one character long", "a".repeat(65)],
    ["a fingerprint that is not hex", "g".repeat(64)],
    ["an empty fingerprint", ""],
    ["a fingerprint with a prefix", `sha256:${"a".repeat(64)}`],
  ].map(([name, fingerprint]): Defect => ({
    name: name as string,
    payload: () =>
      reviewOutput([finding({ fingerprint: fingerprint as string })]),
    expected: invalid("fingerprint_invalid"),
  })),
  {
    name: "two findings with one fingerprint",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: fingerprintOf(1), path: "a.ts" }),
        finding({ fingerprint: fingerprintOf(1), path: "b.ts" }),
      ]),
    expected: invalid("fingerprint_duplicate"),
  },
  {
    name: "an empty path",
    payload: () => reviewOutput([finding({ path: "" })]),
    expected: invalid("path_invalid"),
  },
  {
    name: "a path one character over the bound",
    payload: () =>
      reviewOutput([
        finding({ path: "p".repeat(REVIEW_FINDING_PATH_MAX_LENGTH + 1) }),
      ]),
    expected: invalid("path_invalid"),
  },
  {
    name: "an empty detail",
    payload: () => reviewOutput([finding({ detail: "" })]),
    expected: invalid("detail_invalid"),
  },
  {
    name: "a detail one character over the bound",
    payload: () =>
      reviewOutput([
        finding({ detail: "d".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH + 1) }),
      ]),
    expected: invalid("detail_invalid"),
  },
  ...blankDefects("path", "path_invalid"),
  ...blankDefects("detail", "detail_invalid"),
  {
    name: "a path of the longest allowed length that is all spaces",
    payload: () =>
      reviewOutput([
        finding({ path: " ".repeat(REVIEW_FINDING_PATH_MAX_LENGTH) }),
      ]),
    expected: invalid("path_invalid"),
  },
  {
    name: "a detail of the longest allowed length that is all spaces",
    payload: () =>
      reviewOutput([
        finding({ detail: " ".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH) }),
      ]),
    expected: invalid("detail_invalid"),
  },
  {
    name: "a blank path in the second finding of two",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: fingerprintOf(1) }),
        finding({ fingerprint: fingerprintOf(2), path: " \t " }),
      ]),
    expected: invalid("path_invalid"),
  },
  {
    name: "a blank detail in the second finding of two",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: fingerprintOf(1) }),
        finding({ fingerprint: fingerprintOf(2), detail: "\n" }),
      ]),
    expected: invalid("detail_invalid"),
  },
  {
    name: "line zero",
    payload: () => reviewOutput([finding({ line: 0 })]),
    expected: invalid("line_invalid"),
  },
  ...[
    ["one above the int4 column", INT4_MAX + 1],
    ["two to the thirty-second power", 2 ** 32],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
  ].map(([name, line]): Defect => ({
    name: `a line that is ${name}`,
    payload: () => reviewOutput([finding({ line: line as number })]),
    expected: invalid("line_invalid"),
  })),
  {
    name: "a negative line",
    payload: () => reviewOutput([finding({ line: -3 })]),
    expected: invalid("line_invalid"),
  },
  ...REVIEW_SEVERITIES.map((severity): Defect => ({
    name: `${severity} with the opposite blocking flag`,
    payload: () => {
      const entry = finding({ severity });
      return reviewOutput([{ ...entry, blocking: !entry.blocking }], {
        blockingFindings: entry.blocking ? 0 : 1,
      });
    },
    expected: invalid("blocking_flag_mismatch"),
  })),
  {
    name: "a hidden blocker: a blocker flagged as non-blocking",
    payload: () =>
      reviewOutput([finding({ severity: "blocker", blocking: false })]),
    expected: invalid("blocking_flag_mismatch"),
  },
  {
    name: "an approval smuggled in: a blocker with a zero blocking count",
    payload: () =>
      reviewOutput([finding({ severity: "blocker" })], {
        blockingFindings: 0,
      }),
    expected: invalid("blocking_count_mismatch"),
  },
  {
    name: "a blocking count above the findings",
    payload: () =>
      reviewOutput([finding({ severity: "blocker" })], {
        blockingFindings: 2,
      }),
    expected: invalid("blocking_count_mismatch"),
  },
  {
    name: "a blocking count for a report with no findings",
    payload: () => reviewOutput([], { blockingFindings: 1 }),
    expected: invalid("blocking_count_mismatch"),
  },
  {
    name: "a blocking count that counts advisory findings",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: fingerprintOf(1), severity: "minor" }),
        finding({ fingerprint: fingerprintOf(2), severity: "note" }),
      ], { blockingFindings: 2 }),
    expected: invalid("blocking_count_mismatch"),
  },
];

/**
 * A report with several defects is refused for the first rule in the order
 * the function states: head, base, policy, count, then each finding in turn
 * (fingerprint, duplicate, path, detail, line, flag), then the blocking count,
 * then the byte budget.
 */
const orderCases: Defect[] = [
  {
    name: "head outranks base, policy and findings",
    payload: () =>
      reviewOutput(manyFindings(30), {
        headSha: "3".repeat(40),
        baseSha: "3".repeat(40),
        policyDigest: "d".repeat(64),
      }),
    expected: invalid("head_mismatch"),
  },
  {
    name: "base outranks policy",
    payload: () =>
      reviewOutput([], {
        baseSha: "3".repeat(40),
        policyDigest: "d".repeat(64),
      }),
    expected: invalid("base_mismatch"),
  },
  {
    name: "the findings limit outranks a bad fingerprint",
    payload: () =>
      reviewOutput([
        ...manyFindings(REVIEW_LOOP_LIMITS.maxFindings),
        finding({ fingerprint: "bad" }),
      ]),
    expected: invalid("findings_over_limit"),
  },
  {
    name: "an invalid fingerprint outranks a duplicate and a bad path",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: "bad", path: "" }),
        finding({ fingerprint: "bad", path: "" }),
      ]),
    expected: invalid("fingerprint_invalid"),
  },
  {
    name: "a duplicate fingerprint outranks a bad path",
    payload: () =>
      reviewOutput([
        finding({ fingerprint: fingerprintOf(1) }),
        finding({ fingerprint: fingerprintOf(1), path: "" }),
      ]),
    expected: invalid("fingerprint_duplicate"),
  },
  {
    name: "a bad path outranks a bad detail, line and flag",
    payload: () =>
      reviewOutput([
        finding({
          path: "",
          detail: "",
          line: 0,
          severity: "blocker",
          blocking: false,
        }),
      ]),
    expected: invalid("path_invalid"),
  },
  {
    name: "a bad detail outranks a bad line and flag",
    payload: () =>
      reviewOutput([
        finding({ detail: "", line: 0, severity: "blocker", blocking: false }),
      ]),
    expected: invalid("detail_invalid"),
  },
  {
    name: "a blank path outranks a NUL in the detail",
    payload: () =>
      reviewOutput([finding({ path: "  ", detail: "bad\u0000detail" })]),
    expected: invalid("path_invalid"),
  },
  {
    name: "a blank detail outranks a line past the int4 column and a bad flag",
    payload: () =>
      reviewOutput([
        finding({
          detail: "\t",
          line: INT4_MAX + 1,
          severity: "blocker",
          blocking: false,
        }),
      ]),
    expected: invalid("detail_invalid"),
  },
  {
    name: "a line past the int4 column outranks a bad flag",
    payload: () =>
      reviewOutput([
        finding({ line: INT4_MAX + 1, severity: "blocker", blocking: false }),
      ]),
    expected: invalid("line_invalid"),
  },
  {
    name: "a bad line outranks a bad flag",
    payload: () =>
      reviewOutput([
        finding({ line: 0, severity: "blocker", blocking: false }),
      ]),
    expected: invalid("line_invalid"),
  },
  {
    name: "a bad flag outranks a bad count",
    payload: () =>
      reviewOutput([finding({ severity: "blocker", blocking: false })], {
        blockingFindings: 5,
      }),
    expected: invalid("blocking_flag_mismatch"),
  },
];

export function registerReportCases(): void {
  Deno.test("an honest report passes: clean, advisory only, mixed and at the count limit", () => {
    const honest: Array<[string, unknown]> = [
      ["no findings", reviewOutput([])],
      [
        "advisory findings only",
        reviewOutput([
          finding({ fingerprint: fingerprintOf(1), severity: "minor" }),
          finding({ fingerprint: fingerprintOf(2), severity: "note" }),
        ]),
      ],
      ["blocking and advisory findings", reviewOutput(honestFindings)],
      ["a finding about a whole file", reviewOutput([finding({ line: null })])],
      ["a finding on line one", reviewOutput([finding({ line: 1 })])],
      [
        "a finding on the last line the int4 column holds",
        reviewOutput([finding({ line: INT4_MAX })]),
      ],
      [
        "a path and a detail that hold whitespace around real text",
        reviewOutput([
          finding({
            path: " src/a b.ts\t",
            detail: "line one\nline two\u00a0still the same issue ",
          }),
        ]),
      ],
      [
        "a one-character path and detail",
        reviewOutput([finding({ path: "a", detail: "b" })]),
      ],
      [
        "a path and a detail at the longest allowed length",
        reviewOutput([
          finding({
            path: "p".repeat(REVIEW_FINDING_PATH_MAX_LENGTH),
            detail: "d".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH),
          }),
        ]),
      ],
      [
        "text outside the basic plane in a path and a detail",
        reviewOutput([
          finding({ path: "src/\u{1F950}.ts", detail: "\u{1F950}" }),
        ]),
      ],
      [
        "the most findings the limit allows",
        reviewOutput(
          manyFindings(REVIEW_LOOP_LIMITS.maxFindings),
        ),
      ],
    ];
    for (const [name, payload] of honest) {
      assertEquals(check(payload), null, name);
    }
  });

  Deno.test("an honest report is read back field for field and is not changed", () => {
    const payload = reviewOutput(honestFindings);
    const before = structuredClone(payload);
    const report = parseReviewReport(payload);
    assertEquals(report, before);
    verifyReviewReport(report, PINS, LIMITS);
    assertEquals(report, before);
    assertEquals(report.blockingFindings, 2);
    assertEquals(
      report.findings.filter((entry) => isBlockingSeverity(entry.severity))
        .length,
      2,
    );
  });

  Deno.test("the strict parse refuses every wrong shape with sub-reason shape", () => {
    for (const defect of shapeDefects) {
      assertEquals(check(defect.payload()), defect.expected, defect.name);
    }
  });

  Deno.test("verification refuses a report that contradicts the job's pins", () => {
    for (const defect of pinDefects) {
      assertEquals(check(defect.payload()), defect.expected, defect.name);
    }
  });

  Deno.test("verification refuses every defective finding and every false count", () => {
    for (const defect of findingDefects) {
      assertEquals(check(defect.payload()), defect.expected, defect.name);
    }
  });

  Deno.test("a report with several defects is refused for the first rule in the order", () => {
    for (const defect of orderCases) {
      assertEquals(check(defect.payload()), defect.expected, defect.name);
    }
  });

  Deno.test("values the strict parse cannot hold are still refused when verified directly", () => {
    const typed = (patch: Record<string, unknown>) => ({
      ...reviewOutput([finding()]),
      findings: [{ ...finding(), ...patch }],
    });
    const cases: Array<[string, unknown, string]> = [
      ["a fractional line", typed({ line: 1.5 }), "line_invalid"],
      [
        "a line past the safe integers",
        typed({ line: 2 ** 60 }),
        "line_invalid",
      ],
      ["a line that is not a number", typed({ line: "7" }), "line_invalid"],
      [
        "a line past the int4 column",
        typed({ line: INT4_MAX + 1 }),
        "line_invalid",
      ],
      ["a path that is a number", typed({ path: 7 }), "path_invalid"],
      ["a path that is null", typed({ path: null }), "path_invalid"],
      ["a detail that is a number", typed({ detail: 7 }), "detail_invalid"],
      [
        "a detail that is missing",
        typed({ detail: undefined }),
        "detail_invalid",
      ],
      ["a non-integer count", {
        ...reviewOutput([finding()]),
        blockingFindings: 1.0000001,
      }, "blocking_count_mismatch"],
    ];
    for (const [name, report, subReason] of cases) {
      assertEquals(verifyTyped(report), invalid(subReason), name);
    }
  });

  Deno.test("the blank-text set is what trim strips and covers the named whitespace", () => {
    // The sweep below is only as good as this set: it must hold every named
    // blank, the common ones among them, and nothing that is real text.
    for (const [name, text] of NAMED_BLANKS) {
      for (const character of text) {
        assert(TRIMMED_AWAY.includes(character), `${name}: ${character}`);
      }
    }
    for (const unit of [9, 10, 11, 12, 13, 32, 0xa0, 0x2028, 0x2029, 0xfeff]) {
      assert(TRIMMED_AWAY.includes(String.fromCharCode(unit)), `${unit}`);
    }
    assert(TRIMMED_AWAY.length >= 20, `${TRIMMED_AWAY.length} characters`);
    assert(!TRIMMED_AWAY.includes("a") && !TRIMMED_AWAY.includes("\u0000"));
  });

  Deno.test("a path or detail made only of characters trim strips is refused, alone or in a run", () => {
    for (const character of TRIMMED_AWAY) {
      const code = character.charCodeAt(0).toString(16).padStart(4, "0");
      for (
        const text of [character, character.repeat(3), `${character} `]
      ) {
        assertEquals(
          check(reviewOutput([finding({ path: text })])),
          invalid("path_invalid"),
          `path of U+${code}`,
        );
        assertEquals(
          check(reviewOutput([finding({ detail: text })])),
          invalid("detail_invalid"),
          `detail of U+${code}`,
        );
      }
    }
    // Every such character together is still blank.
    const everyBlank = TRIMMED_AWAY.join("");
    assertEquals(
      check(reviewOutput([finding({ path: everyBlank })])),
      invalid("path_invalid"),
    );
    assertEquals(
      check(reviewOutput([finding({ detail: everyBlank })])),
      invalid("detail_invalid"),
    );
  });

  Deno.test("one real character among blanks makes a path or detail acceptable", () => {
    for (const character of TRIMMED_AWAY) {
      const text = `${character}x${character}`;
      assertEquals(
        check(reviewOutput([finding({ path: text, detail: text })])),
        null,
        `U+${character.charCodeAt(0).toString(16)}`,
      );
    }
  });

  Deno.test("a NUL anywhere in a path or detail is refused, whatever surrounds it", () => {
    for (const filler of ["", "x", " ", "\u00a0", "\u{1F950}"]) {
      for (
        const text of [
          `\u0000${filler}`,
          `${filler}\u0000`,
          `${filler}\u0000${filler}`,
        ]
      ) {
        assertEquals(
          check(reviewOutput([finding({ path: text })])),
          invalid("path_invalid"),
          JSON.stringify(text),
        );
        assertEquals(
          check(reviewOutput([finding({ detail: text })])),
          invalid("detail_invalid"),
          JSON.stringify(text),
        );
      }
    }
  });

  Deno.test("a lone surrogate anywhere in a path or detail is refused, a paired one is not", () => {
    // Postgres jsonb rejects a lone surrogate, so the report must be refused
    // here instead of failing the result insert.
    const lone = ["\ud800", "\udbff", "\udc00", "\udfff"];
    for (const surrogate of lone) {
      for (const filler of ["", "x", " ", "\u00a0", "\u{1F950}"]) {
        for (
          const text of [
            `${surrogate}${filler}`,
            `${filler}${surrogate}`,
            `${filler}${surrogate}${filler}`,
            `${filler}x${surrogate}`,
          ]
        ) {
          assertEquals(
            check(reviewOutput([finding({ path: text })])),
            invalid("path_invalid"),
            JSON.stringify(text),
          );
          assertEquals(
            check(reviewOutput([finding({ detail: text })])),
            invalid("detail_invalid"),
            JSON.stringify(text),
          );
        }
      }
    }
    // A high surrogate then a low one is one astral character, and a reversed
    // pair is two lone halves.
    for (const text of ["\u{1F950}", "a\u{10000}b", "\ud83e\udd50x"]) {
      assertEquals(
        check(reviewOutput([finding({ path: text, detail: text })])),
        null,
        JSON.stringify(text),
      );
    }
    for (const text of ["\udd50\ud83e", "\ud83e\ud83e", "\udd50\udd50"]) {
      assertEquals(
        check(reviewOutput([finding({ path: text })])),
        invalid("path_invalid"),
        JSON.stringify(text),
      );
      assertEquals(
        check(reviewOutput([finding({ detail: text })])),
        invalid("detail_invalid"),
        JSON.stringify(text),
      );
    }
  });

  Deno.test("a lone surrogate in the second finding of two is refused, and the path rule runs first", () => {
    assertEquals(
      check(reviewOutput([
        finding({ fingerprint: fingerprintOf(1) }),
        finding({ fingerprint: fingerprintOf(2), detail: "bad\ud800" }),
      ])),
      invalid("detail_invalid"),
    );
    assertEquals(
      check(reviewOutput([
        finding({ path: "a\udc00.ts", detail: "bad\ud800" }),
      ])),
      invalid("path_invalid"),
    );
  });

  Deno.test("a path or detail at the length bound is still refused for a lone surrogate at the end", () => {
    assertEquals(
      check(reviewOutput([
        finding({
          path: `${"p".repeat(REVIEW_FINDING_PATH_MAX_LENGTH - 1)}\ud800`,
        }),
      ])),
      invalid("path_invalid"),
    );
    assertEquals(
      check(reviewOutput([
        finding({
          detail: `${"d".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH - 1)}\udfff`,
        }),
      ])),
      invalid("detail_invalid"),
    );
  });

  Deno.test("the line bound is exact: the int4 maximum passes and one more refuses", () => {
    for (const line of [1, 2, 65_535, INT4_MAX - 1, INT4_MAX]) {
      assertEquals(check(reviewOutput([finding({ line })])), null, `${line}`);
    }
    for (const line of [INT4_MAX + 1, INT4_MAX + 2, 2 ** 31, 2 ** 53 - 1]) {
      assertEquals(
        check(reviewOutput([finding({ line })])),
        invalid("line_invalid"),
        `${line}`,
      );
    }
  });

  Deno.test("the byte budget is exact: the size itself passes and one byte less refuses", () => {
    const payload = reviewOutput(honestFindings);
    const size = serializedBytes(payload);
    assertEquals(
      check(payload, { maxFindings: 25, resultByteBudget: size }),
      null,
    );
    assertEquals(
      check(payload, { maxFindings: 25, resultByteBudget: size - 1 }),
      invalid("over_budget"),
    );
    assertEquals(
      check(payload, { maxFindings: 25, resultByteBudget: 0 }),
      invalid("over_budget"),
    );
  });

  Deno.test("the byte budget counts UTF-8 bytes, not characters", () => {
    // 25 findings with every text field at its character bound are within the
    // count and character bounds and over the byte budget, in one-byte
    // characters and still more so in two-byte ones.
    const light = verifiableWorstCase("x");
    const heavy = verifiableWorstCase("é");
    assert(serializedBytes(light) > LIMITS.resultByteBudget);
    assert(serializedBytes(heavy) > serializedBytes(light));
    assertEquals(check(light), invalid("over_budget"));
    assertEquals(check(heavy), invalid("over_budget"));
  });

  Deno.test("a report trimmed by the worker's budget rule is accepted", () => {
    for (const unit of ["x", "é"]) {
      const worst = verifiableWorstCase(unit);
      const sized = (findings: readonly FindingFixture[]) =>
        reviewOutput(findings, { sessionId: worst.sessionId });
      const trimmed = fitFindingsToBudget(
        worst.findings,
        (candidate) =>
          serializedBytes(sized(candidate)) <= LIMITS.resultByteBudget,
      );
      assert(trimmed !== null, `${unit}: the blockers fit once shortened`);
      const report = sized(trimmed);
      assert(serializedBytes(report) <= LIMITS.resultByteBudget, unit);
      assertEquals(check(report), null, unit);
      // The rule never drops a blocking finding.
      assertEquals(
        trimmed.filter((entry) => entry.blocking).length,
        worst.findings.filter((entry) => entry.blocking).length,
        unit,
      );
    }
  });

  Deno.test("a report whose blockers cannot fit even when shortened is refused, never trimmed on the server", () => {
    // Three-byte characters in every path: the worker rule cannot fit 25
    // blockers, so it reports null and the worker faults. A server that still
    // received such a report refuses it rather than dropping a blocker.
    const worst = verifiableWorstCase("€");
    assertEquals(check(worst), invalid("over_budget"));
  });

  Deno.test("a limit that is not a non-negative integer is a programming error, not a pass", () => {
    const payload = reviewOutput([]);
    const bad: ReviewReportLimits[] = [
      { maxFindings: Number.NaN, resultByteBudget: 100 },
      { maxFindings: -1, resultByteBudget: 100 },
      { maxFindings: 1.5, resultByteBudget: 100 },
      { maxFindings: 25, resultByteBudget: Number.NaN },
      { maxFindings: 25, resultByteBudget: -1 },
      { maxFindings: 25, resultByteBudget: Number.POSITIVE_INFINITY },
    ];
    for (const limits of bad) {
      assertThrows(
        () => verifyReviewReport(parseReviewReport(payload), PINS, limits),
        Error,
        "REVIEW_REPORT_LIMITS_INVALID",
        JSON.stringify(limits),
      );
    }
  });

  Deno.test("a lower findings limit than the default is honoured", () => {
    const payload = reviewOutput(manyFindings(3));
    assertEquals(check(payload, { ...LIMITS, maxFindings: 3 }), null);
    assertEquals(
      check(payload, { ...LIMITS, maxFindings: 2 }),
      invalid("findings_over_limit"),
    );
    assertEquals(
      check(reviewOutput([]), { ...LIMITS, maxFindings: 0 }),
      null,
    );
    assertEquals(
      check(reviewOutput(manyFindings(1)), { ...LIMITS, maxFindings: 0 }),
      invalid("findings_over_limit"),
    );
  });

  Deno.test("every sub-reason is reachable and every refusal uses a listed one", () => {
    const seen = new Set<string>();
    for (
      const defect of [
        ...shapeDefects,
        ...pinDefects,
        ...findingDefects,
        ...orderCases,
      ]
    ) {
      const refusal = check(defect.payload());
      assert(refusal !== null, defect.name);
      assertEquals(refusal.code, "VALIDATION_FAILED", defect.name);
      assertEquals(refusal.reason, REVIEW_REPORT_INVALID_REASON, defect.name);
      seen.add(refusal.subReason as string);
    }
    seen.add(check(verifiableWorstCase("é"))?.subReason as string);
    assertEquals(
      [...seen].sort(),
      [...REVIEW_REPORT_SUB_REASONS].sort(),
    );
  });

  Deno.test("the report schema describes every field and rejects unknown ones", () => {
    const shape = ReviewReportSchema.shape;
    for (const [name, schema] of Object.entries(shape)) {
      assert(
        (schema.description ?? "").trim().length > 20,
        `${name} has a meaningful description`,
      );
    }
    assert((ReviewReportSchema.description ?? "").length > 20);
    const findings = shape.findings.element;
    for (const [name, schema] of Object.entries(findings.shape)) {
      assert(
        (schema.description ?? "").trim().length > 20,
        `finding.${name} has a meaningful description`,
      );
    }
  });
}
