import { assert, assertEquals } from "@std/assert";
import {
  formatRestartLineageDiagnostic,
  MAX_RESTART_LINEAGE_DIAGNOSTIC_BYTES,
} from "../helpers/restart-lineage.ts";

Deno.test("restart lineage diagnostic keeps only bounded allow-listed metadata", () => {
  const secret = "postgres://operator:secret@host/database";
  const diagnostic = formatRestartLineageDiagnostic({
    ownerGeneration: "2",
    invocationCount: 9,
    requestCount: 2,
    archiveBytes: secret,
    invocations: Array.from({ length: 9 }, (_, index) => ({
      functionSlug: "bakery-fixed-workflow",
      functionRunId: index.toString(16).padStart(32, "0"),
      eventId: `01TESTEVENT${index}`,
      eventInternalId: index.toString(16).padStart(32, "1"),
      originalRunId: null,
      finishStatus: "Completed",
      sessionToken: secret,
    })),
    requests: [{
      requestEventId: "018f6f50-7a0d-7c29-8bc8-e4ab19399f2a",
      deliveryKey: "run:018f6f50-7a0d-7c29-8bc8-e4ab19399f2a:version:21",
      deliveryStatus: "delivered",
      attempts: 1,
      sourcePath: secret,
    }],
  });
  const parsed = JSON.parse(diagnostic);

  assertEquals(parsed.invocations.length, 8);
  assertEquals(parsed.requests.length, 1);
  assertEquals(parsed.invocationCount, 9);
  assertEquals(parsed.requestCount, 2);
  assert(!diagnostic.includes(secret));
  assert(!diagnostic.includes("archiveBytes"));
  assert(!diagnostic.includes("sessionToken"));
  assert(!diagnostic.includes("sourcePath"));
  assert(
    new TextEncoder().encode(diagnostic).byteLength <=
      MAX_RESTART_LINEAGE_DIAGNOSTIC_BYTES,
  );
});

Deno.test("restart lineage diagnostic replaces unsafe values", () => {
  const diagnostic = formatRestartLineageDiagnostic({
    ownerGeneration: "../../secret",
    invocationCount: -1,
    requestCount: 1,
    invocations: [{
      functionSlug: "fixed workflow token=secret",
      functionRunId: "not-hex",
      eventId: "event id with spaces",
      eventInternalId: "/tmp/private",
      originalRunId: "token",
      startedAt: "yesterday; secret",
      finishStatus: "Completed; secret",
    }],
    lease: {
      expiresAt: "soon",
      updatedAt: "/tmp/private",
      databaseNow: "secret",
      remainingMs: 86_400_001,
    },
    requests: [{
      requestEventId: "not-a-uuid",
      deliveryKey: "key with spaces",
      deliveryStatus: "unknown",
      attempts: 101,
    }],
  });

  assert(!diagnostic.includes("secret"));
  assert(!diagnostic.includes("/tmp/private"));
  assertEquals(JSON.parse(diagnostic), {
    ownerGeneration: "[invalid]",
    invocationCount: "[invalid]",
    requestCount: 1,
    lease: {
      expiresAt: "[invalid]",
      updatedAt: "[invalid]",
      databaseNow: "[invalid]",
      remainingMs: "[invalid]",
    },
    invocations: [{
      functionSlug: "[invalid]",
      functionRunId: "[invalid]",
      eventId: "[invalid]",
      eventInternalId: "[invalid]",
      originalRunId: "[invalid]",
      startedAt: "[invalid]",
      finishStatus: "[invalid]",
      source: "recovery-or-other",
    }],
    requests: [{
      requestEventId: "[invalid]",
      deliveryKey: "[invalid]",
      deliveryStatus: "[invalid]",
      attempts: "[invalid]",
    }],
  });
});

Deno.test("restart lineage diagnostic labels a lapsed lease and its recovery invocation", () => {
  const runId = "48e55aa2-85d6-4839-96fc-6aa8da8cc9d9";
  const invocation = (eventId: string, startedAt: string, finish: string) => ({
    functionSlug: "bakery-server-bakery-fixed-workflow",
    functionRunId: "01a19ba8813898c99642811f44c5cb0c",
    eventId,
    eventInternalId: "01a19ba881195587fe84a52da4351f50",
    originalRunId: null,
    startedAt,
    finishStatus: finish,
  });
  const delivery = (deliveryKey: string) => ({
    requestEventId: "59487f5d-ac93-4d1e-a78d-7dcc54b421e5",
    deliveryKey,
    deliveryStatus: "delivered",
    attempts: 1,
  });
  const parsed = JSON.parse(formatRestartLineageDiagnostic({
    ownerGeneration: "3",
    invocationCount: 3,
    requestCount: 2,
    lease: {
      expiresAt: "2026-11-02T09:49:20.658123+00:00",
      updatedAt: "2026-11-02T09:49:00.658123+00:00",
      databaseNow: "2026-11-02T09:49:41.527171+00:00",
      remainingMs: -20_869,
    },
    invocations: [
      invocation(
        `issue40-recovery-${runId}`,
        "2026-11-02T09:47:25.100000",
        "Completed",
      ),
      invocation(
        "01M6DTK1BJMQXGW3DNNJX7GG78",
        "2026-11-02T09:49:00.700000",
        "Completed",
      ),
      invocation(
        `run:${runId}:version:37`,
        "2026-11-02T09:49:30.000000",
        "running",
      ),
    ],
    requests: [
      delivery(`issue40-recovery-${runId}`),
      delivery(`run:${runId}:version:37`),
    ],
  }));

  assertEquals(
    parsed.invocations.map((row: { source: string }) => row.source),
    ["outbox", "recovery-or-other", "outbox"],
  );
  assertEquals(parsed.lease, {
    expiresAt: "2026-11-02T09:49:20.658123+00:00",
    updatedAt: "2026-11-02T09:49:00.658123+00:00",
    databaseNow: "2026-11-02T09:49:41.527171+00:00",
    remainingMs: -20_869,
  });
  assertEquals(
    parsed.invocations[1].startedAt,
    "2026-11-02T09:49:00.700000",
  );
});

Deno.test("restart lineage diagnostic keeps a missing lease expiry as null", () => {
  const parsed = JSON.parse(formatRestartLineageDiagnostic({
    ownerGeneration: "2",
    invocationCount: 0,
    requestCount: 0,
    lease: {
      expiresAt: null,
      updatedAt: "2026-11-02T09:49:00+00:00",
      databaseNow: "2026-11-02T09:49:01Z",
      remainingMs: null,
    },
  }));

  assertEquals(parsed.lease, {
    expiresAt: null,
    updatedAt: "2026-11-02T09:49:00+00:00",
    databaseNow: "2026-11-02T09:49:01Z",
    remainingMs: null,
  });
});
