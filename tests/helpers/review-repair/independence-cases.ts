import { assert, assertEquals } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  assertIndependentReviewer,
  type IndependenceInput,
  REVIEW_INDEPENDENCE_VIOLATIONS,
  REVIEW_NOT_INDEPENDENT_REASON,
} from "../../../apps/server/src/modules/delivery/independence.ts";

/**
 * Cases for the independence rule: a reviewer is the review step's own fresh
 * session, never one of the sessions that wrote the candidate. Each rule has
 * a refusal case, the order the rules run in is pinned, and the rule cannot be
 * dodged by letter case or by input the types do not allow.
 */

const REVIEW_SESSION = crypto.randomUUID();
const REVIEW_STEP = crypto.randomUUID();
const IMPLEMENT_SESSION = crypto.randomUUID();
const REPAIR_SESSION = crypto.randomUUID();
const OTHER_STEP = crypto.randomUUID();

/** A fresh reviewer: the review step's own session, with no lineage. */
function input(patch: Partial<IndependenceInput> = {}): IndependenceInput {
  return {
    reviewer: {
      sessionId: REVIEW_SESSION,
      runStepId: REVIEW_STEP,
      parentSessionId: null,
      resumeRef: null,
    },
    implementingSessions: [IMPLEMENT_SESSION, REPAIR_SESSION],
    reviewStepId: REVIEW_STEP,
    jobCheckpoints: 0,
    ...patch,
  };
}

/** An array that keeps its holes: `[a, , b]` literals do, copies may not. */
function sparse(list: Array<string | undefined>, length?: number): string[] {
  const result = list as unknown as string[];
  if (length !== undefined) result.length = length;
  return result;
}

function reviewer(
  patch: Partial<IndependenceInput["reviewer"]>,
): IndependenceInput["reviewer"] {
  return { ...input().reviewer, ...patch };
}

function refusalOf(work: () => void): string | null {
  try {
    work();
  } catch (error) {
    assert(error instanceof StandardError, String(error));
    assertEquals(error.code, "VALIDATION_FAILED");
    assertEquals(error.params?.reason, REVIEW_NOT_INDEPENDENT_REASON);
    return error.params?.subReason as string;
  }
  return null;
}

const outcome = (value: IndependenceInput) =>
  refusalOf(() => assertIndependentReviewer(value));

type Case = { name: string; value: IndependenceInput; expected: string | null };

const cases: Case[] = [
  {
    name: "a fresh session of the review step",
    value: input(),
    expected: null,
  },
  {
    name: "a run with a single implementing session on record",
    value: input({ implementingSessions: [IMPLEMENT_SESSION] }),
    expected: null,
  },
  {
    name: "a run with no implementing session on record",
    value: input({ implementingSessions: [] }),
    expected: "implementer_unknown",
  },
  {
    name: "an implementing-session list that is missing",
    value: input({
      implementingSessions: undefined as unknown as string[],
    }),
    expected: "implementer_unknown",
  },
  {
    name: "an implementing-session list that is null",
    value: input({ implementingSessions: null as unknown as string[] }),
    expected: "implementer_unknown",
  },
  {
    name: "an implementing-session list that is a string",
    value: input({
      implementingSessions: IMPLEMENT_SESSION as unknown as string[],
    }),
    expected: "implementer_unknown",
  },
  ...[
    ["an empty string entry", [IMPLEMENT_SESSION, ""]],
    ["only an empty string entry", [""]],
    ["a null entry", [IMPLEMENT_SESSION, null]],
    ["an undefined entry", [IMPLEMENT_SESSION, undefined]],
    ["a number entry", [IMPLEMENT_SESSION, 7]],
    ["an object entry", [IMPLEMENT_SESSION, { id: IMPLEMENT_SESSION }]],
    ["an entry that is an array of the id", [[IMPLEMENT_SESSION]]],
    ["a bad entry first", [null, IMPLEMENT_SESSION]],
    ["a bad entry among many", [
      IMPLEMENT_SESSION,
      REPAIR_SESSION,
      "",
      crypto.randomUUID(),
    ]],
    [
      "a sparse hole after a good entry",
      sparse([IMPLEMENT_SESSION, , REPAIR_SESSION]),
    ],
    ["a sparse hole first", sparse([, IMPLEMENT_SESSION])],
    ["only holes", new Array<string>(3)],
    [
      "a length-extended list with a hole at the end",
      sparse([IMPLEMENT_SESSION], 3),
    ],
  ].map(([name, list]): Case => ({
    name: `an implementing-session list with ${name as string}`,
    value: input({ implementingSessions: list as unknown as string[] }),
    expected: "implementer_unknown",
  })),
  {
    name: "a list holding a bad entry is refused before an implementer match",
    value: input({
      reviewer: reviewer({ sessionId: IMPLEMENT_SESSION }),
      implementingSessions: [IMPLEMENT_SESSION, ""],
    }),
    expected: "implementer_unknown",
  },
  {
    name: "a list with a hole is refused before the reviewer is compared",
    value: input({
      reviewer: reviewer({ sessionId: IMPLEMENT_SESSION }),
      implementingSessions: sparse([IMPLEMENT_SESSION, , REPAIR_SESSION]),
    }),
    expected: "implementer_unknown",
  },
  {
    name: "the review step id written in another letter case",
    value: input({ reviewStepId: REVIEW_STEP.toUpperCase() }),
    expected: null,
  },
  {
    name: "many implementing sessions, none of them the reviewer",
    value: input({
      implementingSessions: Array.from(
        { length: 20 },
        () => crypto.randomUUID(),
      ),
    }),
    expected: null,
  },
  {
    name: "a session id the store does not know",
    value: input({ reviewer: reviewer({ runStepId: null }) }),
    expected: "session_unknown",
  },
  {
    name: "an empty session id",
    value: input({ reviewer: reviewer({ sessionId: "" }) }),
    expected: "session_unknown",
  },
  {
    name: "an empty owning step",
    value: input({ reviewer: reviewer({ runStepId: "" }) }),
    expected: "session_unknown",
  },
  {
    name: "the implementing session itself",
    value: input({ reviewer: reviewer({ sessionId: IMPLEMENT_SESSION }) }),
    expected: "session_is_implementer",
  },
  {
    name: "a repair session of the same run",
    value: input({ reviewer: reviewer({ sessionId: REPAIR_SESSION }) }),
    expected: "session_is_implementer",
  },
  {
    name: "the implementing session written in upper case",
    value: input({
      reviewer: reviewer({ sessionId: IMPLEMENT_SESSION.toUpperCase() }),
    }),
    expected: "session_is_implementer",
  },
  {
    name: "a session owned by another step",
    value: input({ reviewer: reviewer({ runStepId: OTHER_STEP }) }),
    expected: "session_not_review_step",
  },
  {
    name: "a session of the implementing step claimed as the review's",
    value: input({
      reviewer: reviewer({ runStepId: crypto.randomUUID() }),
      reviewStepId: REVIEW_STEP,
    }),
    expected: "session_not_review_step",
  },
  {
    name: "a session forked from another session",
    value: input({
      reviewer: reviewer({ parentSessionId: IMPLEMENT_SESSION }),
    }),
    expected: "session_has_parent",
  },
  {
    name: "a session with a parent that is not an implementer",
    value: input({
      reviewer: reviewer({ parentSessionId: crypto.randomUUID() }),
    }),
    expected: "session_has_parent",
  },
  {
    name: "a session resumed from a handle",
    value: input({ reviewer: reviewer({ resumeRef: "resume-handle-1" }) }),
    expected: "session_resumed",
  },
  {
    name: "a review job that carries a checkpoint",
    value: input({ jobCheckpoints: 1 }),
    expected: "job_checkpoints",
  },
  {
    name: "a review job that carries many checkpoints",
    value: input({ jobCheckpoints: 50 }),
    expected: "job_checkpoints",
  },
  {
    name: "a checkpoint count that is not a number",
    value: input({ jobCheckpoints: Number.NaN }),
    expected: "job_checkpoints",
  },
  {
    name: "a negative checkpoint count",
    value: input({ jobCheckpoints: -1 }),
    expected: "job_checkpoints",
  },
  {
    name: "a checkpoint count that is missing",
    value: input({
      jobCheckpoints: undefined as unknown as number,
    }),
    expected: "job_checkpoints",
  },
  {
    name: "a parent that is undefined instead of null",
    value: input({
      reviewer: reviewer({ parentSessionId: undefined as unknown as null }),
    }),
    expected: "session_has_parent",
  },
  {
    name: "a resume reference that is undefined instead of null",
    value: input({
      reviewer: reviewer({ resumeRef: undefined as unknown as null }),
    }),
    expected: "session_resumed",
  },
];

/** A reviewer that breaks several rules is refused for the first in order. */
const orderCases: Case[] = [
  {
    name: "an unknown session outranks every other defect",
    value: input({
      reviewer: reviewer({
        runStepId: null,
        parentSessionId: IMPLEMENT_SESSION,
        resumeRef: "handle",
      }),
      jobCheckpoints: 3,
    }),
    expected: "session_unknown",
  },
  {
    name:
      "an empty implementing-session list outranks a foreign step, a parent, a resume and a checkpoint",
    value: input({
      reviewer: reviewer({
        runStepId: OTHER_STEP,
        parentSessionId: IMPLEMENT_SESSION,
        resumeRef: "handle",
      }),
      implementingSessions: [],
      jobCheckpoints: 3,
    }),
    expected: "implementer_unknown",
  },
  {
    name: "an unknown session outranks an empty implementing-session list",
    value: input({
      reviewer: reviewer({ runStepId: null }),
      implementingSessions: [],
    }),
    expected: "session_unknown",
  },
  {
    name:
      "an implementer outranks a foreign step, a parent, a resume and a checkpoint",
    value: input({
      reviewer: reviewer({
        sessionId: IMPLEMENT_SESSION,
        runStepId: OTHER_STEP,
        parentSessionId: IMPLEMENT_SESSION,
        resumeRef: "handle",
      }),
      jobCheckpoints: 3,
    }),
    expected: "session_is_implementer",
  },
  {
    name: "a foreign step outranks a parent, a resume and a checkpoint",
    value: input({
      reviewer: reviewer({
        runStepId: OTHER_STEP,
        parentSessionId: IMPLEMENT_SESSION,
        resumeRef: "handle",
      }),
      jobCheckpoints: 3,
    }),
    expected: "session_not_review_step",
  },
  {
    name: "a parent outranks a resume and a checkpoint",
    value: input({
      reviewer: reviewer({
        parentSessionId: IMPLEMENT_SESSION,
        resumeRef: "handle",
      }),
      jobCheckpoints: 3,
    }),
    expected: "session_has_parent",
  },
  {
    name: "a resume outranks a checkpoint",
    value: input({
      reviewer: reviewer({ resumeRef: "handle" }),
      jobCheckpoints: 3,
    }),
    expected: "session_resumed",
  },
];

export function registerIndependenceCases(): void {
  Deno.test("a reviewer is independent only as a fresh session of the review step", () => {
    for (const { name, value, expected } of cases) {
      assertEquals(outcome(value), expected, name);
    }
  });

  Deno.test("a reviewer that breaks several rules is refused for the first, in order", () => {
    for (const { name, value, expected } of orderCases) {
      assertEquals(outcome(value), expected, name);
    }
  });

  Deno.test("every violation is reachable and every refusal uses a listed one", () => {
    const seen = new Set<string>();
    for (const { value, expected } of [...cases, ...orderCases]) {
      if (expected !== null) seen.add(outcome(value) as string);
    }
    assertEquals(
      [...seen].sort(),
      [...REVIEW_INDEPENDENCE_VIOLATIONS].sort(),
    );
  });

  Deno.test("the rule reads its input and changes none of it", () => {
    for (const { value } of [...cases, ...orderCases]) {
      const before = structuredClone(value);
      outcome(value);
      assertEquals(value, before);
    }
  });

  Deno.test("a session cannot be both the implementer and independent, whatever else is true", () => {
    // Every other rule satisfied: the only defect is that the reviewer is an
    // implementing session. It is still refused.
    for (const implementer of [IMPLEMENT_SESSION, REPAIR_SESSION]) {
      assertEquals(
        outcome(input({
          reviewer: reviewer({ sessionId: implementer }),
          implementingSessions: [implementer],
        })),
        "session_is_implementer",
      );
    }
  });
}
