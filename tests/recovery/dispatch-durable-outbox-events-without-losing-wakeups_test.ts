import { assertEquals, assertThrows } from "@std/assert";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "../fixtures/loopback-port-allocation.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
  type OutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

const secrets = {
  appPassword: "bakery-issue32-recovery-app",
  bakeryPassword: "bakery-issue32-recovery-bakery",
  eventKey: "bakery-issue32-recovery-event",
  inngestPassword: "bakery-issue32-recovery-inngest",
  postgresPassword: "bakery-issue32-recovery-postgres",
  signingKey:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
} as const;

const consumerAppName = "bakery-issue32-recovery-consumer";
const consumerFunctionId = "bakery-issue32-recovery-function";

function composeArgs(project: string): string[] {
  return [
    "compose",
    "--project-name",
    project,
    "-f",
    "infra/compose.yaml",
  ];
}

async function createOwnedComposeNetworks(
  project: string,
  env: Record<string, string>,
): Promise<readonly string[]> {
  const seed = Number.parseInt(
    project.split("-").at(-1)?.slice(0, 3) ?? "001",
    16,
  );
  for (let attempt = 0; attempt < 32; attempt++) {
    const baseBlock = (seed + attempt * 3) % 4093;
    const networks = [
      { name: "app", internal: false },
      { name: "infra", internal: true },
      { name: "test-access", internal: false },
    ].map(({ name, internal }, index) => {
      const block = baseBlock + index;
      return {
        name: `${project}_${name}`,
        subnet: `10.253.${Math.floor(block / 16)}.${(block % 16) * 16}/28`,
        internal,
      };
    });
    const created: string[] = [];
    for (const network of networks) {
      try {
        await runDocker([
          "network",
          "create",
          "--driver",
          "bridge",
          "--subnet",
          network.subnet,
          ...(network.internal ? ["--internal"] : []),
          "--label",
          `com.docker.compose.project=${project}`,
          "--label",
          `com.docker.compose.network=${
            network.name.slice(project.length + 1)
          }`,
          network.name,
        ], env);
        created.push(network.name);
      } catch (error) {
        for (const name of created) {
          await runDockerCommand(["network", "rm", name], env, true);
        }
        if (error instanceof Error && error.message.includes("Pool overlaps")) {
          break;
        }
        throw error;
      }
    }
    if (created.length === networks.length) return created;
  }
  throw new Error(
    "Could not allocate isolated Docker networks after 32 attempts",
  );
}

async function runDocker(
  args: string[],
  env: Record<string, string>,
  allowFailure = false,
): Promise<string> {
  const result = await new Deno.Command("docker", {
    args,
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = `${new TextDecoder().decode(result.stdout)}${
    new TextDecoder().decode(result.stderr)
  }`;
  if (!allowFailure && !result.success) {
    throw new Error(`docker ${args.join(" ")} failed:\n${output}`);
  }
  return output;
}

async function runDockerCommand(
  args: string[],
  env: Record<string, string>,
  allowFailure = false,
): Promise<string> {
  const result = await new Deno.Command("docker", {
    args,
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = `${new TextDecoder().decode(result.stdout)}${
    new TextDecoder().decode(result.stderr)
  }`;
  if (!allowFailure && !result.success) {
    throw new Error(`docker ${args.join(" ")} failed:\n${output}`);
  }
  return output;
}

function recoveryEnvironment(): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    BAKERY_ENV: "development",
    BAKERY_INNGEST_EVENT_KEY: secrets.eventKey,
    BAKERY_INNGEST_SIGNING_KEY: secrets.signingKey,
    BAKERY_LOCAL_APP_PASSWORD: secrets.appPassword,
    BAKERY_LOCAL_BAKERY_PASSWORD: secrets.bakeryPassword,
    BAKERY_LOCAL_INNGEST_PASSWORD: secrets.inngestPassword,
    BAKERY_LOCAL_POSTGRES_PASSWORD: secrets.postgresPassword,
    BAKERY_LOCAL_REDIS_PASSWORD: "bakery-issue32-recovery-redis",
    BETTER_AUTH_SECRET: "bakery-issue32-recovery-auth-secret-32",
  };
}

type EngineExecutionCounts = {
  readonly physicalReceipts: number;
  readonly logicalAdmissions: number;
  readonly completedExecutions: number;
};

type OutboxRecoveryIdentity = {
  readonly outboxId: string;
  readonly domainEventId: string;
  readonly deliveryKey: string;
};

function completedExactlyOnce(
  counts: EngineExecutionCounts,
  recordedAdmissions: number,
  completionBarriers: number,
  minimumPhysicalReceipts = 1,
  schedulerBarrierCompletions = 0,
  requiredSchedulerBarrierCompletions = 0,
): boolean {
  if (
    counts.logicalAdmissions > 1 || counts.completedExecutions > 1 ||
    recordedAdmissions > 1 || completionBarriers > 1
  ) {
    throw new Error(
      `INNGEST_DUPLICATE_ADMISSION:${
        JSON.stringify({ ...counts, recordedAdmissions, completionBarriers })
      }`,
    );
  }
  return counts.physicalReceipts >= minimumPhysicalReceipts &&
    counts.logicalAdmissions === 1 &&
    counts.completedExecutions === 1 && recordedAdmissions === 1 &&
    completionBarriers === 1 &&
    schedulerBarrierCompletions >= requiredSchedulerBarrierCompletions;
}

Deno.test("consumer completion rejects a duplicate logical admission", () => {
  assertThrows(
    () =>
      completedExactlyOnce(
        {
          physicalReceipts: 2,
          logicalAdmissions: 2,
          completedExecutions: 1,
        },
        1,
        1,
      ),
    Error,
    "INNGEST_DUPLICATE_ADMISSION",
  );
});

Deno.test("consumer completion waits for a causal scheduler barrier", () => {
  assertEquals(
    completedExactlyOnce(
      {
        physicalReceipts: 2,
        logicalAdmissions: 1,
        completedExecutions: 1,
      },
      1,
      1,
      2,
      0,
      1,
    ),
    false,
  );
});

async function engineExecutionCounts(
  compose: string[],
  env: Record<string, string>,
  deliveryKey: string,
): Promise<EngineExecutionCounts> {
  const output = await runDocker([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-Atqc",
    `select json_build_object(
      'physicalReceipts', (
        select count(*) from public.events
        where event_id = '${deliveryKey}'
      ),
      'logicalAdmissions', (
        select count(*)
        from public.function_runs as function_run
        join public.events as event on event.internal_id = function_run.event_id
        where event.event_id = '${deliveryKey}'
      ),
      'completedExecutions', (
        select count(*)
        from public.function_finishes as finish
        join public.function_runs as function_run
          on function_run.run_id = finish.run_id
        join public.events as event on event.internal_id = function_run.event_id
        where event.event_id = '${deliveryKey}'
      )
    )::text`,
  ], env);
  return JSON.parse(
    output.trim().split("\n").at(-1) ?? "{}",
  ) as EngineExecutionCounts;
}

async function recoveryAdmissionCount(
  owner: OutboxTestFixture["owner"],
  domainEventId: string,
): Promise<number> {
  const rows = await owner`
    select count(*)::int as count
    from public.issue32_recovery_admissions
    where event_id = ${domainEventId}`;
  return Number(rows[0].count);
}

async function recoveryBarrierCount(
  owner: OutboxTestFixture["owner"],
  domainEventId: string,
): Promise<number> {
  const rows = await owner`
    select count(*)::int as count
    from public.issue32_recovery_barriers
    where target_event_id = ${domainEventId}`;
  return Number(rows[0].count);
}

async function outboxRecoveryIdentity(
  owner: OutboxTestFixture["owner"],
  outboxId: string,
): Promise<OutboxRecoveryIdentity> {
  const rows = await owner`
    select event_id::text as "domainEventId", delivery_key as "deliveryKey"
    from bakery.outbox where id = ${outboxId}::uuid`;
  return {
    outboxId,
    domainEventId: String(rows[0].domainEventId),
    deliveryKey: String(rows[0].deliveryKey),
  };
}

async function sendDuplicateWithSchedulingBarrier(
  compose: string[],
  env: Record<string, string>,
  identity: OutboxRecoveryIdentity,
): Promise<string> {
  const barrierId =
    `scheduler-barrier:${identity.deliveryKey}:${crypto.randomUUID()}`;
  const events = [{
    id: identity.deliveryKey,
    name: "bakery/run.requested.v1",
    ts: Date.now(),
    data: { eventId: identity.domainEventId },
  }, {
    id: barrierId,
    name: "bakery/run.requested.v1",
    ts: Date.now(),
    data: {
      eventId: identity.domainEventId,
      schedulingBarrierFor: identity.deliveryKey,
    },
  }];
  const inngestUrl = `http://inngest:8288/e/${
    encodeURIComponent(secrets.eventKey)
  }`;
  const script = `
const response = await fetch(
  ${JSON.stringify(inngestUrl)},
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(${JSON.stringify(events)}),
  },
);
if (!response.ok) throw new Error("INNGEST_BARRIER_SEND_FAILED:" + response.status);
await response.text();
`;
  await runDocker([
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "--use-aliases",
    "-T",
    "server",
    "deno",
    "eval",
    script,
  ], env);
  return barrierId;
}

async function waitForConsumerCompletion(
  compose: string[],
  env: Record<string, string>,
  owner: OutboxTestFixture["owner"],
  consumerName: string,
  identity: OutboxRecoveryIdentity,
  minimumPhysicalReceipts = 1,
  schedulerBarrierId?: string,
): Promise<EngineExecutionCounts> {
  const deadline = Date.now() + 20_000;
  let stableSince: number | undefined;
  while (Date.now() < deadline) {
    const counts = await engineExecutionCounts(
      compose,
      env,
      identity.deliveryKey,
    );
    const recordedAdmissions = await recoveryAdmissionCount(
      owner,
      identity.domainEventId,
    );
    const completionBarriers = await recoveryBarrierCount(
      owner,
      identity.domainEventId,
    );
    const schedulerBarrierCompletions = schedulerBarrierId === undefined
      ? 0
      : (await engineExecutionCounts(compose, env, schedulerBarrierId))
        .completedExecutions;
    if (
      completedExactlyOnce(
        counts,
        recordedAdmissions,
        completionBarriers,
        minimumPhysicalReceipts,
        schedulerBarrierCompletions,
        schedulerBarrierId === undefined ? 0 : 1,
      )
    ) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 1_000) return counts;
    } else {
      stableSince = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `INNGEST_CONSUMER_COMPLETION_TIMEOUT:${
      JSON.stringify({
        ...(await engineExecutionCounts(compose, env, identity.deliveryKey)),
        recordedAdmissions: await recoveryAdmissionCount(
          owner,
          identity.domainEventId,
        ),
        completionBarriers: await recoveryBarrierCount(
          owner,
          identity.domainEventId,
        ),
      })
    }:CONSUMER_LOGS:${await runDockerCommand(
      ["logs", "--tail", "100", consumerName],
      env,
      true,
    )}:INNGEST_LOGS:${await runDockerCommand(
      [...compose, "logs", "--tail", "100", "inngest"],
      env,
      true,
    )}`,
  );
}

async function waitForConsumerRegistration(
  compose: string[],
  env: Record<string, string>,
  consumerName: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const output = await runDocker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-Atqc",
      `select count(*) from public.functions as function
       join public.apps as app on app.id = function.app_id
       where app.name = '${consumerAppName}'
          and function.slug = '${consumerAppName}-${consumerFunctionId}'`,
    ], env);
    if (Number(output.trim().split("\n").at(-1)) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `INNGEST_CONSUMER_REGISTRATION_TIMEOUT:${await runDockerCommand(
      ["logs", consumerName],
      env,
      true,
    )}`,
  );
}

type CrashPoint = "before-admission" | "after-admission" | "none";

async function startConsumer(
  compose: string[],
  env: Record<string, string>,
  consumerName: string,
): Promise<void> {
  const script = `
import { Inngest } from "npm:inngest@4.20.0";
import { serve } from "npm:inngest@4.20.0/deno/fresh";
import postgres from "npm:postgres@3.4.7";

const bakery = postgres(${
    JSON.stringify(
      `postgres://bakery:${secrets.bakeryPassword}@postgres:5432/bakery`,
    )
  });

const inngest = new Inngest({
  id: ${JSON.stringify(consumerAppName)},
  eventKey: ${JSON.stringify(secrets.eventKey)},
  signingKey: ${JSON.stringify(secrets.signingKey)},
  baseUrl: "http://inngest:8288",
});
const consumer = inngest.createFunction(
  {
    id: ${JSON.stringify(consumerFunctionId)},
    concurrency: { limit: 1 },
    triggers: [{ event: "bakery/run.requested.v1" }],
  },
  async ({ event, step }) => {
    if (event.data.schedulingBarrierFor) {
      return {
        schedulingBarrierFor: event.data.schedulingBarrierFor,
      };
    }
    await step.run("record-admission", async () => {
      console.log("INNGEST_CONSUMER_FUNCTION_INVOKED:" + event.data.eventId);
      await bakery\`
        insert into public.issue32_recovery_admissions (event_id)
        values (\${event.data.eventId})\`;
      console.log("INNGEST_CONSUMER_ADMISSION_RECORDED:" + event.data.eventId);
      return { eventId: event.data.eventId };
    });
    return await step.run("record-completion-barrier", async () => {
      const barrierId = "bakery-recovery-barrier-" + event.data.eventId;
    await bakery\`
      insert into public.issue32_recovery_barriers (barrier_id, target_event_id)
        values (\${barrierId}, \${event.data.eventId})\`;
      return { barrierId };
    });
  },
);
const handler = serve({
  client: inngest,
  functions: [consumer],
  serveOrigin: "http://server:8000",
});
const server = Deno.serve({ hostname: "0.0.0.0", port: 8000 }, async (request) => {
  console.log("INNGEST_CONSUMER_REQUEST:" + request.method + ":" + new URL(request.url).pathname);
  const response = await handler(request);
  console.log("INNGEST_CONSUMER_RESPONSE:" + response.status);
  return response;
});
await new Promise((resolve) => setTimeout(resolve, 1_000));
const response = await fetch("http://server:8000/api/inngest", {
  method: "PUT",
});
const responseText = await response.text();
if (!response.ok) {
  console.error("INNGEST_CONSUMER_REGISTRATION_FAILED:" + response.status + ":" + responseText);
  Deno.exit(1);
}
console.log("INNGEST_CONSUMER_REGISTERED:" + responseText);
await server.finished;
`;
  await runDocker([
    ...compose,
    "run",
    "-d",
    "--no-deps",
    "--use-aliases",
    "--workdir",
    "/tmp",
    "--name",
    consumerName,
    "-e",
    "INNGEST_DEV=1",
    "-e",
    `INNGEST_SIGNING_KEY=${secrets.signingKey}`,
    "server",
    "deno",
    "eval",
    "--node-modules-dir=auto",
    script,
  ], env);
}

async function runDispatcherInCompose(
  compose: string[],
  env: Record<string, string>,
  crashPoint: CrashPoint,
): Promise<{ code: number; output: string }> {
  const script = `
import { readDatabaseConfig, readInngestEventConfig } from "./packages/config/src/env.ts";
import { openPgDatabase } from "./apps/server/src/platform/database.ts";
import { createOutboxDispatcher } from "./apps/server/src/platform/outbox-dispatcher.ts";
import { createInngestEventClient } from "./apps/server/src/platform/inngest-event-client.ts";

const database = openPgDatabase(readDatabaseConfig().url);
const config = readInngestEventConfig();
const native = createInngestEventClient({ baseUrl: config.url, eventKey: config.eventKey });
const engine = {
  async send(event, signal) {
    if (${JSON.stringify(crashPoint)} === "before-admission") Deno.exit(137);
    const result = await native.send(event, signal);
    if (${JSON.stringify(crashPoint)} === "after-admission") Deno.exit(137);
    return result;
  },
};
const summary = await createOutboxDispatcher({
  database,
  engine,
  leaseSeconds: 1,
  maxAttempts: 3,
}).dispatchBatch(1);
console.error(JSON.stringify(summary));
if (summary.claimed !== 1) throw new Error("RECOVERY_ROW_NOT_CLAIMED");
await database.end();
`;
  const result = await new Deno.Command("docker", {
    args: [
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-e",
      `BAKERY_APP_DATABASE_URL=postgres://bakery_app:${secrets.appPassword}@postgres:5432/bakery`,
      "-e",
      "INNGEST_URL=http://inngest:8288",
      "-e",
      `INNGEST_EVENT_KEY=${secrets.eventKey}`,
      "-e",
      "BAKERY_INNGEST_LOCAL_COMPOSE=1",
      "server",
      "deno",
      "eval",
      script,
    ],
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    output: `${new TextDecoder().decode(result.stdout)}${
      new TextDecoder().decode(result.stderr)
    }`,
  };
}

Deno.test("real isolated Postgres and Inngest recover a crashed dispatcher", async () => {
  const project = `bakery-issue32-recovery-${crypto.randomUUID()}`;
  const env = recoveryEnvironment();
  const compose = composeArgs(project);
  const consumerName = `${project}-consumer`;
  let ownedNetworks: readonly string[] = [];
  let fixture: OutboxTestFixture | undefined;
  try {
    // A lost host-port bind re-runs the whole boot on fresh ports. `down`
    // removes the project's networks with it, so each attempt creates them again.
    await retryOnPortCollision({
      run: async () => {
        env.BAKERY_INNGEST_PORT = String(reserveProcessLoopbackPort());
        env.BAKERY_POSTGRES_PORT = String(reserveProcessLoopbackPort());
        ownedNetworks = await createOwnedComposeNetworks(project, env);
        await runDocker([
          ...compose,
          "up",
          "-d",
          "--wait",
          "postgres",
          "redis",
          "inngest",
        ], env);
      },
      cleanupOwnedAttempt: async () => {
        await runDocker([...compose, "down", "-v", "--remove-orphans"], env);
      },
    });
    const postgresPort = env.BAKERY_POSTGRES_PORT;
    fixture = await openOutboxTestFixture({
      databaseUrl:
        `postgres://bakery:bakery-issue32-recovery-bakery@127.0.0.1:${postgresPort}/bakery`,
      appDatabaseUrl:
        `postgres://bakery_app:${secrets.appPassword}@127.0.0.1:${postgresPort}/bakery`,
      resetConfirmation: "RESET_BAKERY_TEST_DATABASE",
      allowRemoteReset: true,
    });
    await fixture.owner`
      create table public.issue32_recovery_admissions (
        event_id text primary key,
        admitted_at timestamptz not null default now()
      )`;
    await fixture.owner`
      create table public.issue32_recovery_barriers (
        barrier_id text primary key,
        target_event_id text not null,
        completed_at timestamptz not null default now()
      )`;
    await startConsumer(compose, env, consumerName);
    await waitForConsumerRegistration(compose, env, consumerName);

    const preAdmissionCrashId = await enqueueOutboxEvent(
      fixture.owner,
      fixture.organizationId,
      "inngest",
    );
    const preAdmissionIdentity = await outboxRecoveryIdentity(
      fixture.owner,
      preAdmissionCrashId,
    );
    const preAdmissionCrash = await runDispatcherInCompose(
      compose,
      env,
      "before-admission",
    );
    assertEquals(preAdmissionCrash.code, 137, preAdmissionCrash.output);
    assertEquals(
      (await fixture.owner`
        select status, attempt_count as "attemptCount"
        from bakery.outbox where id = ${preAdmissionCrashId}`)[0],
      { status: "sending", attemptCount: 1 },
    );
    assertEquals(
      await engineExecutionCounts(
        compose,
        env,
        preAdmissionIdentity.deliveryKey,
      ),
      { physicalReceipts: 0, logicalAdmissions: 0, completedExecutions: 0 },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const preAdmissionRecovery = await runDispatcherInCompose(
      compose,
      env,
      "none",
    );

    assertEquals(preAdmissionRecovery.code, 0, preAdmissionRecovery.output);
    assertEquals(
      preAdmissionRecovery.output.includes('"delivered":1'),
      true,
      preAdmissionRecovery.output,
    );
    const preAdmissionCounts = await waitForConsumerCompletion(
      compose,
      env,
      fixture.owner,
      consumerName,
      preAdmissionIdentity,
    );
    assertEquals(preAdmissionCounts.logicalAdmissions, 1);
    assertEquals(preAdmissionCounts.completedExecutions, 1);
    assertEquals(preAdmissionCounts.physicalReceipts, 1);
    assertEquals(
      (await fixture.owner`
        select status, attempt_count as "attemptCount", lease_token as "leaseToken"
        from bakery.outbox where id = ${preAdmissionCrashId}`)[0],
      { status: "delivered", attemptCount: 2, leaseToken: null },
    );

    const postAdmissionCrashId = await enqueueOutboxEvent(
      fixture.owner,
      fixture.organizationId,
      "inngest",
    );
    const postAdmissionIdentity = await outboxRecoveryIdentity(
      fixture.owner,
      postAdmissionCrashId,
    );
    const postAdmissionCrash = await runDispatcherInCompose(
      compose,
      env,
      "after-admission",
    );
    assertEquals(postAdmissionCrash.code, 137, postAdmissionCrash.output);
    assertEquals(
      (await engineExecutionCounts(
        compose,
        env,
        postAdmissionIdentity.deliveryKey,
      ))
        .physicalReceipts >= 1,
      true,
    );
    const initialPostAdmissionCounts = await waitForConsumerCompletion(
      compose,
      env,
      fixture.owner,
      consumerName,
      postAdmissionIdentity,
    );
    assertEquals(initialPostAdmissionCounts.logicalAdmissions, 1);
    assertEquals(initialPostAdmissionCounts.completedExecutions, 1);
    assertEquals(
      (await fixture.owner`
        select status, attempt_count as "attemptCount"
        from bakery.outbox where id = ${postAdmissionCrashId}`)[0],
      { status: "sending", attemptCount: 1 },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const postAdmissionRecovery = await runDispatcherInCompose(
      compose,
      env,
      "none",
    );
    assertEquals(postAdmissionRecovery.code, 0, postAdmissionRecovery.output);
    const duplicateSchedulerBarrier = await sendDuplicateWithSchedulingBarrier(
      compose,
      env,
      postAdmissionIdentity,
    );
    const postCompletionDuplicateCounts = await waitForConsumerCompletion(
      compose,
      env,
      fixture.owner,
      consumerName,
      postAdmissionIdentity,
      3,
      duplicateSchedulerBarrier,
    );
    assertEquals(postCompletionDuplicateCounts.physicalReceipts, 3);
    assertEquals(postCompletionDuplicateCounts.logicalAdmissions, 1);
    assertEquals(postCompletionDuplicateCounts.completedExecutions, 1);
    assertEquals(
      (await fixture.owner`
        select status, attempt_count as "attemptCount", lease_token as "leaseToken"
        from bakery.outbox where id = ${postAdmissionCrashId}`)[0],
      { status: "delivered", attemptCount: 2, leaseToken: null },
    );
  } finally {
    if (fixture) {
      await fixture.owner`
        drop table if exists public.issue32_recovery_barriers`
        .catch(() => undefined);
      await fixture.owner`
        drop table if exists public.issue32_recovery_admissions`
        .catch(() => undefined);
      await fixture.close();
    }
    await runDockerCommand(["rm", "-f", consumerName], env, true);
    await runDocker([...compose, "down", "-v"], env, true);
    for (const name of ownedNetworks) {
      await runDockerCommand(["network", "rm", name], env, true);
    }
  }
});
