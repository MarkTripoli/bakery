import { assert, assertEquals } from "@std/assert";
import {
  classifyAttemptFault,
  recordAttemptRouteEvidence,
} from "../../apps/server/src/modules/execution/attempt-route-evidence.ts";

/**
 * A real attempt's answer as provider route evidence, without a database (#70).
 *
 * The probe can never say quota is spent or a credential is invalid; an attempt
 * can. These tests pin the classification, that an attempt proving nothing reads
 * and writes nothing, and that the evidence reaches the one incident writer under
 * the attempt's watermark with the route's own generation and schedule.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const ROUTE = "44444444-4444-4444-8444-444444444444";
const INCIDENT = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-20T12:00:00.000Z");
const NEXT = new Date("2026-11-20T12:05:00.000Z");

type Statement = { sql: string; values: readonly unknown[] };

function stand(world: {
  routes?: Record<string, unknown>[];
  route?: Record<string, unknown>;
  incident?: Record<string, unknown>;
}) {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      if (/from bakery\.jobs as j/.test(sql)) {
        return Promise.resolve({ rows: world.routes ?? [] });
      }
      if (/from bakery\.provider_routes\s+where/.test(sql)) {
        return Promise.resolve({ rows: world.route ? [world.route] : [] });
      }
      if (/from bakery\.provider_incidents/.test(sql)) {
        return Promise.resolve({
          rows: world.incident ? [world.incident] : [],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { transaction: transaction as never, recorded };
}

const matched = { id: ROUTE, incident_generation: 3, next_probe_at: NEXT };
const activeRoute = (overrides: Record<string, unknown> = {}) => ({
  status: "active",
  health: "healthy",
  incident_id: null,
  incident_generation: 3,
  inference_verified_at: null,
  ...overrides,
});
const attempt = (
  status: "completed" | "failed" | "canceled",
  fault: unknown = undefined,
) => ({
  organizationId: ORG,
  jobId: JOB,
  attemptId: ATTEMPT,
  status,
  fault,
  observedAt: NOW,
});

Deno.test("exhausted quota and an invalid credential are classified; nothing else is", () => {
  assertEquals(classifyAttemptFault({ code: "quota_exceeded" }), {
    reason: "quota_exhausted",
    severity: "outage",
  });
  assertEquals(
    classifyAttemptFault({ code: "quota_exhausted" })?.reason,
    "quota_exhausted",
  );
  for (
    const code of [
      "credential_invalid",
      "HARNESS_CREDENTIAL_FILE_INVALID",
      "CODEX_HARNESS_AUTH_FILE_INVALID",
      "PI_HARNESS_AUTH_SOURCE_INVALID",
    ]
  ) {
    assertEquals(
      classifyAttemptFault({ code })?.reason,
      "credential_invalid",
      code,
    );
  }
  // The worker's own setup, a timeout or an exit code say nothing about the route.
  for (
    const fault of [
      { code: "CLAUDE_HARNESS_AUTH_UNAVAILABLE" },
      { code: "WORKER_CREDENTIAL_MISSING" },
      { code: "CLAUDE_HARNESS_TIMEOUT" },
      { code: "CLAUDE_HARNESS_EXIT_NONZERO" },
      { code: 429 },
      {},
      null,
      "quota_exceeded",
      undefined,
    ]
  ) {
    assertEquals(classifyAttemptFault(fault), null, JSON.stringify(fault));
  }
});

Deno.test("an attempt that proves nothing reads no route and writes nothing", async () => {
  for (
    const input of [
      attempt("canceled"),
      attempt("failed", { code: "CLAUDE_HARNESS_TIMEOUT" }),
      attempt("failed", undefined),
    ]
  ) {
    const { transaction, recorded } = stand({ routes: [matched] });
    assertEquals(await recordAttemptRouteEvidence(transaction, input), []);
    assertEquals(recorded.length, 0);
  }
});

Deno.test("routes are matched on the job's whole pin, account included, inside the organization", async () => {
  const { transaction, recorded } = stand({ routes: [] });
  assertEquals(
    await recordAttemptRouteEvidence(transaction, attempt("completed")),
    [],
  );
  assertEquals(recorded.length, 1);
  const { sql, values } = recorded[0]!;
  assertEquals(values, [ORG, JOB]);
  for (
    const clause of [
      "pr.status = 'active'",
      "pr.provider = j.billing->>'provider'",
      "pr.model = j.billing->>'model'",
      "pr.harness = j.agent_config->>'harness'",
      "a.billing_identity = j.billing->>'billingAccountId'",
    ]
  ) assert(sql.includes(clause), clause);
});

Deno.test("exhausted quota opens an incident on the matched route with the attempt as evidence", async () => {
  const { transaction, recorded } = stand({
    routes: [matched],
    route: activeRoute(),
  });
  const [result] = await recordAttemptRouteEvidence(
    transaction,
    attempt("failed", { code: "quota_exceeded" }),
  );
  assertEquals(result?.kind, "opened");
  const insert = recorded.find(({ sql }) =>
    /insert into bakery\.provider_incidents/.test(sql)
  )!;
  // severity, reason, observed time, watermark, and the route's own schedule.
  assertEquals(insert.values.slice(4, 9), [
    "outage",
    "quota_exhausted",
    NOW,
    `attempt:${ATTEMPT}`,
    NEXT,
  ]);
});

Deno.test("a completed attempt is the proven inference that closes an open incident", async () => {
  const { transaction, recorded } = stand({
    routes: [matched],
    route: activeRoute({ health: "open", incident_id: INCIDENT }),
    incident: { id: INCIDENT, generation: 3, severity: "outage" },
  });
  const [result] = await recordAttemptRouteEvidence(
    transaction,
    attempt("completed"),
  );
  assertEquals(result, {
    kind: "recovered",
    incidentId: INCIDENT,
    generation: 3,
  });
  assert(
    recorded.some(({ sql }) => /set status = 'recovered'/.test(sql)),
  );
});
