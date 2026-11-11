import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  activateDeployedIntegrations,
  type AuthoritySnapshot,
  authorizeInvocation,
  type BoundInvocation,
  type ContextDeps,
  createActionContext,
  createReconciliationContext,
  type IntegrationGrantRecord,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import { opaqueCredential } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createBrokerForTesting } from "../../apps/server/src/modules/catalog/integration-gate-broker-testing.ts";
import { HOST_AUTH_PROFILES } from "../../apps/server/src/modules/catalog/integration-gate-profiles.ts";
import { deployedIntegrations } from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CONNECTION = "00000000-0000-4000-8000-000000000003";
const RESOURCE = "00000000-0000-4000-8000-000000000004";
const REPOSITORY = "00000000-0000-4000-8000-000000000005";
const EFFECT = "00000000-0000-4000-8000-0000000000e1";
const ACTION = "github.issue.comment.create";
const CREDENTIAL = "ghs_LOOPBACK_installation_token";
const BOT_ID = 4242;
const MARKER = `<!-- bakery-effect:${EFFECT} -->`;
const COMMENTS_PATH = "/repos/bakery-org/bakery-repo/issues/7/comments";
const ARGS = { issueNumber: 7, body: "hello" };

const registry = activateDeployedIntegrations(deployedIntegrations);
const DIGEST = registry.integrations[0]!.manifestDigest;
const handler = registry.findAction("bakery.github", ACTION, 1)!.handler;

const grant = {
  grantId: "00000000-0000-4000-8000-0000000000a1",
  organizationId: ORG,
  connectionId: CONNECTION,
  subjectType: "principal",
  subjectPrincipalId: ACTOR,
  direction: "out_of_bakery",
  capability: ACTION,
  actionVersion: 1,
  resourceId: RESOURCE,
  revokedAt: null,
  policyRevision: 1,
} as IntegrationGrantRecord;

const snapshot: AuthoritySnapshot = {
  organizationId: ORG,
  actor: {
    principalId: ACTOR,
    subjectType: "principal",
    active: true,
    permissions: ["integrationConnection:invoke"],
  },
  install: {
    id: "inst-1",
    providerId: "bakery.github",
    manifestDigest: DIGEST,
    enabled: true,
    approvedScopes: [],
  },
  connection: {
    id: CONNECTION,
    installId: "inst-1",
    state: "active",
    providerPermissions: { issues: "write" },
  },
  resource: {
    id: RESOURCE,
    kind: "github.repository",
    selected: true,
    available: true,
    binding: {
      owner: "bakery-org",
      repo: "bakery-repo",
      repositoryId: 1234,
      installationId: 987654,
      botUserId: BOT_ID,
    },
    repositoryId: REPOSITORY,
  },
  grants: [grant],
  policyRevision: 1,
};

type Seen = {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  apiVersion: string | null;
  body: string;
};

type Rig = {
  origin: string;
  seen: Seen[];
  bound: BoundInvocation;
  deps: ContextDeps;
};

/** Runs `body` against a loopback server; the server always shuts down. */
async function withRig(
  respond: (req: Request, seen: Seen) => Response | Promise<Response>,
  body: (rig: Rig) => Promise<void>,
  options: { deadlineMs?: number } = {},
): Promise<void> {
  const seen: Seen[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    const entry: Seen = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.get("authorization"),
      apiVersion: req.headers.get("x-github-api-version"),
      body: await req.text(),
    };
    seen.push(entry);
    return respond(req, entry);
  });
  try {
    const origin = `http://127.0.0.1:${server.addr.port}`;
    const snapshotPort = { load: () => Promise.resolve(snapshot) };
    const broker = createBrokerForTesting({
      registry,
      credentials: {
        resolve: () => Promise.resolve(opaqueCredential(CREDENTIAL)),
      },
      fetch,
      snapshotPort,
      ...(options.deadlineMs === undefined
        ? {}
        : { deadlineMs: options.deadlineMs }),
      profiles: {
        "github-app": { ...HOST_AUTH_PROFILES["github-app"]!, origin },
      },
    });
    const bound = await authorizeInvocation(registry, snapshotPort, {
      organizationId: ORG,
      actorRef: ACTOR,
      connectionId: CONNECTION,
      effectId: EFFECT,
    }, {
      actionId: ACTION,
      actionVersion: 1,
      resourceId: RESOURCE,
      arguments: ARGS,
    });
    await body({
      origin,
      seen,
      bound,
      deps: { registry, snapshots: snapshotPort, providerRequests: broker },
    });
  } finally {
    await server.shutdown();
  }
}

const providerError = async (promise: Promise<unknown>) => {
  const error = await assertRejects(() => promise, StandardError);
  assertEquals(error.code, "UNPROCESSABLE");
  assertEquals(error.safeDetail, "provider request failed");
};

Deno.test("loopback: execute posts to the template path with bearer, fixed headers and the effect marker", async () => {
  await withRig(
    () =>
      Response.json({
        id: 555,
        body: "ignored",
        user: { id: BOT_ID, type: "Bot" },
      }, { status: 201 }),
    async ({ seen, bound, deps }) => {
      const ctx = createActionContext(bound, deps);
      const receipt = await handler.invoke(ctx, ARGS);
      assertEquals(receipt, { remoteId: "555" });
      assertEquals(seen.length, 1);
      const [call] = seen;
      assertEquals(call!.method, "POST");
      assertEquals(call!.path, COMMENTS_PATH);
      assertEquals(call!.search, "");
      assertEquals(call!.authorization, `Bearer ${CREDENTIAL}`);
      assertEquals(call!.apiVersion, "2026-03-10");
      const sent = JSON.parse(call!.body) as { body: string };
      assertEquals(Object.keys(sent), ["body"]);
      assert(sent.body.startsWith("hello"));
      assert(sent.body.split("\n").includes(MARKER));
      assert(!call!.body.includes(CREDENTIAL));
    },
  );
});

Deno.test("loopback: a cross-origin redirect is never followed", async () => {
  const hits: string[] = [];
  const other = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => {
      hits.push(req.url);
      return Response.json({ id: 1, body: null, user: null });
    },
  );
  try {
    const target = `http://127.0.0.1:${other.addr.port}${COMMENTS_PATH}`;
    await withRig(
      () => new Response(null, { status: 302, headers: { location: target } }),
      async ({ seen, bound, deps }) => {
        await providerError(
          createActionContext(bound, deps).provider.request(
            { id: ACTION, version: 1 },
            { issue_number: 7, body: "a" },
          ),
        );
        assertEquals(seen.length, 1);
      },
    );
    assertEquals(hits, []);
  } finally {
    await other.shutdown();
  }
});

Deno.test("loopback: a slow provider is aborted at the deadline", async () => {
  await withRig(
    () =>
      new Promise<Response>((resolve) =>
        setTimeout(
          () => resolve(Response.json({ id: 1, body: null, user: null })),
          700,
        )
      ),
    async ({ bound, deps }) => {
      const started = performance.now();
      await providerError(
        createActionContext(bound, deps).provider.request(
          { id: ACTION, version: 1 },
          { issue_number: 7, body: "a" },
        ),
      );
      assert(performance.now() - started < 600);
    },
    { deadlineMs: 150 },
  );
});

Deno.test("loopback: oversize responses are refused, declared or streamed", async () => {
  const big = "x".repeat(600_000);
  await withRig(
    () =>
      Response.json({
        id: 1,
        body: big,
        user: null,
      }),
    async ({ bound, deps }) => {
      await providerError(
        createActionContext(bound, deps).provider.request(
          { id: ACTION, version: 1 },
          { issue_number: 7, body: "a" },
        ),
      );
    },
  );
  // Streamed without a content-length header.
  await withRig(
    () => {
      const chunk = new TextEncoder().encode("y".repeat(65_536));
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ >= 20) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    async ({ bound, deps }) => {
      await providerError(
        createActionContext(bound, deps).provider.request(
          { id: ACTION, version: 1 },
          { issue_number: 7, body: "a" },
        ),
      );
    },
  );
});

type Comment = {
  id: number;
  body: string | null;
  user: { id: number; type: string } | null;
};

const filler = (id: number): Comment => ({
  id,
  body: "unrelated",
  user: { id: 1, type: "User" },
});
const bot = (id: number, userId = BOT_ID): Comment => ({
  id,
  body: `text\n\n${MARKER}`,
  user: { id: userId, type: "Bot" },
});

/** Serves `pages` by the `page` query value; later pages are empty. */
const pagedResponder = (pages: (page: number) => Comment[]) => (req: Request) =>
  Response.json(pages(Number(new URL(req.url).searchParams.get("page"))));

async function reconcileWith(
  pages: (page: number) => Comment[],
): Promise<{ result: unknown; seen: Seen[] }> {
  let outcome: { result: unknown; seen: Seen[] } | undefined;
  await withRig(pagedResponder(pages), async ({ seen, bound, deps }) => {
    const rctx = createReconciliationContext(bound, ARGS, deps);
    outcome = { result: await handler.invokeReconcile!(rctx as never), seen };
  });
  return outcome!;
}

Deno.test("loopback reconcile: one bot marker after a full page confirms with its remote id", async () => {
  const { result, seen } = await reconcileWith((page) =>
    page === 1
      ? Array.from({ length: 100 }, (_, i) => filler(i + 1))
      : page === 2
      ? [filler(500), bot(777)]
      : []
  );
  assertEquals(result, { status: "confirmed", result: { remoteId: "777" } });
  assertEquals(seen.length, 2);
  for (const call of seen) {
    assertEquals(call.method, "GET");
    assertEquals(call.path, COMMENTS_PATH);
    assertEquals(call.authorization, `Bearer ${CREDENTIAL}`);
    assertEquals(call.body, "");
  }
  assertEquals(seen[0]!.search, "?per_page=100&page=1");
  assertEquals(seen[1]!.search, "?per_page=100&page=2");
});

Deno.test("loopback reconcile: two matches stay uncertain", async () => {
  const { result } = await reconcileWith((page) =>
    page === 1 ? [bot(10), filler(11), bot(12)] : []
  );
  assertEquals(result, { status: "uncertain" });
});

Deno.test("loopback reconcile: a marker from the wrong author is not proof", async () => {
  const { result } = await reconcileWith((page) =>
    page === 1 ? [bot(10, BOT_ID + 1)] : []
  );
  assertEquals(result, { status: "uncertain" });
});

Deno.test("loopback reconcile: twenty full pages stay uncertain even if later pages hold the marker", async () => {
  const { result, seen } = await reconcileWith((page) =>
    page <= 20
      ? Array.from({ length: 100 }, (_, i) => filler(page * 1000 + i))
      : [bot(9999)]
  );
  assertEquals(result, { status: "uncertain" });
  assertEquals(seen.length, 20);
});
