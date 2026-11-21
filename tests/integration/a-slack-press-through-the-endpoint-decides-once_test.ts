/**
 * #415: one signed press through the real endpoint, and one decision.
 *
 * Everything below the HTTP layer has its own tests. What this file proves is the
 * wiring and the order: an unsigned request never reaches the decision, a signed one
 * claims a receipt and decides, and the same signed bytes retried by Slack answer
 * `duplicate` and change nothing. It also pins two absences -- no Slack app
 * configured, and an unverifiable caller -- because those are the cases that turn a
 * bug into a 500 Slack retries for ever.
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
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import {
  mountSlackInteractionsRoute,
  SLACK_INTERACTIONS_PATH,
} from "../../apps/server/src/modules/integrations/slack-interactions-route.ts";
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

/** The signing key every secret in these tests is written under. */
async function freshKey(): Promise<KeyConfig> {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/slack-key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "slack-app-fixture-key-v1" };
}

/** The route, mounted the way the product mounts it. */
function endpoint(fixture: Fixture, secretsKey: KeyConfig) {
  const app = new Hono();
  mountSlackInteractionsRoute(app as never, {
    database: fixture.pgDatabase,
    secretsKey,
    publicBaseUrl: "http://localhost",
    log: () => {},
  });
  return app;
}

/**
 * Stores one installation-owned secret and returns its id.
 *
 * This is the shape the product writes: a `bakery.secrets` row with no organization
 * or application, one encrypted `secret_versions` row, and `active_version_id`
 * pointing at it. A test that inserted ciphertext by hand would not prove the reader
 * joins the active version.
 */
async function seedSecret(
  fixture: Fixture,
  keyConfig: KeyConfig,
  name: string,
  value: string,
): Promise<string> {
  const key = await loadSecretKey(keyConfig);
  const secretId = crypto.randomUUID();
  const revision = 1;
  const cipher = await encryptInstallationSecret(
    key,
    { secretId, revision, keyId: keyConfig.keyId },
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
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      versionId,
      secretId,
      revision,
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

/** The configured app, as the settings slice will write it. */
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

/**
 * Removes what these tests wrote, newest first.
 *
 * The secrets name a principal and the settings row names the secrets, and the
 * fixture's own cleanup deletes principals, so leaving either behind breaks the
 * fixture that runs next -- in this file, and in the file after it.
 */
async function cleanUp(
  fixture: Fixture,
  seeded: { signingSecretId: string; clientSecretId: string },
) {
  // Receipts are global ingress state with no organization to scope by, so they are
  // cleared here too: a test that left one behind would make the next file's
  // "nothing was claimed" assertion read the neighbour's row.
  await fixture.pgDatabase.query("delete from bakery.slack_request_receipts");
  await fixture.pgDatabase.query("delete from bakery.slack_app_settings");
  for (const secretId of [seeded.signingSecretId, seeded.clientSecretId]) {
    // The pointer goes first: `secrets.active_version_id` references the version.
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

/** One signed interaction body, as Slack sends it. */
async function signedPress(input: {
  appId: string;
  teamId: string;
  userId: string;
  decisionId: string;
  action: "approve" | "reject";
  timestamp?: number;
  secret?: string;
}) {
  const payload = {
    type: "block_actions",
    api_app_id: input.appId,
    team: { id: input.teamId },
    user: { id: input.userId },
    actions: [{ action_id: input.action, value: input.decisionId }],
  };
  const body = new TextEncoder().encode(
    `payload=${encodeURIComponent(JSON.stringify(payload))}`,
  );
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await signSlackRequest({
    signingSecret: input.secret ?? SIGNING_SECRET,
    timestamp,
    rawBody: body,
  });
  return {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      [SLACK_TIMESTAMP_HEADER]: timestamp,
      [SLACK_SIGNATURE_HEADER]: signature,
    },
  };
}

/** A run with an open approval, a linked person, and the waiting post they see. */
async function seedPress(
  fixture: Fixture,
  input: { appId: string; teamId: string; userId: string },
) {
  const run = await seedPlanRun(fixture, await plan);
  const scope = (await fixture.pgDatabase.query<
    {
      taskId: string;
      conversationId: string;
      applicationId: string;
      repositoryId: string | null;
    }
  >(
    `select id as "taskId", conversation_id as "conversationId",
            application_id as "applicationId", repository_id as "repositoryId"
       from bakery.tasks where organization_id = $1 and id = $2`,
    [fixture.organizationId, run.job.taskId],
  )).rows[0]!;
  const asked = await requestHumanApproval(fixture.pgDatabase as never, {
    organizationId: fixture.organizationId,
    runId: run.job.runId,
    taskId: scope.taskId,
    conversationId: scope.conversationId,
    stepKey: "human.approval",
    prompt: "Ship it?",
    ownerPrincipalId: fixture.principalId,
    applicationId: scope.applicationId,
    repositoryId: scope.repositoryId,
    traceId: crypto.randomUUID(),
  });
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
  const postId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.slack_milestone_posts
       (id, organization_id, installation_team_id, channel_id, message_ts,
        run_id, step_key, milestone, decision_state)
     values ($1, $2, $3, 'C024BE91L', $4, $5, 'human.approval', 'waiting', 'open')`,
    [
      postId,
      fixture.organizationId,
      input.teamId,
      `${Date.now()}.000100`,
      run.job.runId,
    ],
  );
  return { ...asked, postId };
}

const teamId = () =>
  `T${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const userId = () =>
  `U${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

Deno.test("a signed press decides once, and Slack's retry is a duplicate", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const app = await seedSlackApp(fixture, keyConfig);
    try {
      const team = teamId();
      const user = userId();
      const seeded = await seedPress(fixture, {
        appId: app.appId,
        teamId: team,
        userId: user,
      });
      const press = await signedPress({
        appId: app.appId,
        teamId: team,
        userId: user,
        decisionId: seeded.postId,
        action: "approve",
      });
      const route = endpoint(fixture, keyConfig);
      const send = (headers: Record<string, string>) =>
        route.request(SLACK_INTERACTIONS_PATH, {
          method: "POST",
          headers,
          body: press.body,
        });

      const first = await send(press.headers);
      assertEquals(first.status, 200);
      const firstBody = await first.json() as {
        disposition: string;
        receiptId: string;
      };
      assertEquals(firstBody.disposition, "accepted");
      // The decision is the store's, and it landed as the linked person's.
      assertEquals(
        (await fixture.pgDatabase.query<{ status: string; decision: string }>(
          `select status, decision from bakery.questions
            where organization_id = $1 and id = $2`,
          [fixture.organizationId, seeded.approvalId],
        )).rows[0],
        { status: "answered", decision: "approve" },
      );

      // Slack retries the exact bytes: the signature is therefore identical, the
      // receipt collides, and the decision is not applied a second time.
      const retry = await send(press.headers);
      assertEquals(retry.status, 200);
      const retryBody = await retry.json() as {
        disposition: string;
        receiptId: string;
      };
      assertEquals(retryBody.disposition, "duplicate");
      assertEquals(retryBody.receiptId, firstBody.receiptId);
      const ledger = await fixture.pgDatabase.query<{ n: string }>(
        `select count(*)::text as n from bakery.decisions_ledger
          where organization_id = $1`,
        [fixture.organizationId],
      );
      assertEquals(ledger.rows[0]!.n, "1");
    } finally {
      await cleanUp(fixture, app);
    }
  });
});

Deno.test("an unsigned request never reaches the decision, and claims nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const app = await seedSlackApp(fixture, keyConfig);
    try {
      const press = await signedPress({
        appId: app.appId,
        teamId: teamId(),
        userId: userId(),
        decisionId: crypto.randomUUID(),
        action: "approve",
        // A well-formed signature that is not this app's.
        secret: "not-the-configured-signing-secret",
      });
      const response = await endpoint(fixture, keyConfig).request(
        SLACK_INTERACTIONS_PATH,
        { method: "POST", headers: press.headers, body: press.body },
      );
      assertEquals(response.status, 401);
      // Nothing is claimed either: an unverified request leaves no receipt to
      // reconcile, because Bakery cannot say it received anything it cannot verify.
      const receipts = await fixture.pgDatabase.query<{ n: string }>(
        "select count(*)::text as n from bakery.slack_request_receipts",
      );
      assertEquals(receipts.rows[0]!.n, "0");
    } finally {
      await cleanUp(fixture, app);
    }
  });
});

Deno.test("with no Slack app configured the endpoint is absent, not open", async () => {
  await withWorkerFixture(async (fixture) => {
    const keyConfig = await freshKey();
    const press = await signedPress({
      appId: "A0AAAAAAAA",
      teamId: teamId(),
      userId: userId(),
      decisionId: crypto.randomUUID(),
      action: "approve",
    });
    const lines: string[] = [];
    const app = new Hono();
    mountSlackInteractionsRoute(app as never, {
      database: fixture.pgDatabase,
      secretsKey: keyConfig,
      publicBaseUrl: "http://localhost",
      log: (line) => lines.push(line),
    });
    const response = await app.request(SLACK_INTERACTIONS_PATH, {
      method: "POST",
      headers: press.headers,
      body: press.body,
    });
    // No settings row means no route to press: 404 rather than verifying against a
    // secret that does not exist, and a log line naming the table to fill.
    assertEquals(response.status, 404);
    assert((await response.text()).length > 0);
    assertEquals(lines.length, 1);
    assert(lines[0]!.includes("slack_app_settings"));
  });
});
