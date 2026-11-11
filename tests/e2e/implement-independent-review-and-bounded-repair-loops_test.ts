import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";
import type { RunScope } from "../helpers/deterministic-checks/run-fixture.ts";
import {
  insertDeliveryDecision,
  insertReviewCycle,
  insertReviewFinding,
  seedReviewRun,
} from "../helpers/review-repair/run-fixture.ts";
import { fingerprintOf } from "../helpers/review-repair/fixtures.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

// Issue #94 (B10.03). Two proofs share this file.
//
// 1. A fast one against the plain server stack: the compose migrate service
//    creates the three insert-only evidence tables, and the server serves
//    seeded cycles, findings and decisions through the three list operations
//    over HTTP (paging, 401 signed out, 404 unknown id).
// 2. The real-process proof, run as a child under a systemd scope so the
//    production worker can be confined (see
//    implement-independent-review-and-bounded-repair-loops.child.ts for what
//    it proves and the steps it substitutes).

const CHILD_TIMEOUT_MS = 1_200_000;
const CHILD_KILL_GRACE_MS = 10_000;
type ChildTimer = number | NodeJS.Timeout;

async function runBounded(
  command: Deno.Command,
): Promise<{ output: Deno.CommandOutput; timedOut: boolean }> {
  const child = command.spawn();
  let killTimer: ChildTimer | undefined;
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The delegated child already exited.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The delegated child exited during its cleanup grace.
      }
    }, CHILD_KILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);
  try {
    return { output: await child.output(), timedOut };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
  }
}

async function seedSuperuser(
  stack: Stack,
  email: string,
  password: string,
): Promise<void> {
  const pgDatabase = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase, config }, {
      email,
      displayName: "Review evidence reader",
      password,
    });
  } finally {
    await closePgDatabase(pgDatabase);
  }
}

async function scopeOf(stack: Stack, email: string): Promise<RunScope> {
  const rows = await stack.psql<RunScope>(
    `select principal.id as "principalId",
            membership.organization_id as "organizationId"
       from bakery.principals principal
       join public."user" provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships membership
         on membership.principal_id = principal.id
      where provider_user.email = $1`,
    [email],
  );
  if (!rows[0]) throw new Error("SEEDED_USER_SCOPE_REQUIRED");
  return rows[0];
}

type Page = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

Deno.test("the real stack migrates the review evidence tables and serves a run's rows over HTTP", async () => {
  const stack = await upStack("review-repair");
  const email = `e2e-review-${crypto.randomUUID()}@example.test`;
  const password = `Review-${crypto.randomUUID()}`;
  try {
    // The migrate service ran with the delivery source on its read allowlist,
    // and the application role holds select and insert only on each table.
    for (
      const table of ["review_cycles", "review_findings", "delivery_decisions"]
    ) {
      const exists = await stack.psql<{ regclass: string | null }>(
        "select to_regclass($1)::text as regclass",
        [`bakery.${table}`],
      );
      assertEquals(exists[0]?.regclass, `bakery.${table}`);
      const privileges = await stack.psql<Record<string, boolean>>(
        `select has_table_privilege('bakery_app', $1, 'select') as "select",
                has_table_privilege('bakery_app', $1, 'insert') as "insert",
                has_table_privilege('bakery_app', $1, 'update') as "update",
                has_table_privilege('bakery_app', $1, 'delete') as "delete"`,
        [`bakery.${table}`],
      );
      assertEquals(privileges[0], {
        select: true,
        insert: true,
        update: false,
        delete: false,
      }, table);
    }

    await seedSuperuser(stack, email, password);
    const scope = await scopeOf(stack, email);
    const owner = openPgDatabase(stack.ownerDatabaseUrl);
    let run, otherRun;
    const cycles: string[] = [];
    try {
      run = await seedReviewRun(owner, scope);
      otherRun = await seedReviewRun(owner, scope);
      const common = {
        organizationId: scope.organizationId,
        runId: run.runId,
        runStepId: run.reviewStepId,
        reviewerSessionId: run.reviewerSessionId,
        implementerSessionId: run.implementerSessionId,
      };
      // Written out of order on purpose: the read orders by ordinal.
      for (const ordinal of [1, 0, 2]) {
        cycles[ordinal] = await insertReviewCycle(owner, {
          ...common,
          ordinal,
          headSha: String(ordinal + 1).repeat(40),
          status: ordinal === 2 ? "approved" : "changes_requested",
          findingCount: ordinal === 2 ? 0 : ordinal === 0 ? 1 : 2,
          blockingCount: ordinal === 2 ? 0 : 1,
          createdAt: new Date(`2026-10-31T12:0${ordinal}:00.000Z`),
        });
      }
      // The blocker of cycle 0 comes back in cycle 1, and cycle 1's other
      // finding is new; neither is in cycle 2, the latest, so all three read
      // resolved.
      await insertReviewFinding(owner, {
        organizationId: scope.organizationId,
        reviewCycleId: cycles[0],
        fingerprint: fingerprintOf(1),
        severity: "blocker",
        line: 4,
      });
      await insertReviewFinding(owner, {
        organizationId: scope.organizationId,
        reviewCycleId: cycles[1],
        fingerprint: fingerprintOf(1),
        severity: "blocker",
        line: 5,
      });
      await insertReviewFinding(owner, {
        organizationId: scope.organizationId,
        reviewCycleId: cycles[1],
        fingerprint: fingerprintOf(2),
        severity: "minor",
        path: "src/other.ts",
        line: null,
      });
      const failed = {
        checkRunId: crypto.randomUUID(),
        checkId: "unit",
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 3,
      };
      const decisionRows: Array<[number, string, string, unknown[]]> = [
        [0, "repair", "repair_selected", [failed]],
        [1, "repair", "repair_selected", []],
        [2, "proceed", "clean", []],
      ];
      for (const [ordinal, decision, reason, failedChecks] of decisionRows) {
        await insertDeliveryDecision(owner, {
          organizationId: scope.organizationId,
          runId: run.runId,
          ordinal,
          reviewCycleId: cycles[ordinal],
          decision,
          reason,
          headSha: String(ordinal + 1).repeat(40),
          failedChecks,
          blockingFingerprints: ordinal === 2 ? [] : [fingerprintOf(1)],
          createdAt: new Date(`2026-10-31T12:0${ordinal}:30.000Z`),
        });
      }
    } finally {
      await closePgDatabase(owner);
    }

    const signIn = await stack.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signIn.status, 200);
    const headers = {
      cookie: sessionCookie(signIn),
      "Bakery-Organization-Id": scope.organizationId,
    };
    const read = async (path: string) =>
      await stack.fetch(new Request(`${stack.origin}${path}`, { headers }));
    const readPage = async (path: string): Promise<Page> => {
      const response = await read(path);
      const text = await response.text();
      assertEquals(response.status, 200, `${path}: ${text}`);
      return JSON.parse(text) as Page;
    };

    // 1. runReviews.list: ordinal order and keyset paging, one row per page.
    const first = await readPage(`/v1/runs/${run.runId}/reviews?limit=1`);
    assertEquals(first.items.map((item) => item.id), [cycles[0]]);
    assertEquals(first.items[0].ordinal, 0);
    assertEquals(first.items[0].status, "changes_requested");
    assertEquals(first.items[0].pullRequestId, null);
    assert(typeof first.nextCursor === "string");
    const second = await readPage(
      `/v1/runs/${run.runId}/reviews?limit=1&cursor=${
        encodeURIComponent(first.nextCursor)
      }`,
    );
    assertEquals(second.items.map((item) => item.id), [cycles[1]]);
    assert(typeof second.nextCursor === "string");
    const third = await readPage(
      `/v1/runs/${run.runId}/reviews?limit=1&cursor=${
        encodeURIComponent(second.nextCursor)
      }`,
    );
    assertEquals(third.items.map((item) => [item.id, item.status]), [[
      cycles[2],
      "approved",
    ]]);
    assertEquals(third.nextCursor, null);
    // Another run's cycles do not leak into this run's list.
    assertEquals(
      (await readPage(`/v1/runs/${otherRun.runId}/reviews`)).items,
      [],
    );

    // 2. reviewFindings.list: the status is derived from the run's latest
    // cycle. Cycle 1 repeats fingerprint 1 but the latest cycle (2) reports
    // nothing, so fingerprint 1 reads resolved in every earlier cycle.
    const earlier = await readPage(`/v1/reviews/${cycles[0]}/findings`);
    assertEquals(
      earlier.items.map((item) => [item.fingerprint, item.status, item.line]),
      [[fingerprintOf(1), "resolved", 4]],
    );
    const later = await readPage(`/v1/reviews/${cycles[1]}/findings?limit=1`);
    assertEquals(later.items.length, 1);
    assert(typeof later.nextCursor === "string");
    const laterRest = await readPage(
      `/v1/reviews/${cycles[1]}/findings?limit=1&cursor=${
        encodeURIComponent(later.nextCursor)
      }`,
    );
    const laterAll = [...later.items, ...laterRest.items];
    assertEquals(
      Object.fromEntries(
        laterAll.map((item) => [item.fingerprint, item.status]),
      ),
      { [fingerprintOf(1)]: "resolved", [fingerprintOf(2)]: "resolved" },
    );
    assertEquals(
      (await readPage(`/v1/reviews/${cycles[2]}/findings`)).items,
      [],
    );

    // 3. runDeliveryDecisions.list: ordinal order, the failed check carried.
    const decisions = await readPage(
      `/v1/runs/${run.runId}/delivery-decisions`,
    );
    assertEquals(
      decisions.items.map((item) => [item.ordinal, item.decision, item.reason]),
      [[0, "repair", "repair_selected"], [1, "repair", "repair_selected"], [
        2,
        "proceed",
        "clean",
      ]],
    );
    assertEquals(
      (decisions.items[0].failedChecks as Array<Record<string, unknown>>).map((
        check,
      ) => [check.checkId, check.result, check.exitCode]),
      [["unit", "failed", 3]],
    );
    const decisionsPaged = await readPage(
      `/v1/runs/${run.runId}/delivery-decisions?limit=2`,
    );
    assertEquals(decisionsPaged.items.length, 2);
    assert(typeof decisionsPaged.nextCursor === "string");

    // 4. An id the caller did not seed is 404 with a problem document, and a
    // request without a session is 401, for each of the three operations.
    const paths = [
      `/v1/runs/${crypto.randomUUID()}/reviews`,
      `/v1/reviews/${crypto.randomUUID()}/findings`,
      `/v1/runs/${crypto.randomUUID()}/delivery-decisions`,
    ];
    for (const path of paths) {
      const missing = await read(path);
      assertEquals(missing.status, 404, path);
      await missing.body?.cancel();
    }
    for (
      const path of [
        `/v1/runs/${run.runId}/reviews`,
        `/v1/reviews/${cycles[0]}/findings`,
        `/v1/runs/${run.runId}/delivery-decisions`,
      ]
    ) {
      const signedOut = await stack.fetch(
        new Request(`${stack.origin}${path}`, {
          headers: { "Bakery-Organization-Id": scope.organizationId },
        }),
      );
      assertEquals(signedOut.status, 401, path);
      await signedOut.body?.cancel();
    }
  } finally {
    await stack.down();
  }
});

Deno.test("a real worker runs the checks and the server records and decides the review and repair loop", async () => {
  const dockerHost = Deno.env.get("DOCKER_HOST")?.trim();
  if (!dockerHost) throw new Error("DOCKER_HOST_REQUIRED");
  const temporaryDirectory = Deno.env.get("TMPDIR")?.trim() || "/tmp";
  const childPath = new URL(
    "./implement-independent-review-and-bounded-repair-loops.child.ts",
    import.meta.url,
  ).pathname;
  const ownerUnit = `bakery-review-e2e-${crypto.randomUUID()}.scope`;
  const { output, timedOut } = await runBounded(
    new Deno.Command("systemd-run", {
      args: [
        "--user",
        "--scope",
        "--quiet",
        "--property=Delegate=yes",
        `--unit=${ownerUnit}`,
        `--setenv=DOCKER_HOST=${dockerHost}`,
        `--setenv=TMPDIR=${temporaryDirectory}`,
        `--setenv=BAKERY_E2E_OWNER_UNIT=${ownerUnit}`,
        Deno.execPath(),
        "test",
        "--allow-all",
        childPath,
      ],
      // Progress lines stream live on stderr; stdout carries the confirmation.
      stdout: "piped",
      stderr: "inherit",
    }),
  );
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  if (!output.success) {
    // Stderr was inherited and is already in the lane output.
    throw new Error(
      `DELEGATED_REVIEW_PROOF_FAILED:${output.code}:${
        timedOut ? "timed out" : "exited"
      }\n--- stdout ---\n${decode(output.stdout).slice(-6_000)}`,
    );
  }
  const stdout = decode(output.stdout);
  const evidenceLine = stdout.split("\n").find((line) =>
    line.includes("REVIEW_REPAIR_E2E_CONFIRMED")
  );
  assert(evidenceLine, "the child printed no confirmation line");
  console.log(evidenceLine);
});
