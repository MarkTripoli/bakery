import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";
import { createPostgresMcpPinnedStatePort } from "../../apps/server/src/modules/mcp/postgres.ts";

/**
 * #434 personal connection use grants (O27) against a real database and the
 * production app.
 *
 * What only a database and the real routes can show, and what these pin:
 *
 *  - only the owner grants and revokes, and to anyone else, an Admin included, a
 *    personal connection and its grants are absent in the way an unknown id is;
 *  - one live grant per connection and workflow; revoking stamps the row, never
 *    deletes it, and the pair can be granted again afterwards;
 *  - an organization connection takes no grant;
 *  - the invoke path's pinned-state read sees a live grant only for the workflow it
 *    was made for, and sees it end the moment it is revoked.
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

/** A workflow definition with one published version, seeded as the owner role. */
async function workflow(
  f: Fixture,
): Promise<{ id: string; versionId: string }> {
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
     values ($1, $2, $3, 'Shared', true, 1)`,
    [id, f.organizationId, `wf-${crypto.randomUUID().slice(0, 8)}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
       digest, status, created_by, version
     ) values ($1, $2, $3, 1, '', '{}'::jsonb, 'd', 'published', $4, 1)`,
    [versionId, f.organizationId, id, f.adminId],
  );
  return { id, versionId };
}

async function connection(
  f: Fixture,
  cookie: string,
  scope: "organization" | "personal",
): Promise<string> {
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
  return made.json.id as string;
}

const grants = (id: string, grantId?: string) =>
  `/v1/mcp-connections/${id}/use-grants${
    grantId ? `/${grantId}/revocation` : ""
  }`;

Deno.test("mcp use grants: the owner grants and revokes; to everyone else the connection is absent", async () => {
  const f = await openInstallationFixture();
  try {
    const wf = await workflow(f);
    const mine = await connection(f, f.developerCookie, "personal");
    const created = await send(f, f.developerCookie, "POST", grants(mine), {
      body: { workflowId: wf.id },
    });
    assert([200, 201].includes(created.status), JSON.stringify(created.json));
    assertEquals(created.json.workflowId, wf.id);
    assertEquals(created.json.grantedBy, f.developerId);
    assertEquals(created.json.revokedAt, null);
    const grantId = created.json.id as string;

    // The owner sees it; an Admin sees nothing, as for an id that never existed.
    const listed = await send(f, f.developerCookie, "GET", grants(mine));
    assertEquals((listed.json.items as Body[]).map((g) => g.id), [grantId]);
    const absent = await send(
      f,
      f.adminCookie,
      "GET",
      grants(crypto.randomUUID()),
    );
    const hidden = await send(f, f.adminCookie, "GET", grants(mine));
    assertEquals(hidden.status, 404);
    assertEquals(hidden.status, absent.status);
    assertEquals(
      (await send(f, f.adminCookie, "POST", grants(mine), {
        body: { workflowId: wf.id },
      })).status,
      404,
    );
    assertEquals(
      (await send(f, f.adminCookie, "POST", grants(mine, grantId))).status,
      404,
    );

    // One live grant per connection and workflow.
    assertEquals(
      (await send(f, f.developerCookie, "POST", grants(mine), {
        body: { workflowId: wf.id },
      })).status,
      409,
    );

    // Revoking stamps it, once.
    const revoked = await send(
      f,
      f.developerCookie,
      "POST",
      grants(mine, grantId),
    );
    // A POST answers 201, like the other commands that return what they changed.
    assert([200, 201].includes(revoked.status), String(revoked.status));
    assert(typeof revoked.json.revokedAt === "string");
    assertEquals(revoked.json.revokedBy, f.developerId);
    assertEquals(
      (await send(f, f.developerCookie, "POST", grants(mine, grantId))).status,
      409,
    );
    assertEquals(
      (await send(
        f,
        f.developerCookie,
        "POST",
        grants(mine, crypto.randomUUID()),
      )).status,
      404,
    );
    // The row is still there: what was granted stays on record.
    assertEquals(
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.mcp_use_grants where id = $1",
        [grantId],
      )).rows[0].n,
      1,
    );
    // And the pair can be granted again; both rows are listed, newest first.
    const again = await send(f, f.developerCookie, "POST", grants(mine), {
      body: { workflowId: wf.id },
    });
    assert([200, 201].includes(again.status));
    const history = (await send(f, f.developerCookie, "GET", grants(mine))).json
      .items as Body[];
    assertEquals(history.map((g) => g.id), [again.json.id, grantId]);

    // Audited, with the workflow and no more.
    const audit =
      (await f.pgDatabase.query<{ operation: string; details: string }>(
        `select operation, details::text as details from bakery.audit_events
        where resource_id = $1 and operation like 'mcpUseGrants.%' order by created_at, id`,
        [mine],
      )).rows;
    assertEquals(audit.map((row) => row.operation), [
      "mcpUseGrants.create",
      "mcpUseGrants.revoke",
      "mcpUseGrants.create",
    ]);
    assertEquals(JSON.parse(audit[0].details).workflowId, wf.id);
  } finally {
    await f.finish();
  }
});

Deno.test("mcp use grants: an organization connection takes none, and the workflow must be the organization's", async () => {
  const f = await openInstallationFixture();
  try {
    const wf = await workflow(f);
    const org = await connection(f, f.adminCookie, "organization");
    assertEquals(
      (await send(f, f.adminCookie, "POST", grants(org), {
        body: { workflowId: wf.id },
      })).status,
      422,
    );
    assertEquals(
      (await send(f, f.adminCookie, "GET", grants(org))).json.items,
      [],
    );
    const mine = await connection(f, f.developerCookie, "personal");
    assertEquals(
      (await send(f, f.developerCookie, "POST", grants(mine), {
        body: { workflowId: crypto.randomUUID() },
      })).status,
      422,
    );
    assertEquals(
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.mcp_use_grants",
      )).rows[0].n,
      0,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("mcp use grants: the invoke path's read sees a grant only for its own workflow, and sees it end", async () => {
  const f = await openInstallationFixture();
  try {
    const granted = await workflow(f);
    const other = await workflow(f);
    const mine = await connection(f, f.developerCookie, "personal");
    const org = await connection(f, f.adminCookie, "organization");
    const port = createPostgresMcpPinnedStatePort(f.database);
    const load = (connectionId: string, workflowVersionId: string | null) =>
      port.load({
        organizationId: f.organizationId,
        connectionId,
        actorRef: "actor",
        hostId: crypto.randomUUID(),
        workflowVersionId,
        startedByPrincipalId: f.adminId,
      });

    // An organization connection is not personal.
    assertEquals((await load(org, granted.versionId))?.personal, null);
    // A personal one is, and nothing is granted yet.
    assertEquals((await load(mine, granted.versionId))?.personal, {
      ownerPrincipalId: f.developerId,
      useGrantLive: false,
    });
    const made = await send(f, f.developerCookie, "POST", grants(mine), {
      body: { workflowId: granted.id },
    });
    assertEquals(
      (await load(mine, granted.versionId))?.personal?.useGrantLive,
      true,
    );
    // Another workflow, and a call made for no workflow, are not covered.
    assertEquals(
      (await load(mine, other.versionId))?.personal?.useGrantLive,
      false,
    );
    assertEquals((await load(mine, null))?.personal?.useGrantLive, false);
    // Revoked: the next read says so.
    await send(
      f,
      f.developerCookie,
      "POST",
      grants(mine, made.json.id as string),
    );
    assertEquals(
      (await load(mine, granted.versionId))?.personal?.useGrantLive,
      false,
    );
  } finally {
    await f.finish();
  }
});
