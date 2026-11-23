import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

/**
 * #434 tool effect classification against a real database and the production app.
 *
 * What only a database and the real routes can show, and what these pin:
 *
 *  - an unclassified tool reads as a write that runs at most once, and a
 *    classification is created without a version and changed only with the one it read;
 *  - an effect key must be an argument the tool declares, and a confirming read must
 *    itself be classified read, and cannot stop being one while another tool relies on it;
 *  - rediscovery flags a classification made against an earlier snapshot;
 *  - an Admin classifies an organization connection, the owner a personal one, and a
 *    personal connection is absent to everyone else;
 *  - the application role holds exactly the grants the writes need.
 */

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;
type Body = Record<string, unknown>;

async function send(
  f: Fixture,
  cookie: string,
  method: string,
  path: string,
  options: { body?: unknown; ifMatch?: string } = {},
) {
  const headers: Record<string, string> = { ...orgHeader(f.organizationId) };
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;
  const response = await call(f, method, path, cookie, {
    body: options.body,
    headers,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) as Body : {},
  };
}

const tool = (name: string, properties: Body = {}) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties },
});

/** An organization or personal connection with a snapshot pinned, as discovery leaves it. */
async function pinned(
  f: Fixture,
  cookie: string,
  scope: "organization" | "personal",
  tools: unknown[],
  digest = "digest-1",
) {
  const server = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
    body: {
      slug: `s-${crypto.randomUUID().slice(0, 8)}`,
      name: "Docs",
      transport: "streamable_http",
      endpointTemplate: "https://mcp.example.com/mcp",
      configSchema: { type: "object" },
      requiredCapabilities: [],
      sourceRevision: "v1",
    },
  });
  await send(f, f.adminCookie, "PATCH", `/v1/mcp-servers/${server.json.id}`, {
    body: { enabled: true },
    ifMatch: '"1"',
  });
  const made = await send(f, cookie, "POST", "/v1/mcp-connections", {
    body: {
      serverId: server.json.id,
      label: "Docs",
      config: {},
      enabledCapabilities: [],
      scope,
    },
  });
  assert([200, 201].includes(made.status), JSON.stringify(made.json));
  const id = made.json.id as string;
  await pin(f, id, tools, digest);
  return id;
}

async function pin(f: Fixture, id: string, tools: unknown[], digest: string) {
  const snapshotId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.mcp_capability_snapshots
       (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
     values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, $5)`,
    [snapshotId, f.organizationId, id, JSON.stringify({ tools }), digest],
  );
  await f.pgDatabase.query(
    "update bakery.mcp_connections set current_snapshot_id = $2 where id = $1",
    [id, snapshotId],
  );
}

const tools = () => [
  tool("search", { query: {} }),
  tool("create_issue", { title: {}, request_id: {} }),
  tool("get_issue"),
];

const path = (id: string, name?: string) =>
  `/v1/mcp-connections/${id}/tool-classifications${name ? `/${name}` : ""}`;

Deno.test("mcp classification: unclassified is a write that runs at most once; a classification is created bare and changed only with its version", async () => {
  const f = await openInstallationFixture();
  try {
    const id = await pinned(f, f.adminCookie, "organization", tools());
    const listed = await send(f, f.adminCookie, "GET", path(id));
    assertEquals(listed.status, 200);
    const items = listed.json.items as Body[];
    assertEquals(items.map((item) => item.toolName), [
      "create_issue",
      "get_issue",
      "search",
    ]);
    for (const item of items) {
      assertEquals(item.effectClass, "write_opaque");
      assertEquals(item.classified, false);
      assertEquals(item.version, 0);
    }

    const create = path(id, "search");
    // A first classification takes no version, and a version names nothing there.
    assertEquals(
      (await send(f, f.adminCookie, "PUT", create, {
        body: { effectClass: "read" },
        ifMatch: '"1"',
      })).status,
      412,
    );
    const first = await send(f, f.adminCookie, "PUT", create, {
      body: { effectClass: "read" },
    });
    assertEquals(first.status, 200);
    assertEquals(first.json.effectClass, "read");
    assertEquals(first.json.classified, true);
    assertEquals(first.json.version, 1);
    assertEquals(first.json.classifiedAgainstCurrentSnapshot, true);

    // Changing it carries the version it read.
    assertEquals(
      (await send(f, f.adminCookie, "PUT", create, {
        body: { effectClass: "write_opaque" },
      })).status,
      428,
    );
    assertEquals(
      (await send(f, f.adminCookie, "PUT", create, {
        body: { effectClass: "write_opaque" },
        ifMatch: '"9"',
      })).status,
      412,
    );
    const changed = await send(f, f.adminCookie, "PUT", create, {
      body: { effectClass: "write_opaque" },
      ifMatch: '"1"',
    });
    assertEquals(changed.status, 200);
    assertEquals(changed.json.version, 2);

    // The audit row names the tool and the classes, and nothing else.
    const audit = (await f.pgDatabase.query<{ details: string }>(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpToolClassifications.put' and resource_id = $1
        order by created_at, id`,
      [id],
    )).rows.map((row) => JSON.parse(row.details));
    assertEquals(audit.length, 2);
    assertEquals(audit[0].toolName, "search");
    assertEquals(audit[1].previousEffectClass, "read");
    assertEquals(audit[1].effectClass, "write_opaque");

    // An unknown tool is absent.
    assertEquals(
      (await send(f, f.adminCookie, "PUT", path(id, "ghost"), {
        body: { effectClass: "read" },
      })).status,
      404,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp classification: an effect key is a declared argument, and a confirming read is a classified read", async () => {
  const f = await openInstallationFixture();
  try {
    const id = await pinned(f, f.adminCookie, "organization", tools());
    const put = (name: string, body: Body, ifMatch?: string) =>
      send(f, f.adminCookie, "PUT", path(id, name), { body, ifMatch });
    assertEquals(
      (await put("create_issue", { effectClass: "write_idempotent" })).status,
      422,
    );
    assertEquals(
      (await put("create_issue", {
        effectClass: "write_idempotent",
        effectKeyArgument: "nope",
      })).status,
      422,
    );
    assertEquals(
      (await put("create_issue", {
        effectClass: "read",
        effectKeyArgument: "title",
      })).status,
      422,
    );
    const keyed = await put("create_issue", {
      effectClass: "write_idempotent",
      effectKeyArgument: "request_id",
    });
    assertEquals(keyed.status, 200);
    assertEquals(keyed.json.effectKeyArgument, "request_id");

    // A confirming read must already be classified read.
    const pair = {
      effectClass: "write_reconcilable",
      pairedReadTool: "get_issue",
    };
    assertEquals((await put("create_issue", pair, '"1"')).status, 422);
    assertEquals((await put("get_issue", { effectClass: "read" })).status, 200);
    const reconciled = await put("create_issue", pair, '"1"');
    assertEquals(reconciled.status, 200);
    assertEquals(reconciled.json.pairedReadTool, "get_issue");
    assertEquals(reconciled.json.effectKeyArgument, null);

    // ...and cannot stop being a read while another tool relies on it.
    assertEquals(
      (await put("get_issue", { effectClass: "write_opaque" }, '"1"')).status,
      409,
    );
    // A write cannot confirm itself.
    assertEquals(
      (await put("create_issue", {
        effectClass: "write_reconcilable",
        pairedReadTool: "create_issue",
      }, '"2"')).status,
      422,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp classification: an asynchronous declaration is valid only beside a paired read that takes the handle (#439)", async () => {
  const f = await openInstallationFixture();
  try {
    const id = await pinned(f, f.adminCookie, "organization", [
      tool("render", { text: {} }),
      tool("render_status", { jobId: {} }),
      tool("search", { query: {} }),
    ]);
    const put = (name: string, body: Body, ifMatch?: string) =>
      send(f, f.adminCookie, "PUT", path(id, name), { body, ifMatch });
    const form = {
      handlePath: "job.id",
      handleArgument: "jobId",
      statusPath: "job.status",
      doneValues: ["succeeded"],
      failedValues: ["failed"],
    };
    const pair = {
      effectClass: "write_reconcilable",
      pairedReadTool: "render_status",
    };
    assertEquals(
      (await put("render_status", { effectClass: "read" })).status,
      200,
    );

    // Only a reconcilable write may be asynchronous.
    for (const effectClass of ["read", "write_opaque"]) {
      const refused = await put("search", { effectClass, asyncForm: form });
      assertEquals(refused.status, 422, effectClass);
    }
    // The declaration is checked: its shape, its statuses and its handle argument.
    for (
      const bad of [
        { ...form, doneValues: [] },
        { ...form, failedValues: ["succeeded"] },
        { ...form, statusPath: "job[0].status" },
        { ...form, pollEveryMs: 5 },
        { ...form, extra: true },
        { ...form, handleArgument: "nope" },
        "running",
      ]
    ) {
      const refused = await put("render", { ...pair, asyncForm: bad });
      assertEquals(refused.status, 422, JSON.stringify(bad));
    }
    assertEquals(
      ((await send(f, f.adminCookie, "GET", path(id))).json.items as Body[])
        .find((item) => item.toolName === "render")!.classified,
      false,
    );

    // A valid one is stored, with the defaults the declaration takes.
    const made = await put("render", { ...pair, asyncForm: form });
    assertEquals(made.status, 200, JSON.stringify(made.json));
    assertEquals(made.json.asyncForm, { ...form, pollEveryMs: 15_000 });
    const listed = (await send(f, f.adminCookie, "GET", path(id))).json
      .items as Body[];
    assertEquals(
      listed.find((item) => item.toolName === "render")!.asyncForm,
      { ...form, pollEveryMs: 15_000 },
    );
    assertEquals(
      listed.find((item) => item.toolName === "search")!.asyncForm,
      null,
    );
    // Saving it again without the declaration makes the tool finish in the call.
    const cleared = await put("render", pair, '"1"');
    assertEquals(cleared.status, 200);
    assertEquals(cleared.json.asyncForm, null);
    const stored = await f.pgDatabase.query<{ asyncForm: unknown }>(
      `select async_form as "asyncForm" from bakery.mcp_tool_classifications
        where connection_id = $1 and tool_name = 'render'`,
      [id],
    );
    assertEquals(stored.rows[0].asyncForm, null);
  } finally {
    await f.finish();
  }
});

Deno.test("mcp classification: a rediscovered connection flags what was classified against the earlier snapshot", async () => {
  const f = await openInstallationFixture();
  try {
    const id = await pinned(
      f,
      f.adminCookie,
      "organization",
      tools(),
      "digest-1",
    );
    assertEquals(
      (await send(f, f.adminCookie, "PUT", path(id, "search"), {
        body: { effectClass: "read" },
      })).status,
      200,
    );
    const before = (await send(f, f.adminCookie, "GET", path(id))).json
      .items as Body[];
    assertEquals(
      before.find((item) => item.toolName === "search")!
        .classifiedAgainstCurrentSnapshot,
      true,
    );
    // Rediscovery: a new snapshot with another digest, and one tool gone.
    await pin(f, id, [
      tool("search", { query: {}, limit: {} }),
      tool("get_issue"),
    ], "digest-2");
    const after = (await send(f, f.adminCookie, "GET", path(id))).json
      .items as Body[];
    assertEquals(after.map((item) => item.toolName), ["get_issue", "search"]);
    const search = after.find((item) => item.toolName === "search")!;
    assertEquals(search.classified, true);
    assertEquals(search.classifiedAgainstCurrentSnapshot, false);
    // Looking again and saving it brings it up to date.
    const renewed = await send(f, f.adminCookie, "PUT", path(id, "search"), {
      body: { effectClass: "read" },
      ifMatch: '"1"',
    });
    assertEquals(renewed.json.classifiedAgainstCurrentSnapshot, true);
  } finally {
    await f.finish();
  }
});

Deno.test("mcp classification: an Admin classifies an organization connection, the owner a personal one, nobody else", async () => {
  const f = await openInstallationFixture();
  try {
    const org = await pinned(f, f.adminCookie, "organization", tools());
    const mine = await pinned(f, f.developerCookie, "personal", tools());
    const body = { effectClass: "read" };
    // A member reads an organization connection's classifications and cannot change them.
    assertEquals(
      (await send(f, f.developerCookie, "GET", path(org))).status,
      200,
    );
    assertEquals(
      (await send(f, f.developerCookie, "PUT", path(org, "search"), { body }))
        .status,
      403,
    );
    assertEquals(
      (await send(f, f.adminCookie, "PUT", path(org, "search"), { body }))
        .status,
      200,
    );
    // A personal connection: its owner classifies it; to anyone else it is absent.
    assertEquals(
      (await send(f, f.developerCookie, "PUT", path(mine, "search"), { body }))
        .status,
      200,
    );
    const absent = await send(
      f,
      f.adminCookie,
      "GET",
      path(crypto.randomUUID()),
    );
    const hidden = await send(f, f.adminCookie, "GET", path(mine));
    assertEquals(hidden.status, 404);
    assertEquals(hidden.status, absent.status);
    assertEquals(
      (await send(f, f.adminCookie, "PUT", path(mine, "get_issue"), { body }))
        .status,
      404,
    );
    // And nothing was written by the refused attempts.
    assertEquals(
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.mcp_tool_classifications where connection_id = $1",
        [mine],
      )).rows[0].n,
      1,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp classification: the application role holds exactly the grants the writes need", async () => {
  const f = await openInstallationFixture();
  try {
    const can = async (sql: string) =>
      (await f.pgDatabase.query<{ ok: boolean }>(sql)).rows[0].ok;
    const update = (column: string) =>
      can(
        `select has_column_privilege('bakery_app', 'bakery.mcp_tool_classifications', '${column}', 'update') as ok`,
      );
    for (
      const column of [
        "effect_class",
        "effect_key_argument",
        "paired_read_tool",
        "async_form",
        "snapshot_digest",
        "classified_by",
        "version",
      ]
    ) {
      assertEquals(await update(column), true, column);
    }
    // Which tool, of which connection, never moves.
    for (
      const column of ["tool_name", "connection_id", "organization_id", "id"]
    ) {
      assertEquals(await update(column), false, column);
    }
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.mcp_tool_classifications', 'delete') as ok",
      ),
      false,
    );
    // The use grant is stamped revoked, never deleted.
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.mcp_use_grants', 'delete') as ok",
      ),
      false,
    );
    for (const column of ["revoked_at", "revoked_by"]) {
      assertEquals(
        await can(
          `select has_column_privilege('bakery_app', 'bakery.mcp_use_grants', '${column}', 'update') as ok`,
        ),
        true,
        column,
      );
    }
    for (
      const column of [
        "connection_id",
        "workflow_id",
        "granted_by",
        "organization_id",
      ]
    ) {
      assertEquals(
        await can(
          `select has_column_privilege('bakery_app', 'bakery.mcp_use_grants', '${column}', 'update') as ok`,
        ),
        false,
        column,
      );
    }
  } finally {
    await f.finish();
  }
});
