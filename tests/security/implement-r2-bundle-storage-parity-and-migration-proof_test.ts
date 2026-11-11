import { createStackServices } from "../../scripts/run-stack.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createSkillS3Client,
  DatabaseSkillObjectStore,
} from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { S3SkillObjectStore } from "../../apps/server/src/modules/catalog/s3-store.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { SkillFileStoreError } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { skillObjectKey } from "../../apps/server/src/modules/catalog/identity.ts";
import {
  decryptInstallationSecret,
  decryptSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  legacyStorageEnvironment,
  legacyStoragePrefixes,
} from "../helpers/legacy-storage-environment.ts";
import { call } from "../helpers/installation-settings.ts";
import {
  getStorage,
  openSkillStorageFixture,
  pointStorage,
  putStorage,
  savedStorage,
  startFakeS3,
  storageBody,
  storagePath,
  verifyStorage,
} from "../helpers/skill-storage-settings.ts";

const ACCESS_CANARY = "AKIA-access-canary-0123456789";
const SECRET_CANARY = "secret-canary-abcdefghijklmnopqrstuvwxyz";

async function rowCount(
  storage: Awaited<ReturnType<typeof openSkillStorageFixture>>,
): Promise<number> {
  const result = await storage.pgDatabase.query<{ count: number }>(
    "select count(*)::int as count from bakery.skill_storage_settings",
  );
  return result.rows[0].count;
}

Deno.test("only live installation administrators reach storage settings; refusals store nothing", async () => {
  const storage = await openSkillStorageFixture();
  try {
    const developer = storage.developerCookie;
    for (
      const attempt of [
        () => getStorage(storage, developer),
        () => putStorage(storage, storageBody(), { cookie: developer }),
        () => verifyStorage(storage, { cookie: developer }),
      ]
    ) {
      const response = await attempt();
      assertEquals(response.status, 403, await response.clone().text());
      await response.body?.cancel();
    }
    for (
      const attempt of [
        () => call(storage, "GET", storagePath, ""),
        () => call(storage, "PUT", storagePath, "", { body: storageBody() }),
      ]
    ) {
      const response = await attempt();
      assertEquals(response.status, 401, await response.clone().text());
      await response.body?.cancel();
    }
    // CSRF: a cross-site or Origin-less browser write is refused.
    for (const origin of ["https://evil.example", null]) {
      const response = await storage.app.fetch(
        new Request(`${authTestOrigin}${storagePath}`, {
          method: "PUT",
          headers: {
            cookie: storage.adminCookie,
            "Idempotency-Key": crypto.randomUUID(),
            "content-type": "application/json",
            ...(origin === null ? {} : { origin }),
          },
          body: JSON.stringify(storageBody()),
        }),
      );
      assertEquals(
        response.status,
        403,
        `${origin} ${await response.clone().text()}`,
      );
      await response.body?.cancel();
    }
    assertEquals(await rowCount(storage), 0);
    const secrets = await storage.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.secrets where provider = 'r2'",
    );
    assertEquals(secrets.rows[0].count, 0);
  } finally {
    await storage.finish();
  }
});

Deno.test("credentials are encrypted at rest and absent from responses, problems, audit rows, idempotency records and logs", async () => {
  const storage = await openSkillStorageFixture({
    skillStorageProbe: () => Promise.resolve("verified"),
  });
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      captured.push(
        args.map((arg) => {
          try {
            return typeof arg === "string" ? arg : JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }).join(" "),
      );
    };
  }
  let bodies = "";
  try {
    const record = async (response: Response) => {
      bodies += JSON.stringify([...response.headers.entries()]) +
        await response.clone().text();
      return response;
    };
    const canary = storageBody({
      accessKeyId: ACCESS_CANARY,
      secretAccessKey: SECRET_CANARY,
    });
    const first = await record(await putStorage(storage, canary));
    assertEquals(first.status, 200);
    const { version } = await first.json();
    await record(await getStorage(storage));
    await record(await verifyStorage(storage));
    // Refusals that parse the secrets must not echo them either.
    await record(
      await putStorage(storage, { ...canary, secretAccessKey: undefined }, {
        version,
      }),
    );
    await record(await putStorage(storage, canary, { version: version + 5 }));
    await record(
      await putStorage(storage, { ...canary, bucket: "BAD BUCKET" }, {
        version,
      }),
    );
    await record(
      await putStorage(storage, {
        ...canary,
        accessKeyId: `${ACCESS_CANARY} with space`,
      }, { version }),
    );
    // A replay of the completed key returns the stored, secret-free body.
    const key = crypto.randomUUID();
    await record(await putStorage(storage, canary, { version, key }));
    await record(await putStorage(storage, canary, { version, key }));
    for (const secret of [ACCESS_CANARY, SECRET_CANARY]) {
      assertEquals(bodies.includes(secret), false, "response leaked");
      assertEquals(captured.join("\n").includes(secret), false, "log leaked");
    }

    // At rest: the ciphertext hides the pair, and only the installation
    // binding opens it.
    const stored = await storage.pgDatabase.query<{
      secret_id: string;
      revision: number;
      key_id: string;
      ciphertext: Uint8Array;
      nonce: Uint8Array;
    }>(
      `select v.secret_id, v.revision, v.key_id, v.ciphertext, v.nonce
         from bakery.skill_storage_settings s
         join bakery.secrets k on k.id = s.secret_id
         join bakery.secret_versions v on v.id = k.active_version_id`,
    );
    assertEquals(stored.rows.length, 1);
    const row = stored.rows[0];
    const raw = new TextDecoder("latin1").decode(row.ciphertext);
    for (const secret of [ACCESS_CANARY, SECRET_CANARY]) {
      assertEquals(raw.includes(secret), false, "ciphertext is plaintext");
    }
    const aesKey = await loadSecretKey(storage.secretsKey);
    const cipher = {
      ciphertext: new Uint8Array(row.ciphertext),
      nonce: new Uint8Array(row.nonce),
    };
    const opened = JSON.parse(
      new TextDecoder().decode(
        await decryptInstallationSecret(aesKey, {
          secretId: row.secret_id,
          revision: row.revision,
          keyId: row.key_id,
        }, cipher),
      ),
    );
    assertEquals(opened, {
      accessKeyId: ACCESS_CANARY,
      secretAccessKey: SECRET_CANARY,
    });
    // Another revision, key id or the project-secret binding cannot open it.
    await assertRejects(() =>
      decryptInstallationSecret(aesKey, {
        secretId: row.secret_id,
        revision: row.revision + 1,
        keyId: row.key_id,
      }, cipher)
    );
    await assertRejects(() =>
      decryptInstallationSecret(aesKey, {
        secretId: row.secret_id,
        revision: row.revision,
        keyId: "another-key-v1",
      }, cipher)
    );
    await assertRejects(() =>
      decryptSecret(aesKey, {
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        secretId: row.secret_id,
        revision: row.revision,
        keyId: row.key_id,
      }, cipher)
    );

    // Every other place a value could land: audit, idempotency, settings,
    // secret metadata and the domain event log.
    const tables = await storage.pgDatabase.query<{ text: string }>(
      `select (select coalesce(string_agg(a::text, ' '), '') from bakery.audit_events a)
         || (select coalesce(string_agg(i::text, ' '), '') from bakery.idempotency_records i)
         || (select coalesce(string_agg(s::text, ' '), '') from bakery.skill_storage_settings s)
         || (select coalesce(string_agg(k::text, ' '), '') from bakery.secrets k)
         || (select coalesce(string_agg(d::text, ' '), '') from bakery.domain_events d)
         as text`,
    );
    for (const secret of [ACCESS_CANARY, SECRET_CANARY]) {
      assertEquals(tables.rows[0].text.includes(secret), false, "table leaked");
    }
    const audit = await storage.pgDatabase.query<{ details: string }>(
      `select details::text from bakery.audit_events
        where operation like 'skillStorageSettings.%'`,
    );
    assert(audit.rows.length >= 2);
    for (const { details } of audit.rows) {
      for (const secret of [ACCESS_CANARY, SECRET_CANARY]) {
        assertEquals(details.includes(secret), false);
      }
      assertEquals(/ciphertext|nonce|key_?id|secret_?id/i.test(details), false);
    }
  } finally {
    methods.forEach((name, index) => console[name] = originals[index]);
    await storage.finish();
  }
});

Deno.test("no input or stored value redirects the S3 client; the endpoint stays pinned", async () => {
  const storage = await openSkillStorageFixture();
  const fake = startFakeS3();
  const key = skillObjectKey(
    crypto.randomUUID(),
    crypto.randomUUID(),
    "0".repeat(64),
  );
  const root = await Deno.makeTempDir();
  try {
    // The contract has no endpoint, backend or host field.
    for (
      const extra of [
        { endpoint: "https://evil.example" },
        { endpointOverride: fake.endpoint },
        { backend: "r2" },
        { region: "evil" },
      ]
    ) {
      const response = await putStorage(storage, storageBody(extra));
      assert([400, 422].includes(response.status), `${response.status}`);
      await response.body?.cancel();
    }
    // Host and path tricks in the account id or bucket fail the format check.
    for (
      const extra of [
        { accountId: `${"a".repeat(32)}.evil.example` },
        { accountId: "a".repeat(31) + "@" },
        { accountId: "A".repeat(32) },
        { bucket: "../escape" },
        { bucket: "a/b" },
        { bucket: "UPPER-case" },
      ]
    ) {
      const response = await putStorage(storage, storageBody(extra));
      assert([400, 422].includes(response.status), JSON.stringify(extra));
      await response.body?.cancel();
    }
    assertEquals(await rowCount(storage), 0);

    // A row edited behind the API is still pinned when it is used: outside a
    // test environment a stored override is ignored as invalid, and in one it
    // may only name a loopback host.
    await savedStorage(storage);
    await pointStorage(storage, { endpoint: fake.endpoint, backend: "r2" });
    const production = new DatabaseSkillObjectStore(
      storage.runtimePgDatabase!,
      {
        filesystemRoot: root,
        secretsKey: storage.secretsKey,
        allowLoopbackEndpoint: false,
      },
    );
    await assertRejects(
      () => production.read(key, "0".repeat(64), 0),
      SkillFileStoreError,
      "SKILL_STORAGE_CONFIG_INVALID",
    );
    for (
      const endpoint of [
        "https://evil.example",
        "http://169.254.169.254",
        "http://user:pass@127.0.0.1:9",
        "http://127.0.0.1:9/path",
      ]
    ) {
      await pointStorage(storage, { endpoint });
      const test = storage.openStore({ filesystemRoot: root });
      await assertRejects(
        () => test.read(key, "0".repeat(64), 0),
        SkillFileStoreError,
        "SKILL_STORAGE_CONFIG_INVALID",
      );
    }
    // Count only requests this store could have sent: the S3 client signs every
    // request and addresses the object key. An unsigned `GET /` is another
    // local process probing a reused ephemeral port, not a redirected client.
    const contacted = fake.seen.filter((request) =>
      request.accessKeyId !== null || request.path !== "/"
    );
    assertEquals(contacted, [], "a refused endpoint was contacted");
    production.close();
  } finally {
    await fake.close();
    await storage.finish();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an unreadable credential fails closed with fixed codes and no content", async () => {
  const root = await Deno.makeTempDir();
  const storage = await openSkillStorageFixture({ skillFileRoot: root });
  const key = skillObjectKey(
    crypto.randomUUID(),
    crypto.randomUUID(),
    "0".repeat(64),
  );
  try {
    await savedStorage(storage, storageBody({ accessKeyId: ACCESS_CANARY }));
    await pointStorage(storage, { backend: "r2" });
    // A different key cannot open the stored version.
    const otherDirectory = await Deno.makeTempDir();
    const otherFile = `${otherDirectory}/key`;
    await Deno.writeFile(
      otherFile,
      crypto.getRandomValues(new Uint8Array(32)),
      {
        mode: 0o600,
      },
    );
    try {
      for (
        const secretsKey of [
          { file: otherFile, keyId: storage.secretsKey.keyId },
          undefined,
        ]
      ) {
        const store = new DatabaseSkillObjectStore(storage.runtimePgDatabase!, {
          filesystemRoot: root,
          secretsKey,
          allowLoopbackEndpoint: true,
        });
        const error = await assertRejects(
          () => store.read(key, "0".repeat(64), 0),
          SkillFileStoreError,
          "SKILL_FILE_CREDENTIAL_INVALID",
        );
        assertEquals(error.cause, undefined);
        assertEquals(JSON.stringify(error).includes(ACCESS_CANARY), false);
        store.close();
      }
    } finally {
      await Deno.remove(otherDirectory, { recursive: true });
    }
  } finally {
    await storage.finish();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker config excludes storage references and provider failures cannot expose credentials", async () => {
  const root = await Deno.makeTempDir();
  try {
    // Legacy variables an operator might still export are never forwarded.
    const env = {
      BAKERY_ENV: "test",
      ...legacyStorageEnvironment(root),
    };
    const services = createStackServices({
      mode: "dev",
      root: Deno.cwd() + "/",
      denoPath: Deno.execPath(),
      inherited: {
        ...env,
        PATH: "/usr/bin",
        HOME: root,
        BAKERY_WORKER_STATE_DIR: `${root}/worker`,
        BAKERY_WORKER_PROFILE: "worker",
      },
    });
    const workerService = services.find((service) =>
      service.cwd.endsWith("apps/worker")
    );
    assertEquals(
      Object.keys(workerService?.env ?? {}).some((key) =>
        legacyStoragePrefixes.some((prefix) => key.startsWith(prefix))
      ),
      false,
    );
    assertEquals(workerService?.clearEnv, true);
    const worker = JSON.stringify(readRuntimeConfig(env, "worker"));
    assertEquals(worker.includes(root), false);
    assertEquals(worker.includes("r2Storage"), false);
    const workerLauncher = await Deno.readTextFile("apps/worker/package.json");
    for (const prefix of legacyStoragePrefixes) {
      assertEquals(workerLauncher.includes(prefix), false);
    }

    const client = createSkillS3Client({ endpoint: "http://127.0.0.1:1" }, {
      accessKeyId: ACCESS_CANARY,
      secretAccessKey: SECRET_CANARY,
    });
    const messages: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...values: unknown[]) => {
      messages.push(values.map(String).join(" "));
    };
    console.warn = (...values: unknown[]) => {
      messages.push(values.map(String).join(" "));
    };
    try {
      const store = new S3SkillObjectStore(client, "fixture-bucket");
      await assertRejects(
        () => store.read("organizations/../escape", "0".repeat(64), 0),
        SkillFileStoreError,
        "SKILL_FILE_KEY_INVALID",
      );
      const error = await assertRejects(
        () =>
          store.read(
            skillObjectKey(
              crypto.randomUUID(),
              crypto.randomUUID(),
              "0".repeat(64),
            ),
            "0".repeat(64),
            0,
          ),
        SkillFileStoreError,
        "SKILL_FILE_DEPENDENCY_UNAVAILABLE",
      );
      assertEquals(JSON.stringify(error).includes("canary"), false);
      assertEquals(error.cause, undefined);
      for (const privateValue of [ACCESS_CANARY, SECRET_CANARY, root]) {
        assertEquals(messages.join("\n").includes(privateValue), false);
      }
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      client.destroy();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
