import type { Page, Route } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** Stubs for the Evaluations tab and one run: the runs, their results and attempts, and Stop. */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAMP = "2026-11-20T09:00:00.000Z";

export const IDS = {
  agent: uuid(1),
  workflow: uuid(2),
  dataset: uuid(3),
  scorerExact: uuid(4),
  scorerTone: uuid(5),
  /** Finished with gaps: three results never measured. */
  gaps: uuid(101),
  /** Still running. */
  running: uuid(102),
  /** Finished, gate met. */
  met: uuid(103),
  /** Finished, gate not met. */
  notMet: uuid(104),
  /** Waiting to start. */
  queued: uuid(105),
  /** Stopped by a person. */
  canceled: uuid(106),
  /** Did not finish. */
  failed: uuid(107),
  /** Measured something no list names: the title falls back to the kind and the version. */
  noName: uuid(108),
  /** Results in every one of the seven states. */
  everyState: uuid(109),
  /** Unmeasured results in two states: Not run and Stopped. */
  twoStates: uuid(110),
  /** More than one page of errors, then unscored results (only with `manyErrors`). */
  manyErrors: uuid(111),
  /** Model scorer, within its limit, part of the cost estimated (only with `costRuns`). */
  costWithin: uuid(120),
  /** Two model calls with no cost: the limit cannot be shown to hold. */
  costUnsettled: uuid(121),
  /** The limit was reached. */
  costExhausted: uuid(122),
  /** Checks only: nothing to pay. */
  checksOnly: uuid(123),
  /** A sampled model scorer reported apart from the gate. */
  sampled: uuid(124),
  /** No limit, one cost not known. */
  noLimit: uuid(125),
} as const;

const CASES = [
  "Refund for a duplicate charge",
  "Change the delivery address",
  "A question in French",
  "A very angry customer",
  "Cancel after the cutoff",
].map((name, index) => ({
  id: uuid(200 + index),
  repositoryId: null,
  name,
  inputArtifactVersionId: uuid(300 + index),
  expected: null,
  tags: [],
  revision: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
}));

const SCORERS = [
  {
    scorerId: IDS.scorerExact,
    slug: "exact-answer",
    scorerRevision: 2,
    evaluatorType: "deterministic",
    required: true,
  },
  {
    scorerId: IDS.scorerTone,
    slug: "polite-tone",
    scorerRevision: 1,
    evaluatorType: "model",
    required: true,
  },
];

/** The batch budget of a run with no model cost to speak of: no limit, nothing spent. */
const NO_BUDGET = {
  limitUsd: null,
  settledUsd: "0",
  estimatedUsd: "0",
  unknownCount: 0,
  status: "none",
  blocksNewAttempts: false,
  oldestUnknownAt: null,
};

/** The corpus report the server derives from a run's state counts (an attempt is not counted for a result never run). */
const reportOf = (
  counts: Record<string, number>,
  total: number,
  over: Record<string, unknown> = {},
) => {
  const unknown = counts.error + counts.unscored;
  const attempted = counts.passed + counts.failed + unknown;
  return {
    total,
    attempted,
    passed: counts.passed,
    failed: counts.failed,
    unknown,
    unrun: counts.missing + counts.canceled + counts.skipped,
    interrupted: 0,
    recovered: 0,
    passedOfAttempted: attempted === 0 ? null : counts.passed / attempted,
    failedOfAttempted: attempted === 0 ? null : counts.failed / attempted,
    recoveredOfInterrupted: null,
    ...over,
  };
};

type State =
  | "passed"
  | "failed"
  | "error"
  | "unscored"
  | "canceled"
  | "skipped"
  | "missing";

const ZERO = {
  passed: 0,
  failed: 0,
  error: 0,
  unscored: 0,
  canceled: 0,
  skipped: 0,
  missing: 0,
};

type Run = Record<string, unknown> & {
  id: string;
  state: string;
  version: number;
  counts: Record<State, number>;
};

const run = (
  id: string,
  at: number,
  extra: Record<string, unknown>,
): Run => ({
  id,
  datasetId: IDS.dataset,
  datasetName: "Support questions",
  datasetDigest: "sha256:aaaa",
  candidate: { kind: "workflowVersion", id: IDS.workflow, version: 5 },
  candidateDefinition: {
    definitionId: IDS.workflow,
    name: "Reviewed coding",
  },
  baseline: null,
  baselineDefinition: null,
  scorers: SCORERS,
  pinDigest: "b".repeat(64),
  state: "completed",
  requiredCount: 10,
  measuredCount: 10,
  counts: { ...ZERO, passed: 10 },
  gate: {
    decision: "met",
    rule: "at least 80% of required results pass",
    blockers: [],
  },
  hiddenCount: 0,
  canceledAt: null,
  canceledBy: null,
  completedAt: STAMP,
  createdAt: new Date(Date.UTC(2026, 10, 20, 12 - at)).toISOString(),
  updatedAt: STAMP,
  version: 2,
  optionalReport: null,
  budget: NO_BUDGET,
  ...extra,
} as Run);

/** A run's corpus report, from its own counts unless the test names one. */
const withReport = (made: Run): Run => ({
  report: reportOf(made.counts, made.requiredCount as number),
  ...made,
});

/** The states of a run's ten results, in order: five test cases times two scorers. */
function statesOf(counts: Record<State, number>): State[] {
  const order: State[] = [
    "passed",
    "failed",
    "error",
    "unscored",
    "skipped",
    "canceled",
    "missing",
  ];
  return order.flatMap((state) =>
    Array.from({ length: counts[state] }, () => state)
  );
}

export type EvaluationsOptions = {
  /** No runs at all. */
  empty?: boolean;
  /** Add this many finished runs after the usual ones, to fill more than a page. */
  extra?: number;
  /** Add a run with 60 errors and 5 unscored results: two pages of errors, then the rest. */
  manyErrors?: boolean;
  /** The first Stop is refused with 412 after someone else already changed the run. */
  conflictOnce?: boolean;
  /** Reading the run list answers this status. */
  listStatus?: number;
  /** Reading one run answers this status. */
  getStatus?: number;
  /** Hold the answer to reading one run until `release` is called, to see the loading state. */
  holdGet?: boolean;
  /** The person is a viewer: reads, but may not stop a run. */
  viewer?: boolean;
  /** Add the runs that show what a run cost (#75, revision 6). */
  costRuns?: boolean;
  /** Attempts carry what they cost, and the first one was interrupted. */
  attemptCosts?: boolean;
  placeholderReasons?: boolean;
  repeats?: boolean;
  noStopRight?: boolean;
};

export type Seen = {
  method: string;
  path: string;
  search: string;
  ifMatch: string | null;
};

/** Stubs the session and every evaluation read and Stop; returns what it saw and the runs. */
export async function evaluationsFixture(
  page: Page,
  options: EvaluationsOptions = {},
) {
  await mockAuthenticatedSession(page);
  // The shell asks what this person may do; an unstubbed read answers 401 and signs the page out.
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: options.viewer === true ? "viewer" : "developer",
          capabilities: options.viewer === true || options.noStopRight === true
            ? []
            : ["evaluationRun:write"],
        }),
      }),
  );
  const baseRuns: Run[] = options.empty ? [] : [
    run(IDS.gaps, 0, {
      state: "completed_with_errors",
      measuredCount: 7,
      counts: { ...ZERO, passed: 7, missing: 3 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
      // The attempts that carry a cost add up to the run's cost: $0.06 reported,
      // $0.04 estimated and one attempt whose cost is not known.
      ...(options.attemptCosts === true
        ? {
          budget: {
            limitUsd: null,
            settledUsd: "0.10",
            estimatedUsd: "0.04",
            unknownCount: 1,
            status: "none",
            blocksNewAttempts: false,
            oldestUnknownAt: STAMP,
          },
        }
        : {}),
    }),
    run(IDS.running, 1, {
      state: "running",
      candidate: { kind: "agentVersion", id: IDS.agent, version: 3 },
      candidateDefinition: { definitionId: IDS.agent, name: "Reviewer" },
      measuredCount: 4,
      counts: { ...ZERO, passed: 3, failed: 1, missing: 6 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
      completedAt: null,
      version: 1,
    }),
    run(IDS.met, 2, {
      candidate: { kind: "workflowVersion", id: IDS.workflow, version: 4 },
      baseline: { kind: "workflowVersion", id: IDS.workflow, version: 3 },
      baselineDefinition: {
        definitionId: IDS.workflow,
        name: "Reviewed coding",
      },
    }),
    run(IDS.notMet, 3, {
      candidate: { kind: "agentVersion", id: IDS.agent, version: 2 },
      candidateDefinition: { definitionId: IDS.agent, name: "Reviewer" },
      counts: { ...ZERO, passed: 6, failed: 4 },
      gate: {
        decision: "not_met",
        rule: "at least 80% of required results pass",
        blockers: [
          { caseId: CASES[0].id, scorerId: IDS.scorerExact, state: "failed" },
          { caseId: CASES[1].id, scorerId: IDS.scorerExact, state: "failed" },
          { caseId: CASES[2].id, scorerId: IDS.scorerTone, state: "failed" },
          { caseId: CASES[3].id, scorerId: IDS.scorerTone, state: "failed" },
        ],
      },
    }),
    run(IDS.queued, 4, {
      state: "queued",
      measuredCount: 0,
      counts: { ...ZERO, missing: 10 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
      completedAt: null,
      version: 1,
    }),
    run(IDS.canceled, 5, {
      state: "canceled",
      measuredCount: 4,
      counts: { ...ZERO, passed: 4, canceled: 6 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
      canceledAt: STAMP,
      canceledBy: uuid(700),
    }),
    run(IDS.failed, 6, {
      state: "failed",
      candidate: { kind: "somethingElse", id: uuid(999), version: 1 },
      candidateDefinition: null,
      measuredCount: 0,
      counts: { ...ZERO, missing: 10 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
    }),
    run(IDS.noName, 7, {
      candidate: { kind: "agentVersion", id: uuid(998), version: 4 },
      // The pin names a definition the server cannot name.
      candidateDefinition: { definitionId: uuid(998), name: null },
    }),
    run(IDS.everyState, 8, {
      state: "completed_with_errors",
      measuredCount: 5,
      counts: {
        ...ZERO,
        passed: 3,
        failed: 2,
        error: 1,
        unscored: 1,
        canceled: 1,
        skipped: 1,
        missing: 1,
      },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
    }),
    run(IDS.twoStates, 9, {
      state: "completed_with_errors",
      measuredCount: 7,
      counts: { ...ZERO, passed: 7, missing: 2, canceled: 1 },
      gate: {
        decision: "cannot_be_judged",
        rule: "at least 80% of required results pass",
        blockers: [],
      },
    }),
    ...(options.manyErrors === true
      ? [
        run(IDS.manyErrors, 10, {
          state: "completed_with_errors",
          requiredCount: 65,
          measuredCount: 0,
          counts: { ...ZERO, error: 60, unscored: 5 },
          gate: {
            decision: "cannot_be_judged",
            rule: "at least 80% of required results pass",
            blockers: [],
          },
        }),
      ]
      : []),
    ...(options.costRuns === true
      ? [
        run(IDS.costWithin, 11, {
          budget: {
            limitUsd: "20.00",
            settledUsd: "12.40",
            estimatedUsd: "3.10",
            unknownCount: 0,
            status: "within",
            blocksNewAttempts: false,
            oldestUnknownAt: null,
          },
        }),
        run(IDS.costUnsettled, 12, {
          state: "completed_with_errors",
          measuredCount: 8,
          counts: { ...ZERO, passed: 8, error: 2 },
          gate: {
            decision: "cannot_be_judged",
            rule: "at least 80% of required results pass",
            blockers: [],
          },
          budget: {
            limitUsd: "20.00",
            settledUsd: "18.20",
            estimatedUsd: "0",
            unknownCount: 2,
            status: "unsettled",
            blocksNewAttempts: true,
            oldestUnknownAt: STAMP,
          },
          report: reportOf({ ...ZERO, passed: 8, error: 2 }, 10, {
            interrupted: 2,
            recovered: 1,
            recoveredOfInterrupted: 0.5,
          }),
        }),
        run(IDS.costExhausted, 13, {
          state: "completed_with_errors",
          measuredCount: 6,
          counts: { ...ZERO, passed: 6, missing: 4 },
          gate: {
            decision: "cannot_be_judged",
            rule: "at least 80% of required results pass",
            blockers: [],
          },
          budget: {
            limitUsd: "20.00",
            settledUsd: "20.00",
            estimatedUsd: "5.00",
            unknownCount: 0,
            status: "exhausted",
            blocksNewAttempts: true,
            oldestUnknownAt: null,
          },
        }),
        run(IDS.checksOnly, 14, {
          scorers: [SCORERS[0]],
          requiredCount: 5,
          measuredCount: 5,
          counts: { ...ZERO, passed: 5 },
        }),
        run(IDS.sampled, 15, {
          scorers: [SCORERS[0], { ...SCORERS[1], required: false }],
          // Only the required scorer's five results count toward the run.
          requiredCount: 5,
          measuredCount: 5,
          counts: { ...ZERO, passed: 5 },
          budget: {
            limitUsd: "20.00",
            settledUsd: "1.60",
            estimatedUsd: "0",
            unknownCount: 0,
            status: "within",
            blocksNewAttempts: false,
            oldestUnknownAt: null,
          },
          optionalReport: reportOf(
            { ...ZERO, passed: 3, failed: 1, error: 1, missing: 0 },
            5,
          ),
        }),
        run(IDS.noLimit, 16, {
          budget: {
            limitUsd: null,
            settledUsd: "4.20",
            estimatedUsd: "0",
            unknownCount: 1,
            status: "none",
            blocksNewAttempts: false,
            oldestUnknownAt: STAMP,
          },
        }),
      ]
      : []),
    ...Array.from(
      { length: options.extra ?? 0 },
      (_, index) => run(uuid(1000 + index), 10 + index, {}),
    ),
  ];
  const runs: Run[] = baseRuns.map(withReport);
  let release: () => void = () => {};
  const held = options.holdGet === true
    ? new Promise<void>((resolve) => {
      release = resolve;
    })
    : null;
  const seen: Seen[] = [];
  let conflictOnce = options.conflictOnce === true;
  const record = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.push({
      method: request.method(),
      path: url.pathname,
      search: url.search,
      ifMatch: request.headers()["if-match"] ?? null,
    });
    return { request, url };
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const problem = (route: Route, status: number, code: string) =>
    route.fulfill({
      status,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: `https://bakery.example/problems/${code.toLowerCase()}`,
        title: code,
        status,
        detail: code,
        code,
        requestId: "00000000-0000-4000-8000-0000000000e1",
        traceId: "00000000-0000-4000-8000-0000000000e2",
        retryable: false,
      }),
    });
  const pageOf = <T>(items: T[], url: URL, fallback = 50) => {
    const limit = Number(url.searchParams.get("limit") ?? fallback);
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const next = from + limit;
    return {
      items: items.slice(from, next),
      nextCursor: next < items.length ? String(next) : null,
    };
  };

  await page.route(
    (url) => url.pathname === "/v1/evaluation-batches",
    (route) => {
      const { url } = record(route);
      if (options.listStatus !== undefined) {
        return problem(route, options.listStatus, "SERVER_ERROR");
      }
      const ordered = [...runs].sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt))
      );
      return json(route, pageOf(ordered, url, 25));
    },
  );
  await page.route(
    (url) => /^\/v1\/evaluation-batches\/[^/]+$/.test(url.pathname),
    async (route) => {
      await held;
      const { url } = record(route);
      if (options.getStatus !== undefined) {
        return problem(
          route,
          options.getStatus,
          options.getStatus === 404 ? "RESOURCE_NOT_FOUND" : "SERVER_ERROR",
        );
      }
      const id = url.pathname.split("/").pop();
      const found = runs.find((entry) => entry.id === id);
      return found === undefined
        ? problem(route, 404, "RESOURCE_NOT_FOUND")
        : json(route, found);
    },
  );
  await page.route(
    (url) => /^\/v1\/evaluation-batches\/[^/]+\/cancel$/.test(url.pathname),
    (route) => {
      const { request, url } = record(route);
      const id = url.pathname.split("/")[3];
      const found = runs.find((entry) => entry.id === id);
      if (found === undefined) return problem(route, 404, "RESOURCE_NOT_FOUND");
      if (conflictOnce) {
        conflictOnce = false;
        // Someone else already stopped it: the latest is a stopped run.
        Object.assign(found, {
          state: "canceled",
          measuredCount: found.measuredCount,
          counts: { ...ZERO, passed: 3, failed: 1, canceled: 6 },
          canceledAt: STAMP,
          canceledBy: uuid(701),
          version: found.version + 1,
        });
        return problem(route, 412, "PRECONDITION_FAILED");
      }
      void request;
      Object.assign(found, {
        state: "canceled",
        counts: {
          ...ZERO,
          passed: found.counts.passed,
          failed: found.counts.failed,
          canceled: 6,
        },
        canceledAt: STAMP,
        canceledBy: uuid(700),
        version: found.version + 1,
      });
      return json(route, found);
    },
  );
  await page.route(
    (url) => /^\/v1\/evaluation-batches\/[^/]+\/results$/.test(url.pathname),
    (route) => {
      const { url } = record(route);
      const id = url.pathname.split("/")[3];
      const found = runs.find((entry) => entry.id === id);
      if (found === undefined) return problem(route, 404, "RESOURCE_NOT_FOUND");
      const states = statesOf(found.counts);
      const scorers = found.scorers as typeof SCORERS;
      // A run with a sampled scorer counts only its required results; the
      // sampled ones follow the run's own sampled report, so the numbers and
      // the rows agree. Without one, every pinned scorer is required.
      const sampledReport = found.optionalReport as
        | ReturnType<typeof reportOf>
        | null;
      const requiredPins = scorers.filter((scorer) => scorer.required);
      const sampledPins = scorers.filter((scorer) => !scorer.required);
      type Entry = {
        state: State;
        caseIndex: number;
        scorer: (typeof SCORERS)[number];
        index: number;
      };
      const entries: Entry[] = sampledReport === null
        ? states.map((state, index) => ({
          state,
          caseIndex: Math.floor(index / scorers.length),
          scorer: scorers[index % scorers.length],
          index,
        }))
        : [
          ...states.map((state, index) => ({
            state,
            caseIndex: Math.floor(index / requiredPins.length),
            scorer: requiredPins[index % requiredPins.length],
            index,
          })),
          ...[
            ...Array<State>(sampledReport.passed).fill("passed"),
            ...Array<State>(sampledReport.failed).fill("failed"),
            ...Array<State>(sampledReport.unknown).fill("error"),
            ...Array<State>(sampledReport.unrun).fill("missing"),
          ].map((state, caseIndex) => ({
            state,
            caseIndex,
            scorer: sampledPins[0],
            index: 500 + caseIndex,
          })),
        ];
      const rows = entries.map(({ state, caseIndex, scorer, index }) => {
        const measured = state === "passed" || state === "failed";
        return {
          id: uuid(5000 + index),
          batchId: id,
          role: "candidate",
          caseId: CASES[caseIndex % CASES.length].id,
          caseName: CASES[caseIndex % CASES.length].name,
          caseRevision: 1,
          scorerId: scorer.scorerId,
          scorerRevision: scorer.scorerRevision,
          repetition: 1,
          required: scorer.required,
          state,
          reason: state === "error"
            ? "The model did not answer in time."
            : state === "missing" && options.placeholderReasons === true
            ? "Not run yet."
            : state === "missing" && found.state !== "running" &&
                found.state !== "queued"
            ? "No machine was free to run this test case."
            : state === "skipped"
            ? "The test case needs a file that was removed."
            : null,
          score: measured ? (state === "passed" ? 1 : 0.25) : null,
          outputArtifactVersionId: null,
          attemptCount: index === 0 ? 3 : 1,
          updatedAt: STAMP,
        };
      });
      const repeated = options.repeats === true
        ? [
          ...rows,
          {
            ...rows[0],
            id: uuid(9001),
            repetition: 2,
            state: "passed",
            score: 1,
          },
          {
            ...rows[0],
            id: uuid(9002),
            repetition: 3,
            state: "failed",
            score: 0.25,
          },
        ]
        : rows;
      const requiredFilter = url.searchParams.get("required");
      const wanted = url.searchParams.get("state");
      const filtered = repeated.filter((row) =>
        (wanted === null || row.state === wanted) &&
        (requiredFilter === null || String(row.required) === requiredFilter)
      );
      return json(route, pageOf(filtered, url));
    },
  );
  await page.route(
    (url) => /^\/v1\/evaluation-results\/[^/]+\/attempts$/.test(url.pathname),
    (route) => {
      record(route);
      const result = new URL(route.request().url()).pathname.split("/")[3];
      return json(route, {
        items: [1, 2, 3].map((attemptNo) => ({
          id: uuid(7000 + attemptNo),
          resultId: result,
          attemptNo,
          state: attemptNo === 3
            ? "passed"
            : options.attemptCosts === true && attemptNo === 1
            ? "interrupted"
            : "error",
          reason: attemptNo === 3
            ? null
            : options.attemptCosts === true && attemptNo === 1
            ? "The machine went away."
            : "The model did not answer in time.",
          ...(options.attemptCosts === true
            ? {
              usage: attemptNo === 1
                ? { measurement: "unknown", costUsd: null }
                : attemptNo === 2
                ? { measurement: "estimated", costUsd: "0.04" }
                : { measurement: "reported", costUsd: "0.06" },
            }
            : { usage: null }),
          score: attemptNo === 3 ? 1 : null,
          startedAt: `2026-11-20T09:0${attemptNo}:00.000Z`,
          endedAt: `2026-11-20T09:0${attemptNo}:30.000Z`,
          traceRef: attemptNo === 3 ? uuid(8000 + attemptNo) : null,
          createdAt: `2026-11-20T09:0${attemptNo}:00.000Z`,
        })),
        nextCursor: null,
      });
    },
  );
  return { seen, runs, release: () => release() };
}
