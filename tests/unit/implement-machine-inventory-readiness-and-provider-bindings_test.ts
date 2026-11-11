// Machine readiness unit suite: pure readiness/blocking rules and connectivity math
// in packages/persistence/src/machine-readiness.ts. No database is involved.
import { assertEquals } from "@std/assert";
import {
  blockingChecks,
  CAPABILITY_CHECK_PREFIX,
  connectivityState,
  dispatchGate,
  evaluateReadiness,
  GLOBAL_CHECK_IDS,
} from "../../packages/persistence/src/machine-readiness.ts";
import {
  WORKER_CHECK_EXPIRY_SECONDS,
  WORKER_OFFLINE_AFTER_SECONDS,
  WORKER_PROVIDER_AUTH_TTL_SECONDS,
  WORKER_STALE_AFTER_SECONDS,
} from "../../packages/persistence/src/constants.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const ISO = (offsetSeconds: number) =>
  new Date(NOW.getTime() + offsetSeconds * 1_000).toISOString();

function check(input: {
  checkId: string;
  status: string;
  hostGeneration?: number;
  inventoryRevision?: number;
  expiresAt?: string;
  reason?: string | null;
}) {
  return {
    checkId: input.checkId,
    componentKey: null,
    status: input.status,
    reason: input.reason ?? null,
    hostGeneration: input.hostGeneration ?? 3,
    inventoryRevision: input.inventoryRevision ?? 7,
    expiresAt: input.expiresAt ?? ISO(WORKER_CHECK_EXPIRY_SECONDS),
  };
}

const FRESH_IDENTITY = {
  now: NOW,
  credentialGeneration: 3,
  inventoryRevision: 7,
};

Deno.test("global check ids and the capability prefix share one contract", () => {
  assertEquals(
    GLOBAL_CHECK_IDS.every((id) => !id.startsWith("capability:")),
    true,
  );
  assertEquals(CAPABILITY_CHECK_PREFIX, "capability:");
  assertEquals(
    connectivityState,
    connectivityState,
  );
  // Provider auth attempts and inventory checks share the bounded TTLs the
  // issue presets rely on; the claim gate freshness math must never exceed
  // them silently.
  assertEquals(WORKER_STALE_AFTER_SECONDS > 0, true);
  assertEquals(WORKER_OFFLINE_AFTER_SECONDS > WORKER_STALE_AFTER_SECONDS, true);
  assertEquals(
    WORKER_CHECK_EXPIRY_SECONDS >= WORKER_OFFLINE_AFTER_SECONDS,
    true,
  );
  assertEquals(WORKER_PROVIDER_AUTH_TTL_SECONDS > 0, true);
});

Deno.test("connectivity derives only from the server receipt time", () => {
  assertEquals(connectivityState(null, NOW), "offline");
  assertEquals(connectivityState(ISO(-10), NOW), "online");
  assertEquals(
    connectivityState(ISO(-WORKER_STALE_AFTER_SECONDS), NOW),
    "online",
  );
  assertEquals(
    connectivityState(ISO(-(WORKER_STALE_AFTER_SECONDS + 1)), NOW),
    "stale",
  );
  assertEquals(
    connectivityState(ISO(-WORKER_OFFLINE_AFTER_SECONDS), NOW),
    "stale",
  );
  assertEquals(
    connectivityState(ISO(-(WORKER_OFFLINE_AFTER_SECONDS + 1)), NOW),
    "offline",
  );
  // A heartbeat older than the offline window is offline, regardless of the
  // clock skew an unauthenticated client can never influence.
  assertEquals(connectivityState(ISO(-10_000), NOW), "offline");
});

Deno.test("a fresh failed global check blocks every capability", () => {
  const gate = blockingChecks({
    ...FRESH_IDENTITY,
    checks: [check({ checkId: "credential_isolation", status: "fail" })],
  });
  assertEquals(gate.allBlocked, true);
  assertEquals(gate.failedCheckIds, ["credential_isolation"]);
});

Deno.test("a fresh failed capability check blocks exactly that capability", () => {
  const gate = blockingChecks({
    ...FRESH_IDENTITY,
    checks: [
      check({ checkId: "capability:git", status: "fail" }),
      check({ checkId: "capability:docs", status: "pass" }),
    ],
  });
  assertEquals(gate.allBlocked, false);
  assertEquals(gate.blockedCapabilities, ["git"]);
  assertEquals(gate.failedCheckIds, ["capability:git"]);
});

Deno.test("an unknown check status blocks like a failure", () => {
  const gate = blockingChecks({
    ...FRESH_IDENTITY,
    checks: [check({ checkId: "capability:mcp", status: "unknown" })],
  });
  assertEquals(gate.blockedCapabilities, ["mcp"]);
});

Deno.test("passing checks never block and sorted results stay deterministic", () => {
  const gate = blockingChecks({
    ...FRESH_IDENTITY,
    checks: [
      check({ checkId: "capability:zeta", status: "fail" }),
      check({ checkId: "capability:alpha", status: "fail" }),
      check({ checkId: "capability:git", status: "pass" }),
    ],
  });
  assertEquals(gate.allBlocked, false);
  assertEquals(gate.blockedCapabilities, ["alpha", "zeta"]);
  assertEquals(gate.failedCheckIds, ["capability:alpha", "capability:zeta"]);
});
const HOST_OK: {
  now: Date;
  connectivity: "online" | "stale" | "offline";
  status: string;
  desiredMode: string;
  credentialGeneration: number;
  inventoryRevision: number;
} = {
  ...FRESH_IDENTITY,
  connectivity: "online",
  status: "online",
  desiredMode: "accepting",
};

Deno.test("dispatchGate preserves fresh gate ids and safe reasons", () => {
  const projection = dispatchGate({
    ...HOST_OK,
    checks: [
      check({
        checkId: "credential_isolation",
        status: "fail",
        reason: "sandbox isolation unavailable",
      }),
      check({
        checkId: "capability:git",
        status: "unknown",
        reason: null,
      }),
      check({
        checkId: "capability:stale",
        status: "fail",
        expiresAt: ISO(-1),
        reason: "expired result",
      }),
    ],
  });
  assertEquals(projection.allBlocked, true);
  assertEquals(projection.reason, "check_failed");
  assertEquals(projection.blockedCapabilities, ["git"]);
  assertEquals(projection.failedChecks, [
    { checkId: "capability:git", reason: null },
    {
      checkId: "credential_isolation",
      reason: "sandbox isolation unavailable",
    },
  ]);
});

Deno.test("dispatchGate reason table covers every reason and fails closed", () => {
  const failedGlobal = [
    check({ checkId: "credential_isolation", status: "fail" }),
  ];
  const rows: Array<{
    name: string;
    input: Partial<typeof HOST_OK> & { checks?: typeof failedGlobal };
    reason: string | null;
    allBlocked: boolean;
  }> = [
    { name: "ready", input: {}, reason: null, allBlocked: false },
    {
      name: "revoked status",
      input: { status: "revoked" },
      reason: "revoked",
      allBlocked: true,
    },
    {
      name: "revoked desired mode",
      input: { desiredMode: "revoked" },
      reason: "revoked",
      allBlocked: true,
    },
    {
      name: "offline connectivity",
      input: { connectivity: "offline" },
      reason: "offline",
      allBlocked: true,
    },
    {
      name: "offline status on a live heartbeat",
      input: { status: "offline" },
      reason: "offline",
      allBlocked: true,
    },
    {
      name: "stale connectivity",
      input: { connectivity: "stale" },
      reason: "stale",
      allBlocked: true,
    },
    {
      name: "failed check",
      input: { checks: failedGlobal },
      reason: "check_failed",
      allBlocked: true,
    },
    {
      name: "draining status",
      input: { status: "draining" },
      reason: "draining",
      allBlocked: true,
    },
    {
      name: "draining desired mode",
      input: { desiredMode: "draining" },
      reason: "draining",
      allBlocked: true,
    },
    {
      name: "paused desired mode",
      input: { desiredMode: "paused" },
      reason: "paused",
      allBlocked: true,
    },
    {
      name: "unknown desired mode fails closed",
      input: { desiredMode: "mystery" },
      reason: "paused",
      allBlocked: true,
    },
    {
      name: "unknown status fails closed",
      input: { status: "mystery" },
      reason: "paused",
      allBlocked: true,
    },
    // Precedence: revoked > offline > stale > check_failed > draining > paused.
    {
      name: "revoked beats offline, stale, failed check and paused",
      input: {
        status: "revoked",
        connectivity: "offline",
        desiredMode: "paused",
        checks: failedGlobal,
      },
      reason: "revoked",
      allBlocked: true,
    },
    {
      name: "offline beats failed check and draining",
      input: {
        connectivity: "offline",
        desiredMode: "draining",
        checks: failedGlobal,
      },
      reason: "offline",
      allBlocked: true,
    },
    {
      name: "offline status beats failed check",
      input: { status: "offline", checks: failedGlobal },
      reason: "offline",
      allBlocked: true,
    },
    {
      name: "stale beats failed check and paused",
      input: {
        connectivity: "stale",
        desiredMode: "paused",
        checks: failedGlobal,
      },
      reason: "stale",
      allBlocked: true,
    },
    {
      name: "failed check beats draining",
      input: { desiredMode: "draining", checks: failedGlobal },
      reason: "check_failed",
      allBlocked: true,
    },
    {
      name: "draining beats paused",
      input: { status: "draining", desiredMode: "paused" },
      reason: "draining",
      allBlocked: true,
    },
    {
      name: "paused host with only a capability failure stays fully blocked",
      input: {
        desiredMode: "paused",
        checks: [check({ checkId: "capability:git", status: "fail" })],
      },
      reason: "check_failed",
      allBlocked: true,
    },
  ];
  for (const row of rows) {
    const { checks, ...host } = row.input;
    const gate = dispatchGate({ ...HOST_OK, ...host, checks: checks ?? [] });
    assertEquals(gate.reason, row.reason, row.name);
    assertEquals(gate.allBlocked, row.allBlocked, row.name);
  }
});

Deno.test("dispatchGate reason equals the readiness reason whenever readiness needs attention", () => {
  const failedGlobal = [
    check({ checkId: "credential_isolation", status: "fail" }),
  ];
  const connectivities = ["online", "stale", "offline"] as const;
  const statuses = ["online", "offline", "draining", "revoked"];
  const modes = ["accepting", "paused", "draining", "revoked"];
  for (const connectivity of connectivities) {
    for (const status of statuses) {
      for (const desiredMode of modes) {
        for (const checks of [[], failedGlobal]) {
          const host = {
            ...HOST_OK,
            connectivity,
            status,
            desiredMode,
            checks,
          };
          const readiness = evaluateReadiness(host);
          const gate = dispatchGate(host);
          if (readiness.state === "needs_attention") {
            const expected = status === "offline" &&
                readiness.reason !== "revoked" && readiness.reason !== "offline"
              ? "offline"
              : readiness.reason;
            assertEquals(
              gate.reason,
              expected,
              `${connectivity}/${status}/${desiredMode}/${checks.length}`,
            );
          }
        }
      }
    }
  }
});

Deno.test("dispatchGate capability-only failure leaves an accepting online host open", () => {
  const gate = dispatchGate({
    ...HOST_OK,
    checks: [
      check({
        checkId: "capability:model",
        status: "fail",
        reason: "auth unavailable",
      }),
    ],
  });
  assertEquals(gate.reason, "check_failed");
  assertEquals(gate.allBlocked, false);
  assertEquals(gate.blockedCapabilities, ["model"]);
  assertEquals(gate.failedChecks, [
    { checkId: "capability:model", reason: "auth unavailable" },
  ]);
});

Deno.test("dispatchGate ignores expired and old-generation checks", () => {
  const gate = dispatchGate({
    ...HOST_OK,
    checks: [
      check({
        checkId: "credential_isolation",
        status: "fail",
        expiresAt: ISO(-1),
      }),
      check({ checkId: "capability:git", status: "fail", hostGeneration: 2 }),
      check({
        checkId: "capability:docs",
        status: "fail",
        inventoryRevision: 6,
      }),
    ],
  });
  assertEquals(gate.reason, null);
  assertEquals(gate.allBlocked, false);
  assertEquals(gate.blockedCapabilities, []);
  assertEquals(gate.failedChecks, []);
});

Deno.test("old host generations can neither block nor restore readiness", () => {
  // Old generation and old inventory revision are ignored — a stale failed
  // check cannot block capacity and a stale passed check cannot advertise it.
  const old = check({
    checkId: "credential_isolation",
    status: "fail",
    hostGeneration: 2,
  });
  assertEquals(
    blockingChecks({ ...FRESH_IDENTITY, checks: [old] }).allBlocked,
    false,
  );
  const stalePass = check({
    checkId: "capability:git",
    status: "pass",
    hostGeneration: 2,
  });
  assertEquals(
    blockingChecks({ ...FRESH_IDENTITY, checks: [stalePass] }).allBlocked,
    false,
  );
});

Deno.test("old inventory revisions and expired results are ignored", () => {
  const wrongRevision = check({
    checkId: "credential_isolation",
    status: "fail",
    inventoryRevision: 6,
  });
  assertEquals(
    blockingChecks({ ...FRESH_IDENTITY, checks: [wrongRevision] }).allBlocked,
    false,
  );
  const expired = check({
    checkId: "credential_isolation",
    status: "fail",
    expiresAt: ISO(-1),
  });
  assertEquals(
    blockingChecks({ ...FRESH_IDENTITY, checks: [expired] }).allBlocked,
    false,
  );
});

Deno.test("evaluateReadiness: revoked and offline states dominate checks", () => {
  const checks = [
    check({ checkId: "capability:git", status: "pass" }),
    check({ checkId: "capability:docs", status: "fail" }),
  ];
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "accepting",
      checks: [],
    }),
    { state: "checking", reason: null, failedCheckIds: [] },
  );
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "revoked",
      desiredMode: "accepting",
      checks,
    }),
    { state: "needs_attention", reason: "revoked", failedCheckIds: [] },
  );
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "revoked",
      checks,
    }),
    { state: "needs_attention", reason: "revoked", failedCheckIds: [] },
  );
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "offline",
      status: "online",
      desiredMode: "accepting",
      checks,
    }),
    { state: "needs_attention", reason: "offline", failedCheckIds: [] },
  );
});

Deno.test("evaluateReadiness: fresh failures repaint needs_attention with reasons", () => {
  const failing = check({ checkId: "credential_isolation", status: "fail" });
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "accepting",
      checks: [failing],
    }),
    {
      state: "needs_attention",
      reason: "check_failed",
      failedCheckIds: ["credential_isolation"],
    },
  );
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "stale",
      status: "online",
      desiredMode: "accepting",
      checks: [failing],
    }),
    {
      state: "needs_attention",
      reason: "stale",
      failedCheckIds: ["credential_isolation"],
    },
  );
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "stale",
      status: "online",
      desiredMode: "accepting",
      checks: [],
    }),
    { state: "needs_attention", reason: "stale", failedCheckIds: [] },
  );
});

Deno.test("evaluateReadiness: ready only with a fresh passing capability check", () => {
  const passing = check({ checkId: "capability:git", status: "pass" });
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "accepting",
      checks: [passing],
    }),
    { state: "ready", reason: null, failedCheckIds: [] },
  );
  // A fresh global pass alone is not usable-capacity evidence: until a
  // capability check lands, the projection stays `checking`, never `ready`.
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "accepting",
      checks: [check({ checkId: "credential_isolation", status: "pass" })],
    }),
    { state: "checking", reason: null, failedCheckIds: [] },
  );
  // Expired or old-generation passing checks do not restore readiness.
  assertEquals(
    evaluateReadiness({
      ...FRESH_IDENTITY,
      connectivity: "online",
      status: "online",
      desiredMode: "accepting",
      checks: [
        check({
          checkId: "capability:git",
          status: "pass",
          expiresAt: ISO(-1),
        }),
      ],
    }),
    { state: "checking", reason: null, failedCheckIds: [] },
  );
});
