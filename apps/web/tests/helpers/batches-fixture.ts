import type { Page } from "@playwright/test";
import { ticket, uuid } from "./issues-fixture.ts";
import { MOCK_ORGANIZATION_ID, MOCK_PRINCIPAL_ID } from "./mock-session.ts";
import {
  application,
  projectsFixture,
  repository,
} from "./projects-fixture.ts";

/** The two repositories the batch pages are shown with. */
export const APP = application(1, "Shop");
export const WEB = repository(1, APP.id, "web");
export const STOREFRONT = repository(2, APP.id, "storefront");
export const ANA = uuid(8800);
/** The repositories of a large organization, beyond the two the pages are shown with. */
export const extraRepositoryId = (index: number) => uuid(3000 + index);

const STAMP = "2026-11-20T09:12:00.000Z";

/** The issues a batch considered: number, title and the task each one linked. */
export const ISSUES = [
  { number: 412, title: "Cart total ignores the gift-card balance" },
  { number: 415, title: "Show the delivery estimate on the order page" },
  { number: 409, title: "Retry the address lookup when it times out" },
  { number: 421, title: "Remember the last used payment method" },
  { number: 418, title: "Move checkout copy into the locale files" },
];
export const taskOf = (number: number) => uuid(7000 + number);

export type BatchIssueSeed = {
  position: number;
  number: number;
  state: "started" | "merged" | "failed" | "cancelled" | "passed_over";
  reason?: string;
  costUsd?: string;
  startedAt?: string | null;
};

export type BatchSeed = {
  id?: string;
  repositoryId?: string;
  startedBy?: string;
  maxIssues?: number;
  maxHours?: number;
  maxSpendUsd?: string;
  continueMode?: "carry_on" | "ask_first";
  state?:
    | "running"
    | "waiting"
    | "paused"
    | "stopping"
    | "finishing"
    | "finished"
    | "stopped";
  pauseReason?: string | null;
  pausedBy?: string | null;
  finishReason?: string | null;
  stoppedBy?: string | null;
  stopCancelledCurrent?: boolean;
  issuesDone?: number;
  elapsedSeconds?: number;
  spentUsd?: string;
  issues?: BatchIssueSeed[];
  startedAt?: string;
  finishedAt?: string | null;
};

let counter = 0;
export const batchId = (n: number) => uuid(6000 + n);

/** A batch as the server serves it. */
export function batch(seed: BatchSeed = {}) {
  counter += 1;
  const id = seed.id ?? batchId(counter);
  const issues = seed.issues ?? [];
  return {
    id,
    repositoryId: seed.repositoryId ?? WEB.id,
    startedBy: seed.startedBy ?? ANA,
    maxIssues: seed.maxIssues ?? 5,
    maxHours: seed.maxHours ?? 8,
    maxSpendUsd: seed.maxSpendUsd ?? "40.0000",
    continueMode: seed.continueMode ?? "carry_on",
    state: seed.state ?? "running",
    pauseReason: seed.pauseReason ?? null,
    pausedBy: seed.pausedBy ?? null,
    pausedAt: seed.pauseReason ? STAMP : null,
    finishReason: seed.finishReason ?? null,
    finishedAt: seed.finishedAt ?? null,
    stoppedBy: seed.stoppedBy ?? null,
    stopCancelledCurrent: seed.stopCancelledCurrent ?? false,
    startedAt: seed.startedAt ?? STAMP,
    issuesDone: seed.issuesDone ??
      issues.filter((i) => i.state === "merged").length,
    elapsedSeconds: seed.elapsedSeconds ?? 0,
    spentUsd: seed.spentUsd ?? "0.0000",
    waitingOn: null,
    issues: issues.map((issue) => ({
      id: uuid(5000 + id.charCodeAt(30) * 10 + issue.position + issue.number),
      position: issue.position,
      externalTicketId: uuid(issue.number),
      issueNumber: String(issue.number),
      issueTitle:
        ISSUES.find((known) => known.number === issue.number)?.title ??
          null,
      state: issue.state,
      reason: issue.reason ?? null,
      ticketRequestId: null,
      costUsd: issue.costUsd ?? "0.0000",
      startedAt: issue.startedAt === undefined
        ? issue.state === "passed_over" ? null : STAMP
        : issue.startedAt,
      mergedAt: issue.state === "merged" ? STAMP : null,
    })),
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  };
}
export type Batch = ReturnType<typeof batch>;

/** The batch of the design's running mock: three merged, the fourth being worked on, one passed over. */
export const RUNNING = () =>
  batch({
    id: batchId(1),
    state: "running",
    elapsedSeconds: 3 * 3600 + 41 * 60,
    spentUsd: "22.4000",
    issues: [
      { position: 1, number: 412, state: "merged", costUsd: "7.8500" },
      { position: 2, number: 415, state: "merged", costUsd: "6.3000" },
      { position: 3, number: 409, state: "merged", costUsd: "5.9500" },
      { position: 4, number: 421, state: "started", costUsd: "2.3000" },
      {
        position: 5,
        number: 418,
        state: "passed_over",
        reason: "predecessor_open",
      },
    ],
  });

export type Options = {
  batches?: Batch[];
  /** What the person may do: read only, or read and control (the default). */
  canControl?: boolean;
  canRead?: boolean;
  /** What a start answers: ok (default) or one of the refusals. */
  create?:
    | "ok"
    | "alreadyRunning"
    | "notTaking"
    | "notFound"
    | "forbidden"
    | "spendLow";
  /** The list answers with this status instead of the batches. */
  listFails?: number;
  /** The next control action answers with a conflict, once. */
  conflictOnce?: boolean;
  pageSize?: number;
  /** More repositories taking issues than one page of issue sources holds (100). */
  extraRepositories?: number;
  /**
   * What the startable read answers (`GET /v1/batches/startable`): the issue
   * numbers it lists, the smallest spend ("null" when the repository cannot run
   * work), whether more can start after the first page, how long ago the
   * stored checks were made, or a failure status.
   */
  startable?: {
    numbers?: number[];
    smallestSpendUsd?: string | null;
    more?: boolean;
    checkedMinutesAgo?: number;
    fails?: number;
    /** The first answer fails and the next succeeds (for Try again). */
    failsOnce?: number;
    /** Once a start is refused as too low, later reads say this is the smallest. */
    smallestAfterRefusal?: string;
  };
};

const problem = (
  status: number,
  code: string,
  reason?: string,
  issueCodes?: string[],
) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: "Request refused",
    detail: "Request refused.",
    status,
    code,
    retryable: false,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    ...(reason === undefined ? {} : { reason }),
    // The server declares a 422's problems as `issues`; the client reads their codes.
    ...(issueCodes === undefined ? {} : {
      issues: issueCodes.map((code) => ({
        path: ["repositoryId"],
        code,
        message: code.replaceAll("_", " "),
      })),
    }),
  }),
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Stubs the session, access, repositories, issues and the eight batches actions; returns what it saw. */
export async function batchesFixture(page: Page, options: Options = {}) {
  await projectsFixture(page, {
    applications: [APP],
    repositories: [WEB, STOREFRONT],
    role: "admin",
  });
  const world = new Map<string, Batch>();
  for (const item of options.batches ?? [RUNNING()]) world.set(item.id, item);
  const seen = {
    lists: [] as string[],
    created: [] as Record<string, unknown>[],
    actions: [] as { id: string; action: string; body: unknown }[],
    gets: 0,
    startable: [] as string[],
  };
  let startableFailure = options.startable?.failsOnce;
  let smallestAfterRefusal: string | null = null;
  let conflict = options.conflictOnce === true;

  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "developer",
        capabilities: [
          ...(options.canRead === false ? [] : ["batch:read"]),
          ...(options.canControl === false ? [] : ["batch:control"]),
        ],
      })),
  );
  const member = (principalId: string, displayName: string, n: number) => ({
    id: uuid(8700 + n),
    organizationId: MOCK_ORGANIZATION_ID,
    principalId,
    displayName,
    role: n === 0 ? "admin" : "developer",
    status: "active",
    joinedAt: STAMP,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  });
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/memberships**`,
    (route) =>
      route.fulfill(json({
        items: [
          member(MOCK_PRINCIPAL_ID, "Fixture Admin", 0),
          member(ANA, "Ana Reyes", 1),
        ],
        nextCursor: null,
      })),
  );
  const sourceFor = (repositoryId: string, name: string, n: number) => ({
    id: uuid(900 + n),
    organizationId: MOCK_ORGANIZATION_ID,
    integrationConnectionId: uuid(901),
    integrationResourceId: uuid(902),
    applicationId: APP.id,
    repositoryId,
    externalContainerId: name,
    enabled: true,
    policy: {},
    policyRevision: 1,
    syncHealth: "healthy",
    lastSyncedAt: STAMP,
    lastProblemCode: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  });
  const allSources = [
    ...[WEB, STOREFRONT].map((repo, index) =>
      sourceFor(repo.id, `${repo.owner}/${repo.name}`, index)
    ),
    ...Array.from(
      { length: options.extraRepositories ?? 0 },
      (_, index) =>
        sourceFor(
          extraRepositoryId(index),
          `acme/extra-${index}`,
          100 + index,
        ),
    ),
  ];
  await page.route(
    (url) => url.pathname === "/v1/ticket-sources",
    (route) => {
      // Served in pages, as the server does: the first 100, then the rest by cursor.
      const url = new URL(route.request().url());
      const size = Math.min(Number(url.searchParams.get("limit") ?? 100), 100);
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      const items = allSources.slice(offset, offset + size);
      const next = offset + size < allSources.length
        ? `c${offset + size}`
        : null;
      return route.fulfill(json({ items, nextCursor: next }));
    },
  );
  await page.route(
    (url) => /^\/v1\/external-tickets\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3]!;
      const found = ISSUES.find((issue) => uuid(issue.number) === id);
      if (found === undefined) {
        return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      }
      const blocked = found.number === 418;
      const row = ticket({
        number: found.number,
        title: found.title,
        verdict: blocked ? "waiting" : "ready",
        checks: blocked
          ? [{
            id: "dependency",
            status: "wait",
            reason: "predecessor_open",
            evidence: ["blocker:acme/web#470"],
          }]
          : [],
      });
      return route.fulfill(json({
        ...row,
        linkedTaskIds: [taskOf(found.number)],
        linkedTaskCount: 1,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/batches",
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        seen.created.push(body);
        const refusal = options.create ?? "ok";
        if (refusal === "alreadyRunning") {
          return route.fulfill(
            problem(409, "STATE_CONFLICT", "batch_already_running"),
          );
        }
        if (refusal === "notTaking") {
          return route.fulfill(
            problem(409, "STATE_CONFLICT", "repository_not_taking_issues"),
          );
        }
        if (refusal === "notFound") {
          return route.fulfill(
            problem(422, "UNPROCESSABLE", undefined, ["repository_not_found"]),
          );
        }
        if (refusal === "forbidden") {
          return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
        }
        if (refusal === "spendLow") {
          smallestAfterRefusal = options.startable?.smallestAfterRefusal ??
            null;
          return route.fulfill(
            problem(422, "UNPROCESSABLE", undefined, [
              "max_spend_below_smallest",
            ]),
          );
        }
        const created = batch({
          repositoryId: String(body.repositoryId),
          maxIssues: Number(body.maxIssues),
          maxHours: Number(body.maxHours),
          maxSpendUsd: String(body.maxSpendUsd),
          continueMode: body.continueMode as "carry_on" | "ask_first",
          state: "running",
        });
        world.set(created.id, created);
        return route.fulfill(json(created, 201));
      }
      seen.lists.push(url.search);
      if (options.listFails !== undefined) {
        return route.fulfill(problem(options.listFails, "INTERNAL"));
      }
      const repositoryId = url.searchParams.get("repositoryId");
      const all = [...world.values()].filter((item) =>
        repositoryId === null || item.repositoryId === repositoryId
      );
      const size = Math.min(
        Number(url.searchParams.get("limit") ?? 25),
        options.pageSize ?? 25,
      );
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      const items = all.slice(offset, offset + size);
      const next = offset + size < all.length ? `c${offset + size}` : null;
      return route.fulfill(json({ items, nextCursor: next }));
    },
  );
  await page.route(
    (url) => /^\/v1\/batches\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3]!;
      seen.gets += 1;
      const found = world.get(id);
      return route.fulfill(
        found === undefined ? problem(404, "RESOURCE_NOT_FOUND") : json(found),
      );
    },
  );
  await page.route(
    (url) =>
      /^\/v1\/batches\/[^/]+\/(pause|resume|start-next|finish|stop)$/.test(
        url.pathname,
      ),
    (route) => {
      const parts = new URL(route.request().url()).pathname.split("/");
      const id = parts[3]!;
      const action = parts[4]!;
      const body = route.request().postDataJSON() as unknown;
      seen.actions.push({ id, action, body });
      const found = world.get(id);
      if (found === undefined) {
        return route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
      }
      if (conflict) {
        conflict = false;
        return route.fulfill(problem(409, "STATE_CONFLICT", "wrong_state"));
      }
      const next: Batch = { ...found };
      const running = found.issues.some((issue) => issue.state === "started");
      if (action === "pause") {
        next.state = "paused";
        next.pauseReason = "paused_by_person";
        next.pausedBy = MOCK_PRINCIPAL_ID;
        next.pausedAt = STAMP;
      } else if (action === "resume") {
        next.state = "running";
        next.pauseReason = null;
        next.pausedBy = null;
        next.pausedAt = null;
      } else if (action === "start-next") {
        next.state = "running";
      } else if (action === "finish") {
        next.state = "finished";
        next.finishReason = "finished_by_person";
        next.finishedAt = STAMP;
      } else {
        const cancel = (body as { cancelCurrent?: boolean }).cancelCurrent ===
          true;
        next.stopCancelledCurrent = cancel;
        next.stoppedBy = MOCK_PRINCIPAL_ID;
        next.state = running ? "stopping" : "stopped";
        next.finishedAt = running ? null : STAMP;
      }
      world.set(id, next);
      return route.fulfill(json(next));
    },
  );
  // Registered after the batch-by-id route, so `startable` is not read as an id.
  await page.route(
    (url) => url.pathname === "/v1/batches/startable",
    (route) => {
      const url = new URL(route.request().url());
      seen.startable.push(url.search);
      const plan = options.startable ?? {};
      if (plan.fails !== undefined) {
        return route.fulfill(problem(plan.fails, "INTERNAL"));
      }
      if (startableFailure !== undefined) {
        const status = startableFailure;
        startableFailure = undefined;
        return route.fulfill(problem(status, "INTERNAL"));
      }
      const limit = Number(url.searchParams.get("limit") ?? 5);
      const numbers = [...(plan.numbers ?? ISSUES.map((issue) => issue.number))]
        .sort((a, b) => a - b);
      const checkedAt = new Date(
        Date.now() - (plan.checkedMinutesAgo ?? 12) * 60_000,
      ).toISOString();
      const items = numbers.slice(0, limit).map((number) => ({
        externalTicketId: uuid(number),
        number: String(number),
        title: ISSUES.find((issue) => issue.number === number)?.title ?? null,
        url: null,
        checkedAt,
      }));
      return route.fulfill(json({
        items,
        nextCursor: plan.more === true || numbers.length > limit ? "c5" : null,
        smallestSpendUsd: smallestAfterRefusal ??
          (plan.smallestSpendUsd === undefined
            ? "12.5000"
            : plan.smallestSpendUsd),
      }));
    },
  );
  return { seen, world };
}
