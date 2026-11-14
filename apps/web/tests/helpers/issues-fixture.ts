import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/**
 * Shared stubs for the Issues specs: the saved copy of GitHub issues with their
 * readiness, the repository sources, and the role.
 */

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SOURCE_ID = uuid(900);

export type Check = {
  id: string;
  status: string;
  reason: string;
  evidence?: string[];
};
export type Seed = {
  number: number;
  title: string;
  state?: "open" | "closed";
  labels?: string[];
  verdict?: "ready" | "waiting" | "rejected" | null;
  checks?: Check[];
  request?: { disposition: string; dispositionReason?: string | null } | null;
  body?: string;
  bodyTruncated?: boolean;
  /** Native links of the saved copy. */
  links?: Record<string, unknown> | null;
  checkedAt?: string;
};

export const ticket = (seed: Seed) => {
  const state = seed.state ?? "open";
  return {
    id: uuid(seed.number),
    organizationId: MOCK_ORGANIZATION_ID,
    ticketSourceId: SOURCE_ID,
    externalTicketId: `gh-${seed.number}`,
    key: `acme/web#${seed.number}`,
    number: String(seed.number),
    safeUrl: `https://github.com/acme/web/issues/${seed.number}`,
    snapshot: {
      title: seed.title,
      body: seed.body ?? "",
      bodyTruncated: seed.bodyTruncated ?? false,
      labels: seed.labels ?? ["ready for agent"],
      state,
      stateReason: null,
      locked: false,
      repositoryFullName: "acme/web",
      links: seed.links ?? null,
    },
    requirementsDigest: "0".repeat(64),
    providerUpdateMarker: "m",
    visibility: "private",
    state,
    lastObservedAt: "2026-01-01T00:00:00.000Z",
    latestReadiness: seed.verdict
      ? {
        id: uuid(seed.number + 5000),
        version: 1,
        verdict: seed.verdict,
        checks: (seed.checks ?? []).map((check) => ({
          ...check,
          evidence: (check.evidence ?? []).map((ref) => ({ ref })),
        })),
        requirementsDigest: "0".repeat(64),
        dependencyDigest: "0".repeat(64),
        basisDigest: "0".repeat(64),
        sourcePolicyRevision: 1,
        evaluatedAt: seed.checkedAt ??
          new Date(Date.now() - 12 * 60_000).toISOString(),
      }
      : null,
    activeRequest: seed.request
      ? {
        id: uuid(seed.number + 7000),
        intent: "start",
        generation: 1,
        disposition: seed.request.disposition,
        dispositionReason: seed.request.dispositionReason ?? null,
        workflowRunId: null,
      }
      : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
};

export const ready: Check[] = [{
  id: "source_live",
  status: "pass",
  reason: "ok",
}];

export const OPEN: Seed[] = [
  { number: 201, title: "Add invoice export", verdict: "ready", checks: ready },
  {
    number: 202,
    title: "Show the export button",
    verdict: "waiting",
    checks: [{
      id: "dependencies_satisfied",
      status: "wait",
      reason: "predecessor_open",
      evidence: ["blocker:acme/web#201"],
    }],
  },
  {
    number: 203,
    title: "Archive old invoices",
    verdict: "rejected",
    checks: [{
      id: "acceptance_present",
      status: "reject",
      reason: "acceptance_missing",
    }],
  },
  {
    number: 204,
    title: "Fix rounding on totals",
    verdict: "ready",
    checks: ready,
    request: { disposition: "active" },
  },
  { number: 205, title: "Review the new report layout", verdict: null },
];
export const CLOSED: Seed[] = [
  { number: 190, title: "Old checkout bug", state: "closed", verdict: null },
];

export type Options = {
  open?: Seed[];
  closed?: Seed[];
  sources?: "none" | "healthy" | "degraded" | "authRequired" | "unknown";
  pageSize?: number;
  /** What starting work answers: ok (default), or a refusal. */
  start?:
    | "ok"
    | "notReady"
    | "changed"
    | "unavailable"
    | "notAllowed"
    | "gone"
    | "alreadyRunning";
};

/** Stubs the session, the role, the sources and the issues; returns the requests seen. */
export async function issuesFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const seen = {
    lists: [] as string[],
    syncs: 0,
    checks: 0,
    /** Issues somebody else already started. */
    running: new Set<number>(),
    starts: [] as { intent: string; revision: number; digest: string }[],
  };
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: "admin",
          capabilities: [],
        }),
      }),
  );
  const sourcesMode = options.sources ?? "healthy";
  await page.route(
    (url) => url.pathname === "/v1/ticket-sources",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: sourcesMode === "none" ? [] : [{
            id: SOURCE_ID,
            organizationId: MOCK_ORGANIZATION_ID,
            integrationConnectionId: uuid(901),
            integrationResourceId: uuid(902),
            applicationId: uuid(904),
            repositoryId: uuid(903),
            externalContainerId: "acme/web",
            enabled: true,
            policy: {},
            policyRevision: 1,
            syncHealth: sourcesMode === "degraded"
              ? "degraded"
              : sourcesMode === "authRequired"
              ? "auth_required"
              : sourcesMode === "unknown"
              ? "unknown"
              : "healthy",
            lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            lastProblemCode: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          }],
          nextCursor: null,
        }),
      }),
  );
  await page.route(
    (url) => /^\/v1\/ticket-sources\/[^/]+\/syncs$/.test(url.pathname),
    (route) => {
      seen.syncs += 1;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ operationId: uuid(950), status: "queued" }),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/external-tickets",
    (route) => {
      const url = new URL(route.request().url());
      seen.lists.push(url.search);
      const closed = url.searchParams.get("state") === "closed";
      const all = (closed ? options.closed ?? CLOSED : options.open ?? OPEN)
        .map(ticket);
      const size = options.pageSize ?? 25;
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      const items = all.slice(offset, offset + size);
      const next = offset + size < all.length ? `c${offset + size}` : null;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, nextCursor: next }),
      });
    },
  );
  const problem = (status: number, code: string) => ({
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
    }),
  });
  const everySeed = [
    ...(options.open ?? OPEN),
    ...(options.closed ?? CLOSED),
  ];
  const idOf = (pathname: string) => pathname.split("/")[3] ?? "";
  await page.route(
    (url) => /^\/v1\/external-tickets\/[^/]+$/.test(url.pathname),
    (route) => {
      const found = everySeed.find((seed) =>
        uuid(seed.number) === idOf(new URL(route.request().url()).pathname)
      );
      return found
        ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            ticket(
              seen.running.has(found.number)
                ? { ...found, request: { disposition: "active" } }
                : found,
            ),
          ),
        })
        : route.fulfill(problem(404, "NOT_FOUND"));
    },
  );
  await page.route(
    (url) =>
      /^\/v1\/external-tickets\/[^/]+\/readiness-checks$/.test(url.pathname),
    (route) => {
      seen.checks += 1;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ operationId: uuid(951), status: "queued" }),
      });
    },
  );
  await page.route(
    (url) => /^\/v1\/external-tickets\/[^/]+\/requests$/.test(url.pathname),
    (route) => {
      const body = route.request().postDataJSON() as {
        intent: string;
        expectedSourcePolicyRevision: number;
        requirementsDigest: string;
      };
      seen.starts.push({
        intent: body.intent,
        revision: body.expectedSourcePolicyRevision,
        digest: body.requirementsDigest,
      });
      const answer = options.start ?? "ok";
      if (answer === "alreadyRunning") {
        const found = everySeed.find((seed) =>
          uuid(seed.number) === idOf(new URL(route.request().url()).pathname)
        );
        if (found) seen.running.add(found.number);
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      if (answer === "notReady") {
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      if (answer === "notAllowed") {
        return route.fulfill(problem(403, "FORBIDDEN"));
      }
      if (answer === "gone") {
        return route.fulfill(problem(404, "NOT_FOUND"));
      }
      if (answer === "changed") {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      if (answer === "unavailable") {
        return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
      }
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: uuid(960),
          organizationId: MOCK_ORGANIZATION_ID,
          ticketTaskLinkId: uuid(961),
          externalTicketId: idOf(new URL(route.request().url()).pathname),
          intent: body.intent,
          generation: 1,
          authorityPrincipalId: null,
          inboundEventRouteId: null,
          sourcePolicyRevision: body.expectedSourcePolicyRevision,
          requirementsDigest: body.requirementsDigest,
          planArtifactVersionId: null,
          disposition: "pending",
          workflowRunId: null,
          origin: "manual",
          dispositionReason: null,
          readinessReportId: null,
          pinnedPreset: null,
          pauseRequestedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
        }),
      });
    },
  );
  return seen;
}
