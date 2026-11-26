import { assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  sealInstallationSecret,
  writeInstallationSecretVersion,
} from "../../apps/server/src/modules/secrets/installation-secrets.ts";
import {
  decodeSecretSlots,
  encodeSecretSlots,
  postgresStoredSlotReader,
} from "../../apps/server/src/modules/integrations/provider-credential-port.ts";
import type { CredentialRequest } from "../../apps/server/src/modules/catalog/integration-gate-broker.ts";
import { createInstallationCredentialPort } from "../../apps/server/src/modules/integrations/credential-port.ts";
import type { AppCredentials } from "../../apps/server/src/modules/integrations/callbacks.ts";
import type { TokenTarget } from "../../apps/server/src/modules/integrations/token-broker.ts";
import { seedRigIntegration } from "../helpers/external-effects.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";

async function keyFile() {
  const directory = await Deno.makeTempDir({ prefix: "bakery-slots-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  return { directory, secretsKey: { file, keyId: "provider-slots-key-v1" } };
}

Deno.test("an installation's sealed secret slots are read only for its enabled connection in its organization", async () => {
  const fixture = await openSocketFixture();
  const { directory, secretsKey } = await keyFile();
  let sealedSecretId: string | null = null;
  try {
    const rig = {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      connectionId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
    };
    await seedRigIntegration(fixture.pgDatabase, rig);
    const installId = await withPgTransaction(
      fixture.pgDatabase,
      async (transaction) => {
        const sealed = await sealInstallationSecret(
          secretsKey,
          null,
          encodeSecretSlots({ access_token: "xoxb-sealed" }),
        );
        sealedSecretId = sealed.secretId;
        await writeInstallationSecretVersion(transaction, sealed, {
          name: "provider-slots",
          provider: "github",
          principalId: fixture.principalId,
        });
        const updated = await transaction.query<{ id: string }>(
          `update bakery.integration_installations installation
              set credential_secret_id = $2
             from bakery.integration_connections connection
            where connection.id = $1
              and installation.id = connection.installation_id
          returning installation.id`,
          [rig.connectionId, sealed.secretId],
        );
        return updated.rows[0]!.id;
      },
    );
    const raw = await withPgTransaction(
      fixture.pgDatabase,
      async (transaction) =>
        (await transaction.query<{ ciphertext: Uint8Array }>(
          `select version.ciphertext from bakery.secret_versions version
             join bakery.integration_installations installation
               on installation.credential_secret_id = version.secret_id
            where installation.id = $1`,
          [installId],
        )).rows[0]!.ciphertext,
    );
    assertEquals(
      new TextDecoder().decode(raw).includes("xoxb-sealed"),
      false,
      "the slot is encrypted at rest",
    );
    const read = postgresStoredSlotReader(fixture.pgDatabase, secretsKey);
    const request: CredentialRequest = {
      organizationId: rig.organizationId,
      connectionId: rig.connectionId,
      resourceId: rig.resourceId,
      profileId: "mockchat-bot",
      providerPermissions: {},
      generation: 0,
      subject: { installId, resourceKind: "mockchat.channel" },
    };
    const stored = await read(request);
    assertEquals(
      new TextDecoder().decode(
        decodeSecretSlots(stored!, ["access_token"]).access_token,
      ),
      "xoxb-sealed",
    );
    assertEquals(
      await read({ ...request, organizationId: crypto.randomUUID() }),
      null,
    );
    assertEquals(
      await read({
        ...request,
        subject: { ...request.subject, installId: crypto.randomUUID() },
      }),
      null,
    );
    await fixture.pgDatabase.query(
      "update bakery.integration_connections set status = 'disabled' where id = $1",
      [rig.connectionId],
    );
    assertEquals(await read(request), null);
  } finally {
    if (sealedSecretId !== null) {
      await fixture.pgDatabase.query(
        "update bakery.integration_installations set credential_secret_id = null where credential_secret_id = $1",
        [sealedSecretId],
      );
      await fixture.pgDatabase.query(
        "update bakery.secrets set active_version_id = null where id = $1",
        [sealedSecretId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.secret_versions where secret_id = $1",
        [sealedSecretId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.secrets where id = $1",
        [
          sealedSecretId,
        ],
      );
    }
    await Deno.remove(directory, { recursive: true });
    await fixture.close();
  }
});

Deno.test("a GitHub installation token is minted from the real connection and installation rows", async () => {
  const fixture = await openSocketFixture();
  try {
    const rig = {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
      connectionId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
    };
    await seedRigIntegration(fixture.pgDatabase, rig);
    const installId = (await fixture.pgDatabase.query<{ id: string }>(
      "select installation_id as id from bakery.integration_connections where id = $1",
      [rig.connectionId],
    )).rows[0]!.id;
    const targets: TokenTarget[] = [];
    const port = createInstallationCredentialPort({
      database: fixture.pgDatabase,
      broker: {
        token: (target: TokenTarget) => {
          targets.push(target);
          return Promise.resolve({
            kind: "minted" as const,
            token: "ghs_rows",
            expiresAt: Date.now() + 3_600_000,
            permissions: { issues: "write" },
            repositoryIds: [1234],
          });
        },
        generation: () => 0,
      } as never,
      readAppCredentials: () =>
        Promise.resolve(
          { appId: 42, privateKey: "key" } as unknown as AppCredentials,
        ),
      generationOf: () => 0,
    });
    const credential = await port.resolve({
      organizationId: rig.organizationId,
      connectionId: rig.connectionId,
      resourceId: rig.resourceId,
      profileId: "github-app",
      providerPermissions: { issues: "write" },
      generation: 0,
      subject: {
        installId,
        resourceKind: "github.repository",
        repositoryId: "1234",
      },
    });
    assertEquals(credential, "ghs_rows");
    assertEquals(targets[0]?.status, "enabled");
    assertEquals(targets[0]?.installationStatus, "enabled");
  } finally {
    await fixture.close();
  }
});
