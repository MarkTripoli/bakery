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
  /** The status the next create answers with, and its problem body. */
  createProblem?: { status: number; body: unknown };
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
    destination(1, { name: "Grafana Cloud" }),
    destination(2, {
      name: "Honeycomb",
      state: "failing",
      lastAnswerOk: false,
      lastAnswerReason: "The destination answered 401.",
      lastAcceptedAt: "2026-11-19T09:00:00.000Z",
      dropped: 14,
      droppedSince: "2026-11-19T10:00:00.000Z",
    }),
    destination(3, { name: "Old collector", enabled: false, state: "off" }),
  ];
  const seen: Seen[] = [];
  let createProblem = options.createProblem;
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
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kinds: [KIND],
          measurements: MEASUREMENTS,
          destinations: items,
        }),
      });
    },
  );
  await page.route(
    /\/v1\/installation\/telemetry-destinations\/[^/]+$/,
    (route) => {
      const request = record(route);
      const id = new URL(request.url()).pathname.split("/").pop();
      const at = items.findIndex((item) => item.id === id);
      if (request.method() === "DELETE") {
        items.splice(at, 1);
        return route.fulfill({ status: 204 });
      }
      const input = request.postDataJSON() as Record<string, unknown>;
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
  return { seen, items };
}
