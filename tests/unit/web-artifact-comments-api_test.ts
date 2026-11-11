import { assertEquals, assertRejects } from "@std/assert";
import { QueryClient } from "../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js";
import {
  type ArtifactCommentResponse,
  type ArtifactPinResponse,
  type ArtifactStorageResponse,
  type BakeryApiClient,
  createBakeryApiClient,
  type MessageResponse,
} from "../../apps/web/src/api/client.ts";
import {
  artifactCommentsAcrossVersionsQueryOptions,
  artifactCommentsQueryOptions,
  artifactStorageQueryOptions,
} from "../../apps/web/src/api/query.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const versionId = "00000000-0000-4000-8000-000000000003";
const commentId = "00000000-0000-4000-8000-000000000004";
const conversationId = "00000000-0000-4000-8000-000000000005";
const timestamp = "2026-10-11T00:00:00.000Z";
const comment: ArtifactCommentResponse = {
  id: commentId,
  artifactVersionId: versionId,
  authorId: organizationId,
  body: "Review this paragraph",
  anchor: null,
  status: "open",
  resolvedBy: null,
  rootId: null,
  resolvedAt: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 3,
};

function transport(response: unknown) {
  const requests: Request[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    signals.push(init?.signal);
    return Promise.resolve(Response.json(response));
  };
  return {
    requests,
    signals,
    client: createBakeryApiClient({
      baseUrl: "https://bakery.example",
      fetchImpl,
    }),
  };
}

for (const acrossVersions of [false, true]) {
  Deno.test(`lists ${acrossVersions ? "artifact" : "version"} comments when filters and abort signal are supplied`, async () => {
    const page = { items: [comment], nextCursor: "next" };
    const { client, requests, signals } = transport(page);
    const controller = new AbortController();
    const input = {
      organizationId,
      cursor: "cursor",
      limit: 10,
      status: "open" as const,
      viewVersionId: versionId,
      signal: controller.signal,
    };

    const result = acrossVersions
      ? await client.listArtifactCommentsAcrossVersions({
        ...input,
        artifactId,
      })
      : await client.listArtifactComments({ ...input, versionId });

    assertEquals(result, { ok: true, data: page });
    const request = requests[0];
    const url = new URL(request?.url ?? "https://invalid.example");
    assertEquals(
      url.pathname,
      acrossVersions
        ? `/v1/artifacts/${artifactId}/comments`
        : `/v1/artifact-versions/${versionId}/comments`,
    );
    assertEquals(Object.fromEntries(url.searchParams), {
      cursor: "cursor",
      limit: "10",
      status: "open",
      viewVersionId: versionId,
    });
    assertEquals(
      request?.headers.get("Bakery-Organization-Id"),
      organizationId,
    );
    assertEquals(request?.credentials, "include");
    assertEquals(signals[0], controller.signal);
  });
}

Deno.test("creates a reply when root and stable idempotency key are supplied", async () => {
  const { client, requests } = transport({
    ...comment,
    rootId: commentId,
    status: null,
  });
  const input = { body: "Reply", rootId: commentId };

  const result = await client.createArtifactComment({
    organizationId,
    versionId,
    input,
    idempotencyKey: "comment-create",
  });

  assertEquals(result.ok, true);
  assertEquals(requests[0]?.method, "POST");
  assertEquals(
    requests[0]?.url,
    `https://bakery.example/v1/artifact-versions/${versionId}/comments`,
  );
  assertEquals(requests[0]?.headers.get("Idempotency-Key"), "comment-create");
  assertEquals(await requests[0]?.json(), input);
});

Deno.test("resolves a root when its If-Match version is supplied", async () => {
  const { client, requests } = transport({ ...comment, status: "resolved" });

  const result = await client.updateArtifactComment({
    organizationId,
    id: commentId,
    input: { resolved: true },
    ifMatch: '"3"',
    idempotencyKey: "comment-resolve",
  });

  assertEquals(result.ok, true);
  assertEquals(requests[0]?.method, "PATCH");
  assertEquals(
    requests[0]?.url,
    `https://bakery.example/v1/artifact-comments/${commentId}`,
  );
  assertEquals(requests[0]?.headers.get("If-Match"), '"3"');
  assertEquals(requests[0]?.headers.get("Idempotency-Key"), "comment-resolve");
  assertEquals(await requests[0]?.json(), { resolved: true });
});

Deno.test("pins an artifact when CAS and idempotency headers are supplied", async () => {
  const artifact: ArtifactPinResponse = {
    id: artifactId,
    pinned: true,
    pinnedAt: timestamp,
    pinnedBy: organizationId,
    version: 4,
    unpinEligible: false,
  };
  const { client, requests } = transport(artifact);

  const result = await client.updateArtifact({
    organizationId,
    id: artifactId,
    input: { pinned: true },
    ifMatch: '"3"',
    idempotencyKey: "artifact-pin",
  });

  assertEquals(result, { ok: true, data: artifact });
  assertEquals(
    requests[0]?.url,
    `https://bakery.example/v1/artifacts/${artifactId}`,
  );
  assertEquals(requests[0]?.headers.get("If-Match"), '"3"');
  assertEquals(requests[0]?.headers.get("Idempotency-Key"), "artifact-pin");
  assertEquals(await requests[0]?.json(), { pinned: true });
});

Deno.test("rejects comment mutation before transport when CAS is empty", async () => {
  const { client, requests } = transport(comment);

  const result = await client.updateArtifactComment({
    organizationId,
    id: commentId,
    input: { resolved: true },
    ifMatch: "",
    idempotencyKey: "comment-resolve",
  });

  assertEquals(result, {
    ok: false,
    error: { kind: "invalid-response", status: 0 },
  });
  assertEquals(requests.length, 0);
});

Deno.test("rejects malformed comment payload when server claims success", async () => {
  const { client } = transport({
    items: [{ id: commentId }],
    nextCursor: null,
  });

  const result = await client.listArtifactComments({
    organizationId,
    versionId,
  });

  assertEquals(result, {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
});

Deno.test("sends selected root versions when agent request is created", async () => {
  const message: MessageResponse = {
    id: artifactId,
    conversationId,
    authorId: organizationId,
    agentSessionId: null,
    messageType: "user",
    body: "Apply feedback",
    clientMessageId: versionId,
    replyToId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    sequence: "1",
    intent: "agent_request",
    commentContext: null,
  };
  const { client, requests } = transport(message);
  const input = {
    body: message.body,
    clientMessageId: versionId,
    intent: "agent_request" as const,
    commentRefs: [{ commentId, expectedVersion: 3 }],
  };

  const result = await client.createMessage({
    organizationId,
    conversationId,
    input,
    idempotencyKey: "agent-request",
  });

  assertEquals(result, { ok: true, data: message });
  assertEquals(
    requests[0]?.url,
    `https://bakery.example/v1/conversations/${conversationId}/messages`,
  );
  assertEquals(
    requests[0]?.headers.get("Bakery-Organization-Id"),
    organizationId,
  );
  assertEquals(requests[0]?.headers.get("Idempotency-Key"), "agent-request");
  assertEquals(await requests[0]?.json(), input);
});

for (const acrossVersions of [false, true]) {
  const build = acrossVersions
    ? artifactCommentsAcrossVersionsQueryOptions
    : artifactCommentsQueryOptions;
  Deno.test(`isolates ${acrossVersions ? "artifact" : "version"} comment keys when scope or filters change`, () => {
    const { client } = transport({ items: [], nextCursor: null });
    const scope = { organizationId, sessionGeneration: 4 };
    const input = {
      rootId: commentId,
      viewVersionId: versionId,
      cursor: "next",
      limit: 5,
    };

    const key = build(client, scope, artifactId, input).queryKey;

    assertEquals([...key], [
      "protected",
      4,
      organizationId,
      acrossVersions
        ? "artifactComments.listAcrossVersions"
        : "artifactComments.list",
      {
        [acrossVersions ? "artifactId" : "versionId"]: artifactId,
        rootId: commentId,
        viewVersionId: versionId,
        cursor: "next",
        limit: 5,
        status: null,
      },
    ]);
    assertEquals(
      JSON.stringify(key) ===
        JSON.stringify(
          build(client, { ...scope, sessionGeneration: 5 }, artifactId, input)
            .queryKey,
        ),
      false,
    );
    assertEquals(
      JSON.stringify(key) ===
        JSON.stringify(
          build(
            client,
            { ...scope, organizationId: versionId },
            artifactId,
            input,
          ).queryKey,
        ),
      false,
    );
  });
}

Deno.test("rejects comments query before transport when organization is missing", async () => {
  const { client, requests } = transport({ items: [], nextCursor: null });
  const queryClient = new QueryClient();

  try {
    await assertRejects(() =>
      queryClient.fetchQuery(artifactCommentsQueryOptions(
        client,
        { organizationId: null, sessionGeneration: 1 },
        versionId,
      ))
    );
    assertEquals(requests.length, 0);
  } finally {
    queryClient.clear();
  }
});

Deno.test("aborts comment transport when query is cancelled", async () => {
  let signal: AbortSignal | undefined;
  const started = Promise.withResolvers<void>();
  const client: Pick<BakeryApiClient, "listArtifactComments"> = {
    listArtifactComments: (options) => {
      signal = options.signal;
      started.resolve();
      return new Promise((resolve) =>
        options.signal?.addEventListener("abort", () => {
          resolve({ ok: false, error: { kind: "network" } });
        }, { once: true })
      );
    },
  };
  const queryClient = new QueryClient();
  const query = artifactCommentsQueryOptions(client, {
    organizationId,
    sessionGeneration: 1,
  }, versionId);
  const pending = queryClient.fetchQuery(query).catch(() => undefined);
  await started.promise;

  await queryClient.cancelQueries({ queryKey: query.queryKey });

  assertEquals(signal?.aborted, true);
  await pending;
  queryClient.clear();
});

const storage: ArtifactStorageResponse = {
  state: "paused",
  totalBytes: 1000,
  availableBytes: 50,
  usedPercent: 95,
  retainedBytes: 750,
  pinnedBytes: 500,
};

Deno.test("reads storage capacity when organization and abort signal are supplied", async () => {
  const { client, requests, signals } = transport(storage);
  const controller = new AbortController();

  const result = await client.getArtifactStorage({
    organizationId,
    signal: controller.signal,
  });

  assertEquals(result, { ok: true, data: storage });
  assertEquals(requests[0]?.url, "https://bakery.example/v1/artifact-storage");
  assertEquals(requests[0]?.method, "GET");
  assertEquals(requests[0]?.credentials, "include");
  assertEquals(
    requests[0]?.headers.get("Bakery-Organization-Id"),
    organizationId,
  );
  assertEquals(signals[0], controller.signal);
});

Deno.test("rejects storage response when capacity state is outside the contract", async () => {
  const { client } = transport({ ...storage, state: "healthy" });

  const result = await client.getArtifactStorage({ organizationId });

  assertEquals(result, {
    ok: false,
    error: { kind: "invalid-response", status: 200 },
  });
});

Deno.test("isolates storage query cache when organization or session changes", () => {
  const { client } = transport(storage);
  const scope = { organizationId, sessionGeneration: 4 };

  const keys = [scope, { ...scope, organizationId: artifactId }, {
    ...scope,
    sessionGeneration: 5,
  }].map((value) => [...artifactStorageQueryOptions(client, value).queryKey]);

  assertEquals(keys, [
    ["protected", 4, organizationId, "artifactStorage.get", {}],
    ["protected", 4, artifactId, "artifactStorage.get", {}],
    ["protected", 5, organizationId, "artifactStorage.get", {}],
  ]);
});

Deno.test("rejects storage query before transport when organization is missing", async () => {
  const { client, requests } = transport(storage);
  const queryClient = new QueryClient();

  try {
    await assertRejects(() =>
      queryClient.fetchQuery(artifactStorageQueryOptions(client, {
        organizationId: null,
        sessionGeneration: 1,
      }))
    );
    assertEquals(requests.length, 0);
  } finally {
    queryClient.clear();
  }
});

Deno.test("fetches storage query with its protected scope", async () => {
  const { client, requests } = transport(storage);
  const queryClient = new QueryClient();

  try {
    const result = await queryClient.fetchQuery(
      artifactStorageQueryOptions(client, {
        organizationId,
        sessionGeneration: 1,
      }),
    );

    assertEquals(result, storage);
    assertEquals(
      requests[0]?.headers.get("Bakery-Organization-Id"),
      organizationId,
    );
  } finally {
    queryClient.clear();
  }
});
