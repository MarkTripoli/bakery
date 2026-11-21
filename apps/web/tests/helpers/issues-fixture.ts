import { expect, type Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
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

/** Work Bakery started from one issue: its request, the repositories it went to, the note. */
export type WorkSeed = {
  /** The issue number the work belongs to. */
  issue: number;
  progress:
    | "pending"
    | "waiting"
    | "admitted"
    | "active"
    | "suspended"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected";
  origin?: "manual" | "adoption" | "webhook" | "poll";
  /**
   * Started by the signed-in person (default), by a listed teammate (false:
   * Ana Reyes), or by somebody the memberships read does not list ("unlisted").
   */
  byMe?: boolean | "unlisted";
  triggerLabel?: string | null;
  reason?: string | null;
  pausedReason?:
    | "edited_after_setup"
    | "label_removed"
    | "hold_label_added"
    | "dependency_unreadable"
    | null;
  /** One entry per repository the work went to. */
  targets?: {
    role: string;
    repository: string;
    status?: string;
    pulls?: { number: number; status: "open" | "merged" | "closed" }[];
  }[];
  note?: {
    health: "unknown" | "pending" | "healthy" | "failed";
    problem?: string | null;
  };
  /** Tasks that only mention the issue. */
  mentioned?: { title: string; status: string }[];
  /** The questions the work's own task has raised (served from the questions read). */
  questions?: {
    status: "open" | "answered" | "expired";
    prompt: string;
    /** How long ago it was asked; 25 minutes by default. */
    minutesAgo?: number;
    kind?: "question" | "approval";
  }[];
  /** Questions cannot be read (the read answers an error). */
  questionsFail?: boolean;
};

export type Options = {
  /**
   * The batches the server lists (as `batch()` of batches-fixture builds them);
   * giving any also gives the person `batch:read`, which the notice needs.
   */
  batches?: readonly { repositoryId: string }[];
  work?: WorkSeed;
  /** The work that exists once somebody else's start has been refused (start: "alreadyRunning"). */
  workWhenRunning?: WorkSeed;
  open?: Seed[];
  closed?: Seed[];
  sources?: "none" | "healthy" | "degraded" | "authRequired" | "unknown";
  pageSize?: number;
  /** The person's role in the organization; an administrator by default. */
  role?: "admin" | "developer" | "viewer";
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

/**
 * Turns a list filter on. A click before the page is ready does nothing, so
 * the filter's being on is what is waited for, not the click.
 */
export async function chooseFilter(page: Page, name: string) {
  const radio = page.getByRole("radio", { name });
  await expect(async () => {
    await radio.click({ force: true });
    await expect(radio).toBeChecked({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

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
    /** Retries of Bakery's note on the issue. */
    resyncs: 0,
  };
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: options.role ?? "admin",
          capabilities: options.batches === undefined ? [] : ["batch:read"],
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/v1/batches",
    (route) => {
      const repository = new URL(route.request().url()).searchParams.get(
        "repositoryId",
      );
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: (options.batches ?? []).filter((batch) =>
            repository === null || batch.repositoryId === repository
          ),
          nextCursor: null,
        }),
      });
    },
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
  const work = options.work ?? options.workWhenRunning;
  // The work is read from the server only once it exists: from the start, or after the refused start.
  const exists = () => options.work !== undefined || seen.running.size > 0;
  const stamp = "2026-01-01T00:00:00.000Z";
  const issueId = work ? uuid(work.issue) : null;
  const linkId = uuid(8000);
  const taskId = uuid(8100);
  const targets = (work?.targets ?? []).map((target, index) => ({
    ...target,
    repositoryId: uuid(8200 + index),
    childTaskId: uuid(8300 + index),
  }));
  const tasks = new Map<string, Record<string, unknown>>();
  const taskRow = (id: string, title: string, status: string) => ({
    id,
    applicationId: uuid(904),
    repositoryId: null,
    conversationId: uuid(8400),
    parentTaskId: null,
    title,
    description: "",
    taskType: "task",
    status,
    priority: 50,
    createdBy: MOCK_PRINCIPAL_ID,
    currentRunId: null,
    archivedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
    repositoryProfileId: null,
    repositoryProfileRevision: null,
    repositoryProfileDigest: null,
    observationId: null,
    observationDigest: null,
    baseSha: null,
    approvalPolicy: null,
    planningOnly: false,
  });
  if (work) {
    tasks.set(
      taskId,
      taskRow(taskId, "Fix the login redirect", "active"),
    );
    targets.forEach((target) =>
      tasks.set(
        target.childTaskId,
        taskRow(target.childTaskId, target.role, target.status ?? "active"),
      )
    );
  }
  const mentionedLinks = (work?.mentioned ?? []).map((entry, index) => {
    const id = uuid(8500 + index);
    tasks.set(id, taskRow(id, entry.title, entry.status));
    return {
      id: uuid(8600 + index),
      organizationId: MOCK_ORGANIZATION_ID,
      externalTicketId: issueId,
      taskId: id,
      role: "reference",
      statusCommentExternalId: null,
      lastSyncedRunRevision: null,
      syncHealth: "unknown",
      lastProblemCode: null,
      createdAt: stamp,
      updatedAt: stamp,
      version: 1,
    };
  });
  let note = work?.note ?? { health: "healthy" as const };
  const page_ = (items: unknown[]) =>
    JSON.stringify({ items, nextCursor: null });
  const ownLink = () => ({
    id: linkId,
    organizationId: MOCK_ORGANIZATION_ID,
    externalTicketId: issueId,
    taskId,
    role: "primary",
    statusCommentExternalId: note.health === "unknown" ? null : "note-1",
    lastSyncedRunRevision: null,
    syncHealth: note.health,
    lastProblemCode: note.problem ?? null,
    createdAt: stamp,
    updatedAt: stamp,
    version: 3,
  });
  await page.route(
    (url) => url.pathname === "/v1/ticket-requests",
    (route) => {
      const asked = new URL(route.request().url()).searchParams.get(
        "externalTicketId",
      );
      const items = work && exists() && asked === issueId
        ? [{
          id: uuid(8700),
          externalTicketId: issueId,
          ticketTaskLinkId: linkId,
          intent: "start",
          origin: work.origin ?? "manual",
          requestedByPrincipalId: (work.origin ?? "manual") === "webhook" ||
              (work.origin ?? "manual") === "poll"
            ? null
            : work.byMe === "unlisted"
            ? uuid(8801)
            : work.byMe === false
            ? uuid(8800)
            : MOCK_PRINCIPAL_ID,
          triggerLabelName: work.triggerLabel ?? null,
          disposition: work.progress === "active" ? "active" : work.progress,
          dispositionReasonCode: work.reason ?? null,
          pausedAt: work.pausedReason ? stamp : null,
          pausedReason: work.pausedReason ?? null,
          progress: work.progress,
          workflowRunId: null,
          createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          updatedAt: stamp,
          version: 1,
          targets: targets.map((target) => ({
            repositoryId: target.repositoryId,
            role: target.role,
            routingRuleId: null,
            routingRuleVersion: null,
            childTaskId: target.childTaskId,
          })),
        }]
        : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: page_(items),
      });
    },
  );
  const member = (principalId: string, displayName: string, index: number) => ({
    id: uuid(9100 + index),
    organizationId: MOCK_ORGANIZATION_ID,
    principalId,
    displayName,
    role: "developer",
    status: "active",
    joinedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
  });
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/memberships**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: page_([
          member(MOCK_PRINCIPAL_ID, "Fixture Admin", 0),
          member(uuid(8800), "Ana Reyes", 1),
        ]),
      }),
  );
  await page.route(
    (url) => url.pathname === "/v1/ticket-task-links",
    (route) => {
      const asked = new URL(route.request().url()).searchParams.get(
        "externalTicketId",
      );
      const items = work && exists() && asked === issueId
        ? [ownLink(), ...mentionedLinks]
        : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: page_(items),
      });
    },
  );
  await page.route(
    (url) => /^\/v1\/ticket-task-links\/[^/]+\/note-syncs$/.test(url.pathname),
    (route) => {
      seen.resyncs += 1;
      note = { health: "healthy" };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownLink()),
      });
    },
  );
  await page.route(
    (url) => /^\/v1\/tasks\/[^/]+$/.test(url.pathname),
    (route) => {
      const row = tasks.get(
        new URL(route.request().url()).pathname.split("/")[3]!,
      );
      return route.fulfill(
        row
          ? {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(row),
          }
          : problem(404, "NOT_FOUND"),
      );
    },
  );
  await page.route(
    (url) => /^\/v1\/repositories\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3]!;
      const target = targets.find((entry) => entry.repositoryId === id);
      // Not one of this work's repositories: leave it to a route the spec added.
      if (!target) return route.fallback();
      return route.fulfill(
        target
          ? {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id,
              applicationId: uuid(904),
              slug: null,
              integrationConnectionId: uuid(901),
              providerRepoId: id,
              owner: "acme",
              name: target.repository,
              defaultBranch: "main",
              activeProfileId: null,
              archivedAt: null,
              createdAt: stamp,
              updatedAt: stamp,
              nextProfileRevision: 1,
              standing: "ready",
              version: 1,
            }),
          }
          : problem(404, "NOT_FOUND"),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/pull-requests",
    (route) => {
      const asked = new URL(route.request().url()).searchParams.get("taskId");
      const target = targets.find((entry) => entry.childTaskId === asked);
      const items = (target?.pulls ?? []).map((pull) => ({
        id: uuid(8900 + pull.number),
        taskId: asked,
        repositoryId: target!.repositoryId,
        providerNumber: pull.number,
        url: `https://github.com/acme/${
          target!.repository
        }/pull/${pull.number}`,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        status: pull.status,
        mergedSha: pull.status === "merged" ? "c".repeat(40) : null,
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
        runId: null,
        mayMerge: false,
        mergeMethod: "squash",
        targetBranch: "main",
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: page_(items),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/questions",
    (route) => {
      if (work?.questionsFail) {
        return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
      }
      const params = new URL(route.request().url()).searchParams;
      const asked = params.get("taskId");
      const all = asked === taskId
        ? (work?.questions ?? []).map((question, index) => ({
          id: uuid(8950 + index),
          kind: question.kind ?? "question",
          conversationId: uuid(8400),
          taskId,
          runId: null,
          turnId: null,
          generation: 1,
          prompt: question.prompt,
          options: null,
          allowFreeText: true,
          audience: { type: "task_participants" },
          expiresAt: null,
          status: question.status,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: new Date(
            Date.now() - (question.minutesAgo ?? 25) * 60_000,
          ).toISOString(),
          updatedAt: stamp,
          version: 1,
          responseSchema: null,
        }))
        : [];
      // As the server answers: newest first, filtered by status, one page at a
      // time (25 unless asked, at most 100), with a cursor to the next page.
      const status = params.get("status");
      const matching = all
        .filter((question) => status === null || question.status === status)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const limit = Math.min(Number(params.get("limit") ?? 25), 100);
      const start = Number(params.get("cursor") ?? 0);
      const items = matching.slice(start, start + limit);
      const end = start + items.length;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items,
          nextCursor: end < matching.length ? String(end) : null,
        }),
      });
    },
  );
  return seen;
}
