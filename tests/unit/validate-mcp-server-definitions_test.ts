import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  createMcpServer,
  endpointTemplateProblem,
  updateMcpServer,
} from "../../apps/server/src/modules/mcp/server-commands.ts";

/**
 * MCP server definitions without a database (#434): which endpoint a registration
 * may name, which transport and fields a remote definition may carry, and that a
 * refused definition never reaches the database.
 */

const ACCEPTED = [
  "https://mcp.example.com/mcp",
  "https://mcp.example.com:8443/v1/mcp",
  "https://{tenant}.mcp.example.com/mcp",
  "https://api.example.com/{workspace}/mcp",
  "https://mcp.example.com/mcp?region=eu",
];

const REFUSED: [string, string][] = [
  ["http://mcp.example.com/mcp", "endpoint_not_https"],
  ["ftp://mcp.example.com/mcp", "endpoint_not_https"],
  ["https://user:pass@mcp.example.com/mcp", "endpoint_has_credentials"],
  ["https://user@mcp.example.com/mcp", "endpoint_has_credentials"],
  ["https://mcp.example.com/mcp#frag", "endpoint_has_fragment"],
  ["https://localhost/mcp", "endpoint_host_not_public"],
  ["https://app.localhost/mcp", "endpoint_host_not_public"],
  ["https://127.0.0.1/mcp", "endpoint_host_not_public"],
  ["https://10.0.0.5/mcp", "endpoint_host_not_public"],
  ["https://[::1]/mcp", "endpoint_host_not_public"],
  ["https://internal/mcp", "endpoint_host_not_public"],
  ["https://{host}/mcp", "endpoint_placeholder_in_domain"],
  ["https://mcp.{domain}/mcp", "endpoint_placeholder_in_domain"],
  ["https://mcp.example.{tld}/mcp", "endpoint_placeholder_in_domain"],
  ["https://mcp.example.com/{Bad}/mcp", "endpoint_placeholder_invalid"],
  ["https://mcp.example.com/{}/mcp", "endpoint_placeholder_invalid"],
  ["https://mcp.example.com/{a/mcp", "endpoint_placeholder_invalid"],
  ["https://mcp.example.com/mc p", "endpoint_invalid"],
  ["https://mcp.example.com/mc\tp", "endpoint_invalid"],
  ["https://mcp.example.com/mc\\p", "endpoint_invalid"],
  ["https://mcp.example.com/mc\u0000p", "endpoint_invalid"],
  ["not a url", "endpoint_invalid"],
  ["", "endpoint_invalid"],
];

Deno.test("endpoint templates: public https hosts only, with placeholders only outside the domain", () => {
  for (const template of ACCEPTED) {
    assertEquals(endpointTemplateProblem(template), null, template);
  }
  for (const [template, reason] of REFUSED) {
    assertEquals(endpointTemplateProblem(template), reason, template);
  }
});

type Statement = string;

function stand() {
  const recorded: Statement[] = [];
  const transaction = {
    query: (sql: string) => {
      recorded.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const context = {
    transaction,
    params: { id: "11111111-1111-4111-8111-111111111111" },
    principal: { principalId: "p" },
    requestId: "r",
    traceId: "t",
    authority: {
      organizationId: "22222222-2222-4222-8222-222222222222",
      subject: { principalId: "p", principalType: "human" },
    },
    commandMetadata: {
      operation: "mcpServers.create",
      idempotencyKey: "k",
      target: "x",
      expectedVersion: 1,
    },
  } as unknown as ActionContext;
  return { recorded, context };
}

const valid = {
  slug: "docs",
  name: "Docs",
  transport: "streamable_http" as const,
  launchSpec: null,
  endpointTemplate: "https://mcp.example.com/mcp",
  configSchema: { type: "object" },
  requiredCapabilities: [] as string[],
  sourceRevision: "v1",
};

Deno.test("a definition that is not remote, or carries what only a local one carries, is refused before any write", async () => {
  const cases: [string, Partial<typeof valid>, string][] = [
    [
      "stdio without a launch spec",
      { transport: "stdio" as never },
      "launch_spec_required",
    ],
    [
      "stdio with a shell string for a launch",
      {
        transport: "stdio" as never,
        launchSpec: { command: "npx some-server" } as never,
        endpointTemplate: null as never,
      },
      "launch_spec_invalid",
    ],
    [
      "stdio with an endpoint",
      {
        transport: "stdio" as never,
        launchSpec: {
          command: "/usr/local/bin/mcp-files",
          artifactDigest: "a".repeat(64),
        } as never,
      },
      "endpoint_not_for_stdio",
    ],
    [
      "a launch spec",
      { launchSpec: { command: "x" } as never },
      "launch_spec_not_for_remote",
    ],
    [
      "required capabilities",
      { requiredCapabilities: ["gpu"] },
      "capabilities_not_for_remote",
    ],
    ["no endpoint", { endpointTemplate: null as never }, "endpoint_required"],
    [
      "a plain-http endpoint",
      { endpointTemplate: "http://a.example.com/m" },
      "endpoint_not_https",
    ],
    [
      "an array config schema",
      { configSchema: [] as never },
      "config_schema_not_object",
    ],
  ];
  for (const [name, override, reason] of cases) {
    const { context, recorded } = stand();
    const error = await assertRejects(
      () => createMcpServer(context, { ...valid, ...override }),
      StandardError,
      "",
      name,
    );
    assertEquals(error.code, "UNPROCESSABLE", name);
    const issues = (error.params as { issues?: { code: string }[] }).issues;
    assertEquals(issues?.[0]?.code, reason, name);
    assertEquals(recorded, [], `${name} reached the database`);
  }
});

Deno.test("an update names something to change, keeps a remote server's capabilities empty, and needs its version", async () => {
  {
    const { context, recorded } = stand();
    const error = await assertRejects(
      () => updateMcpServer(context, {}),
      StandardError,
    );
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(recorded, []);
  }
  {
    const { context, recorded } = stand();
    const error = await assertRejects(
      () => updateMcpServer(context, { requiredCapabilities: ["gpu"] }),
      StandardError,
    );
    assertEquals(error.code, "UNPROCESSABLE");
    assertEquals(recorded, []);
  }
  {
    const { context } = stand();
    (context as unknown as { commandMetadata: Record<string, unknown> })
      .commandMetadata.expectedVersion = undefined;
    const error = await assertRejects(
      () => updateMcpServer(context, { name: "x" }),
      StandardError,
    );
    assertEquals(error.code, "PRECONDITION_REQUIRED");
  }
});

Deno.test("a local stdio definition stores its pinned launch and required capabilities, and no endpoint (#441)", async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const row = {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "files",
    name: "Files",
    transport: "stdio",
    launch_spec: {
      command: "/usr/local/bin/mcp-files",
      args: ["--root", "/srv"],
      artifactDigest: "a".repeat(64),
    },
    endpoint_template: null,
    config_schema: { type: "object" },
    required_capabilities: ["mcp-files"],
    source_revision: "v1",
    enabled: false,
    created_at: new Date(0),
    updated_at: new Date(0),
    version: 1,
  };
  const { context } = stand();
  (context as unknown as { transaction: unknown }).transaction = {
    query: (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes("insert into bakery.mcp_servers")) {
        return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
      }
      if (sql.includes("from bakery.mcp_servers")) {
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      return Promise.resolve({ rows: [{ next: 1 }], rowCount: 1 });
    },
  };
  // The stand has no event clock; the insert is what this test reads.
  await createMcpServer(context, {
    ...valid,
    slug: "files",
    name: "Files",
    transport: "stdio" as never,
    endpointTemplate: null as never,
    launchSpec: {
      command: "/usr/local/bin/mcp-files",
      args: ["--root", "/srv"],
      artifactDigest: "a".repeat(64),
    } as never,
    requiredCapabilities: ["mcp-files"],
  }).catch(() => undefined);
  const insert = statements.find((s) =>
    s.sql.includes("insert into bakery.mcp_servers")
  )!;
  assertEquals(insert.values.slice(3, 6), [
    "stdio",
    JSON.stringify({
      command: "/usr/local/bin/mcp-files",
      args: ["--root", "/srv"],
      artifactDigest: "a".repeat(64),
    }),
    null,
  ]);
  assertEquals(insert.values[7], JSON.stringify(["mcp-files"]));
});
