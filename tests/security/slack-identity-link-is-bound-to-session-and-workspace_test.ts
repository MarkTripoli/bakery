import { assert, assertEquals } from "@std/assert";
import { call } from "../helpers/installation-settings.ts";
import { secondOrganization } from "../helpers/github-app-registration.ts";
import { TEAM_ID } from "../helpers/slack-connect.ts";
import {
  attemptRow,
  completeLink,
  connectWorkspace,
  IDENTITY_CALLBACK,
  identityCallback,
  identityClaims,
  linkResult,
  linkRows,
  openLinking,
  readLink,
  registerWorkspace,
  signIdToken,
  startedLink,
  startLink,
  unlink,
} from "../helpers/slack-identity-link.ts";

type Linking = Awaited<ReturnType<typeof openLinking>>;

async function withOtherOrganization(
  run: (o: Linking, otherOrganizationId: string) => Promise<void>,
) {
  const o = await openLinking();
  try {
    await run(o, await secondOrganization(o.fixture));
  } finally {
    try {
      await o.fixture.pgDatabase.query(
        "delete from bakery.slack_installations where team_id = 'T0SECONDTEAM'",
      );
    } finally {
      await o.finish();
    }
  }
}

Deno.test("a member of one organization can neither read, start nor remove a link in another, and a link never crosses organizations", async () => {
  await withOtherOrganization(async (o, otherOrganizationId) => {
    await connectWorkspace(o);
    assertEquals(await completeLink(o, o.fixture.adminCookie), "linked");
    const outsider = o.fixture.developerCookie;
    for (
      const response of [
        await readLink(o.fixture, outsider, otherOrganizationId),
        await startLink(o.fixture, outsider, otherOrganizationId),
        await unlink(o.fixture, outsider, otherOrganizationId),
      ]
    ) {
      assert(
        response.status === 403 || response.status === 404,
        await response.clone().text(),
      );
      await response.body?.cancel();
    }
    const elsewhere = await readLink(
      o.fixture,
      o.fixture.adminCookie,
      otherOrganizationId,
    );
    assertEquals(elsewhere.status, 200, await elsewhere.clone().text());
    assertEquals(await elsewhere.json(), {
      connection: "setup_unfinished",
      state: "not_linked",
    });
    const removedElsewhere = await unlink(
      o.fixture,
      o.fixture.adminCookie,
      otherOrganizationId,
    );
    assertEquals(removedElsewhere.status, 200);
    await removedElsewhere.body?.cancel();
    const rows = await linkRows(o.fixture);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.state, "active");
    assertEquals(rows[0]!.principal_id, o.fixture.adminId);
  });
});

Deno.test("a state is bound to the session and member that started it, across organizations too", async () => {
  await withOtherOrganization(async (o, otherOrganizationId) => {
    await connectWorkspace(o);
    const started = await startedLink(o.fixture, o.fixture.developerCookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce),
    );
    const query = { code: "identity-code", state: started.state };
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, o.fixture.adminCookie, query),
      ),
      "expired",
    );
    const anonymous = await o.fixture.app.fetch(
      new Request(
        `http://127.0.0.1:8788${IDENTITY_CALLBACK}?${new URLSearchParams(
          query,
        )}`,
      ),
    );
    assert(anonymous.status >= 400 && anonymous.status < 500);
    await anonymous.body?.cancel();
    assertEquals(
      (await attemptRow(o.fixture, started.state))?.status,
      "pending",
    );
    assertEquals(await linkRows(o.fixture), []);
    assertEquals(await linkRows(o.fixture, otherOrganizationId), []);
    assertEquals(
      o.slack.calls.filter((entry) => entry.url.includes("openid")).length,
      0,
    );
  });
});

Deno.test("an identity token from another organization's workspace never links into this one", async () => {
  await withOtherOrganization(async (o, otherOrganizationId) => {
    await connectWorkspace(o);
    await registerWorkspace(o.fixture, otherOrganizationId, "T0SECONDTEAM");
    const started = await startedLink(o.fixture, o.fixture.developerCookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(started.nonce, {
        "https://slack.com/team_id": "T0SECONDTEAM",
      }),
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, o.fixture.developerCookie, {
          code: "identity-code",
          state: started.state,
        }),
      ),
      "wrong_workspace",
    );
    assertEquals(await linkRows(o.fixture), []);
    assertEquals(await linkRows(o.fixture, otherOrganizationId), []);
    assertEquals(started.url.searchParams.get("team"), TEAM_ID);
  });
});

Deno.test("a token without the attempt's nonce or for another app's audience is refused even with a valid signature", async () => {
  await withOtherOrganization(async (o) => {
    await connectWorkspace(o);
    const cookie = o.fixture.developerCookie;
    const first = await startedLink(o.fixture, cookie);
    const second = await startedLink(o.fixture, o.fixture.adminCookie);
    o.slack.state.idToken = await signIdToken(
      o.key,
      identityClaims(second.nonce),
    );
    assertEquals(
      linkResult(
        await identityCallback(o.fixture, cookie, {
          code: "identity-code",
          state: first.state,
        }),
      ),
      "token_invalid",
    );
    assertEquals(
      await completeLink(o, cookie, { aud: ["1234.5678", "other.app"] }),
      "token_invalid",
    );
    assertEquals(await linkRows(o.fixture), []);
  });
});

Deno.test("a request without a browser session cannot start a link", async () => {
  await withOtherOrganization(async (o) => {
    await connectWorkspace(o);
    const response = await call(
      o.fixture,
      "POST",
      "/v1/me/slack-link/attempts",
      "",
      {
        body: {},
        headers: {
          "Bakery-Organization-Id": o.fixture.organizationId,
          authorization: "Bearer bkr_not_a_real_token",
        },
      },
    );
    assert(
      response.status === 401 || response.status === 403,
      await response.clone().text(),
    );
    await response.body?.cancel();
    assertEquals(
      (await o.fixture.pgDatabase.query(
        "select 1 from bakery.slack_identity_attempts where organization_id = $1",
        [o.fixture.organizationId],
      )).rows.length,
      0,
    );
  });
});
