import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Inngest } from "inngest";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  commitSlackReceipt,
  findSlackInstallation,
  registerSlackInstallation,
  sweepExpiredSlackReceipts,
} from "../../apps/server/src/modules/integrations/slack-receipts.ts";
import type { SlackInstallation } from "../../apps/server/src/modules/integrations/slack-scope.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import {
  sealInstallationSecret,
  writeInstallationSecretVersion,
} from "../../apps/server/src/modules/secrets/installation-secrets.ts";
import { createIntegrationIntakeRetention } from "../../apps/server/src/modules/integrations/intake-retention.ts";

import { linkSlackIdentity } from "../../apps/server/src/modules/integrations/slack-identity-links.ts";
type Fixture = Awaited<ReturnType<typeof openInstallationFixture>>;

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await f.finish();
  }
}

async function withIngressFixture(run: (f: Fixture) => Promise<void>) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-slack-intake-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const f = await openInstallationFixture(true, {
    secretsKey: { file, keyId: "slack-intake-fixture-key-v1" },
  });
  try {
    await run(f);
  } finally {
    try {
      const signingSecrets = await f.pgDatabase.query<{
        signing_secret_id: string | null;
      }>(
        `select signing_secret_id
           from bakery.slack_installations
          where organization_id = $1`,
        [f.organizationId],
      );
      await f.pgDatabase.query(
        "delete from bakery.slack_installations where organization_id = $1",
        [f.organizationId],
      );
      const secretIds = signingSecrets.rows.flatMap(({ signing_secret_id }) =>
        signing_secret_id === null ? [] : [signing_secret_id]
      );
      if (secretIds.length > 0) {
        await f.pgDatabase.query(
          "update bakery.secrets set active_version_id = null where id = any($1::uuid[])",
          [secretIds],
        );
        await f.pgDatabase.query(
          "delete from bakery.secret_versions where secret_id = any($1::uuid[])",
          [secretIds],
        );
        await f.pgDatabase.query(
          "delete from bakery.secrets where id = any($1::uuid[])",
          [secretIds],
        );
      }
      await f.finish();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
}

const suffix = () => crypto.randomUUID().replaceAll("-", "").toUpperCase();

function installation(): SlackInstallation {
  const id = suffix();
  return {
    kind: "workspace",
    appId: `A${id.slice(0, 10)}`,
    teamId: `T${id.slice(10, 20)}`,
    botUserId: `U${id.slice(20, 30)}`,
    scopes: ["chat:write"],
  };
}

const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const eventId = () => `Ev${suffix().slice(0, 10)}`;

const register = (
  f: Fixture,
  organizationId: string,
  value: SlackInstallation,
) =>
  withPgTransaction(
    f.runtimePgDatabase,
    (tx) =>
      registerSlackInstallation(tx, { organizationId, installation: value }),
  );

async function anotherOrganization(f: Fixture): Promise<string> {
  const id = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
     values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
    [id, `other-${id}`],
  );
  return id;
}

async function cleanup(f: Fixture, organizationId: string) {
  await f.pgDatabase.query(
    "delete from bakery.organizations where id = $1",
    [organizationId],
  );
}

async function registerWithSecret(
  f: Fixture,
  value: SlackInstallation,
  signingSecret: string,
  organizationId = f.organizationId,
) {
  const sealed = await sealInstallationSecret(
    f.config.secretsKey,
    null,
    signingSecret,
  );
  return await withPgTransaction(f.runtimePgDatabase, async (transaction) => {
    await writeInstallationSecretVersion(transaction, sealed, {
      name: `Slack ${value.appId}`,
      provider: "slack",
      principalId: f.adminId,
    });
    return await registerSlackInstallation(transaction, {
      organizationId,
      installation: value,
      signingSecretId: sealed.secretId,
    });
  });
}

async function slackSignature(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    ),
  );
  return `v0=${
    [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

Deno.test("the running server ignores an unreadable unrelated app secret", async () => {
  await withIngressFixture(async (f) => {
    const value = installation();
    const signingSecret = `secret-${suffix()}`;
    const registered = await registerWithSecret(f, value, signingSecret);
    assert(registered.ok);
    const linked = await withPgTransaction(
      f.runtimePgDatabase,
      (transaction) =>
        linkSlackIdentity(transaction, {
          organizationId: f.organizationId,
          principalId: f.adminId,
          identity: {
            appId: value.appId,
            teamId: value.teamId,
            userId: "U1AUTHOR",
          },
          verifiedAt: new Date(),
        }),
    );
    assert(linked.ok);
    const otherOrganizationId = await anotherOrganization(f);
    let unrelatedSecretId: string | null = null;
    try {
      const unrelated = await registerWithSecret(
        f,
        installation(),
        `unreadable-${suffix()}`,
        otherOrganizationId,
      );
      assert(unrelated.ok);
      unrelatedSecretId = unrelated.installation.signingSecretId;
      assert(unrelatedSecretId !== null);
      await f.pgDatabase.query(
        `update bakery.secret_versions
            set ciphertext = $2
          where secret_id = $1`,
        [unrelatedSecretId, new Uint8Array([0])],
      );
      const acceptedEventId = eventId();
      const body = JSON.stringify({
        type: "event_callback",
        event_id: acceptedEventId,
        api_app_id: value.appId,
        team_id: value.teamId,
        authorizations: [{
          team_id: value.teamId,
          user_id: value.botUserId,
        }],
        event: {
          type: "app_mention",
          channel: "C1CHANNEL",
          user: "U1AUTHOR",
          ts: "1.1",
          text: "hello",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await f.app.fetch(
        new Request(`${f.config.publicBaseUrl}/v1/webhooks/slack/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": await slackSignature(
              timestamp,
              body,
              signingSecret,
            ),
          },
          body,
        }),
      );
      assertEquals(response.status, 200);
      const result = await response.json() as {
        disposition: string;
        receiptId: string | null;
      };
      assertEquals(result.disposition, "accepted");
      assert(typeof result.receiptId === "string");
      const receipts = await f.pgDatabase.query<{
        id: string;
        app_id: string;
        outcome: string;
        status: string;
        processed_at: Date | null;
      }>(
        `select id, app_id, outcome, status, processed_at
           from bakery.slack_event_receipts where id = $1`,
        [result.receiptId],
      );
      assertEquals(receipts.rows[0]?.id, result.receiptId);
      assertEquals(receipts.rows[0]?.app_id, value.appId);
      assertEquals(receipts.rows[0]?.outcome, "accepted");
      assertEquals(receipts.rows[0]?.status, "completed");
      assert(receipts.rows[0]?.processed_at instanceof Date);
      const work = await f.pgDatabase.query<{
        body: string;
        conversation_id: string;
        message_type: string;
        status: string;
      }>(
        `select message.body, message.message_type,
                binding.conversation_id, turn.status
           from bakery.slack_thread_bindings binding
           join bakery.messages message
             on message.organization_id = binding.organization_id
            and message.conversation_id = binding.conversation_id
           join bakery.conversation_turns turn
             on turn.organization_id = message.organization_id
            and turn.trigger_message_id = message.id
          where binding.installation_id = $1
            and message.client_message_id = $2`,
        [
          registered.installation.installationId,
          `slack:${value.appId}:${acceptedEventId}`,
        ],
      );
      assertEquals(work.rows.length, 1);
      assertEquals(work.rows[0]?.body, "hello");
      assertEquals(work.rows[0]?.message_type, "human");
      assertEquals(work.rows[0]?.status, "queued");
    } finally {
      await cleanup(f, otherOrganizationId);
      if (unrelatedSecretId !== null) {
        await f.pgDatabase.query(
          "update bakery.secrets set active_version_id = null where id = $1",
          [unrelatedSecretId],
        );
        await f.pgDatabase.query(
          "delete from bakery.secret_versions where secret_id = $1",
          [unrelatedSecretId],
        );
        await f.pgDatabase.query(
          "delete from bakery.secrets where id = $1",
          [unrelatedSecretId],
        );
      }
    }
  });
});

Deno.test("the Slack events ingress refuses a body over 256 KiB", async () => {
  await withIngressFixture(async (f) => {
    const response = await f.app.fetch(
      new Request(`${f.config.publicBaseUrl}/v1/webhooks/slack/events`, {
        method: "POST",
        headers: { "content-length": "262145" },
        body: "x",
      }),
    );
    assertEquals(response.status, 413);
  });
});

Deno.test("an installation belongs to one organization, and registering it again changes nothing", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const first = await register(f, f.organizationId, value);
    assert(first.ok && first.created);
    const again = await register(f, f.organizationId, value);
    assert(again.ok && !again.created);
    assertEquals(
      again.ok && again.installation.installationId,
      first.ok && first.installation.installationId,
    );
    const found = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) => findSlackInstallation(tx, value),
    );
    assertEquals(found?.organizationId, f.organizationId);
    assertEquals(found?.botUserId, value.botUserId);
    assertEquals(found?.signingSecretId, null);
  });
});

Deno.test("a workspace cannot serve a second organization, and the first keeps it", async () => {
  await withFixture(async (f) => {
    const other = await anotherOrganization(f);
    try {
      const value = installation();
      assert((await register(f, f.organizationId, value)).ok);
      assertEquals(await register(f, other, value), {
        ok: false,
        reason: "claimed_elsewhere",
      });
      const found = await withPgTransaction(
        f.runtimePgDatabase,
        (tx) => findSlackInstallation(tx, value),
      );
      assertEquals(found?.organizationId, f.organizationId);
    } finally {
      await cleanup(f, other);
    }
  });
});

Deno.test("malformed ids are refused before the database is touched", async () => {
  await withFixture(async (f) => {
    const bad: SlackInstallation[] = [
      { ...installation(), appId: "not-an-app" },
      { ...installation(), teamId: "x" },
      { ...installation(), botUserId: "" },
      { ...installation(), enterpriseId: "T123" },
    ];
    for (const value of bad) {
      assertEquals(await register(f, f.organizationId, value), {
        ok: false,
        reason: "malformed",
      });
    }
    assertEquals(
      await register(f, "not-a-uuid", installation()),
      { ok: false, reason: "malformed" },
    );
    const found = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) => findSlackInstallation(tx, { appId: "x", teamId: "y" }),
    );
    assertEquals(found, null);
  });
});

Deno.test("a disabled installation, like an uninstalled workspace, admits nothing", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    await f.pgDatabase.query(
      "update bakery.slack_installations set status = 'disabled' where id = $1",
      [made.installation.installationId],
    );
    const found = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) => findSlackInstallation(tx, value),
    );
    assertEquals(found, null);
  });
});

Deno.test("an installation disabled after lookup cannot commit plaintext work", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const active = await withPgTransaction(
      f.runtimePgDatabase,
      (tx) => findSlackInstallation(tx, value),
    );
    assert(active !== null);
    await f.pgDatabase.query(
      "update bakery.slack_installations set status = 'disabled' where id = $1",
      [made.installation.installationId],
    );
    const event = eventId();
    assertEquals(
      await commit(
        f,
        value,
        made.installation.installationId,
        event,
        digest("9"),
      ),
      { kind: "inactive" },
    );
    const receipts = await f.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.slack_event_receipts where event_id = $1`,
      [event],
    );
    assertEquals(receipts.rows[0]?.count, "0");
  });
});

async function commit(
  f: Fixture,
  value: SlackInstallation,
  installationId: string,
  event: string,
  payloadDigest: string,
) {
  return await withPgTransaction(
    f.runtimePgDatabase,
    (tx) =>
      commitSlackReceipt(tx, {
        installationId,
        appId: value.appId,
        eventId: event,
        payloadDigest,
        decision: {
          kind: "ignore",
          reason: "unsupported_event",
        },
        now: new Date(),
      }),
  );
}

Deno.test("a receipt is recorded once; the same bytes again are a duplicate, different bytes a conflict", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const id = made.installation.installationId;
    const event = eventId();
    const recorded = await commit(f, value, id, event, digest("a"));
    assert(recorded.kind === "recorded");
    const receiptId = recorded.receiptId;
    assertEquals(await commit(f, value, id, event, digest("a")), {
      kind: "duplicate",
      receiptId,
      outcome: "ignored",
    });
    assertEquals(await commit(f, value, id, event, digest("b")), {
      kind: "conflict",
    });
    assertEquals(
      await commit(f, value, id, "no spaces!", digest("a")),
      { kind: "malformed" },
    );
    assertEquals(await commit(f, value, id, eventId(), "short"), {
      kind: "malformed",
    });
  });
});

Deno.test("two deliveries of one event racing: exactly one records", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const id = made.installation.installationId;
    const event = eventId();
    const results = await Promise.all(
      Array.from(
        { length: 6 },
        () => commit(f, value, id, event, digest("c")),
      ),
    );
    assertEquals(results.filter((r) => r.kind === "recorded").length, 1);
    assertEquals(results.filter((r) => r.kind === "duplicate").length, 5);
  });
});

Deno.test("an ignored event leaves a digest-only receipt", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    await commit(
      f,
      value,
      made.installation.installationId,
      eventId(),
      digest("d"),
    );
    const columns = (await f.pgDatabase.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'bakery' and table_name = 'slack_event_receipts'`,
    )).rows.map((row) => row.column_name).sort();
    assertEquals(columns, [
      "app_id",
      "event_id",
      "expires_at",
      "id",
      "installation_id",
      "outcome",
      "payload_digest",
      "processed_at",
      "received_at",
      "status",
    ]);
  });
});

Deno.test("retention drains terminal receipts while preserving pending work", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const installationId = made.installation.installationId;
    const expiredIds = Array.from(
      { length: 501 },
      () => crypto.randomUUID(),
    );
    const expiredEvents = expiredIds.map((_, index) => `EvExpired${index}`);
    await f.pgDatabase.query(
      `insert into bakery.slack_event_receipts (
         id, app_id, event_id, installation_id, payload_digest, outcome,
         status, received_at, processed_at, expires_at)
       select expired.id, $1, expired.event_id, $2, $3, 'ignored',
              'ignored', now() - interval '8 days',
              now() - interval '8 days', now() - interval '1 minute'
         from unnest($4::uuid[], $5::text[])
           as expired(id, event_id)`,
      [
        value.appId,
        installationId,
        digest("e"),
        expiredIds,
        expiredEvents,
      ],
    );
    const completed = eventId();
    const pending = eventId();
    const fresh = eventId();
    await f.pgDatabase.query(
      `insert into bakery.slack_event_receipts (
         id, app_id, event_id, installation_id, payload_digest, outcome,
         status, received_at, processed_at, expires_at)
       values
         ($1, $2, $3, $4, $5, 'accepted', 'completed',
          now() - interval '8 days', now() - interval '8 days',
          now() - interval '1 minute'),
         ($6, $2, $7, $4, $5, 'accepted', 'pending',
          now() - interval '8 days', null, now() - interval '1 minute')`,
      [
        crypto.randomUUID(),
        value.appId,
        completed,
        installationId,
        digest("f"),
        crypto.randomUUID(),
        pending,
      ],
    );
    await commit(f, value, installationId, fresh, digest("0"));
    assertEquals(
      await sweepExpiredSlackReceipts(f.runtimePgDatabase, {
        now: new Date(),
        limit: 500,
        maxBatches: 100,
      }),
      { deleted: 502, batches: 2 },
    );
    const remaining = await f.pgDatabase.query<{
      event_id: string;
      outcome: string;
      status: string;
    }>(
      `select event_id, outcome, status
         from bakery.slack_event_receipts
        where installation_id = $1 order by event_id`,
      [installationId],
    );
    assertEquals(
      remaining.rows,
      [
        { event_id: pending, outcome: "accepted", status: "pending" },
        { event_id: fresh, outcome: "ignored", status: "ignored" },
      ].sort((left, right) => left.event_id.localeCompare(right.event_id)),
    );
  });
});
Deno.test("the production retention function sweeps expired Slack receipts", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const installationId = made.installation.installationId;
    const old = eventId();
    const fresh = eventId();
    await commit(f, value, installationId, old, digest("7"));
    await commit(f, value, installationId, fresh, digest("8"));
    await f.pgDatabase.query(
      "update bakery.slack_event_receipts set expires_at = now() - interval '1 minute' where event_id = $1",
      [old],
    );
    let handler:
      | ((context: { step: unknown }) => Promise<unknown>)
      | undefined;
    const client = {
      createFunction(_: unknown, body: typeof handler) {
        handler = body;
        return {};
      },
    } as unknown as Inngest;
    createIntegrationIntakeRetention({
      client,
      database: f.runtimePgDatabase,
    });
    const steps: string[] = [];
    const outcome = await handler!({
      step: {
        run: async <T>(id: string, work: () => Promise<T>) => {
          steps.push(id);
          return await work();
        },
      },
    });
    assertEquals(outcome, {
      inbound: { deleted: 0, batches: 0 },
      slack: { deleted: 1, batches: 1 },
    });
    assertEquals(steps, ["sweep-expired-intake-receipts"]);
    const remaining = await f.pgDatabase.query<{ event_id: string }>(
      `select event_id from bakery.slack_event_receipts
        where installation_id = $1 order by event_id`,
      [installationId],
    );
    assertEquals(remaining.rows, [{ event_id: fresh }]);
  });
});

Deno.test("the application role cannot rewrite what an installation or a receipt is bound to", async () => {
  await withFixture(async (f) => {
    const value = installation();
    const made = await register(f, f.organizationId, value);
    assert(made.ok);
    const id = made.installation.installationId;
    await commit(f, value, id, eventId(), digest("1"));
    const denied = [
      "update bakery.slack_installations set team_id = 'T0000000009'",
      "update bakery.slack_installations set organization_id = organization_id",
      "update bakery.slack_installations set bot_user_id = 'U0000000009'",
      "delete from bakery.slack_installations",
      "update bakery.slack_event_receipts set payload_digest = payload_digest",
      "update bakery.slack_event_receipts set installation_id = installation_id",
    ];
    for (const statement of denied) {
      await assertRejects(
        () => f.runtimePgDatabase.query(statement),
        Error,
        "permission denied",
        statement,
      );
    }
    const allowed = await f.runtimePgDatabase.query(
      "update bakery.slack_installations set status = status, updated_at = now(), version = version + 1 where id = $1",
      [id],
    );
    assertEquals(allowed.rowCount, 1);
  });
});
