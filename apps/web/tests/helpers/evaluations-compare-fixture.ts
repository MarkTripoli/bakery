import type { Page } from "@playwright/test";
import {
  evaluationsFixture,
  type EvaluationsOptions,
  IDS,
} from "./evaluations-fixture.ts";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const CASE = (index: number) => uuid(200 + index);

export const SET_OTHER = uuid(900);

type State =
  | "passed"
  | "failed"
  | "error"
  | "unscored"
  | "canceled"
  | "skipped"
  | "missing";

export type CompareOptions = EvaluationsOptions & {
  readonly compareStatus?: number;
  readonly many?: number;
  readonly refusal?:
    | "different_dataset"
    | "different_case_revision"
    | "different_scorer_version";
  readonly otherSetRun?: string;
};

export async function compareFixture(
  page: Page,
  options: CompareOptions = {},
) {
  const fixture = await evaluationsFixture(page, options);
  const exact = IDS.scorerExact;
  const tone = IDS.scorerTone;
  if (options.refusal === "different_dataset") {
    const other = fixture.runs.find((run) => run.id === IDS.notMet);
    if (other !== undefined) {
      other.datasetId = SET_OTHER;
      other.datasetName = "Plan quality";
    }
  }
  if (options.otherSetRun !== undefined) {
    const other = fixture.runs.find((run) => run.id === options.otherSetRun);
    if (other !== undefined) {
      other.datasetId = SET_OTHER;
      other.datasetName = "Plan quality";
    }
  }
  const paired: [number, string, State, State][] = [
    [0, exact, "passed", "failed"],
    [1, exact, "passed", "failed"],
    [2, exact, "failed", "passed"],
    [0, tone, "failed", "passed"],
    [1, tone, "passed", "missing"],
    [2, tone, "failed", "error"],
    [3, exact, "failed", "failed"],
    [3, tone, "passed", "passed"],
    ...Array.from(
      { length: options.many ?? 0 },
      (_, index) =>
        [700 + index, exact, "failed", "passed"] as [
          number,
          string,
          State,
          State,
        ],
    ),
  ];
  const comparison = {
    compatible: true,
    reason: null,
    measures: [
      {
        scorerId: exact,
        left: { passRate: 0.5, cases: 10 },
        right: { passRate: 0.7, cases: 10 },
        change: 0.2,
      },
      {
        scorerId: tone,
        left: { passRate: 1, cases: 10 },
        right: { passRate: 0.9, cases: 10 },
        change: -0.1,
      },
    ],
    cases: paired.map(([index, scorerId, left, right]) => ({
      caseId: index >= 700 ? uuid(index) : CASE(index),
      scorerId,
      left,
      right,
    })),
    onlyLeft: [{ caseId: CASE(4), scorerId: exact }],
    onlyRight: [{ caseId: CASE(4), scorerId: tone }],
  };
  await page.route(
    (url) => /^\/v1\/evaluation-batches\/[^/]+\/compare$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url());
      fixture.seen.push({
        method: "GET",
        path: url.pathname,
        search: url.search,
        ifMatch: null,
      });
      if (options.compareStatus !== undefined) {
        return route.fulfill({
          status: options.compareStatus,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/server_error",
            title: "SERVER_ERROR",
            status: options.compareStatus,
            detail: "SERVER_ERROR",
            code: "SERVER_ERROR",
            requestId: "00000000-0000-4000-8000-0000000000e1",
            traceId: "00000000-0000-4000-8000-0000000000e2",
            retryable: false,
          }),
        });
      }
      if (options.refusal !== undefined) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            compatible: false,
            reason: options.refusal,
            measures: [],
            cases: [],
            onlyLeft: [],
            onlyRight: [],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(comparison),
      });
    },
  );
  return fixture;
}
