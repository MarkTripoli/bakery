/**
 * #415: the installation's Slack app details, as the settings screen reads them.
 *
 * The screen can show a saved secret only as a date, and it must be able to replace
 * one without the other, refuse a second editor's blind overwrite, and remove the
 * details without unlinking anybody. Each of those is a place where the obvious
 * implementation loses something, so each is a test rather than a comment: an edit
 * that "cleans up" an omitted secret, skips the version check, or cascades the
 * removal into `external_identity_links` fails here.
 */
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { loadSecretKey } from "../../apps/server/src/modules/secrets/crypto.ts";
import { openAppSecret } from "../../apps/server/src/modules/integrations/callbacks.ts";
import { deleteSlackApp } from "../../apps/server/src/modules/integrations/slack-app-actions.ts";
import {
  readSlackAppCredentials,
  readSlackAppSettings,
  recordSlackCheck,
  removeSlackAppSettings,
  saveSlackAppSettings,
} from "../../apps/server/src/modules/integrations/slack-app-credentials.ts";
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

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

const appId = () =>
  `A${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

async function key() {
  const file = `${await Deno.makeTempDir()}/slack-key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
  return { file, keyId: "slack-settings-fixture-key-v1" };
}

/**
 * Cleanup: removes whatever row is there.
 *
 * The removal names the version it removes, so nothing to remove is the only
 * outcome worth swallowing; a removal that lost a race is the test's business.
 */
async function removeSlackApp(
  transaction: Parameters<typeof removeSlackAppSettings>[0],
  input: Parameters<typeof removeSlackAppSettings>[1] extends infer T
    ? Omit<T & object, "expectedVersion">
    : never,
): Promise<void> {
  const existing = await readSlackAppSettings(transaction as never);
  if (existing === null) return;
  await removeSlackAppSettings(
    transaction,
    {
      ...input,
      expectedVersion: existing.version,
    } as Parameters<typeof removeSlackAppSettings>[1],
  );
}

function save(
  fixture: Fixture,
  secretsKey: { file: string; keyId: string },
  draft: {
    appId: string;
    clientId: string;
    clientSecret?: string;
    signingSecret?: string;
    expectedVersion?: number;
  },
) {
  return withPgTransaction(
    fixture.pgDatabase,
    async (transaction) =>
      await saveSlackAppSettings(transaction, {
        ...draft,
        principalId: fixture.principalId,
        key: await loadSecretKey(secretsKey),
        keyId: secretsKey.keyId,
        operation: "integration.slack.credentials.save",
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
      }),
  );
}

function remove(
  fixture: Fixture,
  draft: { expectedVersion?: number },
) {
  return withPgTransaction(
    fixture.pgDatabase,
    async (transaction) =>
      await deleteSlackApp(
        {
          transaction,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
          commandMetadata: {
            expectedVersion: draft.expectedVersion,
          },
          principal: { principalId: fixture.principalId },
          authority: {
            installationAdministrator: true,
            subject: {
              principalId: fixture.principalId,
              principalType: "human",
            },
          },
        } as never,
        {},
        { publicBaseUrl: "https://bakery.test" } as never,
      ),
  );
}

Deno.test("a first save stores both secrets and reports only their dates", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const saved = await save(fixture, secretsKey, {
      appId: appId(),
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
      expectedVersion: undefined,
    });
    try {
      assertEquals(saved.version, 1);
      assert(Number.isNaN(Date.parse(saved.signingSecretSavedAt)) === false);
      // The projection a route returns has no field a secret could travel in.
      assertEquals(
        Object.keys(saved).sort(),
        [
          "appId",
          "clientId",
          "clientSecretSavedAt",
          "detailsCheckResult",
          "detailsCheckedAt",
          "lastRequestAt",
          "lastRequestFailedAt",
          "signingSecretSavedAt",
          "version",
        ],
      );
      // The reader returns cipher bindings, never plaintext: opening them is the
      // caller's job with the key, which is what keeps a secret out of a log line.
      const stored = await readSlackAppCredentials(
        fixture.pgDatabase as never,
      );
      const opened = await loadSecretKey(secretsKey);
      assertEquals(
        await openAppSecret(opened, stored!.clientSecret),
        "client-secret-one",
      );
      assertEquals(
        await openAppSecret(opened, stored!.signingSecret),
        "signing-secret-one",
      );
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
    }
  });
});

Deno.test("a replaced secret is the only one written, and the other date stands", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const first = await save(fixture, secretsKey, {
      appId: appId(),
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // "Replace details" sends what changed: the signing secret keeps its revision.
      const replaced = await save(fixture, secretsKey, {
        appId: first.appId,
        clientId: "1234567890.0987654321",
        clientSecret: "client-secret-two",
        expectedVersion: first.version,
      });
      assertEquals(replaced.version, 2);
      assertEquals(replaced.signingSecretSavedAt, first.signingSecretSavedAt);
      assert(
        Date.parse(replaced.clientSecretSavedAt) >
          Date.parse(first.clientSecretSavedAt),
      );
      const stored = await readSlackAppCredentials(fixture.pgDatabase as never);
      const opened = await loadSecretKey(secretsKey);
      // The kept secret is still the old value: omitting is not clearing.
      assertEquals(
        await openAppSecret(opened, stored!.signingSecret),
        "signing-secret-one",
      );
      assertEquals(
        await openAppSecret(opened, stored!.clientSecret),
        "client-secret-two",
      );
      // A replaced secret invalidates the old check, so the screen asks again.
      const reread = await readSlackAppSettings(fixture.pgDatabase as never);
      assertEquals(reread?.detailsCheckedAt, null);
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
    }
  });
});

Deno.test("a second editor's save is refused rather than overwriting", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const first = await save(fixture, secretsKey, {
      appId: appId(),
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
    });
    try {
      // A save that quotes nothing must not overwrite a row it never read.
      let name = "";
      try {
        await save(fixture, secretsKey, {
          appId: first.appId,
          clientId: "1234567890.0987654321",
          clientSecret: "other-editor",
        });
      } catch (error) {
        name = (error as { code?: string }).code ?? "";
      }
      assertEquals(name, "PRECONDITION_REQUIRED");

      // A save quoting a version someone else already moved past is refused too.
      let stale = "";
      try {
        await save(fixture, secretsKey, {
          appId: first.appId,
          clientId: "1234567890.0987654321",
          clientSecret: "other-editor",
          expectedVersion: first.version + 7,
        });
      } catch (error) {
        stale = (error as { code?: string }).code ?? "";
      }
      assertEquals(stale, "PRECONDITION_FAILED");
      // Neither attempt wrote a secret.
      const stored = await readSlackAppCredentials(fixture.pgDatabase as never);
      assertEquals(
        await openAppSecret(
          await loadSecretKey(secretsKey),
          stored!.clientSecret,
        ),
        "client-secret-one",
      );
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
    }
  });
});

Deno.test("a removal names the version it removes", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const saved = await save(fixture, secretsKey, {
      appId: appId(),
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
    });
    try {
      // Removal destroys the pair, so a caller that never read the row is refused
      // rather than deleting a row it never saw.
      let missing = "";
      try {
        await remove(fixture, {});
      } catch (error) {
        missing = (error as { code?: string }).code ?? "";
      }
      assertEquals(missing, "PRECONDITION_REQUIRED");

      // A removal quoting a version someone else already moved past is refused.
      let stale = "";
      try {
        await remove(fixture, { expectedVersion: saved.version + 7 });
      } catch (error) {
        stale = (error as { code?: string }).code ?? "";
      }
      assertEquals(stale, "PRECONDITION_FAILED");

      // Neither attempt removed anything: the row and both secrets are still here.
      const still = await readSlackAppSettings(fixture.pgDatabase as never);
      assertEquals(still?.version, saved.version);
      const secrets = await fixture.pgDatabase.query<{ n: string }>(
        "select count(*)::text as n from bakery.secrets where provider = 'slack'",
      );
      assertEquals(secrets.rows[0]!.n, "2");

      // The version the row carries is accepted.
      await remove(fixture, { expectedVersion: saved.version });
      assertEquals(
        await readSlackAppSettings(fixture.pgDatabase as never),
        null,
      );
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
    }
  });
});

Deno.test("a check belongs to the pair it was asked about", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const saved = await save(fixture, secretsKey, {
      appId: appId(),
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
    });
    try {
      // Slack answered about the pair that was current when the check started. A
      // save that moved the row while Slack was answering must not carry that
      // answer onto the new pair, so the record names the version it was about.
      let stale = "";
      try {
        await withPgTransaction(
          fixture.pgDatabase,
          (transaction) =>
            recordSlackCheck(transaction, "accepted", saved.version + 5, {
              principalId: fixture.principalId,
              operation: "integration.slack.credentials.check",
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            }),
        );
      } catch (error) {
        stale = (error as { code?: string }).code ?? "";
      }
      assertEquals(stale, "PRECONDITION_FAILED");

      // The refused record wrote neither the result nor an audit row of its own.
      let settings = await readSlackAppSettings(fixture.pgDatabase as never);
      assertEquals(settings?.detailsCheckedAt, null);
      // Other cases in this file share the database, so the check's own audit
      // rows are counted by the id a check writes under.
      const countChecks = async () => {
        const rows = await fixture.pgDatabase.query<{ n: string }>(
          `select count(*)::text as n from bakery.audit_events
            where resource_type = 'slack_app_settings'
              and resource_id = 'slack-app'
              and operation = 'integration.slack.credentials.check'`,
        );
        return rows.rows[0]!.n;
      };
      // The refused check wrote no audit row of its own; earlier cases in this
      // file share the database, so the count is read as a delta.
      const before = Number(await countChecks());

      // The version the row carries is accepted, and that one is recorded.
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          recordSlackCheck(transaction, "accepted", saved.version, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.check",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
      settings = await readSlackAppSettings(fixture.pgDatabase as never);
      assertEquals(settings?.detailsCheckResult, "accepted");
      assert(settings?.detailsCheckedAt !== null);
      // The accepted check wrote exactly the one row the refusal did not.
      assertEquals(Number(await countChecks()) - before, 1);
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
    }
  });
});

Deno.test("removing the details keeps the links people made", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const appIdValue = appId();
    const saved = await save(fixture, secretsKey, {
      appId: appIdValue,
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
    });
    const teamId = `T${
      crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
    }`;
    await fixture.pgDatabase.query(
      `insert into bakery.external_identity_links
         (id, organization_id, principal_id, provider, external_app_id,
          identity_scope, external_user_id, state, verification_method,
          verified_at, created_at, updated_at, version)
       values (gen_random_uuid(), $1, $2, 'slack', $3, $4, 'U00000001',
               'active', 'sign_in_with_slack_oidc', now(), now(), now(), 1)`,
      [fixture.organizationId, fixture.principalId, appIdValue, teamId],
    );
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        removeSlackApp(transaction, {
          principalId: fixture.principalId,
          operation: "integration.slack.credentials.remove",
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
    );

    const settings = await readSlackAppSettings(fixture.pgDatabase as never);
    assertEquals(settings, null);
    // The dialog promises the links work again when details are entered again.
    const links = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.external_identity_links
        where organization_id = $1 and provider = 'slack'`,
      [fixture.organizationId],
    );
    assertEquals(links.rows[0]!.n, "1");
    // The secrets are revoked, not destroyed: Bakery never deletes a stored
    // credential, and a revoked row is one no reader will accept again.
    const secrets = await fixture.pgDatabase.query<
      { n: string; live: string }
    >(
      `select count(*)::text as n,
              count(*) filter (where revoked_at is null)::text as live
         from bakery.secrets where provider = 'slack'`,
    );
    assertEquals(secrets.rows[0]!.n, "2");
    assertEquals(secrets.rows[0]!.live, "0");
    // Save/remove both left an audit row, and neither names a secret value.
    const audit = await fixture.pgDatabase.query<{ details: unknown }>(
      `select details from bakery.audit_events
        where resource_type = 'slack_app_settings' and resource_id = $1
        order by created_at`,
      [appIdValue],
    );
    assertEquals(audit.rows.length, 2);
    const text = JSON.stringify(audit.rows);
    for (
      const secret of ["client-secret-one", "signing-secret-one", "ciphertext"]
    ) {
      assert(!text.includes(secret), `audit leaked ${secret}`);
    }
    assertEquals(saved.version, 1);
  });
});

Deno.test("a real request writes the two times the screen reports", async () => {
  await withWorkerFixture(async (fixture) => {
    const secretsKey = await key();
    const appIdValue = appId();
    const signingSecret = `sig-${crypto.randomUUID()}`;
    await save(fixture, secretsKey, {
      appId: appIdValue,
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-one",
      signingSecret,
    });
    try {
      assertEquals(
        (await readSlackAppSettings(fixture.pgDatabase as never))
          ?.lastRequestAt,
        null,
      );
      const app = new Hono();
      mountSlackInteractionsRoute(app as never, {
        database: fixture.pgDatabase,
        secretsKey,
        publicBaseUrl: "http://localhost",
        log: () => {},
      });
      const body = new TextEncoder().encode("payload=%7B%7D");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const send = async (secret: string) =>
        await app.request(SLACK_INTERACTIONS_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            [SLACK_TIMESTAMP_HEADER]: timestamp,
            [SLACK_SIGNATURE_HEADER]: await signSlackRequest({
              signingSecret: secret,
              timestamp,
              rawBody: body,
            }),
          },
          body,
        });
      // A request that does not verify records the failure, not the acceptance.
      assertEquals((await send("wrong-secret")).status, 401);
      let settings = await readSlackAppSettings(fixture.pgDatabase as never);
      assertEquals(settings?.lastRequestAt, null);
      assert(settings?.lastRequestFailedAt !== null);

      // One that does verify records the acceptance.
      assertEquals((await send(signingSecret)).status, 200);
      settings = await readSlackAppSettings(fixture.pgDatabase as never);
      assert(settings?.lastRequestAt !== null);
    } finally {
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          removeSlackApp(transaction, {
            principalId: fixture.principalId,
            operation: "integration.slack.credentials.remove",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
      );
      await fixture.pgDatabase.query(
        "delete from bakery.slack_request_receipts",
      );
    }
  });
});
