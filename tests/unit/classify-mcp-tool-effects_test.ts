import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  listMcpToolClassifications,
  putMcpToolClassification,
} from "../../apps/server/src/modules/mcp/classification-commands.ts";

/**
 * Tool effect classification without a database (#434, O26): every rule on what a
 * class may and may not carry, the version rules, and what the list says about a
 * tool nobody classified. The fake answers from the SQL text and records the writes.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const DIGEST = "sha256:current";

const tools = [
  {
    name: "search",
    description: "",
    inputSchema: { type: "object", properties: { query: {} } },
  },
  {
    name: "create_issue",
    description: "",
    inputSchema: { type: "object", properties: { title: {}, request_id: {} } },
  },
  {
    name: "get_issue",
    description: "",
    inputSchema: { type: "object", properties: { request_id: {} } },
  },
  { name: "bare", description: "", inputSchema: { type: "object" } },
];

type Row = {
  tool_name: string;
  effect_class: string;
  effect_key_argument: string | null;
  paired_read_tool: string | null;
  snapshot_digest: string;
  updated_at: Date;
  version: number;
};
const row = (over: Partial<Row> & { tool_name: string }): Row => ({
  effect_class: "read",
  effect_key_argument: null,
  paired_read_tool: null,
  snapshot_digest: DIGEST,
  updated_at: new Date("2026-11-19T12:00:00.000Z"),
  version: 1,
  ...over,
});

function stand(
  options: {
    role?: string;
    owner?: string | null;
    snapshot?: boolean;
    rows?: Row[];
    expectedVersion?: number | null;
  } = {},
) {
  const writes: { sql: string; values: unknown[] }[] = [];
  const rows = options.rows ?? [];
  const transaction = {
    query: (sql: string, values: unknown[] = []) => {
      if (sql.includes("from bakery.mcp_connections as connection")) {
        // The real query shows an organization connection, or the caller's own.
        const owner = options.owner ?? null;
        if (owner !== null && owner !== values[2]) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({
          rows: [{
            id: CONNECTION,
            server_id: "s",
            integration_connection_id: null,
            worker_host_id: null,
            owner_principal_id: options.owner ?? null,
            label: "L",
            config: {},
            secret_id: null,
            enabled_capabilities: [],
            status: "enabled",
            current_snapshot_id: options.snapshot === false ? null : SNAPSHOT,
            created_at: new Date(),
            updated_at: new Date(),
            version: 1,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("from bakery.mcp_capability_snapshots")) {
        return Promise.resolve({
          rows: [{ digest: DIGEST, manifest: { tools } }],
          rowCount: 1,
        });
      }
      if (/^\s*insert|^\s*update/i.test(sql)) {
        if (sql.includes("bakery.mcp_tool_classifications")) {
          writes.push({ sql, values });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("paired_read_tool = $3")) {
        const found = rows.some((r) => r.paired_read_tool === values[2]);
        return Promise.resolve({
          rows: found ? [{}] : [],
          rowCount: found ? 1 : 0,
        });
      }
      if (sql.includes("select effect_class from")) {
        const hit = rows.find((r) => r.tool_name === values[2]);
        return Promise.resolve({
          rows: hit ? [{ effect_class: hit.effect_class }] : [],
          rowCount: 1,
        });
      }
      if (sql.includes("from bakery.mcp_tool_classifications")) {
        const wanted = values[2];
        const result = sql.includes("for update") || wanted !== undefined
          ? rows.filter((r) => r.tool_name === wanted)
          : rows;
        // After a write the selected row reflects it, as the real table would.
        const wrote = writes.length > 0;
        return Promise.resolve({
          rows: wrote && result.length === 0
            ? [
              row({
                tool_name: String(wanted),
                effect_class: String(writes[0].values[3]),
                version: 1,
              }),
            ]
            : result,
          rowCount: result.length,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const metadata: Record<string, unknown> = {
    operation: "mcpToolClassifications.put",
    idempotencyKey: "k",
    target: "t",
  };
  if (
    options.expectedVersion !== null && options.expectedVersion !== undefined
  ) {
    metadata.expectedVersion = options.expectedVersion;
  }
  const context = {
    transaction,
    params: { id: CONNECTION, toolName: "create_issue" },
    principal: { principalId: "p" },
    requestId: "r",
    traceId: "t",
    authority: {
      organizationId: ORG,
      role: options.role ?? "admin",
      subject: { principalId: "p", principalType: "human" },
    },
    commandMetadata: metadata,
  } as unknown as ActionContext;
  return { context, writes };
}

async function refused(
  run: () => Promise<unknown>,
  code: string,
  reason?: string,
) {
  const error = await assertRejects(run, StandardError);
  assertEquals(error.code, code);
  if (reason) {
    const issues = (error.params as { issues?: { code: string }[] }).issues;
    assertEquals(issues?.[0]?.code, reason);
  }
}

Deno.test("each class carries exactly what it needs and nothing it does not", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "idempotent without a key",
      { effectClass: "write_idempotent" },
      "effect_key_required",
    ],
    ["idempotent naming an argument the schema lacks", {
      effectClass: "write_idempotent",
      effectKeyArgument: "nope",
    }, "effect_key_unknown_argument"],
    [
      "read with a key",
      { effectClass: "read", effectKeyArgument: "title" },
      "effect_key_not_allowed",
    ],
    ["opaque with a key", {
      effectClass: "write_opaque",
      effectKeyArgument: "title",
    }, "effect_key_not_allowed"],
    ["reconcilable without a paired read", {
      effectClass: "write_reconcilable",
    }, "paired_read_required"],
    ["reconcilable paired with itself", {
      effectClass: "write_reconcilable",
      pairedReadTool: "create_issue",
    }, "paired_read_is_self"],
    ["reconcilable paired with a tool that is not there", {
      effectClass: "write_reconcilable",
      pairedReadTool: "ghost",
    }, "paired_read_unknown_tool"],
    ["reconcilable paired with an unclassified tool", {
      effectClass: "write_reconcilable",
      pairedReadTool: "get_issue",
    }, "paired_read_not_read"],
    ["read with a paired read", {
      effectClass: "read",
      pairedReadTool: "get_issue",
    }, "paired_read_not_allowed"],
    ["idempotent with a paired read", {
      effectClass: "write_idempotent",
      effectKeyArgument: "request_id",
      pairedReadTool: "get_issue",
    }, "paired_read_not_allowed"],
  ];
  for (const [name, input, reason] of cases) {
    const { context, writes } = stand();
    await refused(
      () => putMcpToolClassification(context, input as never),
      "UNPROCESSABLE",
      reason,
    );
    assertEquals(writes, [], name);
  }
  // A schema with no properties declares no argument to key on.
  const { context } = stand();
  (context.params as Record<string, string>).toolName = "bare";
  await refused(
    () =>
      putMcpToolClassification(
        context,
        { effectClass: "write_idempotent", effectKeyArgument: "x" } as never,
      ),
    "UNPROCESSABLE",
    "effect_key_unknown_argument",
  );
});

Deno.test("a reconcilable write pairs only with a tool already classified read", async () => {
  const { context, writes } = stand({
    rows: [row({ tool_name: "get_issue", effect_class: "read" })],
  });
  const saved = await putMcpToolClassification(context, {
    effectClass: "write_reconcilable",
    pairedReadTool: "get_issue",
  } as never);
  assertEquals(saved.effectClass, "write_reconcilable");
  assertEquals(writes.length, 1);
  assertEquals(writes[0].values[6], DIGEST);
  // Paired with a tool classified as a write is not a confirming read.
  const wrong = stand({
    rows: [row({ tool_name: "get_issue", effect_class: "write_opaque" })],
  });
  await refused(
    () =>
      putMcpToolClassification(
        wrong.context,
        {
          effectClass: "write_reconcilable",
          pairedReadTool: "get_issue",
        } as never,
      ),
    "UNPROCESSABLE",
    "paired_read_not_read",
  );
});

Deno.test("an async write names a key both tools declare and polls through a read", async () => {
  const classifiedRead = [
    row({ tool_name: "get_issue", effect_class: "read" }),
    row({ tool_name: "search", effect_class: "read" }),
  ];
  const cases: [string, Record<string, unknown>, string][] = [
    ["async without a key", {
      effectClass: "write_async",
      pairedReadTool: "get_issue",
    }, "effect_key_required"],
    ["async without a poll", {
      effectClass: "write_async",
      effectKeyArgument: "request_id",
    }, "paired_read_required"],
    ["async polling itself", {
      effectClass: "write_async",
      effectKeyArgument: "request_id",
      pairedReadTool: "create_issue",
    }, "paired_read_is_self"],
    ["async polling a tool that lacks the key", {
      effectClass: "write_async",
      effectKeyArgument: "request_id",
      pairedReadTool: "search",
    }, "async_poll_lacks_effect_key"],
  ];
  for (const [name, input, reason] of cases) {
    const { context, writes } = stand({ rows: classifiedRead });
    await refused(
      () => putMcpToolClassification(context, input as never),
      "UNPROCESSABLE",
      reason,
    );
    assertEquals(writes, [], name);
  }
  const unread = stand();
  await refused(
    () =>
      putMcpToolClassification(unread.context, {
        effectClass: "write_async",
        effectKeyArgument: "request_id",
        pairedReadTool: "get_issue",
      } as never),
    "UNPROCESSABLE",
    "paired_read_not_read",
  );
  const { context, writes } = stand({ rows: classifiedRead });
  const saved = await putMcpToolClassification(context, {
    effectClass: "write_async",
    effectKeyArgument: "request_id",
    pairedReadTool: "get_issue",
  } as never);
  assertEquals(saved.effectClass, "write_async");
  assertEquals(writes.length, 1);
  assertEquals(writes[0].values.slice(3, 6), [
    "write_async",
    "request_id",
    "get_issue",
  ]);
});

Deno.test("a first classification takes no version; a change must carry the one it read", async () => {
  // Nothing there: a version names something that is not.
  {
    const { context, writes } = stand({ expectedVersion: 1 });
    await refused(
      () =>
        putMcpToolClassification(
          context,
          { effectClass: "write_opaque" } as never,
        ),
      "PRECONDITION_FAILED",
    );
    assertEquals(writes, []);
  }
  const existing = [
    row({
      tool_name: "create_issue",
      effect_class: "write_opaque",
      version: 3,
    }),
  ];
  {
    const { context, writes } = stand({ rows: existing });
    await refused(
      () => putMcpToolClassification(context, { effectClass: "read" } as never),
      "PRECONDITION_REQUIRED",
    );
    assertEquals(writes, []);
  }
  {
    const { context, writes } = stand({ rows: existing, expectedVersion: 2 });
    await refused(
      () => putMcpToolClassification(context, { effectClass: "read" } as never),
      "PRECONDITION_FAILED",
    );
    assertEquals(writes, []);
  }
  {
    const { context, writes } = stand({ rows: existing, expectedVersion: 3 });
    await putMcpToolClassification(context, { effectClass: "read" } as never);
    assertEquals(writes.length, 1);
  }
});

Deno.test("a read tool another tool names as its confirming read cannot stop being a read", async () => {
  const rows = [
    row({ tool_name: "create_issue", effect_class: "read", version: 2 }),
    row({
      tool_name: "other",
      effect_class: "write_reconcilable",
      paired_read_tool: "create_issue",
    }),
  ];
  const { context, writes } = stand({ rows, expectedVersion: 2 });
  await refused(
    () =>
      putMcpToolClassification(
        context,
        { effectClass: "write_opaque" } as never,
      ),
    "STATE_CONFLICT",
  );
  assertEquals(writes, []);
});

Deno.test("who may classify: an Admin an organization connection, the owner a personal one, nobody else", async () => {
  {
    const { context, writes } = stand({ role: "developer" });
    await refused(
      () =>
        putMcpToolClassification(
          context,
          { effectClass: "write_opaque" } as never,
        ),
      "AUTH_FORBIDDEN",
    );
    assertEquals(writes, []);
  }
  {
    // A personal connection of someone else is absent, even to an Admin.
    const { context } = stand({ role: "admin", owner: "someone-else" });
    await refused(
      () =>
        putMcpToolClassification(
          context,
          { effectClass: "write_opaque" } as never,
        ),
      "RESOURCE_NOT_FOUND",
    );
  }
});

Deno.test("an unknown tool, a malformed name and an undiscovered connection are absent", async () => {
  for (const name of ["ghost", "has space", "", "../x"]) {
    const { context, writes } = stand();
    (context.params as Record<string, string>).toolName = name;
    await refused(
      () =>
        putMcpToolClassification(
          context,
          { effectClass: "write_opaque" } as never,
        ),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(writes, []);
  }
  const { context } = stand({ snapshot: false });
  await refused(
    () =>
      putMcpToolClassification(
        context,
        { effectClass: "write_opaque" } as never,
      ),
    "RESOURCE_NOT_FOUND",
  );
});

Deno.test("the list shows every snapshot tool: unclassified ones as the writes Bakery treats them as, stale ones flagged", async () => {
  const { context } = stand({
    rows: [
      row({ tool_name: "search", effect_class: "read", version: 4 }),
      row({
        tool_name: "get_issue",
        effect_class: "read",
        snapshot_digest: "sha256:old",
      }),
      row({ tool_name: "removed_since", effect_class: "read" }),
    ],
  });
  const listed = await listMcpToolClassifications(context);
  assertEquals(listed.items.map((item) => item.toolName), [
    "bare",
    "create_issue",
    "get_issue",
    "search",
  ]);
  const by = Object.fromEntries(
    listed.items.map((item) => [item.toolName, item]),
  );
  // Nobody classified these: at most once, and never read as safe.
  assertEquals(by.bare.effectClass, "write_opaque");
  assertEquals(by.bare.classified, false);
  assertEquals(by.bare.version, 0);
  assertEquals(by.bare.classifiedAt, null);
  assertEquals(by.search.classified, true);
  assertEquals(by.search.version, 4);
  assertEquals(by.search.classifiedAgainstCurrentSnapshot, true);
  // Classified against a snapshot that has since changed: look again.
  assertEquals(by.get_issue.classifiedAgainstCurrentSnapshot, false);
  // A classification for a tool no longer offered is not listed.
  assertEquals("removed_since" in by, false);
});
