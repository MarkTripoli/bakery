import { createTool } from "@mastra/core/tools";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { Inngest } from "inngest";
import { serve } from "inngest/hono";
import postgres from "postgres";
import { z } from "zod";
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { assertDescribedJsonSchema } from "../../packages/contracts/src/contracts.ts";

const dependencyBoundarySchema = z.strictObject({
  runtime: z.string().min(1).describe(
    "Exact Deno runtime version that executed the compatibility suite.",
  ),
  packages: z.array(
    z.strictObject({
      name: z.string().min(1).describe(
        "Package import name used by Bakery's backend boundary.",
      ),
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe(
        "Pinned npm package version resolved by the Deno import map.",
      ),
      role: z.string().min(1).describe(
        "Narrow backend boundary covered by this pinned dependency.",
      ),
    }).describe(
      "One pinned package and the reason it is part of the compatibility boundary.",
    ),
  ).min(1).describe(
    "Pinned packages that must stay mutually compatible under Deno.",
  ),
  incompatibilities: z.array(
    z.strictObject({
      package: z.string().min(1).describe(
        "Package or export where the compatibility limitation was observed.",
      ),
      finding: z.string().min(1).describe(
        "Focused incompatibility or drift that downstream issues must not hide.",
      ),
    }).describe(
      "Recorded compatibility finding that blocks silent bridges or stack switches.",
    ),
  ).describe("Known compatibility findings recorded by this suite."),
}).describe(
  "Bakery backend dependency boundary evidence recorded by the compatibility suite.",
);

const toolInputSchema = z.strictObject({
  text: z.string().min(1).describe(
    "Text supplied by the caller for a deterministic local tool echo.",
  ),
}).describe("Input accepted by the deterministic Mastra compatibility tool.");

const toolOutputSchema = z.strictObject({
  echoed: z.string().min(1).describe(
    "Text returned by the deterministic local tool after validation.",
  ),
}).describe("Output returned by the deterministic Mastra compatibility tool.");

const mcpToolInputSchema = z.strictObject({
  text: z.string().min(1).describe(
    "Text argument accepted by the MCP echo tool.",
  ),
}).describe("Input schema exposed through the MCP tool registration.");

const mcpToolOutputSchema = z.strictObject({
  echoed: z.string().min(1).describe(
    "Text result exposed as structured MCP content.",
  ),
}).describe("Output schema exposed through the MCP tool registration.");

function isPublicCimdAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (!isIpv4(value)) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 31 && c === 196) ||
    (a === 192 && b === 52 && c === 193) ||
    (a === 192 && b === 175 && c === 48) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

async function fetchCimdClientMetadata(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new TypeError("CIMD transport requires HTTPS");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("CIMD transport supports only GET and HEAD");
  }
  if (request.redirect !== "error") {
    throw new TypeError("CIMD transport refuses redirects");
  }
  request.signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = hostname.includes(":") || isIpv4(hostname)
    ? [hostname]
    : await resolveDnsWithAbort(hostname, request.signal);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicCimdAddress(address))
  ) {
    throw new TypeError(
      "CIMD hostname must resolve only to public-routable addresses",
    );
  }
  throw new TypeError(
    "CIMD Deno transport is blocked until resolved-address connection pinning is available",
  );
}

async function resolveDnsWithAbort(
  hostname: string,
  signal: AbortSignal,
  resolveDns: (hostname: string) => Promise<string[]> = (name) =>
    Deno.resolveDns(name, "A"),
): Promise<string[]> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([resolveDns(hostname), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    const octet = Number(part);
    return /^\d+$/.test(part) && Number.isInteger(octet) && octet <= 255;
  });
}

Deno.test("recursive schema checker rejects missing and whitespace descriptions", () => {
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root object",
      properties: { nested: { description: "   ", type: "string" } },
      type: "object",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root object",
      properties: { nested: { description: "nested", type: "string" } },
      type: "object",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root object",
      properties: {
        nested: { description: "TODO: describe this", type: "string" },
      },
      type: "object",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root object",
      properties: { nested: { description: "string", type: "string" } },
      type: "object",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root object",
      properties: { nested: { description: "A description", type: "string" } },
      type: "object",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      description: "Root array",
      items: { type: "string" },
      type: "array",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      anyOf: [{ description: "First branch", type: "string" }, {
        type: "number",
      }],
      description: "Union of branches",
    })
  );
  assertThrows(() =>
    assertDescribedJsonSchema({
      additionalProperties: { description: "   ", type: "string" },
      description: "String record",
      type: "object",
    })
  );
});

Deno.test("pinned Deno dependency boundary is explicit", () => {
  const boundary = dependencyBoundarySchema.parse({
    runtime: Deno.version.deno,
    packages: [
      {
        name: "hono",
        version: "4.13.7",
        role: "HTTP routing and request/response handling.",
      },
      {
        name: "inngest",
        version: "4.20.0",
        role: "Direct HTTP workflow discovery and invocation endpoint.",
      },
      {
        name: "@mastra/core",
        version: "1.64.0",
        role: "Local tool schema validation and execution surface.",
      },
      {
        name: "better-auth",
        version: "1.7.3",
        role:
          "Auth handler, organization, OAuth, two-factor, and OpenAPI plugin boundary.",
      },
      {
        name: "@better-auth/passkey",
        version: "1.7.3",
        role: "Passkey plugin boundary; not exported by better-auth/plugins.",
      },
      {
        name: "@modelcontextprotocol/client",
        version: "2.0.0",
        role: "MCP 2026-07-28 client transport and protocol boundary.",
      },
      {
        name: "@modelcontextprotocol/server",
        version: "2.0.0",
        role: "MCP 2026-07-28 server transport and protocol boundary.",
      },
      {
        name: "@better-auth/mcp",
        version: "1.7.3",
        role: "OAuth 2.1 protected resource and MCP authorization boundary.",
      },
      {
        name: "@better-auth/cimd",
        version: "1.7.3",
        role: "MCP 2026-07-28 Client ID Metadata Document validation boundary.",
      },
      {
        name: "postgres",
        version: "3.4.9",
        role: "Deno-compatible Postgres driver import and pool construction.",
      },
      {
        name: "zod",
        version: "4.5.4",
        role: "Described runtime schemas and native JSON Schema export.",
      },
    ],
    incompatibilities: [
      {
        package: "inngest@4.20.0",
        finding:
          "createFunction uses { id, triggers } as the first argument; older trigger-second-argument examples fail.",
      },
      {
        package: "better-auth@1.7.3/plugins",
        finding:
          "passkey is resolved from @better-auth/passkey@1.7.3, not from better-auth/plugins.",
      },
      {
        package: "@mastra/deploy-inngest@1.64.0",
        finding:
          "The package is not published; use Inngest's direct HTTP boundary instead of an unpinned connector bridge.",
      },
      {
        package: "@better-auth/cimd@1.7.3",
        finding:
          "The Deno suite cannot safely exercise the callback against a live public metadata endpoint; connected CIMD proof remains blocked after denied-address transport checks.",
      },
    ],
  });

  assertEquals(boundary.runtime, "2.9.1");
  assertEquals(boundary.packages.length, 11);
  assertEquals(boundary.packages.map(({ name }) => name), [
    "hono",
    "inngest",
    "@mastra/core",
    "better-auth",
    "@better-auth/passkey",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/server",
    "@better-auth/mcp",
    "@better-auth/cimd",
    "postgres",
    "zod",
  ]);
  assertEquals(boundary.incompatibilities.length, 4);
  assertDescribedJsonSchema(z.toJSONSchema(dependencyBoundarySchema));
});

Deno.test("CIMD Deno transport rejects non-HTTPS and special-use addresses", async () => {
  await assertRejects(
    () => fetchCimdClientMetadata("http://example.com/client.json"),
    TypeError,
    "CIMD transport requires HTTPS",
  );
  for (
    const address of [
      "127.0.0.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.175.48.1",
      "192.88.99.1",
    ]
  ) {
    await assertRejects(
      () =>
        fetchCimdClientMetadata(`https://${address}/client.json`, {
          redirect: "error",
        }),
      TypeError,
      "CIMD hostname must resolve only to public-routable addresses",
    );
  }
});

Deno.test("CIMD DNS resolution aborts before a pending resolver completes", async () => {
  const controller = new AbortController();
  let finishResolution!: (addresses: string[]) => void;
  const pendingResolution = new Promise<string[]>((resolve) => {
    finishResolution = resolve;
  });
  const resolution = resolveDnsWithAbort(
    "metadata.example",
    controller.signal,
    () => pendingResolution,
  );
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assertRejects(
    () => resolution,
    DOMException,
    "client disconnected",
  );
  finishResolution(["203.0.113.1"]);
});

Deno.test({
  name: "Better Auth serves the composed JWT MCP/CIMD profile",
  permissions: { env: true },
  fn: async () => {
    const { betterAuth } = await import("better-auth");
    const { jwt } = await import("better-auth/plugins");
    const { cimd } = await import("@better-auth/cimd");
    const { mcp } = await import("@better-auth/mcp");
    const auth = betterAuth({
      secret: "bakery-compatibility-secret-32-bytes",
      baseURL: "https://bakery.example",
      plugins: [
        jwt(),
        mcp({
          consentPage: "/consent",
          loginPage: "/login",
          resource: "https://bakery.example/mcp",
        }),
        cimd({
          fetchClientMetadataResource: fetchCimdClientMetadata,
          metadataProfile: "mcp-2026-07-28",
        }),
      ],
    });

    const metadata = await auth.handler(
      new Request(
        "https://bakery.example/.well-known/oauth-protected-resource/mcp",
      ),
    );
    assertEquals(metadata.status, 200);
    const metadataBody = await metadata.json();
    assertEquals(metadataBody.resource, "https://bakery.example/mcp");
    assertEquals(metadataBody.authorization_servers, [
      "https://bakery.example/api/auth",
    ]);
    assertEquals(metadataBody.bearer_methods_supported, ["header"]);

    const authorizationMetadata = await auth.handler(
      new Request(
        "https://bakery.example/api/auth/.well-known/openid-configuration",
      ),
    );
    assertEquals(authorizationMetadata.status, 200);
    assertEquals(
      (await authorizationMetadata.json())
        .client_id_metadata_document_supported,
      true,
    );

    const jwks = await auth.handler(
      new Request("https://bakery.example/api/auth/jwks"),
    );
    assertEquals(jwks.status, 200);
    const jwksBody = await jwks.json();
    assert(Array.isArray(jwksBody.keys) && jwksBody.keys.length > 0);
    assertExists(jwksBody.keys[0].alg);
  },
});

Deno.test("Hono serves Inngest discovery over direct HTTP without model billing", async () => {
  const inngest = new Inngest({ id: "bakery-compatibility", isDev: true });
  const fn = inngest.createFunction(
    { id: "echo", triggers: [{ event: "bakery/compat.echo" }] },
    ({ event }) => ({ echoed: String(event.data?.text ?? "") }),
  );
  const app = new Hono();

  app.on(
    ["GET", "PUT", "POST"],
    "/api/inngest",
    serve({ client: inngest, functions: [fn] }),
  );

  const discovery = await app.request("/api/inngest", { method: "GET" });
  assertEquals(discovery.status, 200);
  const body = await discovery.json();
  assertEquals(body.mode, "dev");
  assertEquals(body.function_count, 1);
  assertEquals(body.schema_version, "2024-05-24");
});

Deno.test("Mastra executes through a bounded real Deno HTTP stream", async () => {
  const echoTool = createTool({
    id: "compat.echo",
    description: "Echoes validated input without calling a model provider.",
    inputSchema: toolInputSchema,
    outputSchema: toolOutputSchema,
    execute: ({ text }) => Promise.resolve({ echoed: text }),
  });

  const app = new Hono();
  const maxBodyBytes = 1024;
  app.post("/tool", async (context) => {
    const contentType = context.req.header("content-type")?.split(";", 1)[0];
    if (contentType !== "application/json") {
      return context.json({ error: "unsupported media type" }, 415);
    }
    const contentLength = Number(context.req.header("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > maxBodyBytes) {
      return context.json({ error: "request body too large" }, 413);
    }
    const reader = context.req.raw.body?.getReader();
    if (!reader) return context.json({ error: "request body required" }, 400);
    const bytes: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel("body limit");
          return context.json({ error: "request body too large" }, 413);
        }
        bytes.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let input: z.infer<typeof toolInputSchema>;
    try {
      input = toolInputSchema.parse(
        JSON.parse(new TextDecoder().decode(concat(bytes))),
      );
    } catch {
      return context.json({ error: "invalid input" }, 400);
    }
    if (context.req.raw.signal.aborted) {
      return context.json({ error: "cancelled" }, 408);
    }
    const output = await Promise.race([
      echoTool.execute?.(
        input,
        {} as Parameters<NonNullable<typeof echoTool.execute>>[1],
      ),
      new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(new DOMException("request cancelled", "AbortError"));
        context.req.raw.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      }),
    ]);
    const body = JSON.stringify(toolOutputSchema.parse(output)) + "\n";
    const encoded = new TextEncoder().encode(body);
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      canceled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        context.req.raw.signal.addEventListener("abort", cancel, {
          once: true,
        });
        const split = Math.ceil(encoded.length / 2);
        controller.enqueue(encoded.subarray(0, split));
        timer = setTimeout(() => {
          if (canceled || context.req.raw.signal.aborted) return;
          try {
            controller.enqueue(encoded.subarray(split));
            controller.close();
          } catch {
            cancel();
          }
        }, 10);
      },
      cancel() {
        cancel();
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 } as Deno.ServeTcpOptions,
    (request) => app.fetch(request),
  );
  try {
    const endpoint = `http://127.0.0.1:${server.addr.port}/tool`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "streamed" }),
      signal: AbortSignal.timeout(1000),
    });
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "application/x-ndjson; charset=utf-8",
    );
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert(!first.done);
    assert(
      first.value &&
        first.value.byteLength < encodedLength({ echoed: "streamed" }),
    );
    const chunks = [first.value!];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const lines = new TextDecoder().decode(concat(chunks)).trim().split("\n");
    assertEquals(lines.length, 1);
    assertEquals(toolOutputSchema.parse(JSON.parse(lines[0])), {
      echoed: "streamed",
    });

    const canceledResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "canceled" }),
    });
    const canceledReader = canceledResponse.body!.getReader();
    const canceledFirst = await canceledReader.read();
    assert(!canceledFirst.done);
    await canceledReader.cancel("client disconnected");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const survivingResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "survives" }),
    });
    assertEquals(survivingResponse.status, 200);
    assertEquals(
      toolOutputSchema.parse(
        JSON.parse((await survivingResponse.text()).trim()),
      ),
      { echoed: "survives" },
    );
  } finally {
    await Promise.race([
      server.shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("server shutdown timed out")), 1000)
      ),
    ]);
  }
  assertDescribedJsonSchema(z.toJSONSchema(toolOutputSchema));
});

Deno.test({
  name: "Better Auth plugins and generated OpenAPI handler survive under Deno",
  permissions: { env: true },
  fn: async () => {
    const { passkey } = await import("@better-auth/passkey");
    const { betterAuth } = await import("better-auth");
    const { genericOAuth, openAPI, organization, twoFactor } = await import(
      "better-auth/plugins"
    );
    const auth = betterAuth({
      secret: "bakery-compatibility-secret-32-bytes",
      baseURL: "http://localhost:3000",
      plugins: [
        organization(),
        genericOAuth({
          config: [{
            providerId: "bakery-oauth",
            clientId: "client-id",
            clientSecret: "client-secret",
            authorizationUrl: "https://identity.example/authorize",
            tokenUrl: "https://identity.example/token",
          }],
        }),
        twoFactor(),
        passkey(),
        openAPI({ disableDefaultReference: true }),
      ],
    });

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/open-api/generate-schema"),
    );
    assertEquals(response.status, 200);
    const schema = await response.json();
    assertEquals(schema.openapi, "3.1.1");
    assertExists(schema.paths["/organization/create"]);
    assertExists(schema.paths["/two-factor/enable"]);
    assertExists(schema.paths["/passkey/generate-register-options"]);
  },
});

Deno.test("MCP v2 probes and invokes the pinned 2026-07-28 HTTP profile", async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "bakery-compat", version: "1.0.0" });
    server.registerTool(
      "bakery_echo",
      {
        title: "Bakery Echo",
        description: "Validates the selected MCP SDK tool boundary.",
        inputSchema: mcpToolInputSchema,
        outputSchema: mcpToolOutputSchema,
      },
      ({ text }: z.infer<typeof mcpToolInputSchema>) => ({
        content: [{ type: "text", text }],
        structuredContent: mcpToolOutputSchema.parse({ echoed: text }),
      }),
    );
    return server;
  }, { legacy: "reject", responseMode: "json" });
  const tcp = Deno.serve(
    { hostname: "127.0.0.1", port: 0 } as Deno.ServeTcpOptions,
    (request) => handler.fetch(request),
  );
  try {
    const client = new Client(
      { name: "bakery-compat-client", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
          probe: { timeoutMs: 1000 },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(tcp.addr as Deno.NetAddr).port}/mcp`),
      { requestInit: { signal: AbortSignal.timeout(2000) } },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    assertEquals(tools.tools.length, 1);
    assertEquals(tools.tools[0].name, "bakery_echo");
    assertEquals(
      tools.tools[0].inputSchema.description,
      "Input schema exposed through the MCP tool registration.",
    );
    assertDescribedJsonSchema(tools.tools[0].inputSchema);
    const result = await client.callTool({
      name: "bakery_echo",
      arguments: { text: "ok" },
    });
    assertEquals(result.structuredContent, { echoed: "ok" });
    await client.close();
  } finally {
    await handler.close();
    await tcp.shutdown();
  }
});

Deno.test("Postgres boundary imports without substituting runtimes", async () => {
  const sql = postgres("postgres://127.0.0.1:1/bakery", {
    connect_timeout: 1,
    max: 1,
  });
  assertEquals(typeof sql.begin, "function");
  assertEquals(typeof sql.unsafe, "function");
  await assertRejectsWithin(
    sql`select 1`,
    1000,
    new Set(["ECONNREFUSED", "ETIMEDOUT", "CONNECT_TIMEOUT"]),
  );
  await sql.end({ timeout: 1 });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function assertRejectsWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  expectedCodes: ReadonlySet<string>,
): Promise<void> {
  await Promise.race([
    promise.then(() => {
      throw new Error("expected dependency failure");
    }, (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      assert(
        typeof code === "string" && expectedCodes.has(code),
        `unexpected dependency failure code: ${String(code)}`,
      );
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("dependency probe timed out")),
        timeoutMs,
      )
    ),
  ]);
}

function encodedLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) + "\n").byteLength;
}
