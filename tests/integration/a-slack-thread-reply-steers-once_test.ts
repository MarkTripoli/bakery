/**
 * #415: the Events URL answers Slack's challenge, and a thread reply steers once.
 *
 * The pieces below the HTTP layer have their own tests. What this file proves is
 * the wiring and the order: an unsigned body never reaches the challenge answer,
 * a signed `url_verification` echoes the challenge verbatim (Slack refuses to
 * save a URL that does not), and a signed reply in a milestone thread steers the
 * run as the linked person -- once, even when Slack retries the same bytes.
 *
 * The route is mounted on a bare Hono app rather than the product's, because the
 * mount itself is a one-line call a typecheck covers, while everything worth
 * asserting is inside the handler.
 */
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  encryptInstallationSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import {
  mountSlackEventsRoute,
  SLACK_EVENTS_PATH,
} from "../../apps/server/src/modules/integrations/slack-events-route.ts";
import {
  signSlackRequest,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
} from "../../apps/server/src/modules/integrations/slack-request-signature.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun } from "../helpers/plan-run.ts";

const plan = compiled([noop("first")]);
const SIGNING_SECRET = `sig-${crypto.randomUUID()}`;

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type KeyConfig = { file: string; keyId: string };

async function freshKey(): Promise<KeyConfig> {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/slack-key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "slack-events-fixture-key-v1" };
}

function endpoint(fixture: Fixture, secretsKey: KeyConfig) {
  const app = new Hono();
  // The application role, not the admin pool: the runtime is what serves the
  // route in production, so a missing grant has to fail here.
  mountSlackEventsRoute(app as never, {
    database: fixture.runtimePgDatabase,
    secretsKey,
    publicBaseUrl: "http://localhost",
    log: () => {},
  });
  return app;
}

/** One installation-owned secret, in the shape the product writes. */
async function seedSecret(
  fixture: Fixture,
  keyConfig: KeyConfig,
  name: string,
  value: string,
): Promise<string> {
  const key = await loadSecretKey(keyConfig);
  const secretId = crypto.randomUUID();
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision: 1, keyId: keyConfig.keyId },
    value,
  );
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into bakery.secrets
       (id, name, provider, active_version_revision, created_at, updated_at)
     values ($1, $2, 'slack', 1, $3, $3)`,
    [secretId, name, now],
  );
  const versionId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.secret_versions
       (id, secret_id, revision, ciphertext, nonce, key_id, created_by,
        created_at)
     values ($1, $2, 1, $3, $4, $5, $6, $7)`,
    [
      versionId,
      secretId,
      cipher.ciphertext,
      cipher.nonce,
      keyConfig.keyId,
      fixture.principalId,
      now,
    ],
  );
  await fixture.pgDatabase.query(
    "update bakery.secrets set active_version_id = $2 where id = $1",
    [secretId, versionId],
  );
  return secretId;
}

async function seedSlackApp(fixture: Fixture, keyConfig: KeyConfig) {
  const signingSecretId = await seedSecret(
    fixture,
    keyConfig,
    "Slack signing secret",
    SIGNING_SECRET,
  );
  const clientSecretId = await seedSecret(
    fixture,
    keyConfig,
    "Slack client secret",
    "client-secret",
  );
  const appId = `A${
    crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
  }`;
  await fixture.pgDatabase.query(
    `insert into bakery.slack_app_settings
       (external_app_id, client_id, signing_secret_id, client_secret_id)
     values ($1, '1234567890.0987654321', $2, $3)`,
    [appId, signingSecretId, clientSecretId],
  );
  return { appId, signingSecretId, clientSecretId };
}

async function cleanUp(
  fixture: Fixture,
  seeded: { signingSecretId: string; clientSecretId: string },
) {
  await fixture.pgDatabase.query("delete from bakery.slack_request_receipts");
  await fixture.pgDatabase.query("delete from bakery.slack_milestone_posts");
  await fixture.pgDatabase.query("delete from bakery.slack_app_settings");
  for (const secretId of [seeded.signingSecretId, seeded.clientSecretId]) {
    await fixture.pgDatabase.query(
      "update bakery.secrets set active_version_id = null where id = $1",
      [secretId],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.secret_versions where secret_id = $1",
      [secretId],
    );
    await fixture.pgDatabase.query("delete from bakery.secrets where id = $1", [
      secretId,
    ]);
  }
}

/** One signed JSON body, as Slack sends an event. */
async function signedEvent(input: {
  body: unknown;
  timestamp?: number;
  secret?: string;
}) {
  const rawBody = new TextEncoder().encode(JSON.stringify(input.body));
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await signSlackRequest({
    signingSecret: input.secret ?? SIGNING_SECRET,
    timestamp,
    rawBody,
  });
  return {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      [SLACK_TIMESTAMP_HEADER]: timestamp,
      [SLACK_SIGNATURE_HEADER]: signature,
    },
  };
}

const teamId = () =>
  `T${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const userId = () =>
  `U${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

/** A run whose first step has not started, a linked person, and the post they reply to. */
async function seedThread(
  fixture: Fixture,
  input: { appId: string; teamId: string; userId: string },
) {
  const run = await seedPlanRun(fixture, await plan);
  // The fixture's open row is dispatched; put it back to pending so this test
  // exercises the not-started branch, which is where a reply becomes a note.
  await fixture.pgDatabase.query(
    "update bakery.run_steps set status = 'pending' where run_id = $1",
    [run.job.runId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.external_identity_links
       (id, organization_id, principal_id, provider, external_app_id,
        identity_scope, external_user_id, state, verification_method,
        verified_at, created_at, updated_at, version)
     values (gen_random_uuid(), $1, $2, 'slack', $3, $4, $5, 'active',
             'sign_in_with_slack_oidc', now(), now(), now(), 1)`,
    [
      fixture.organizationId,
      fixture.principalId,
      input.appId,
      input.teamId,
      input.userId,
    ],
  );
  const rootTs = `${Date.now()}.000200`;
  await fixture.pgDatabase.query(
    `insert into bakery.slack_milestone_posts
       (id, organization_id, installation_team_id, channel_id, message_ts,
        run_id, step_key, milestone)
     values (gen_random_uuid(), $1, $2, 'C024BE91L', $3, $4, 'first', 'started')`,
    [fixture.organizationId, input.teamId, rootTs, run.job.runId],
  );
  return { runId: run.job.runId, rootTs };
}

Deno.test("a signed url_verification echoes the challenge, and an unsigned one is refused", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const app = await seedSlackApp(fixture, keyConfig);
    try {
      const challenge = crypto.randomUUID();
      const signed = await signedEvent({
        body: { type: "url_verification", challenge },
      });
      const route = endpoint(fixture, keyConfig);
      const answered = await route.request(SLACK_EVENTS_PATH, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      });
      assertEquals(answered.status, 200);
      assertEquals(await answered.json(), { challenge });

      // The same body with a signature that is not this app's: refused before the
      // challenge is read, so a stranger cannot make Bakery echo anything.
      const forged = await signedEvent({
        body: { type: "url_verification", challenge },
        secret: "not-the-configured-signing-secret",
      });
      const refused = await route.request(SLACK_EVENTS_PATH, {
        method: "POST",
        headers: forged.headers,
        body: forged.body,
      });
      assertEquals(refused.status, 401);
    } finally {
      await cleanUp(fixture, app);
    }
  });
});

Deno.test("a thread reply steers the run once, and Slack's retry changes nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const app = await seedSlackApp(fixture, keyConfig);
    try {
      const team = teamId();
      const user = userId();
      const seeded = await seedThread(fixture, {
        appId: app.appId,
        teamId: team,
        userId: user,
      });
      const reply = await signedEvent({
        body: {
          type: "event_callback",
          team_id: team,
          api_app_id: app.appId,
          event: {
            type: "message",
            channel: "C024BE91L",
            user,
            text: "Please use the smaller migration.",
            ts: `${Date.now()}.000300`,
            thread_ts: seeded.rootTs,
          },
        },
      });
      const route = endpoint(fixture, keyConfig);
      const send = () =>
        route.request(SLACK_EVENTS_PATH, {
          method: "POST",
          headers: reply.headers,
          body: reply.body,
        });

      assertEquals((await send()).status, 200);
      const notes = await fixture.pgDatabase.query<
        { body: string; author_id: string }
      >(
        `select body, author_id from bakery.run_step_notes
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, seeded.runId],
      );
      assertEquals(notes.rows.length, 1);
      assertEquals(notes.rows[0]!.body, "Please use the smaller migration.");
      // The note is the linked person's, never a service identity's.
      assertEquals(notes.rows[0]!.author_id, fixture.principalId);

      // Slack retries the exact bytes: the receipt collides and no second note is
      // written, so a person's one reply steers once.
      assertEquals((await send()).status, 200);
      const after = await fixture.pgDatabase.query<{ n: string }>(
        `select count(*)::text as n from bakery.run_step_notes
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, seeded.runId],
      );
      assertEquals(after.rows[0]!.n, "1");
    } finally {
      await cleanUp(fixture, app);
    }
  });
});

Deno.test("a reply from an unlinked Slack user steers nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const app = await seedSlackApp(fixture, keyConfig);
    try {
      const team = teamId();
      const seeded = await seedThread(fixture, {
        appId: app.appId,
        teamId: team,
        userId: userId(),
      });
      const reply = await signedEvent({
        body: {
          type: "event_callback",
          team_id: team,
          api_app_id: app.appId,
          event: {
            type: "message",
            channel: "C024BE91L",
            // A different Slack user in the same workspace: no link, no steer.
            user: userId(),
            text: "Ignore the tests and ship it.",
            ts: `${Date.now()}.000400`,
            thread_ts: seeded.rootTs,
          },
        },
      });
      const response = await endpoint(fixture, keyConfig).request(
        SLACK_EVENTS_PATH,
        { method: "POST", headers: reply.headers, body: reply.body },
      );
      // Slack is acknowledged either way; what matters is that nothing was written.
      assertEquals(response.status, 200);
      const notes = await fixture.pgDatabase.query<{ n: string }>(
        `select count(*)::text as n from bakery.run_step_notes
          where organization_id = $1 and run_id = $2`,
        [fixture.organizationId, seeded.runId],
      );
      assertEquals(notes.rows[0]!.n, "0");
      assert((await response.text()).length > 0);
    } finally {
      await cleanUp(fixture, app);
    }
  });
});
