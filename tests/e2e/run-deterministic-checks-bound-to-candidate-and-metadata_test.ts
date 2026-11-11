import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";
import {
  insertCheckRun,
  type RunScope,
  seedRun,
} from "../helpers/deterministic-checks/run-fixture.ts";
import { SHA256_A } from "../helpers/deterministic-checks/observations.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

// Two proofs share this file.
//
// 1. A fast one against the plain server stack: the compose migrate service
//    loads the delivery source and the server serves seeded rows over HTTP.
// 2. The real-process proof, run as a child under a systemd scope so the
//    production worker can be confined (see
//    run-deterministic-checks-bound-to-candidate-and-metadata.child.ts for what
//    it proves and the one substituted step, the onboarding inspection).

const CHILD_TIMEOUT_MS = 180_000;
const CHILD_KILL_GRACE_MS = 5_000;
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
      displayName: "Deterministic checks reader",
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

Deno.test("the real stack migrates check_runs and serves a run's rows over HTTP", async () => {
  const stack = await upStack("deterministic-checks");
  const email = `e2e-checks-${crypto.randomUUID()}@example.test`;
  const password = `Checks-${crypto.randomUUID()}`;
  try {
    // The migrate service ran with the delivery source on its read allowlist.
    const table = await stack.psql<{ regclass: string | null }>(
      "select to_regclass('bakery.check_runs')::text as regclass",
    );
    assertEquals(table[0]?.regclass, "bakery.check_runs");

    await seedSuperuser(stack, email, password);
    const scope = await scopeOf(stack, email);
    const owner = openPgDatabase(stack.ownerDatabaseUrl);
    let run, otherRun;
    try {
      run = await seedRun(owner, scope);
      otherRun = await seedRun(owner, scope);
      const common = {
        organizationId: scope.organizationId,
        runId: run.runId,
        runStepId: run.stepId,
      };
      await insertCheckRun(owner, {
        ...common,
        checkId: "lint",
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 1,
        durationMs: 640,
        outputDigest: SHA256_A,
        createdAt: new Date("2026-10-31T12:00:01.000Z"),
      });
      await insertCheckRun(owner, {
        ...common,
        checkId: "e2e",
        result: "unavailable",
        reason: "tool_missing",
        createdAt: new Date("2026-10-31T12:00:02.000Z"),
      });
      await insertCheckRun(owner, {
        organizationId: scope.organizationId,
        runId: otherRun.runId,
        checkId: "other-run-check",
      });
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

    const first = await read(`/v1/runs/${run.runId}/checks?limit=1`);
    assertEquals(first.status, 200);
    const firstPage = await first.json();
    assertEquals(firstPage.items.length, 1);
    assertEquals(
      [firstPage.items[0].checkId, firstPage.items[0].result],
      ["lint", "failed"],
    );
    assertEquals(firstPage.items[0].reason, "exit_nonzero");
    assert(typeof firstPage.nextCursor === "string");

    const second = await read(
      `/v1/runs/${run.runId}/checks?limit=1&cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(second.status, 200);
    const secondPage = await second.json();
    assertEquals(
      [secondPage.items[0].checkId, secondPage.items[0].result],
      ["e2e", "unavailable"],
    );
    assertEquals(secondPage.items[0].reason, "tool_missing");
    assertEquals(secondPage.nextCursor, null);

    // A run id the caller did not seed answers 404 with a problem document.
    const missing = await read(`/v1/runs/${crypto.randomUUID()}/checks`);
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    const signedOut = await stack.fetch(
      new Request(`${stack.origin}/v1/runs/${run.runId}/checks`, {
        headers: { "Bakery-Organization-Id": scope.organizationId },
      }),
    );
    assertEquals(signedOut.status, 401);
    await signedOut.body?.cancel();
  } finally {
    await stack.down();
  }
});

Deno.test("a real worker runs the fixed checks and the server records only what it can verify", async () => {
  const dockerHost = Deno.env.get("DOCKER_HOST")?.trim();
  if (!dockerHost) throw new Error("DOCKER_HOST_REQUIRED");
  const temporaryDirectory = Deno.env.get("TMPDIR")?.trim() || "/tmp";
  const childPath = new URL(
    "./run-deterministic-checks-bound-to-candidate-and-metadata.child.ts",
    import.meta.url,
  ).pathname;
  const ownerUnit = `bakery-checks-e2e-${crypto.randomUUID()}.scope`;
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
      `DELEGATED_CHECKS_PROOF_FAILED:${output.code}:${
        timedOut ? "timed out" : "exited"
      }\n--- stdout ---\n${decode(output.stdout).slice(-6_000)}`,
    );
  }
  const stdout = decode(output.stdout);
  const evidenceLine = stdout.split("\n").find((line) =>
    line.includes("DETERMINISTIC_CHECKS_E2E_CONFIRMED")
  );
  assert(evidenceLine, "the child printed no confirmation line");
  console.log(evidenceLine);
});
