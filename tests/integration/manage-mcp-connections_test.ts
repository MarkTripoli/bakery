import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { orgHeader } from "../helpers/account-settings.ts";
import {
  decryptMcpCredential,
  loadSecretKey,
  SecretCipherSchema,
} from "../../apps/server/src/modules/secrets/crypto.ts";

/**
 * #434 against a real database and the production app: MCP connections.
 *
 * What only a database and the real routes can show, and what these pin:
 *
 *  - a credential is sealed (it decrypts to what was sent, and appears in no
 *    response, audit row or stored column) and a rotation is the next revision of
 *    the same secret, with the earlier one kept;
 *  - tenancy: an organization connection is an Admin's to change and a member's to
 *    read; a personal one is its owner's alone, and to everyone else, an Admin
 *    included, it is absent in exactly the way an unknown id is;
 *  - a config the server's schema refuses, a disabled server, a stale version and a
 *    revoked connection each change nothing;
 *  - a tool is enabled only if the pinned snapshot lists it;
 *  - the application role holds exactly the grants the writes need.
 */

type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;
type Body = Record<string, unknown>;

const SECRET = "mcp_browser_canary_token_0123456789abcdef";
const NEXT_SECRET = "mcp_browser_canary_token_next_fedcba987654";

async function keyFile() {
  const file = await Deno.makeTempFile({ prefix: "bakery-mcp-key-" });
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "mcp-test-key-1" };
}

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
    text,
    json: text ? JSON.parse(text) as Body : {},
  };
}

/** An enabled remote definition with a strict config schema. */
async function enabledServer(f: Fixture): Promise<string> {
  const created = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
    body: {
      slug: `s-${crypto.randomUUID().slice(0, 8)}`,
      name: "Docs",
      transport: "streamable_http",
      endpointTemplate: "https://mcp.example.com/mcp",
      configSchema: {
        type: "object",
        properties: { region: { type: "string", enum: ["eu", "us"] } },
        required: ["region"],
        additionalProperties: false,
      },
      requiredCapabilities: [],
      sourceRevision: "v1",
    },
  });
  const id = created.json.id as string;
  const enabled = await send(
    f,
    f.adminCookie,
    "PATCH",
    `/v1/mcp-servers/${id}`,
    {
      body: { enabled: true },
      ifMatch: '"1"',
    },
  );
  assertEquals(enabled.status, 200);
  return id;
}

const connection = (serverId: string, overrides: Body = {}): Body => ({
  serverId,
  label: `Docs ${crypto.randomUUID().slice(0, 6)}`,
  config: { region: "eu" },
  enabledCapabilities: [],
  ...overrides,
});

/**
 * A sealed credential belongs to the organization, and the organization's key has no
 * cascade, so the fixture cannot delete the organization while one remains. Removes
 * what these tests wrote, in dependency order: a connection points at its secret and a
 * secret at its active version, so break the links before deleting either.
 */
async function removeMcpSecrets(f: Fixture) {
  const pg = f.pgDatabase;
  const org = f.organizationId;
  await pg.query(
    "delete from bakery.mcp_connections where organization_id = $1",
    [org],
  );
  await pg.query(
    "update bakery.secrets set active_version_id = null where organization_id = $1 and provider = 'mcp'",
    [org],
  );
  await pg.query(
    `delete from bakery.secret_versions where secret_id in
       (select id from bakery.secrets where organization_id = $1 and provider = 'mcp')`,
    [org],
  );
  await pg.query(
    "delete from bakery.secrets where organization_id = $1 and provider = 'mcp'",
    [org],
  );
}

async function withFixture(
  run: (
    f: Fixture,
    secretsKey: { file: string; keyId: string },
  ) => Promise<void>,
) {
  const secretsKey = await keyFile();
  const f = await openInstallationFixture(true, { secretsKey });
  try {
    await run(f, secretsKey);
  } finally {
    try {
      await removeMcpSecrets(f);
      await f.finish();
    } finally {
      await Deno.remove(secretsKey.file);
    }
  }
}

Deno.test("mcp connections: a credential is sealed, never returned or audited, and a rotation is the next revision", async () => {
  await withFixture(async (f, secretsKey) => {
    const serverId = await enabledServer(f);
    const created = await send(
      f,
      f.adminCookie,
      "POST",
      "/v1/mcp-connections",
      {
        body: connection(serverId, { secret: SECRET }),
      },
    );
    assert([200, 201].includes(created.status), created.text);
    assertEquals(created.text.includes(SECRET), false);
    assertEquals(created.json.ownerPrincipalId, null);
    assertEquals(created.json.status, "enabled");
    assertEquals(created.json.currentSnapshotId, null);
    assertEquals(created.json.enabledCapabilities, []);
    const secretId = created.json.secretId as string;
    assert(secretId);

    const pg = f.pgDatabase;
    const stored = (await pg.query(
      `select organization_id, application_id, provider, active_version_revision as revision
         from bakery.secrets where id = $1`,
      [secretId],
    )).rows[0];
    // Organization-owned, with no application: invisible to the project-secret reads.
    assertEquals(stored.organization_id, f.organizationId);
    assertEquals(stored.application_id, null);
    assertEquals(stored.provider, "mcp");
    assertEquals(stored.revision, 1);

    const decrypt = async (revision: number) => {
      const version = (await pg.query(
        `select ciphertext, nonce, key_id from bakery.secret_versions
          where secret_id = $1 and revision = $2`,
        [secretId, revision],
      )).rows[0];
      assertEquals(String(version.ciphertext).includes(SECRET), false);
      return new TextDecoder().decode(
        await decryptMcpCredential(
          await loadSecretKey(secretsKey),
          {
            organizationId: f.organizationId,
            secretId,
            revision,
            keyId: version.key_id,
          },
          SecretCipherSchema.parse({
            ciphertext: version.ciphertext,
            nonce: version.nonce,
          }),
        ),
      );
    };
    assertEquals(await decrypt(1), SECRET);

    const audit = (await pg.query(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpConnections.create' and resource_id = $1`,
      [created.json.id],
    )).rows;
    assertEquals(audit.length, 1);
    assertEquals(audit[0].details.includes(SECRET), false);
    const details = JSON.parse(audit[0].details);
    assertEquals(details.credential, "set");
    assertEquals(details.secretRevision, 1);

    const rotated = await send(
      f,
      f.adminCookie,
      "PATCH",
      `/v1/mcp-connections/${created.json.id}`,
      { body: { secret: NEXT_SECRET }, ifMatch: '"1"' },
    );
    assertEquals(rotated.status, 200);
    assertEquals(rotated.text.includes(NEXT_SECRET), false);
    // The same secret, advanced; the earlier revision is kept.
    assertEquals(rotated.json.secretId, secretId);
    assertEquals(rotated.json.version, 2);
    assertEquals(await decrypt(1), SECRET);
    assertEquals(await decrypt(2), NEXT_SECRET);
    const after = (await pg.query(
      "select active_version_revision as revision from bakery.secrets where id = $1",
      [secretId],
    )).rows[0];
    assertEquals(after.revision, 2);
    const updateAudit = (await pg.query(
      `select details::text as details from bakery.audit_events
        where operation = 'mcpConnections.update' and resource_id = $1`,
      [created.json.id],
    )).rows;
    assertEquals(updateAudit.length, 1);
    assertEquals(updateAudit[0].details.includes(NEXT_SECRET), false);
    assertEquals(JSON.parse(updateAudit[0].details).credential, "rotated");
  });
});

Deno.test("mcp connections: without a sealing key a credential is refused and nothing is written", async () => {
  const f = await openInstallationFixture(true);
  try {
    const serverId = await enabledServer(f);
    const before = (await f.pgDatabase.query(
      "select count(*)::int as n from bakery.mcp_connections",
    )).rows[0].n;
    const refused = await send(
      f,
      f.adminCookie,
      "POST",
      "/v1/mcp-connections",
      {
        body: connection(serverId, { secret: SECRET }),
      },
    );
    assertEquals(refused.status, 409);
    assertEquals(refused.text.includes(SECRET), false);
    assertEquals(
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.mcp_connections",
      )).rows[0].n,
      before,
    );
    // The same connection without a credential needs no key.
    const plain = await send(f, f.adminCookie, "POST", "/v1/mcp-connections", {
      body: connection(serverId),
    });
    assert([200, 201].includes(plain.status), plain.text);
    assertEquals(plain.json.secretId, null);
  } finally {
    await f.finish();
  }
});

Deno.test("mcp connections: organization scope is the Admin's, personal scope is the owner's alone", async () => {
  await withFixture(async (f) => {
    const serverId = await enabledServer(f);
    const admin = f.adminCookie;
    const developer = f.developerCookie;

    // Organization scope: a developer may not register one; the Admin may.
    assertEquals(
      (await send(f, developer, "POST", "/v1/mcp-connections", {
        body: connection(serverId),
      })).status,
      403,
    );
    const org = await send(f, admin, "POST", "/v1/mcp-connections", {
      body: connection(serverId, { scope: "organization" }),
    });
    assert([200, 201].includes(org.status), org.text);
    const orgPath = `/v1/mcp-connections/${org.json.id}`;
    // A member reads it, and cannot change it.
    assertEquals((await send(f, developer, "GET", orgPath)).status, 200);
    assertEquals(
      (await send(f, developer, "PATCH", orgPath, {
        body: { label: "Mine now" },
        ifMatch: '"1"',
      })).status,
      403,
    );
    assertEquals(
      (await send(f, admin, "PATCH", orgPath, {
        body: { label: "Renamed" },
        ifMatch: '"1"',
      })).status,
      200,
    );

    // Personal scope: a developer registers their own, for themselves alone.
    const mine = await send(f, developer, "POST", "/v1/mcp-connections", {
      body: connection(serverId, { scope: "personal" }),
    });
    assert([200, 201].includes(mine.status), mine.text);
    assertEquals(mine.json.ownerPrincipalId, f.developerId);
    const minePath = `/v1/mcp-connections/${mine.json.id}`;
    assertEquals((await send(f, developer, "GET", minePath)).status, 200);
    assertEquals(
      (await send(f, developer, "PATCH", minePath, {
        body: { label: "Still mine" },
        ifMatch: '"1"',
      })).status,
      200,
    );

    // To the Admin it is absent, the same as an id that never existed.
    const absent = await send(
      f,
      admin,
      "GET",
      `/v1/mcp-connections/${crypto.randomUUID()}`,
    );
    const hidden = await send(f, admin, "GET", minePath);
    assertEquals(hidden.status, 404);
    assertEquals(hidden.status, absent.status);
    assertEquals(hidden.json.code, absent.json.code);
    const hiddenChange = await send(f, admin, "PATCH", minePath, {
      body: { status: "revoked" },
      ifMatch: '"2"',
    });
    assertEquals(hiddenChange.status, 404);
    // And it did not change.
    assertEquals(
      (await send(f, developer, "GET", minePath)).json.status,
      "enabled",
    );

    // The same the other way round: the Admin's personal connection is theirs.
    const theirs = await send(f, admin, "POST", "/v1/mcp-connections", {
      body: connection(serverId, { scope: "personal" }),
    });
    assertEquals(theirs.json.ownerPrincipalId, f.adminId);
    assertEquals(
      (await send(f, developer, "GET", `/v1/mcp-connections/${theirs.json.id}`))
        .status,
      404,
    );

    // The list shows each viewer the organization's connections and their own.
    const ids = async (cookie: string) => {
      const listed = await send(
        f,
        cookie,
        "GET",
        "/v1/mcp-connections?limit=100",
      );
      return (listed.json.items as { id: string }[]).map((item) => item.id);
    };
    const developerSees = await ids(developer);
    assert(developerSees.includes(org.json.id as string));
    assert(developerSees.includes(mine.json.id as string));
    assertEquals(developerSees.includes(theirs.json.id as string), false);
    const adminSees = await ids(admin);
    assert(adminSees.includes(org.json.id as string));
    assert(adminSees.includes(theirs.json.id as string));
    assertEquals(adminSees.includes(mine.json.id as string), false);
  });
});

Deno.test("mcp connections: a refused connection or change writes nothing", async () => {
  await withFixture(async (f) => {
    const serverId = await enabledServer(f);
    const count = async () =>
      (await f.pgDatabase.query(
        "select count(*)::int as n from bakery.mcp_connections",
      )).rows[0].n as number;
    const before = await count();
    const post = (body: Body) =>
      send(f, f.adminCookie, "POST", "/v1/mcp-connections", { body });
    // A config the server's schema refuses.
    assertEquals(
      (await post(connection(serverId, { config: { region: "mars" } }))).status,
      422,
    );
    assertEquals(
      (await post(connection(serverId, { config: {} }))).status,
      422,
    );
    assertEquals(
      (await post(connection(serverId, { config: { region: "eu", extra: 1 } })))
        .status,
      422,
    );
    // What a remote connection may not carry yet.
    assertEquals(
      (await post(connection(serverId, { workerHostId: crypto.randomUUID() })))
        .status,
      422,
    );
    assertEquals(
      (await post(connection(serverId, { enabledCapabilities: ["search"] })))
        .status,
      422,
    );
    // A server that is not there, or is not enabled.
    assertEquals((await post(connection(crypto.randomUUID()))).status, 404);
    const disabled = await send(f, f.adminCookie, "POST", "/v1/mcp-servers", {
      body: {
        slug: `d-${crypto.randomUUID().slice(0, 8)}`,
        name: "Off",
        transport: "streamable_http",
        endpointTemplate: "https://mcp.example.com/off",
        configSchema: { type: "object" },
        requiredCapabilities: [],
        sourceRevision: "v1",
      },
    });
    assertEquals(
      (await post(connection(disabled.json.id as string, { config: {} })))
        .status,
      409,
    );
    assertEquals(await count(), before);

    // Version rules and finality.
    const made = await post(connection(serverId));
    const path = `/v1/mcp-connections/${made.json.id}`;
    const patch = (body: Body, ifMatch?: string) =>
      send(f, f.adminCookie, "PATCH", path, { body, ifMatch });
    assertEquals((await patch({ label: "x" })).status, 428);
    assertEquals((await patch({ label: "x" }, '"9"')).status, 412);
    assertEquals((await patch({}, '"1"')).status, 422);
    assertEquals((await patch({ status: "degraded" }, '"1"')).status, 422);
    assertEquals(
      (await patch({ config: { region: "mars" } }, '"1"')).status,
      422,
    );
    assertEquals(
      (await patch({ enabledCapabilities: ["search"] }, '"1"')).status,
      422,
    );
    const revoked = await patch({ status: "revoked" }, '"1"');
    assertEquals(revoked.status, 200);
    assertEquals(revoked.json.status, "revoked");
    // Nothing revives a revoked connection.
    assertEquals((await patch({ status: "enabled" }, '"2"')).status, 409);
    assertEquals((await patch({ label: "back" }, '"2"')).status, 409);
  });
});

Deno.test("mcp connections: a tool is enabled only if the pinned snapshot lists it", async () => {
  await withFixture(async (f) => {
    const serverId = await enabledServer(f);
    const made = await send(f, f.adminCookie, "POST", "/v1/mcp-connections", {
      body: connection(serverId),
    });
    const id = made.json.id as string;
    const path = `/v1/mcp-connections/${id}`;
    // No snapshot yet: nothing can be enabled.
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { enabledCapabilities: ["search"] },
        ifMatch: '"1"',
      })).status,
      422,
    );
    // Pin a snapshot the way discovery will (insert-only, then move the pointer).
    const snapshotId = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.mcp_capability_snapshots
         (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest)
       values ($1, $2, $3, now(), '2026-07-28', $4::jsonb, 'digest-1')`,
      [
        snapshotId,
        f.organizationId,
        id,
        JSON.stringify({ tools: [{ name: "search" }, { name: "read_page" }] }),
      ],
    );
    await f.pgDatabase.query(
      "update bakery.mcp_connections set current_snapshot_id = $2 where id = $1",
      [id, snapshotId],
    );
    assertEquals(
      (await send(f, f.adminCookie, "PATCH", path, {
        body: { enabledCapabilities: ["search", "delete_everything"] },
        ifMatch: '"1"',
      })).status,
      422,
    );
    const enabled = await send(f, f.adminCookie, "PATCH", path, {
      body: { enabledCapabilities: ["search"] },
      ifMatch: '"1"',
    });
    assertEquals(enabled.status, 200);
    assertEquals(enabled.json.enabledCapabilities, ["search"]);
    assertEquals(enabled.json.currentSnapshotId, snapshotId);
  });
});

Deno.test("mcp connections: the application role holds exactly the grants the writes need", async () => {
  await withFixture(async (f) => {
    const can = async (sql: string) =>
      (await f.pgDatabase.query<{ ok: boolean }>(sql)).rows[0].ok;
    const update = (table: string, column: string) =>
      can(
        `select has_column_privilege('bakery_app', 'bakery.${table}', '${column}', 'update') as ok`,
      );
    for (
      const column of [
        "label",
        "config",
        "secret_id",
        "enabled_capabilities",
        "status",
        "current_snapshot_id",
        "version",
      ]
    ) assertEquals(await update("mcp_connections", column), true, column);
    // Identity never moves: which server, whose, which organization.
    for (
      const column of [
        "server_id",
        "owner_principal_id",
        "organization_id",
        "id",
      ]
    ) {
      assertEquals(await update("mcp_connections", column), false, column);
    }
    assertEquals(
      await can(
        "select has_table_privilege('bakery_app', 'bakery.mcp_connections', 'delete') as ok",
      ),
      false,
    );
  });
});
