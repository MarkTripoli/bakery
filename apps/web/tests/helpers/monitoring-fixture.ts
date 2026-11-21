import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** Stubs for the Monitoring page: the kinds, the measurements, the destinations and every change. */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAMP = "2026-11-20T09:00:00.000Z";

const KIND = {
  kind: "otlp",
  label: "OpenTelemetry",
  fields: [
    {
      name: "address",
      label: "Address",
      help: "Bakery adds /v1/traces and /v1/metrics. Must be https.",
      secret: false,
      required: true,
    },
    {
      name: "headerName",
      label: "Sign-in header name",
      help:
        "For example Authorization. Leave empty when the address needs none.",
      secret: false,
      required: false,
    },
    {
      name: "headerValue",
      label: "Sign-in header value",
      help:
        "Stored encrypted. It is never shown again after you save; you can only replace it.",
      secret: true,
      required: false,
    },
  ],
  measurements: ["results", "health"],
  unavailableReasons: {
    cost: "Bakery does not send this yet.",
    durations: "Bakery does not send this yet.",
    skills: "Bakery does not send this yet.",
    errors: "OpenTelemetry destinations receive errors as part of traces.",
  },
};

const PROVIDERS = [
  {
    key: "opentelemetry",
    name: "OpenTelemetry",
    description:
      "Any collector or service that accepts OpenTelemetry over HTTPS.",
    kind: "otlp",
    prefill: {},
  },
  {
    key: "grafana",
    name: "Grafana",
    description:
      "Send timings and health to Grafana Cloud or your own Grafana stack.",
    kind: "otlp",
    prefill: {},
  },
  {
    key: "datadog",
    name: "Datadog",
    description: "Send timings and health to Datadog.",
    kind: "otlp",
    prefill: {},
  },
  {
    key: "honeycomb",
    name: "Honeycomb",
    description: "Send timings and health to Honeycomb.",
    kind: "otlp",
    prefill: {
      address: "https://api.honeycomb.io",
      headerName: "x-honeycomb-team",
    },
  },
  {
    key: "sentry",
    name: "Sentry",
    description: "Send timings and health to Sentry.",
    kind: "otlp",
    prefill: {},
  },
];

const MEASUREMENTS = [
  {
    kind: "cost",
    label: "Cost and token use",
    help: "The cost and tokens of each use.",
  },
  {
    kind: "durations",
    label: "How long work takes",
    help: "How long each job takes.",
  },
  {
    kind: "results",
    label: "Workflow results",
    help: "How each job ended: completed, failed or canceled.",
  },
  {
    kind: "skills",
    label: "Skills used",
    help: "The names of the skills a run used.",
  },
  {
    kind: "health",
    label: "System health",
    help:
      "Queue age, leases and retries, and measurements Bakery could not send.",
  },
  {
    kind: "errors",
    label: "Errors",
    help:
      "Failures inside Bakery, with where they happened. Never prompts, code or diffs.",
  },
];

type Destination = Record<string, unknown> & { id: string; version: number };

const destination = (
  n: number,
  extra: Record<string, unknown>,
): Destination => ({
  id: uuid(n),
  kind: "otlp",
  provider: "opentelemetry",
  name: `Destination ${n}`,
  enabled: true,
  measurements: ["results", "health"],
  settings: {
    address: `https://collector${n}.example.com`,
    headerName: "Authorization",
  },
  secretFieldsSet: ["headerValue"],
  credentialUpdatedAt: "2026-11-01T09:00:00.000Z",
  state: "working",
  lastAcceptedAt: STAMP,
  lastAnswerAt: STAMP,
  lastAnswerOk: true,
  lastAnswerReason: null,
  dropped: 0,
  droppedSince: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 2,
  ...extra,
});

export type MonitoringOptions = {
  /** Start with nothing set up. */
  empty?: boolean;
  /** Add this many working destinations after the usual ones, to fill more than a page. */
  extra?: number;
  /** Offer only this many providers, to skip the chooser with one. */
  providers?: number;
  /** The first save is refused with 412 after someone else changed the destination's name. */
  conflictOnce?: boolean;
  /** Grafana Cloud has lost records but no first-lost time is known. */
  droppedWithoutTime?: boolean;
  /** The status the next create answers with, and its problem body. */
  createProblem?: { status: number; body: unknown };
  /** Hold the answer to a remove until the test calls `releaseDelete`. */
  holdDelete?: boolean;
  /** What the next test answers with. */
  testResult?: Record<string, unknown>;
};

export type Seen = {
  method: string;
  path: string;
  ifMatch: string | null;
  body: Record<string, unknown> | null;
};

/** Stubs the session and every Monitoring read and write; returns what it saw. */
export async function monitoringFixture(
  page: Page,
  options: MonitoringOptions = {},
) {
  await mockAuthenticatedSession(page);
  // The shell asks what this person may do to decide which links to draw; an
  // unstubbed read answers 401 here and signs the page out.
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
  const items: Destination[] = options.empty ? [] : [
    destination(1, {
      name: "Grafana Cloud",
      provider: "grafana",
      ...(options.droppedWithoutTime ? { dropped: 3, droppedSince: null } : {}),
    }),
    destination(4, { name: "Errors, production", provider: "sentry" }),
    destination(2, {
      name: "Honeycomb",
      provider: "honeycomb",
      state: "failing",
      lastAnswerOk: false,
      lastAnswerReason: "The destination answered 401.",
      lastAcceptedAt: "2026-11-19T09:00:00.000Z",
      dropped: 14,
      droppedSince: "2026-11-19T10:00:00.000Z",
    }),
    destination(3, { name: "Old collector", enabled: false, state: "off" }),
    ...Array.from(
      { length: options.extra ?? 0 },
      (_, index) =>
        destination(100 + index, {
          name: `Collector ${String(index + 1).padStart(2, "0")}`,
        }),
    ),
  ];
  const providers = PROVIDERS.slice(0, options.providers ?? PROVIDERS.length);
  const rank = (state: unknown) =>
    state === "failing" ? 0 : state === "dropping_data" ? 1 : 2;
  const ordered = () =>
    [...items].sort((a, b) =>
      rank(a.state) - rank(b.state) ||
      String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase())
    );
  const counts = () => {
    const by = (state: string) =>
      items.filter((item) => item.state === state).length;
    return {
      all: items.length,
      working: by("working"),
      not_tested_yet: by("not_tested_yet"),
      failing: by("failing"),
      dropping_data: by("dropping_data"),
      off: by("off"),
    };
  };
  const seen: Seen[] = [];
  let createProblem = options.createProblem;
  let conflictOnce = options.conflictOnce === true;
  let releaseDelete: () => void = () => {};
  const deleteHeld = options.holdDelete === true
    ? new Promise<void>((resolve) => {
      releaseDelete = resolve;
    })
    : null;
  const record = (route: import("@playwright/test").Route) => {
    const request = route.request();
    seen.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      ifMatch: request.headers()["if-match"] ?? null,
      body: request.method() === "GET" || request.method() === "DELETE"
        ? null
        : request.postDataJSON() as Record<string, unknown>,
    });
    return request;
  };
  await page.route(
    (url) => url.pathname === "/v1/installation/telemetry-destinations",
    (route) => {
      const request = record(route);
      if (request.method() === "POST") {
        if (createProblem !== undefined) {
          const problem = createProblem;
          createProblem = undefined;
          return route.fulfill({
            status: problem.status,
            contentType: "application/problem+json",
            body: JSON.stringify(problem.body),
          });
        }
        const input = request.postDataJSON() as Record<string, unknown>;
        const made = destination(items.length + 10, {
          name: input.name,
          kind: input.kind,
          provider: input.provider ?? "opentelemetry",
          measurements: input.measurements,
          settings: input.values,
          secretFieldsSet: [],
          credentialUpdatedAt: null,
          state: "not_tested_yet",
          lastAcceptedAt: null,
          version: 1,
        });
        items.push(made);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(made),
        });
      }
      const query = new URL(request.url()).searchParams;
      const search = (query.get("search") ?? "").toLowerCase();
      const matching = ordered().filter((item) =>
        (query.get("state") === null || item.state === query.get("state")) &&
        (query.get("provider") === null ||
          item.provider === query.get("provider")) &&
        (query.get("kind") === null || item.kind === query.get("kind")) &&
        (search === "" || String(item.name).toLowerCase().includes(search))
      );
      const limit = Number(query.get("limit") ?? 25);
      const from = Number(query.get("cursor") ?? 0);
      const page = matching.slice(from, from + limit);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kinds: [KIND],
          measurements: MEASUREMENTS,
          providers,
          destinations: page,
          destinationLimit: 200,
          nextCursor: from + limit < matching.length
            ? String(from + limit)
            : null,
          total: matching.length,
          stateCounts: counts(),
        }),
      });
    },
  );
  await page.route(
    /\/v1\/installation\/telemetry-destinations\/[^/]+$/,
    async (route) => {
      const request = record(route);
      const id = new URL(request.url()).pathname.split("/").pop();
      const at = items.findIndex((item) => item.id === id);
      if (request.method() === "GET") {
        if (at < 0) {
          return route.fulfill({
            status: 404,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/not_found",
              title: "Not found",
              status: 404,
              detail: "Not found",
              code: "NOT_FOUND",
              requestId: "00000000-0000-4000-8000-0000000000e1",
              traceId: "00000000-0000-4000-8000-0000000000e2",
              retryable: false,
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            destination: items[at],
            kind: KIND,
            provider: PROVIDERS.find((entry) =>
              entry.key === items[at].provider
            ) ?? null,
            measurements: MEASUREMENTS,
          }),
        });
      }
      if (request.method() === "DELETE") {
        await deleteHeld;
        items.splice(at, 1);
        return route.fulfill({ status: 204 });
      }
      const input = request.postDataJSON() as Record<string, unknown>;
      if (conflictOnce && input.name !== undefined) {
        conflictOnce = false;
        items[at].name = "Changed elsewhere";
        items[at].version = items[at].version + 1;
        return route.fulfill({
          status: 412,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/precondition_failed",
            title: "Precondition failed",
            status: 412,
            detail: "The destination changed.",
            code: "PRECONDITION_FAILED",
            requestId: "00000000-0000-4000-8000-0000000000e1",
            traceId: "00000000-0000-4000-8000-0000000000e2",
            retryable: false,
          }),
        });
      }
      Object.assign(
        items[at],
        input.enabled === undefined ? {} : {
          enabled: input.enabled,
          state: input.enabled ? "working" : "off",
        },
        input.name === undefined ? {} : { name: input.name },
        { version: items[at].version + 1 },
      );
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(items[at]),
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/installation/telemetry-destination-tests",
    (route) => {
      record(route);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          options.testResult ??
            { ok: true, status: 200, reason: null, answer: null, tookMs: 84 },
        ),
      });
    },
  );
  return { seen, items, releaseDelete: () => releaseDelete() };
}
