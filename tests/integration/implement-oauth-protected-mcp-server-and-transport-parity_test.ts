import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  call,
  type Fixture,
  type Json,
  seed,
} from "../helpers/account-settings.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  userIdFor,
} from "../helpers/auth.ts";
import {
  authorize,
  callTool,
  codeFrom,
  connectClient,
  consentQuery,
  exchangeCode,
  listTools,
  mcpRequest,
  type McpResult,
  OAUTH_ISSUER,
  pkcePair,
  registerTestClient,
  submitConsent,
} from "../helpers/oauth-mcp.ts";

/** Token `iat` and the revoke epoch are whole seconds; a re-consent must land in a later second. */
const NEXT_SECOND_MS = 1_100;

async function cleanupOAuth(
  fixture: Fixture,
  emails: readonly string[],
  clientIds: readonly string[],
) {
  const users = await fixture.pgDatabase.query<{ id: string }>(
    'select id from public."user" where email = any($1::text[])',
    [emails],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.oauth_grant_revocations where user_id = any($1::uuid[])",
    [users.rows.map(({ id }) => id)],
  );
  await fixture.pgDatabase.query(
    "delete from bakery.oauth_grant_activity where user_id = any($1::uuid[])",
    [users.rows.map(({ id }) => id)],
  );
  await fixture.pgDatabase.query(
    `delete from public.verification
      where position('"type":"authorization_code"' in value) > 0
        and exists (
          select 1 from unnest($1::text[]) as client_id
          where position('"client_id":' || to_json(client_id)::text in value) > 0
        )`,
    [clientIds],
  );
  await cleanupAuthFixture(fixture.pgDatabase, emails);
  await fixture.pgDatabase.query(
    'delete from public."oauthClient" where "clientId" = any($1::text[])',
    [clientIds],
  );
}

async function listGrants(fixture: Fixture, cookie: string) {
  const response = await call(
    fixture,
    "GET",
    "/v1/me/connected-clients",
    cookie,
  );
  assertEquals(response.status, 200, await response.clone().text());
  return (await response.json() as { items: Json[] }).items;
}

async function revokeGrant(fixture: Fixture, cookie: string, grantId: string) {
  return await call(
    fixture,
    "DELETE",
    `/v1/me/connected-clients/${grantId}`,
    cookie,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function challengeOf(response: Response): string {
  return response.headers.get("www-authenticate") ?? "";
}

Deno.test("a pre-registered client uses PKCE, calls tools, is listed, and revoke beats re-consent for the old token", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture, { name: "Harness" });
    clientIds.push(clientId);
    const first = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    // Fixed tools plus the catalog tools read+operate allow, in a fixed order.
    assertEquals(await listTools(fixture, first.accessToken), [
      "bakery_applications_get",
      "bakery_applications_list",
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

    const who = await callTool(fixture, first.accessToken, "whoami");
    assertEquals(who.status, 200);
    const whoBody = await who.json() as McpResult;
    assertEquals(whoBody.result?.isError, undefined);
    assertEquals(
      JSON.parse(whoBody.result!.content![0].text).email,
      seeded.adminEmail,
    );
    const org = await callTool(fixture, first.accessToken, "organization_get");
    const orgBody = await org.json() as McpResult;
    assertEquals(orgBody.result?.isError, undefined);
    assertEquals(
      JSON.parse(orgBody.result!.content![0].text).id,
      seeded.organizationId,
    );

    const [grant] = await listGrants(fixture, seeded.adminCookie);
    assertEquals(grant.clientId, clientId);
    assertEquals(grant.clientName, "Harness");
    assertEquals(grant.organizationId, seeded.organizationId);
    assertEquals(grant.scopes, ["bakery:read", "bakery:operate"]);
    assert(typeof grant.lastUsedAt === "string", "use is recorded");

    const revoked = await revokeGrant(
      fixture,
      seeded.adminCookie,
      grant.id as string,
    );
    assertEquals(revoked.status, 200, await revoked.clone().text());
    assertEquals((await revoked.json() as Json).revoked, true);
    assertEquals(await listGrants(fixture, seeded.adminCookie), []);

    // The same unexpired token is refused at once and told where to reauthorize.
    const refused = await callTool(fixture, first.accessToken, "whoami");
    assertEquals(refused.status, 401);
    assert(
      challengeOf(refused).includes(
        `resource_metadata="${authTestOrigin}/.well-known/oauth-protected-resource/mcp"`,
      ),
    );
    assert(challengeOf(refused).includes('error="invalid_token"'));

    // Re-consent in a later second: the new token works, the old one stays dead.
    await sleep(NEXT_SECOND_MS);
    const second = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    assertNotEquals(second.accessToken, first.accessToken);
    assertEquals(
      (await callTool(fixture, second.accessToken, "whoami")).status,
      200,
    );
    assertEquals(
      (await callTool(fixture, first.accessToken, "whoami")).status,
      401,
    );
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a token issued in the same second as the revoke fails closed and a later one does not", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const iat = JSON.parse(
      atob(
        accessToken.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"),
      ),
    ).iat as number;
    const userId = await userIdFor(fixture.pgDatabase, seeded.adminEmail);
    const setEpoch = async (secondsFromIat: number, fraction: string) => {
      await fixture.pgDatabase.query(
        `insert into bakery.oauth_grant_revocations
           (user_id, client_id, organization_id, revoked_at)
         values ($1, $2, $3, to_timestamp($4) + $5::interval)
         on conflict (user_id, client_id, organization_id)
         do update set revoked_at = excluded.revoked_at`,
        [
          userId,
          clientId,
          seeded.organizationId,
          iat + secondsFromIat,
          fraction,
        ],
      );
    };
    // Revoked later within the token's own second: indistinguishable from a
    // pre-revoke token, so it is refused.
    await setEpoch(0, "0.9 seconds");
    assertEquals((await callTool(fixture, accessToken, "whoami")).status, 401);
    await setEpoch(0, "0 seconds");
    assertEquals((await callTool(fixture, accessToken, "whoami")).status, 401);
    // Revoked in an earlier second: the token was issued after it.
    await setEpoch(-1, "0.9 seconds");
    assertEquals((await callTool(fixture, accessToken, "whoami")).status, 200);
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a pending authorization code is unusable after the grant is revoked", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { verifier, challenge } = await pkcePair();
    const authorized = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
    });
    const consent = await submitConsent(fixture, {
      cookie: seeded.adminCookie,
      oauthQuery: await consentQuery(authorized),
    });
    const code = await codeFrom(consent);
    const [grant] = await listGrants(fixture, seeded.adminCookie);
    assertEquals(
      (await revokeGrant(fixture, seeded.adminCookie, grant.id as string))
        .status,
      200,
    );
    const exchange = await exchangeCode(fixture, { clientId, code, verifier });
    assert(
      exchange.status >= 400,
      `code redeemed after revoke: ${exchange.status}`,
    );
    assertEquals(
      "access_token" in (await exchange.json() as Json),
      false,
    );
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("revoking another person's grant, or an unknown one, is not found and changes nothing", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const [grant] = await listGrants(fixture, seeded.adminCookie);
    assertEquals(await listGrants(fixture, seeded.developerCookie), []);
    assertEquals(
      (await revokeGrant(fixture, seeded.developerCookie, grant.id as string))
        .status,
      404,
    );
    assertEquals(
      (await revokeGrant(fixture, seeded.adminCookie, crypto.randomUUID()))
        .status,
      404,
    );
    assertEquals(
      (await callTool(fixture, accessToken, "whoami")).status,
      200,
    );
    assertEquals((await listGrants(fixture, seeded.adminCookie)).length, 1);
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("scopes are the intersection of the token and the live consent, and discovery is scoped", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);

    // `bakery:operate` covers every read tool, so operate-only consent lists and runs them.
    const operateOnly = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
      scope: "bakery:operate",
    });
    assertEquals(
      (await listTools(fixture, operateOnly.accessToken)).length > 0,
      true,
    );
    assertEquals(
      (await callTool(fixture, operateOnly.accessToken, "whoami")).status,
      200,
    );

    // A fresh full-scope token works until the consent is narrowed underneath it.
    const full = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    assertEquals(
      (await callTool(fixture, full.accessToken, "whoami")).status,
      200,
    );
    await fixture.pgDatabase.query(
      `update public."oauthConsent" set scopes = '["bakery:operate"]'::jsonb
       where "clientId" = $1`,
      [clientId],
    );
    assertEquals(
      (await callTool(fixture, full.accessToken, "whoami")).status,
      200,
    );
    await fixture.pgDatabase.query(
      `update public."oauthConsent" set scopes = '[]'::jsonb where "clientId" = $1`,
      [clientId],
    );
    assertEquals(
      (await callTool(fixture, full.accessToken, "whoami")).status,
      403,
    );
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("losing the membership or the principal stops an unexpired token", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.developerCookie,
      clientId,
    });
    assertEquals(
      (await callTool(fixture, accessToken, "organization_get")).status,
      200,
    );
    const developerId = await userIdFor(
      fixture.pgDatabase,
      seeded.developerEmail,
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive'
       where principal_id = (select id from bakery.principals where provider_user_id = $1)`,
      [developerId],
    );
    assertEquals(
      (await callTool(fixture, accessToken, "organization_get")).status,
      401,
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'active'
       where principal_id = (select id from bakery.principals where provider_user_id = $1)`,
      [developerId],
    );
    assertEquals(
      (await callTool(fixture, accessToken, "organization_get")).status,
      200,
    );
    await fixture.pgDatabase.query(
      `update bakery.principals set disabled_at = now() where provider_user_id = $1`,
      [developerId],
    );
    assertEquals(
      (await callTool(fixture, accessToken, "whoami")).status,
      401,
    );
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a person in two organizations picks the one organization a consent binds", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const created = await fixture.app.fetch(authRequest(
      "/v1/organizations",
      { name: "Second Org", slug: `second-${crypto.randomUUID().slice(0, 8)}` },
      {
        cookie: seeded.adminCookie,
        headers: { "idempotency-key": crypto.randomUUID() },
      },
    ));
    assert(
      created.status === 201 || created.status === 200,
      await created.clone().text(),
    );
    const second = (await created.json() as Json).id as string;
    assertNotEquals(second, seeded.organizationId);

    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { verifier, challenge } = await pkcePair();
    const authorized = await authorize(fixture, {
      clientId,
      cookie: seeded.adminCookie,
      challenge,
    });
    // Two organizations and no choice yet: the provider sends the person to
    // the page that picks one instead of guessing.
    const oauthQuery = await consentQuery(authorized);
    const early = await submitConsent(fixture, {
      cookie: seeded.adminCookie,
      oauthQuery,
    });
    assert(
      early.status >= 400,
      `consent bound without a choice: ${early.status}`,
    );

    const selected = await fixture.app.fetch(authRequest(
      "/api/auth/bakery/oauth/select-organization",
      { organizationId: second },
      { cookie: seeded.adminCookie },
    ));
    assertEquals(selected.status, 200, await selected.clone().text());
    const foreign = await fixture.app.fetch(authRequest(
      "/api/auth/bakery/oauth/select-organization",
      { organizationId: crypto.randomUUID() },
      { cookie: seeded.adminCookie },
    ));
    assertEquals(foreign.status, 403);

    const resumed = await fixture.app.fetch(authRequest(
      "/api/auth/oauth2/continue",
      { postLogin: true, oauth_query: oauthQuery },
      { cookie: seeded.adminCookie },
    ));
    assertEquals(resumed.status, 200, await resumed.clone().text());
    const next = new URL(
      (await resumed.json() as { url: string }).url,
      authTestOrigin,
    );
    const consent = await submitConsent(fixture, {
      cookie: seeded.adminCookie,
      oauthQuery: next.search.slice(1),
    });
    assertEquals(consent.status, 200, await consent.clone().text());
    const token = await exchangeCode(fixture, {
      clientId,
      code: await codeFrom(consent),
      verifier,
    });
    assertEquals(token.status, 200);
    const { access_token: accessToken } = await token.json() as {
      access_token: string;
    };
    const org = await callTool(fixture, accessToken, "organization_get");
    assertEquals(
      JSON.parse(
        ((await org.json()) as McpResult).result!.content![0].text,
      ).id,
      second,
    );
    const [grant] = await listGrants(fixture, seeded.adminCookie);
    assertEquals(grant.organizationId, second);
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [second],
    ).catch(() => undefined);
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("discovery documents name the resource, the issuer and no dynamic registration", async () => {
  const fixture = await openAuthFixture();
  try {
    const resource = await fixture.app.fetch(
      new Request(`${authTestOrigin}/.well-known/oauth-protected-resource/mcp`),
    );
    assertEquals(resource.status, 200);
    assertEquals(await resource.json(), {
      resource: `${authTestOrigin}/mcp`,
      authorization_servers: [OAUTH_ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["bakery:read", "bakery:operate", "bakery:admin"],
      resource_name: "Bakery",
    });
    const server = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/.well-known/oauth-authorization-server/api/auth`,
      ),
    );
    assertEquals(server.status, 200);
    const metadata = await server.json() as Json;
    assertEquals(metadata.issuer, OAUTH_ISSUER);
    assert(
      (metadata.code_challenge_methods_supported as string[]).includes("S256"),
    );
    assertEquals(metadata.registration_endpoint, undefined);
    assert(String(metadata.authorization_endpoint).startsWith(OAUTH_ISSUER));
    assert(String(metadata.token_endpoint).startsWith(OAUTH_ISSUER));
  } finally {
    await fixture.close();
  }
});

type ToolCall = {
  isError?: boolean;
  structuredContent?: {
    status?: number;
    body?: Record<string, unknown>;
    etag?: string;
    problem?: { code: string; status: number };
  };
};

async function tool(
  fixture: Fixture,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const response = await fixture.app.fetch(
    mcpRequest("tools/call", { name, arguments: args }, { token }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    result?: ToolCall;
    error?: unknown;
  };
  assertEquals(body.error, undefined, JSON.stringify(body.error));
  return body.result!;
}

Deno.test("catalog tools run the REST operation: same state, replay, preconditions and fault codes", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture, {
      scopes: ["bakery:read", "bakery:operate", "bakery:admin"],
    });
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
      scope: "bakery:read bakery:operate bakery:admin",
    });
    const org = { "bakery-organization-id": seeded.organizationId };
    assert(
      (await listTools(fixture, accessToken)).includes(
        "bakery_applications_create",
      ),
    );

    // Discovery publishes the operation's own input schema.
    const listed = await fixture.app.fetch(
      mcpRequest("tools/list", {}, { token: accessToken }),
    );
    const createTool = (await listed.json() as {
      result: {
        tools: {
          name: string;
          inputSchema: {
            properties: Record<string, unknown>;
            required?: string[];
          };
        }[];
      };
    }).result.tools.find((t) => t.name === "bakery_applications_create")!;
    for (const field of ["slug", "name", "description", "idempotencyKey"]) {
      assert(field in createTool.inputSchema.properties, field);
    }
    assert(createTool.inputSchema.required?.includes("slug"));

    // Write through MCP; the result is the REST 201 body plus its ETag.
    const key = crypto.randomUUID();
    const input = { slug: "mcp-app", name: "MCP app", description: "" };
    const created = await tool(
      fixture,
      accessToken,
      "bakery_applications_create",
      {
        ...input,
        idempotencyKey: key,
      },
    );
    assertEquals(created.isError, undefined, JSON.stringify(created));
    assertEquals(created.structuredContent?.status, 201);
    const application = created.structuredContent!.body!;
    const id = (application.application as { id: string } | undefined)?.id ??
      application.id as string;
    assert(typeof id === "string");

    // The same key and input replays the original result exactly.
    const replay = await tool(
      fixture,
      accessToken,
      "bakery_applications_create",
      {
        ...input,
        idempotencyKey: key,
      },
    );
    assertEquals(replay.structuredContent, created.structuredContent);
    // The same key with a different input is the REST 422.
    const mismatch = await tool(
      fixture,
      accessToken,
      "bakery_applications_create",
      {
        ...input,
        name: "Other",
        idempotencyKey: key,
      },
    );
    assertEquals(mismatch.isError, true);
    assertEquals(
      mismatch.structuredContent?.problem?.code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    // REST reads what MCP wrote, and both reads agree.
    const restRead = await call(
      fixture,
      "GET",
      `/v1/applications/${id}`,
      seeded.adminCookie,
      { headers: org },
    );
    assertEquals(restRead.status, 200);
    const mcpRead = await tool(
      fixture,
      accessToken,
      "bakery_applications_get",
      {
        id,
      },
    );
    assertEquals(mcpRead.structuredContent?.status, 200);
    assertEquals(mcpRead.structuredContent?.body, await restRead.json());
    const etag = mcpRead.structuredContent?.etag ??
      restRead.headers.get("etag") ?? undefined;

    // Compare-and-set: missing and stale If-Match are the REST 428 and 412.
    const update = { id, name: "Renamed", idempotencyKey: crypto.randomUUID() };
    const missing = await tool(
      fixture,
      accessToken,
      "bakery_applications_update",
      update,
    );
    const restMissing = await call(
      fixture,
      "PATCH",
      `/v1/applications/${id}`,
      seeded.adminCookie,
      {
        headers: { ...org, "idempotency-key": crypto.randomUUID() },
        body: { name: "Renamed" },
      },
    );
    assertEquals(missing.isError, true);
    assertEquals(
      missing.structuredContent?.problem?.code,
      ((await restMissing.json()) as { code: string }).code,
    );
    assertEquals(
      missing.structuredContent?.problem?.status,
      restMissing.status,
    );
    if (etag) {
      const stale = await tool(
        fixture,
        accessToken,
        "bakery_applications_update",
        {
          ...update,
          idempotencyKey: crypto.randomUUID(),
          ifMatch: '"stale"',
        },
      );
      assertEquals(
        stale.structuredContent?.problem?.code,
        "PRECONDITION_FAILED",
      );
      const fresh = await tool(
        fixture,
        accessToken,
        "bakery_applications_update",
        {
          ...update,
          idempotencyKey: crypto.randomUUID(),
          ifMatch: etag,
        },
      );
      assertEquals(fresh.isError, undefined, JSON.stringify(fresh));
      assertEquals(fresh.structuredContent?.status, 200);
    }

    // A missing resource is the REST fault code, as a tool error.
    const unknown = crypto.randomUUID();
    const notFound = await tool(
      fixture,
      accessToken,
      "bakery_applications_get",
      {
        id: unknown,
      },
    );
    const restNotFound = await call(
      fixture,
      "GET",
      `/v1/applications/${unknown}`,
      seeded.adminCookie,
      { headers: org },
    );
    assertEquals(notFound.isError, true);
    assertEquals(
      notFound.structuredContent?.problem?.code,
      ((await restNotFound.json()) as { code: string }).code,
    );
    // Invalid input is a tool error carrying the REST validation code.
    const invalid = await tool(
      fixture,
      accessToken,
      "bakery_applications_get",
      {
        id: "not-a-uuid",
      },
    );
    assertEquals(invalid.isError, true);
    assertEquals(invalid.structuredContent?.problem?.code, "MALFORMED_REQUEST");
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.applications where slug = 'mcp-app'",
    );
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});

Deno.test("a read+operate grant cannot call an admin catalog tool: 403 before dispatch", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), false);
  const clientIds: string[] = [];
  try {
    const clientId = await registerTestClient(fixture);
    clientIds.push(clientId);
    const { accessToken } = await connectClient(fixture, {
      cookie: seeded.adminCookie,
      clientId,
    });
    const response = await fixture.app.fetch(mcpRequest("tools/call", {
      name: "bakery_applications_create",
      arguments: { slug: "denied-app", name: "Denied", description: "" },
    }, { token: accessToken }));
    assertEquals(response.status, 403);
    assert(
      response.headers.get("www-authenticate")?.includes("insufficient_scope"),
    );
    const written = await fixture.pgDatabase.query(
      "select 1 from bakery.applications where slug = 'denied-app'",
    );
    assertEquals(written.rows.length, 0);
  } finally {
    await cleanupOAuth(fixture, seeded.emails, clientIds);
    await fixture.close();
  }
});
