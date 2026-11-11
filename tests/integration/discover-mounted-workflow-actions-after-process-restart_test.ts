import { assert, assertEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import { openAuthFixture, signSessionCookie } from "../helpers/auth.ts";

const databaseConfig = readTestDatabaseConfig();
const fixturePath = new URL(
  "./fixtures/workflow-action-server.ts",
  import.meta.url,
).pathname;

type RunningServer = {
  child: Deno.ChildProcess;
  origin: string;
};

type MetadataSnapshot = {
  list: unknown;
  firstPage: unknown;
  secondPage: unknown;
  detail: unknown;
};

function reservePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

async function startServer(
  environment: Record<string, string>,
): Promise<RunningServer> {
  const port = reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-net",
      fixturePath,
    ],
    env: {
      ...Deno.env.toObject(),
      ...environment,
      FIXTURE_PORT: String(port),
      FIXTURE_PUBLIC_BASE_URL: origin,
    },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (output.includes(`FIXTURE_PORT=${port}`)) {
      void reader.cancel();
      return { child, origin };
    }
  }
  throw new Error("FIXTURE_START_FAILED");
}

async function stopServer(server: RunningServer): Promise<void> {
  server.child.kill("SIGTERM");
  const status = await server.child.status;
  assertEquals(status.success, true);
}

async function getJson(
  server: RunningServer,
  path: string,
  cookie: string,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${server.origin}${path}`, {
    headers: { cookie },
  });
  return { response, body: await response.json() };
}

async function metadataSnapshot(
  server: RunningServer,
  cookie: string,
): Promise<MetadataSnapshot> {
  const list = await getJson(server, "/v1/workflow-actions", cookie);
  assertEquals(list.response.status, 200);

  const firstPage = await getJson(
    server,
    "/v1/workflow-actions?limit=5",
    cookie,
  );
  assertEquals(firstPage.response.status, 200);
  const firstPageBody = firstPage.body as {
    items: Array<{ actionId: string }>;
    nextCursor: string | null;
  };
  assert(firstPageBody.nextCursor);

  const secondPage = await getJson(
    server,
    `/v1/workflow-actions?limit=5&cursor=${
      encodeURIComponent(firstPageBody.nextCursor)
    }`,
    cookie,
  );
  assertEquals(secondPage.response.status, 200);

  const actionId = "harness.implement";
  const detail = await getJson(
    server,
    `/v1/workflow-actions/${actionId}/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
    cookie,
  );
  assertEquals(detail.response.status, 200);

  return {
    list: list.body,
    firstPage: firstPage.body,
    secondPage: secondPage.body,
    detail: detail.body,
  };
}

Deno.test("the mounted workflow action catalog authenticates and survives a real server restart", async () => {
  const reset = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(reset, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(reset);
  }

  const fixture = await openAuthFixture({ databaseConfig });
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `workflow-actions-${crypto.randomUUID()}`;
  const now = new Date("2026-10-04T12:00:00.000Z");
  const expiresAt = new Date(Date.now() + 86_400_000);
  let server: RunningServer | undefined;
  try {
    await fixture.database`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${userId}, 'Workflow Action Tester',
        ${`workflow-actions-${userId}@example.test`}, true, ${now}, ${now}
      )`;
    await fixture.database`
      insert into public.session (
        id, token, "userId", "expiresAt", "createdAt", "updatedAt"
      ) values (
        ${crypto.randomUUID()}, ${token}, ${userId}, ${expiresAt}, ${now}, ${now}
      )`;
    await fixture.database`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (
        ${principalId}, ${userId}, 'Workflow Action Tester', 'human'
      )`;
    const cookie = await signSessionCookie(token, fixture.config.auth!.secret);
    const environment = {
      FIXTURE_APP_DATABASE_URL: databaseConfig.appDatabaseUrl,
      FIXTURE_AUTH_SECRET: fixture.config.auth!.secret,
    };

    server = await startServer(environment);
    const unauthenticated = await fetch(
      `${server.origin}/v1/workflow-actions`,
    );
    assertEquals(unauthenticated.status, 401);

    const first = await metadataSnapshot(server, cookie);
    const list = first.list as {
      items: Array<{ actionId: string }>;
      nextCursor: string | null;
    };
    assertEquals(
      list.items.map((item) => item.actionId),
      [...WORKFLOW_ACTION_NAMES],
    );
    assertEquals(list.nextCursor, null);
    assertEquals(first.detail, {
      actionId: "harness.implement",
      version: WORKFLOW_ACTION_REGISTRY_VERSION,
      ...WORKFLOW_ACTION_METADATA["harness.implement"],
      modelBillingRequired: true,
    });

    for (
      const path of [
        "/v1/workflow-actions/unknown.action/versions/1",
        "/v1/workflow-actions/rpi.research/versions/2",
      ]
    ) {
      const unknown = await getJson(server, path, cookie);
      assertEquals(unknown.response.status, 404);
      assertEquals(
        (unknown.body as { code: string }).code,
        "RESOURCE_NOT_FOUND",
      );
    }

    await stopServer(server);
    server = undefined;
    server = await startServer(environment);
    const afterRestart = await metadataSnapshot(server, cookie);
    assertEquals(afterRestart, first);
  } finally {
    if (server) await stopServer(server);
    await fixture.close();
  }
});
