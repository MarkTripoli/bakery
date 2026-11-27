import { assert, assertEquals, assertMatch } from "@std/assert";
import { call, signIn } from "../helpers/installation-settings.ts";
import { CLIENT_SECRET, TEAM_ID } from "../helpers/slack-connect.ts";
import {
  APP_ID,
  attemptRow,
  clearLinking,
  CLIENT_ID,
  completeLink,
  connectWorkspace,
  identityCallback,
  identityClaims,
  linkResult,
  linkRows,
  openLinking,
  readLink,
  signIdToken,
  signingKey,
  SLACK_USER,
  startedLink,
  startLink,
  unlink,
} from "../helpers/slack-identity-link.ts";
import {
  findSlackIdentityLink,
  revokeSlackIdentityLink,
} from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

type Linking = Awaited<ReturnType<typeof openLinking>>;

async function withLinking(run: (o: Linking) => Promise<void>) {
  const o = await openLinking();
  try {
    await run(o);
  } finally {
    await o.finish();
  }
}

async function read(o: Linking, cookie: string) {
  const response = await readLink(o.fixture, cookie);
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Record<string, unknown>;
}

async function refusal(response: Response) {
  assertEquals(response.status, 409, await response.clone().text());
  const problem = await response.json() as {
    code: string;
    issues?: { code: string }[];
  };
  assertEquals(problem.code, "STATE_CONFLICT");
  return problem.issues?.[0]?.code;
}

async function setConnection(o: Linking, status: string, health: string) {
  await o.fixture.pgDatabase.query(
    `update bakery.integration_connections set status = $2, health = $3
      where organization_id = $1 and provider = 'slack'`,
    [o.fixture.organizationId, status, health],
  );
}

async function auditCount(o: Linking, operation: string) {
  return (await o.fixture.pgDatabase.query<
    { details: Record<string, unknown> }
  >(
    `select details from bakery.audit_events
      where organization_id = $1 and operation = $2 order by created_at`,
    [o.fixture.organizationId, operation],
  )).rows;
}

Deno.test("starting a link returns Slack's sign-in address with state, nonce and the connected workspace", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const started = await startedLink(o.fixture, o.fixture.developerCookie);
    assertEquals(
      `${started.url.origin}${started.url.pathname}`,
      "https://slack.com/openid/connect/authorize",
    );
    const query = started.url.searchParams;
    assertEquals(query.get("response_type"), "code");
    assertEquals(query.get("scope"), "openid profile");
    assertEquals(query.get("client_id"), CLIENT_ID);
    assertEquals(query.get("team"), TEAM_ID);
    assert(
      query.get("redirect_uri")!.endsWith(
        "/v1/integration-auth/slack/identity-callback",
      ),
    );
    assert(started.state.length >= 43);
    assert(started.nonce.length >= 43);
    assert(started.state !== started.nonce);
    assert(Date.parse(started.expiresAt) > Date.now());
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.status,
      "pending",
    );
    assertEquals(
      (await auditCount(o, "mySlackLinkAttempts.create")).length,
      1,
    );
  });
});

Deno.test("the connection state reads none, setup_unfinished, working and not_working, and start refuses unless working", async () => {
  await withLinking(async (o) => {
    const cookie = o.fixture.developerCookie;
    await clearLinking(o.fixture);
    assertEquals(await read(o, cookie), {
      connection: "none",
      state: "not_linked",
    });
    assertEquals(
      await refusal(await startLink(o.fixture, cookie)),
      "slack_not_connected",
    );

    const saved = await call(
      o.fixture,
      "PUT",
      "/v1/integration-client-credentials/slack",
      o.fixture.adminCookie,
      {
        body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      },
    );
    assertEquals(saved.status, 200, await saved.clone().text());
    assertEquals(await read(o, cookie), {
      connection: "setup_unfinished",
      state: "not_linked",
    });
    assertEquals(
      await refusal(await startLink(o.fixture, cookie)),
      "slack_not_connected",
    );

    await connectWorkspace(o);
    assertEquals(await read(o, cookie), {
      connection: "working",
      workspaceName: "Test Workspace",
      state: "not_linked",
    });

    const cases: [string, string, string, string | null][] = [
      ["enabled", "healthy", "working", null],
      ["enabled", "unknown", "working", null],
      ["enabled", "degraded", "not_working", "slack_connection_not_working"],
      [
        "enabled",
        "auth_required",
        "not_working",
        "slack_connection_not_working",
      ],
      ["disabled", "healthy", "not_working", "slack_connection_not_working"],
      ["revoked", "unknown", "not_working", "slack_connection_not_working"],
      ["pending", "unknown", "setup_unfinished", "slack_not_connected"],
    ];
    for (const [status, health, expected, refused] of cases) {
      await setConnection(o, status, health);
      const body = await read(o, cookie);
      assertEquals(body.connection, expected, `${status}/${health}`);
      assertEquals(body.workspaceName, "Test Workspace");
      const response = await startLink(o.fixture, cookie);
      if (refused === null) {
        assertEquals(response.status, 201, await response.clone().text());
        await response.body?.cancel();
      } else {
        assertEquals(await refusal(response), refused, `${status}/${health}`);
      }
    }
  });
});

Deno.test("start refuses when the workspace has no recorded Slack app", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    await o.fixture.pgDatabase.query(
      "delete from bakery.slack_installations where organization_id = $1",
      [o.fixture.organizationId],
    );
    assertEquals(
      await refusal(await startLink(o.fixture, o.fixture.developerCookie)),
      "slack_workspace_unregistered",
    );
  });
});

Deno.test("the callback verifies Slack's identity token and links the member who started", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    const started = await startedLink(o.fixture, cookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce),
    );
    const result = linkResult(
      await identityCallback(o.fixture, cookie, {
        code: "identity-code",
        state: started.state,
      }),
    );
    assertEquals(result, "linked");
    const exchange = o.slack.calls.find((entry) =>
      entry.url === "https://slack.com/api/openid.connect.token"
    )!;
    const form = new URLSearchParams(exchange.body);
    assertEquals(form.get("client_id"), CLIENT_ID);
    assertEquals(form.get("client_secret"), CLIENT_SECRET);
    assertEquals(form.get("code"), "identity-code");
    assert(form.get("redirect_uri")!.endsWith("/slack/identity-callback"));
    assert(
      o.slack.calls.some((entry) =>
        entry.url === "https://slack.com/openid/connect/keys"
      ),
    );
    const rows = await linkRows(o.fixture);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.principal_id, o.fixture.developerId);
    assertEquals(rows[0]!.state, "active");
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.status,
      "completed",
    );
    const body = await read(o, cookie);
    assertEquals(body.state, "linked");
    assertEquals(body.connection, "working");
    assertEquals(body.workspaceName, "Test Workspace");
    assertMatch(String(body.linkedAt), /^\d{4}-\d{2}-\d{2}T/);
    const audits = await auditCount(o, "integrationAuth.slackIdentityCallback");
    assertEquals(audits.length, 1);
    assertEquals(audits[0]!.details.outcome, "linked");
    assert(!JSON.stringify(audits).includes(SLACK_USER));

    assertEquals(await completeLink(o, cookie), "unchanged");
    assertEquals((await linkRows(o.fixture)).length, 1);
  });
});

Deno.test("a state presented by another session or another member, replayed, expired or superseded links nothing", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    const started = await startedLink(o.fixture, cookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce),
    );
    const query = { code: "identity-code", state: started.state };

    const otherSession = await signIn(
      o.fixture,
      o.fixture.developerEmail,
      o.fixture.password,
    );
    assertEquals(
      linkResult(await identityCallback(o.fixture, otherSession, query)),
      "expired",
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, o.fixture.adminCookie, query),
      ),
      "expired",
    );
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.status,
      "pending",
    );
    assertEquals(await linkRows(o.fixture), []);
    assertEquals(
      o.slack.calls.filter((entry) => entry.url.includes("openid")).length,
      0,
    );

    assertEquals(
      linkResult(await identityCallback(o.fixture, cookie, query)),
      "linked",
    );
    const version = (await linkRows(o.fixture))[0]!.version;
    assertEquals(
      linkResult(await identityCallback(o.fixture, cookie, query)),
      "expired",
    );
    assertEquals((await linkRows(o.fixture))[0]!.version, version);

    const late = await startedLink(o.fixture, cookie);
    await o.fixture.pgDatabase.query(
      `update bakery.slack_identity_attempts
          set expires_at = now() - interval '1 minute'
        where status = 'pending' and organization_id = $1`,
      [o.fixture.organizationId],
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: late.state,
        }),
      ),
      "expired",
    );
    assertEquals((await attemptRow(o.fixture, late.state))?.status, "pending");

    const first = await startedLink(o.fixture, cookie);
    await startedLink(o.fixture, cookie);
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: first.state,
        }),
      ),
      "superseded",
    );
    assertEquals((await linkRows(o.fixture)).length, 1);
  });
});

Deno.test("a token that fails verification is token_invalid, another workspace is wrong_workspace, and nothing links", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    const forger = await signingKey();
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Record<string, unknown>, string, boolean][] = [
      ["bad signature", {}, "token_invalid", true],
      [
        "wrong issuer",
        { iss: "https://slack.example" },
        "token_invalid",
        false,
      ],
      ["wrong audience", { aud: "9999.0000" }, "token_invalid", false],
      ["wrong nonce", { nonce: "not-the-nonce" }, "token_invalid", false],
      [
        "expired token",
        { iat: now - 500, exp: now - 400 },
        "token_invalid",
        false,
      ],
      [
        "other workspace",
        { "https://slack.com/team_id": "T0OTHERTEAM" },
        "wrong_workspace",
        false,
      ],
    ];
    for (const [name, overrides, expected, forged] of cases) {
      const started = await startedLink(o.fixture, cookie);
      const claims = identityClaims(started.nonce, overrides);
      o.slack.state.idToken = await signIdToken(
        forged ? forger : o.key,
        claims,
      );
      const result = linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: started.state,
        }),
      );
      assertEquals(result, expected, name);
      const attempt = await attemptRow(o.fixture, started.state);
      assertEquals(attempt?.status, "failed", name);
      assertEquals(attempt?.failure_code, expected, name);
    }
    assertEquals(await linkRows(o.fixture), []);
  });
});

Deno.test("a denial in Slack, a failed exchange and an unreadable nonce each end the attempt without a link", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;

    const denied = await startedLink(o.fixture, cookie);
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          state: denied.state,
          error: "access_denied",
        }),
      ),
      "provider_denied",
    );
    assertEquals(
      (await attemptRow(o.fixture, denied.state))?.failure_code,
      "provider_denied",
    );

    const failed = await startedLink(o.fixture, cookie);
    o.slack.state.tokenOk = false;
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: failed.state,
        }),
      ),
      "exchange_failed",
    );
    o.slack.state.tokenOk = true;

    const unreadable = await startedLink(o.fixture, cookie);
    await o.fixture.pgDatabase.query(
      `update bakery.slack_identity_attempts set nonce_key_id = 'retired-key'
        where status = 'pending' and organization_id = $1`,
      [o.fixture.organizationId],
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: unreadable.state,
        }),
      ),
      "nonce_unreadable",
    );
    assertEquals(await linkRows(o.fixture), []);
  });
});

Deno.test("a Slack account another member holds is link_refused, and a member made inactive is not_a_member", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    assertEquals(await completeLink(o, o.fixture.adminCookie), "linked");
    assertEquals(
      await completeLink(o, o.fixture.developerCookie),
      "link_refused",
    );
    const rows = await linkRows(o.fixture);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.principal_id, o.fixture.adminId);

    const started = await startedLink(o.fixture, o.fixture.developerCookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce, { sub: "U0MEMBER02" }),
    );
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive'
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.fixture.developerId],
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, o.fixture.developerCookie, {
          code: "identity-code",
          state: started.state,
        }),
      ),
      "not_a_member",
    );
    assertEquals((await linkRows(o.fixture)).length, 1);
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.failure_code,
      "not_a_member",
    );
  });
});

Deno.test("a connection removed while the member is in Slack ends the attempt as expired", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    const started = await startedLink(o.fixture, cookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce),
    );
    await setConnection(o, "revoked", "unknown");
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: started.state,
        }),
      ),
      "expired",
    );
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.failure_code,
      "connection_unavailable",
    );
    assertEquals(await linkRows(o.fixture), []);
  });
});

Deno.test("my link reads removed_by_admin after an administrator removes it, and linked again after relinking", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    assertEquals(await completeLink(o, cookie), "linked");
    const linkId = (await o.fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.external_identity_links
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.fixture.developerId],
    )).rows[0]!.id;
    const revoked = await withPgTransaction(
      o.fixture.pgDatabase,
      (transaction) =>
        revokeSlackIdentityLink(transaction, {
          organizationId: o.fixture.organizationId,
          linkId,
          revokedBy: o.fixture.adminId,
          reason: "revoked_by_admin",
          at: new Date(),
        }),
    );
    assert(revoked.ok);
    const removed = await read(o, cookie);
    assertEquals(removed.state, "removed_by_admin");
    assertMatch(String(removed.removedAt), /^\d{4}-\d{2}-\d{2}T/);
    assertEquals(removed.linkedAt, undefined);

    assertEquals(await completeLink(o, cookie), "relinked");
    assertEquals((await read(o, cookie)).state, "linked");
  });
});

Deno.test("unlinking revokes the member's link with unlinked_by_member, is audited, and repeats as a read", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    assertEquals(await completeLink(o, cookie), "linked");

    const first = await unlink(o.fixture, cookie);
    assertEquals(first.status, 200, await first.clone().text());
    assertEquals(await first.json(), {
      connection: "working",
      workspaceName: "Test Workspace",
      state: "not_linked",
    });
    const rows = await linkRows(o.fixture);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.state, "revoked");
    assertEquals(rows[0]!.revoke_reason, "unlinked_by_member");
    const audits = await auditCount(o, "mySlackLink.delete");
    assertEquals(audits.length, 1);
    assertEquals(audits[0]!.details.reason, "unlinked_by_member");
    assertEquals((await read(o, cookie)).state, "not_linked");

    const again = await unlink(o.fixture, cookie);
    assertEquals(again.status, 200, await again.clone().text());
    assertEquals((await again.json() as { state: string }).state, "not_linked");
    assertEquals((await auditCount(o, "mySlackLink.delete")).length, 1);
  });
});

Deno.test("linking a second Slack account replaces the member's first one, and the replacement is audited", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    assertEquals(await completeLink(o, cookie), "linked");
    assertEquals(await completeLink(o, cookie, { sub: "U0SECOND1" }), "linked");
    const rows = await linkRows(o.fixture);
    assertEquals(
      rows.map((row) => [row.state, row.revoke_reason]),
      [["revoked", "replaced_by_new_link"], ["active", null]],
    );
    const lookup = (userId: string) =>
      withPgTransaction(
        o.fixture.runtimePgDatabase,
        (tx) =>
          findSlackIdentityLink(tx, {
            organizationId: o.fixture.organizationId,
            appId: APP_ID,
            teamId: TEAM_ID,
            userId,
          }),
      );
    assertEquals((await lookup(SLACK_USER))?.state, "revoked");
    assertEquals((await lookup("U0SECOND1"))?.state, "active");
    const audits = await auditCount(o, "integrationAuth.slackIdentityCallback");
    assertEquals(
      audits.filter((row) => row.details.reason === "replaced_by_new_link")
        .length,
      1,
    );
    assertEquals((await read(o, cookie)).state, "linked");
  });
});

Deno.test("a viewer reads, links and unlinks their own Slack account but still cannot list other members' links", async () => {
  await withLinking(async (o) => {
    await connectWorkspace(o);
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'viewer'
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.fixture.developerId],
    );
    const cookie = o.fixture.developerCookie;
    assertEquals((await read(o, cookie)).state, "not_linked");
    assertEquals(await completeLink(o, cookie), "linked");
    assertEquals((await read(o, cookie)).state, "linked");
    const unlinked = await unlink(o.fixture, cookie);
    assertEquals(unlinked.status, 200, await unlinked.clone().text());
    assertEquals((await read(o, cookie)).state, "not_linked");
    const connection = await o.fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.integration_connections
        where organization_id = $1 and provider = 'slack'`,
      [o.fixture.organizationId],
    );
    const others = await call(
      o.fixture,
      "GET",
      `/v1/integration-connections/${connection.rows[0]!.id}/identity-links`,
      cookie,
      { headers: { "Bakery-Organization-Id": o.fixture.organizationId } },
    );
    assert(
      others.status === 403 || others.status === 404,
      String(others.status),
    );
    await others.body?.cancel();
  });
});
