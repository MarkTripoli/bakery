// Real-process OAuth + MCP: the shipped server image, the shipped
// `register-oauth-client` task, a real TCP hop and two forced server restarts.
// Raw HTTP JSON-RPC drives `/mcp` because tests import only `@bakery/*` and
// repository modules, never the MCP SDK (the SDK client is exercised by the
// compatibility spike).
import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, authTestOrigin, sessionCookie } from "../helpers/auth.ts";
import {
  callTool,
  connectClient,
  listTools,
  type McpResult,
  READ_AND_OPERATE,
  TEST_REDIRECT_URI,
} from "../helpers/oauth-mcp.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

const NEXT_SECOND_MS = 1_100;

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
      displayName: "E2E OAuth MCP",
      password,
    });
  } finally {
    await closePgDatabase(pgDatabase);
  }
}

/** Runs the shipped task in a one-off container and returns what it printed. */
async function registerClientWithTask(stack: Stack): Promise<string> {
  const containerOwnerUrl = stack.ownerDatabaseUrl.replace(
    /@[^/]+\//,
    "@postgres:5432/",
  );
  const result = await stack.runOneOff([
    "run",
    "--rm",
    "-T",
    "-e",
    `DATABASE_URL=${containerOwnerUrl}`,
    "server",
    "deno",
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-sys=hostname",
    "--allow-read=apps/server/src/platform/migrations,apps/server/src/modules/auth/migrations,apps/server/src/modules/work/migrations,apps/server/src/modules/projects/migrations,apps/server/src/modules/agents/migrations,apps/server/src/modules/repository-rules/migrations,apps/server/src/modules/integrations/migrations,apps/server/src/modules/delivery/migrations",
    "apps/server/src/tasks.ts",
    "register-oauth-client",
    "--name",
    "E2E harness client",
    "--redirect-uri",
    TEST_REDIRECT_URI,
    "--scopes",
    READ_AND_OPERATE.join(" "),
  ]);
  assert(result.success, `register-oauth-client failed: ${result.output}`);
  // Compose may add its own status lines; the task itself prints exactly one
  // token-shaped line, the public client id, and nothing else.
  const printed = result.output.split("\n").map((line) => line.trim()).filter(
    (line) => /^[A-Za-z0-9_-]{32,}$/.test(line),
  );
  assertEquals(
    printed.length,
    1,
    `the task prints only the client id: ${result.output}`,
  );
  const clientId = printed[0];
  return clientId;
}

Deno.test(
  "OAuth-protected MCP survives restarts and revocation stays effective through the real process",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("oauth-mcp");
    const suffix = crypto.randomUUID();
    const email = `e2e-oauth-${suffix}@example.test`;
    const password = `E2e-Oauth-${suffix}`;
    // Redirects are part of the protocol under test, so they must not be followed.
    const driver = {
      app: {
        fetch: (request: Request) => {
          const url = new URL(request.url);
          const target = new URL(stack.origin);
          url.protocol = target.protocol;
          url.host = target.host;
          const headers = new Headers(request.headers);
          if (headers.has("origin")) headers.set("origin", stack.origin);
          return request.clone().arrayBuffer().then((body) =>
            fetch(url, {
              method: request.method,
              headers,
              body: request.method === "GET" || request.method === "HEAD"
                ? undefined
                : body,
              redirect: "manual",
            })
          );
        },
      },
    };
    const resource = `${stack.origin}/mcp`;
    let cookie = "";
    let clientId = "";
    let accessToken = "";
    try {
      await t.step(
        "the task registers a client and prints only its id",
        async () => {
          await seedSuperuser(stack, email, password);
          const signIn = await stack.fetch(
            authRequest("/api/auth/sign-in/email", { email, password }),
          );
          assertEquals(signIn.status, 200);
          cookie = sessionCookie(signIn);
          clientId = await registerClientWithTask(stack);
          const rows = await stack.psql<
            { name: string; secret: string | null }
          >(
            `select name, "clientSecret" as secret from public."oauthClient" where "clientId" = $1`,
            [clientId],
          );
          assertEquals(rows[0].name, "E2E harness client");
          assertEquals(rows[0].secret, null);
        },
      );

      await t.step(
        "discovery, PKCE flow and both tools work over TCP",
        async () => {
          const prm = await stack.fetch(
            new Request(
              `${authTestOrigin}/.well-known/oauth-protected-resource/mcp`,
            ),
          );
          assertEquals(prm.status, 200);
          assertEquals((await prm.json()).resource, resource);
          const unauthenticated = await stack.fetch(
            new Request(`${authTestOrigin}/mcp`, { method: "POST" }),
          );
          assertEquals(unauthenticated.status, 401);
          assert(
            (unauthenticated.headers.get("www-authenticate") ?? "").includes(
              `resource_metadata="${stack.origin}/.well-known/oauth-protected-resource/mcp"`,
            ),
          );

          ({ accessToken } = await connectClient(driver, {
            cookie,
            clientId,
            resource,
          }));
          assertEquals(await listTools(driver, accessToken), [
            "bakery_applications_get",
            "bakery_applications_list",
            "bakery_artifactComments_create",
            "bakery_artifactComments_list",
            "bakery_artifactComments_listAcrossVersions",
            "bakery_artifactComments_update",
            "bakery_artifactStorage_get",
            "bakery_artifactVersions_content",
            "bakery_artifactVersions_extract",
            "bakery_artifactVersions_import",
            "bakery_artifactVersions_list",
            "bakery_artifacts_get",
            "bakery_artifacts_list",
            "bakery_conversationTurns_cancel",
            "bakery_conversationTurns_get",
            "bakery_conversationTurns_list",
            "bakery_conversations_create",
            "bakery_conversations_get",
            "bakery_conversations_list",
            "bakery_conversations_update",
            "bakery_messages_create",
            "bakery_messages_list",
            "bakery_questions_answer",
            "bakery_questions_get",
            "bakery_questions_list",
            "bakery_repositories_get",
            "bakery_repositories_list",
            "bakery_repositoryRulePreviews_createForRepository",
            "bakery_repositoryRules_getEffective",
            "bakery_runSteps_list",
            "bakery_runs_create",
            "bakery_runs_get",
            "bakery_runs_list",
            "bakery_taskDependencies_create",
            "bakery_taskDependencies_delete",
            "bakery_tasks_create",
            "bakery_tasks_get",
            "bakery_tasks_list",
            "bakery_tasks_update",
            "bakery_usage_list",
            "organization_get",
            "whoami",
          ]);
          const who = await callTool(driver, accessToken, "whoami");
          assertEquals(who.status, 200);
          const body = await who.json() as McpResult;
          assertEquals(JSON.parse(body.result!.content![0].text).email, email);
          assertEquals(
            (await callTool(driver, accessToken, "organization_get")).status,
            200,
          );
        },
      );

      await t.step(
        "a server restart keeps the grant and the same token",
        async () => {
          await stack.restartServer({});
          assertEquals(
            (await callTool(driver, accessToken, "whoami")).status,
            200,
          );
          const grants = await stack.fetch(
            new Request(`${authTestOrigin}/v1/me/connected-clients`, {
              headers: { cookie },
            }),
          );
          assertEquals(grants.status, 200);
          const { items } = await grants.json() as {
            items: { id: string; clientId: string }[];
          };
          assertEquals(items.map((item) => item.clientId), [clientId]);
        },
      );

      await t.step(
        "revoke is effective at once, after a restart and after re-consent",
        async () => {
          const grants = await stack.fetch(
            new Request(`${authTestOrigin}/v1/me/connected-clients`, {
              headers: { cookie },
            }),
          );
          const { items } = await grants.json() as { items: { id: string }[] };
          const revoked = await stack.fetch(
            new Request(
              `${authTestOrigin}/v1/me/connected-clients/${items[0].id}`,
              {
                method: "DELETE",
                headers: { cookie, origin: authTestOrigin },
              },
            ),
          );
          assertEquals(revoked.status, 200, await revoked.clone().text());
          assertEquals(
            (await callTool(driver, accessToken, "whoami")).status,
            401,
          );
          const audits = await stack.psql<{ count: string }>(
            `select count(*)::text as count from bakery.audit_events
            where operation = 'connectedClients.revoke' and outcome = 'succeeded'`,
          );
          assertEquals(audits[0].count, "1");

          await stack.restartServer({});
          assertEquals(
            (await callTool(driver, accessToken, "whoami")).status,
            401,
          );
          await new Promise((resolve) => setTimeout(resolve, NEXT_SECOND_MS));
          const again = await connectClient(driver, {
            cookie,
            clientId,
            resource,
          });
          assertEquals(
            (await callTool(driver, again.accessToken, "whoami")).status,
            200,
          );
          assertEquals(
            (await callTool(driver, accessToken, "whoami")).status,
            401,
          );
        },
      );
    } finally {
      await stack.down();
    }
  },
);
