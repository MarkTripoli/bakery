import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";

/**
 * #434 against a real database and the production app: MCP server definitions.
 *
 * What only a database and the real routes can show, and what these pin:
 *
 *  - an Admin registers a remote definition, it starts disabled, and the audit
 *    row names the slug and transport and carries no endpoint;
 *  - a developer reads definitions but cannot register or change one;
 *  - the same slug twice is a conflict, and a stdio or plain-http definition is
 *    refused with its reason and writes nothing;
 *  - a change carries the version it read: missing is 428, stale is 412, current
 *    moves the version by one;
 *  - the list pages by cursor in a stable order;
 *  - the application role holds exactly the grants the writes need.
 */

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;
type Body = Record<string, unknown>;

function definition(slug: string, overrides: Body = {}): Body {
  return {
    slug,
    name: `Server ${slug}`,
    transport: "streamable_http",
    endpointTemplate: "https://mcp.example.com/mcp",
    configSchema: { type: "object" },
    requiredCapabilities: [],
    sourceRevision: "v1",
    ...overrides,
  };
}

const slug = () => `s-${crypto.randomUUID().slice(0, 8)}`;

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
    json: text ? JSON.parse(text) as Record<string, unknown> : {},
  };
}

async function count(f: Fixture, name: string) {
  return (await f.pgDatabase.query<{ n: number }>(
    "select count(*)::int as n from bakery.mcp_servers where slug = $1",
    [name],
  )).rows[0].n;
}

Deno.test("mcp servers: an Admin registers a remote definition that starts disabled and is audited without its endpoint", async () => {
  const f = await openInstallationFixture();
  try {
    const name = slug();
    const created = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: definition(name),
    });
    assert([200, 201].includes(created.status), JSON.stringify(created));
    assertEquals(created.json.slug, name);
    assertEquals(created.json.enabled, false);
    assertEquals(created.json.transport, "streamable_http");
    assertEquals(created.json.launchSpec, null);
    assertEquals(created.json.requiredCapabilities, []);
    assertEquals(created.json.version, 1);

    const audit = (await f.pgDatabase.query<{ details: string }>(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpServers.create' and resource_id = $1`,
      [created.json.id],
    )).rows;
    assertEquals(audit.length, 1);
    const details = JSON.parse(audit[0].details);
    assertEquals(details.slug, name);
    assertEquals(details.transport, "streamable_http");
    assertEquals(audit[0].details.includes("mcp.example.com"), false);

    const read = await send(
      f,
      f.adminCookie,
      "GET",
      `/v1/mcp-servers/${created.json.id}`,
    );
    assertEquals(read.status, 200);
    assertEquals(read.json.endpointTemplate, "https://mcp.example.com/mcp");
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: a developer reads definitions but cannot register or change one", async () => {
  const f = await openInstallationFixture();
  try {
    const name = slug();
    const created = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: definition(name),
    });
    const developer = f.developerCookie;
    assertEquals(
      (await send(f, developer, "GET", "/v1/mcp-servers")).status,
      200,
    );
    assertEquals(
      (await send(f, developer, "GET", `/v1/mcp-servers/${created.json.id}`))
        .status,
      200,
    );
    const other = slug();
    assertEquals(
      (await send(f, developer, "POST", "/v1/mcp-servers", {
        body: definition(other),
      })).status,
      403,
    );
    assertEquals(await count(f, other), 0);
    assertEquals(
      (await send(f, developer, "PATCH", `/v1/mcp-servers/${created.json.id}`, {
        body: { enabled: true },
        ifMatch: '"1"',
      })).status,
      403,
    );
    assertEquals(
      (await send(
        f,
        f.adminCookie,
        "GET",
        `/v1/mcp-servers/${created.json.id}`,
      ))
        .json.enabled,
      false,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: a duplicate slug conflicts and a refused definition writes nothing", async () => {
  const f = await openInstallationFixture();
  try {
    const name = slug();
    const first = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: definition(name),
    });
    assert([200, 201].includes(first.status));
    const again = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: definition(name, { name: "Other" }),
    });
    assertEquals(again.status, 409);
    assertEquals(await count(f, name), 1);

    for (
      const [label, overrides] of [
        ["stdio", { transport: "stdio", launchSpec: { command: "x" } }],
        ["plain http", { endpointTemplate: "http://mcp.example.com/mcp" }],
        ["a private host", { endpointTemplate: "https://10.0.0.5/mcp" }],
        ["a host chosen by config", { endpointTemplate: "https://{host}/mcp" }],
        ["required capabilities", { requiredCapabilities: ["gpu"] }],
      ] as const
    ) {
      const refused = slug();
      const response = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
        body: definition(refused, overrides),
      });
      assert(response.status === 422 || response.status === 400, label);
      assertEquals(await count(f, refused), 0, label);
    }
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: a change carries the version it read", async () => {
  const f = await openInstallationFixture();
  try {
    const created = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: definition(slug()),
    });
    const path = `/v1/mcp-servers/${created.json.id}`;
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { enabled: true },
      })).status,
      428,
    );
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { enabled: true },
        ifMatch: '"7"',
      })).status,
      412,
    );
    const changed = await send(f, f.adminCookie, "PATCH", path, {
      body: { enabled: true, name: "Renamed" },
      ifMatch: '"1"',
    });
    assertEquals(changed.status, 200);
    assertEquals(changed.json.enabled, true);
    assertEquals(changed.json.name, "Renamed");
    assertEquals(changed.json.version, 2);
    // Identity did not move.
    assertEquals(changed.json.slug, created.json.slug);
    assertEquals(changed.json.endpointTemplate, created.json.endpointTemplate);
    // The version it read is no longer current.
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { enabled: false },
        ifMatch: '"1"',
      })).status,
      412,
    );
    // An empty change is refused, and remote definitions take no capabilities.
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: {},
        ifMatch: '"2"',
      })).status,
      422,
    );
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { requiredCapabilities: ["gpu"] },
        ifMatch: '"2"',
      })).status,
      422,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: the list pages newest first by cursor", async () => {
  const f = await openInstallationFixture();
  try {
    const names = [slug(), slug(), slug()];
    for (const name of names) {
      await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
        body: definition(name),
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query: string = cursor
        ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
        : "?limit=1";
      const response = await send(
        f,
        f.adminCookie,
        "GET",
        `/v1/mcp-servers${query}`,
      );
      assertEquals(response.status, 200);
      const items = response.json.items as { slug: string }[];
      assertEquals(items.length <= 1, true);
      for (const item of items) seen.push(item.slug);
      cursor = response.json.nextCursor as string | null;
      if (!cursor) break;
    }
    // Every registered definition appears exactly once, newest first.
    const mine = seen.filter((name) => names.includes(name));
    assertEquals(mine, [...names].reverse());
    assertEquals(new Set(seen).size, seen.length);
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: an unknown definition is absent, not forbidden", async () => {
  const f = await openInstallationFixture();
  try {
    const missing = crypto.randomUUID();
    assertEquals(
      (await send(f, f.adminCookie, "GET", `/v1/mcp-servers/${missing}`))
        .status,
      404,
    );
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", `/v1/mcp-servers/${missing}`, {
        body: { enabled: true },
        ifMatch: '"1"',
      })).status,
      404,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp servers: the application role holds exactly the grants the writes need", async () => {
  const f = await openInstallationFixture();
  try {
    const can = async (sql: string, ...values: unknown[]) =>
      (await f.pgDatabase.query<{ ok: boolean }>(sql, values)).rows[0].ok;
    const update = (table: string, column: string) =>
      can(
        "select has_column_privilege('bakery_app', $1, $2, 'update') as ok",
        `bakery.${table}`,
        column,
      );
    for (
      const column of ["name", "enabled", "required_capabilities", "version"]
    ) {
      assertEquals(await update("mcp_servers", column), true, column);
    }
    // Identity is fixed at registration.
    for (
      const column of [
        "slug",
        "transport",
        "launch_spec",
        "endpoint_template",
        "config_schema",
        "source_revision",
        "organization_id",
        "id",
      ]
    ) assertEquals(await update("mcp_servers", column), false, column);
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.mcp_servers', 'delete') as ok",
      ),
      false,
    );
    // A snapshot is observed once and never rewritten.
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.mcp_capability_snapshots', 'insert') as ok",
      ),
      true,
    );
    for (const privilege of ["update", "delete"]) {
      assertEquals(
        await can(
          `select has_table_privilege('bakery_app', 'bakery.mcp_capability_snapshots', '${privilege}') as ok`,
        ),
        false,
        privilege,
      );
    }
  } finally {
    await f.finish();
  }
});
