import { proveSkillObjectMigrationCli } from "../helpers/skill-object-migration-cli.ts";
import { SkillFileStoreError } from "../../apps/server/src/modules/catalog/storage-port.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { skillObjectKey } from "../../apps/server/src/modules/catalog/identity.ts";
import { openSkillS3Fixture } from "../helpers/skill-s3-fixture.ts";
import { skillObjectStoreContract } from "../helpers/skill-object-store-contract.ts";
import {
  assertReferencedInventory,
  collectSkillInventory,
  copySkillInventory,
  verifySkillInventory,
  withSkillStoragePause,
} from "../../scripts/storage/skill-object-migration.ts";
import {
  makeUpload,
  openPublicationTestContext,
} from "../helpers/local-skill-publication.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  openResolvedSkillStore,
  resolveSkillStorage,
} from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { readSkillStorageSettings } from "../../apps/server/src/modules/catalog/skill-storage-settings.ts";
import {
  fixtureAccountId,
  fixtureBucket,
  getStorage,
  openSkillStorageFixture,
  pointStorage,
  putStorage,
  s3Error,
  savedStorage,
  type SkillStorageFixture,
  startFakeS3,
  storageBody,
  verifyStorage,
} from "../helpers/skill-storage-settings.ts";

/** The S3 store built from the saved settings and their encrypted credentials. */
async function databaseS3Store(
  storage: SkillStorageFixture,
  root: string,
) {
  const settings = await readSkillStorageSettings(storage.runtimePgDatabase!);
  const live = openResolvedSkillStore(
    await resolveSkillStorage(storage.runtimePgDatabase!, settings, {
      filesystemRoot: root,
      secretsKey: storage.secretsKey,
      allowLoopbackEndpoint: true,
    }, "r2"),
  );
  return live;
}

Deno.test("pinned S3 fixture returns 412; both adapters satisfy immutable contract and verified migration", async () => {
  const fixture = await openSkillS3Fixture();
  const root = await Deno.makeTempDir();
  let storage: SkillStorageFixture | undefined;
  let database: Awaited<ReturnType<typeof databaseS3Store>> | undefined;
  try {
    storage = await openSkillStorageFixture({ skillFileRoot: root });
    // The S3 adapter is built from the settings an administrator saved:
    // account, bucket and credentials come from the database, the endpoint is
    // the loopback fixture only a test environment accepts.
    await savedStorage(storage, storageBody({ bucket: fixture.bucket }));
    await pointStorage(storage, { endpoint: fixture.endpoint });
    const opened = database = await databaseS3Store(storage, root);
    const request = {
      Bucket: fixture.bucket,
      Key: "conditional-probe",
      Body: new TextEncoder().encode("original"),
      IfNoneMatch: "*",
    };
    await fixture.client.send(new PutObjectCommand(request));
    const failure = await assertRejects(
      () =>
        fixture.client.send(
          new PutObjectCommand({
            ...request,
            Body: new TextEncoder().encode("replacement"),
          }),
        ),
      S3ServiceException,
    );
    assertEquals(failure.$metadata.httpStatusCode, 412);
    await fixture.client.send(
      new DeleteObjectCommand({ Bucket: fixture.bucket, Key: request.Key }),
    );
    const filesystem = new SkillFileStore(root);
    await skillObjectStoreContract(
      filesystem,
      (key, bytes) => Deno.writeFile(`${root}/${key}`, bytes),
    );
    await skillObjectStoreContract(opened.store, async (key, bytes) => {
      await fixture.client.send(
        new PutObjectCommand({ Bucket: fixture.bucket, Key: key, Body: bytes }),
      );
    });
    const inventory = await collectSkillInventory(filesystem);
    await copySkillInventory(filesystem, opened.store, inventory);
    await verifySkillInventory(opened.store, inventory);
    await copySkillInventory(filesystem, opened.store, inventory);
    assertEquals(
      await filesystem.read(
        inventory[0].objectKey,
        inventory[0].sha256,
        inventory[0].sizeBytes,
      ),
      await opened.store.read(
        inventory[0].objectKey,
        inventory[0].sha256,
        inventory[0].sizeBytes,
      ),
    );
    const object = inventory[0];
    const original = await filesystem.read(
      object.objectKey,
      object.sha256,
      object.sizeBytes,
    );
    await fixture.client.send(
      new PutObjectCommand({
        Bucket: fixture.bucket,
        Key: object.objectKey,
        Body: new TextEncoder().encode("corrupt bytes"),
      }),
    );
    await assertRejects(
      () => opened.store.putIfAbsent(object.objectKey, original, object.sha256),
      SkillFileStoreError,
      "SKILL_OBJECT_DIGEST_CONFLICT",
    );
  } finally {
    database?.close();
    try {
      await storage?.finish();
    } finally {
      try {
        await fixture.close();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }
  }
});

Deno.test("lost S3 publication response leaves bytes inaccessible; retry publishes same verified objects", async () => {
  const fixture = await openSkillS3Fixture();
  const root = await Deno.makeTempDir();
  const keyFile = `${root}.key`;
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file: keyFile, keyId: "lost-response-key-v1" };
  let interrupt = true;
  let database: Awaited<ReturnType<typeof databaseS3Store>> | undefined;
  const store = {
    recover: (key: string, digest: string, size: number) =>
      database!.store.recover(key, digest, size),
    read: (key: string, digest: string, size: number) =>
      database!.store.read(key, digest, size),
    async putIfAbsent(key: string, content: Uint8Array, digest: string) {
      await database!.store.putIfAbsent(key, content, digest);
      if (interrupt) {
        interrupt = false;
        throw new Error("LOST_RESPONSE");
      }
    },
  };
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  let storage: SkillStorageFixture | undefined;
  try {
    context = await openPublicationTestContext({ root, store, secretsKey });
    // Credentials, bucket and account come from the encrypted database row.
    const saved = await putStorage(
      context.fixture as never,
      storageBody({ bucket: fixture.bucket }),
      { cookie: context.cookie },
    );
    assertEquals(saved.status, 200, await saved.clone().text());
    await pointStorage(context.fixture, { endpoint: fixture.endpoint });
    storage = {
      ...context.fixture,
      secretsKey,
    } as unknown as SkillStorageFixture;
    database = await databaseS3Store(storage, root);
    const skill = await context.createSkill();
    const upload = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("# S3 skill\n"),
    }]);
    const failed = await context.publish(skill.id, upload, "s3-lost-response");
    assertEquals(failed.status, 503);
    const publicError = await failed.text();
    for (
      const privateValue of [
        "fixture-secret-access-key",
        "fixture-access-key-id",
        root,
        fixture.endpoint,
      ]
    ) {
      assertEquals(publicError.includes(privateValue), false);
    }
    const inventory = await collectSkillInventory(database.store);
    assertEquals(inventory.length, 1);
    const skillResponse = await context.fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}`, {
        headers: context.headers,
      }),
    );
    assertEquals(skillResponse.status, 200);
    assertEquals((await skillResponse.json()).activeVersionId, null);
    const metadata = await context.fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.skill_versions where organization_id = $1 and skill_id = $2",
      [context.organizationId, skill.id],
    );
    assertEquals(metadata.rows[0].count, 0);

    assertEquals(
      (await context.publish(skill.id, upload, "s3-lost-response")).status,
      201,
    );
    assertEquals(await collectSkillInventory(database.store), inventory);
  } finally {
    database?.close();
    try {
      await context?.close(true);
    } finally {
      try {
        await fixture.close();
      } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(keyFile);
      }
    }
  }
});

Deno.test("migration pause refuses live writers and verifies database references while drained", async () => {
  const root = await Deno.makeTempDir();
  const context = await openPublicationTestContext({ root });
  const database = openDatabase(readTestDatabaseConfig().databaseUrl);
  let contextClosed = false;
  try {
    const skill = await context.createSkill();
    const upload = await makeUpload([{
      path: "SKILL.md",
      content: new TextEncoder().encode("# Migration reference\n"),
    }]);
    assertEquals((await context.publish(skill.id, upload)).status, 201);
    await assertRejects(
      () => assertReferencedInventory(database, []),
      Error,
      "SKILL_STORAGE_INVENTORY_INCOMPLETE",
    );
    await assertReferencedInventory(
      database,
      await collectSkillInventory(new SkillFileStore(root)),
    );

    await assertRejects(
      () => withSkillStoragePause(database, () => Promise.resolve(undefined)),
      Error,
      "APPLICATION_DATABASE_DRAIN_REQUIRED",
    );
    await context.close(true);
    contextClosed = true;
    await withSkillStoragePause(database, async () => {
      const rows = await database<
        { id: string }[]
      >`select id from bakery.application_migration_drain where id = 'database'`;
      assertEquals(rows.length, 1);
      await assertReferencedInventory(database, []);
    });
  } finally {
    if (!contextClosed) await context.close(true);
    await closeDatabase(database);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "operator CLI copies, verifies and selects backend configuration with exact inventory",
  proveSkillObjectMigrationCli,
);

Deno.test("settings API saves, hides credentials, verifies against the S3 fixture and honours If-Match", async () => {
  const fixture = await openSkillS3Fixture();
  const storage = await openSkillStorageFixture();
  const since = (await storage.pgDatabase.query<{ now: Date }>(
    "select clock_timestamp() as now",
  )).rows[0].now;
  try {
    const empty = await getStorage(storage);
    assertEquals(empty.status, 200, await empty.clone().text());
    assertEquals(await empty.json(), {
      backend: "filesystem",
      configured: false,
      accountId: null,
      bucket: null,
      credentialUpdatedAt: null,
      credentialRevision: null,
      updatedAt: null,
      version: 0,
    });
    // Nothing to probe before the first save.
    const unconfigured = await verifyStorage(storage);
    assertEquals(unconfigured.status, 200, await unconfigured.clone().text());
    assertEquals((await unconfigured.json()).outcome, "not_configured");

    const first = await savedStorage(
      storage,
      storageBody({ bucket: fixture.bucket }),
    );
    assertEquals(first.backend, "filesystem");
    assertEquals(first.configured, true);
    assertEquals(first.accountId, fixtureAccountId);
    assertEquals(first.bucket, fixture.bucket);
    assertEquals(first.credentialRevision, 1);
    assertEquals(first.version, 1);
    assertEquals(Object.keys(first).sort(), [
      "accountId",
      "backend",
      "bucket",
      "configured",
      "credentialRevision",
      "credentialUpdatedAt",
      "updatedAt",
      "version",
    ]);

    // A second first-save, a missing and a stale If-Match all store nothing.
    assertEquals(
      (await putStorage(storage, storageBody({ bucket: fixture.bucket })))
        .status,
      428,
    );
    assertEquals(
      (await putStorage(storage, storageBody(), { version: 7 })).status,
      412,
    );
    assertEquals(
      (await readSkillStorageSettings(storage.pgDatabase))?.version,
      1,
    );

    // The probe round-trips a sentinel through the real S3 API.
    await pointStorage(storage, { endpoint: fixture.endpoint });
    const probed = await verifyStorage(storage);
    assertEquals(probed.status, 200, await probed.clone().text());
    assertEquals((await probed.json()).outcome, "verified");
    // The sentinel is outside the inventory prefix and was deleted.
    const listed = await fixture.client.send(
      new ListObjectsV2Command({
        Bucket: fixture.bucket,
        Prefix: "bakery-probe/",
      }),
    );
    assertEquals(listed.KeyCount ?? 0, 0);

    // A non-secret edit keeps the credentials and their revision.
    const edited = await savedStorage(
      storage,
      { accountId: fixtureAccountId, bucket: fixture.bucket },
      2,
    );
    assertEquals(edited.credentialRevision, 1);
    assertEquals(edited.version, 3);
    // A rotation takes the next revision and keeps the earlier version row.
    const rotated = await savedStorage(
      storage,
      storageBody({
        bucket: fixture.bucket,
        accessKeyId: "rotated-access-key-id",
        secretAccessKey: "rotated-secret-access-key",
      }),
      3,
    );
    assertEquals(rotated.credentialRevision, 2);
    assertEquals(rotated.version, 4);
    const versions = await storage.pgDatabase.query<{ revision: number }>(
      `select v.revision from bakery.skill_storage_settings s
         join bakery.secret_versions v on v.secret_id = s.secret_id
        order by v.revision`,
    );
    assertEquals(versions.rows.map((row) => row.revision), [1, 2]);
    const audit = await storage.pgDatabase.query<{ operation: string }>(
      `select operation from bakery.audit_events
        where operation like 'skillStorageSettings.%' and created_at > $1
        order by created_at, id`,
      [since],
    );
    assertEquals(audit.rows.map((row) => row.operation), [
      "skillStorageSettings.verify",
      "skillStorageSettings.put",
      "skillStorageSettings.verify",
      "skillStorageSettings.put",
      "skillStorageSettings.put",
    ]);
  } finally {
    await storage.finish();
    await fixture.close();
  }
});

Deno.test("the verify probe maps each provider failure to one fixed code", async () => {
  const storage = await openSkillStorageFixture();
  let respond = () => s3Error(403, "AccessDenied");
  const fake = startFakeS3(() => respond());
  try {
    await savedStorage(storage);
    await pointStorage(storage, { endpoint: fake.endpoint });
    const cases: Array<[() => Response, string]> = [
      [() => s3Error(403, "InvalidAccessKeyId"), "credentials_rejected"],
      [() => s3Error(403, "SignatureDoesNotMatch"), "credentials_rejected"],
      [() => s3Error(403, "AccessDenied"), "access_denied"],
      [() => s3Error(404, "NoSuchBucket"), "bucket_not_found"],
      [() => s3Error(500, "InternalError"), "provider_error"],
    ];
    for (const [answer, expected] of cases) {
      respond = answer;
      const response = await verifyStorage(storage);
      assertEquals(response.status, 200, await response.clone().text());
      const text = await response.text();
      assertEquals(JSON.parse(text).outcome, expected);
      // Provider text, endpoint and credentials never reach the answer.
      for (
        const forbidden of [
          "provider-text-canary",
          fake.endpoint,
          "fixture-secret-access-key",
          "fixture-access-key-id",
        ]
      ) assertEquals(text.includes(forbidden), false, forbidden);
    }
    // Nothing listens: no HTTP answer at all.
    await fake.close();
    await pointStorage(storage, { endpoint: fake.endpoint });
    const unreachable = await verifyStorage(storage);
    assertEquals((await unreachable.json()).outcome, "endpoint_unreachable");
  } finally {
    await fake.close().catch(() => {});
    await storage.finish();
  }
});

Deno.test("rotated credentials and a backend switch apply to the next operation without a restart", async () => {
  const root = await Deno.makeTempDir();
  // The fake answers 404 to everything, so the rotation probe is stubbed;
  // the probe itself is proven against the S3 fixtures elsewhere.
  const storage = await openSkillStorageFixture({
    skillFileRoot: root,
    skillStorageProbe: () => Promise.resolve("verified"),
  });
  const fake = startFakeS3();
  const key = skillObjectKey(
    crypto.randomUUID(),
    crypto.randomUUID(),
    "0".repeat(64),
  );
  try {
    const store = storage.openStore({ filesystemRoot: root });
    // Filesystem is the default: no row, no network.
    await assertRejects(
      () => store.read(key, "0".repeat(64), 0),
      SkillFileStoreError,
      "SKILL_FILE_NOT_FOUND",
    );
    assertEquals(fake.seen.length, 0);
    const first = await savedStorage(
      storage,
      storageBody({
        accessKeyId: "first-access-key-id",
      }),
    );
    await pointStorage(storage, { endpoint: fake.endpoint, backend: "r2" });
    // The same store object now talks to S3 with the saved credentials.
    await assertRejects(
      () => store.read(key, "0".repeat(64), 0),
      SkillFileStoreError,
      "SKILL_FILE_NOT_FOUND",
    );
    assertEquals(fake.seen.at(-1)?.accessKeyId, "first-access-key-id");
    // Rotation through the API: the next call signs with the new key id.
    const rotated = await putStorage(
      storage,
      storageBody({
        accessKeyId: "second-access-key-id",
        secretAccessKey: "second-secret-access-key",
      }),
      { version: first.version + 1 },
    );
    assertEquals(rotated.status, 200, await rotated.clone().text());
    await assertRejects(
      () => store.read(key, "0".repeat(64), 0),
      SkillFileStoreError,
      "SKILL_FILE_NOT_FOUND",
    );
    assertEquals(fake.seen.at(-1)?.accessKeyId, "second-access-key-id");
    // Switching back is read from the database too.
    const calls = fake.seen.length;
    await pointStorage(storage, { backend: "filesystem" });
    await assertRejects(
      () => store.read(key, "0".repeat(64), 0),
      SkillFileStoreError,
      "SKILL_FILE_NOT_FOUND",
    );
    assertEquals(fake.seen.length, calls);
    store.close();
  } finally {
    await fake.close();
    await storage.finish();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("account and bucket stay fixed while r2 is the active backend", async () => {
  const storage = await openSkillStorageFixture({
    skillStorageProbe: () => Promise.resolve("verified"),
  });
  try {
    const first = await savedStorage(storage);
    await pointStorage(storage, { backend: "r2" });
    const moved = await putStorage(
      storage,
      { accountId: fixtureAccountId, bucket: "another-bucket" },
      { version: first.version + 1 },
    );
    assertEquals(moved.status, 409);
    assertEquals((await moved.json()).reason, "backend_active");
    // A rotation under the same bucket is the allowed change.
    const rotated = await putStorage(
      storage,
      storageBody({ accessKeyId: "next-key", secretAccessKey: "next-secret" }),
      { version: first.version + 1 },
    );
    assertEquals(rotated.status, 200, await rotated.clone().text());
    assertEquals((await rotated.json()).backend, "r2");
  } finally {
    await storage.finish();
  }
});

Deno.test("rotation under an active r2 backend must pass the probe before it is stored", async () => {
  const probed: string[] = [];
  let outcome: string = "credentials_rejected";
  const storage = await openSkillStorageFixture({
    skillStorageProbe: (_connection, credentials) => {
      probed.push(credentials.accessKeyId);
      return Promise.resolve(outcome as never);
    },
  });
  try {
    // While filesystem is active a save touches no provider.
    const first = await savedStorage(storage);
    assertEquals(probed, []);
    await pointStorage(storage, { backend: "r2" });
    const before = await (await getStorage(storage)).json();

    const refused = await putStorage(
      storage,
      storageBody({
        accessKeyId: "typo-access-key-id",
        secretAccessKey: "typo-secret-access-key",
      }),
      { version: first.version + 1 },
    );
    const refusedText = await refused.text();
    assertEquals(refused.status, 422, refusedText);
    assertEquals(refusedText.includes("credentials_rejected"), true);
    for (const leaked of ["typo-access-key-id", "typo-secret-access-key"]) {
      assertEquals(refusedText.includes(leaked), false, leaked);
    }
    assertEquals(probed, ["typo-access-key-id"]);
    // Nothing was stored: same version, same credential revision.
    assertEquals(await (await getStorage(storage)).json(), before);

    // A rotation without new credentials, or with a good probe, is committed.
    outcome = "verified";
    const rotated = await putStorage(
      storage,
      storageBody({
        accessKeyId: "good-access-key-id",
        secretAccessKey: "good-secret-access-key",
      }),
      { version: before.version },
    );
    assertEquals(rotated.status, 200, await rotated.clone().text());
    const after = await rotated.json();
    assertEquals(after.credentialRevision, before.credentialRevision + 1);
    assertEquals(probed.at(-1), "good-access-key-id");
    const probes = probed.length;
    const bucketOnly = await putStorage(
      storage,
      { accountId: fixtureAccountId, bucket: fixtureBucket },
      { version: after.version },
    );
    assertEquals(bucketOnly.status, 200, await bucketOnly.clone().text());
    assertEquals(probed.length, probes);
  } finally {
    await storage.finish();
  }
});

Deno.test("the application role cannot switch the backend; only the owner path can", async () => {
  const storage = await openSkillStorageFixture();
  try {
    await savedStorage(storage);
    const privilege = (column: string) =>
      storage.pgDatabase.query<{ allowed: boolean }>(
        `select has_column_privilege('bakery_app',
           'bakery.skill_storage_settings', $1, 'UPDATE') as allowed`,
        [column],
      );
    assertEquals((await privilege("backend")).rows[0].allowed, false);
    assertEquals((await privilege("endpoint_override")).rows[0].allowed, false);
    assertEquals((await privilege("bucket")).rows[0].allowed, true);
    const insertPrivilege = (column: string) =>
      storage.pgDatabase.query<{ allowed: boolean }>(
        `select has_column_privilege('bakery_app',
           'bakery.skill_storage_settings', $1, 'INSERT') as allowed`,
        [column],
      );
    assertEquals((await insertPrivilege("backend")).rows[0].allowed, false);
    assertEquals(
      (await insertPrivilege("endpoint_override")).rows[0].allowed,
      false,
    );
    assertEquals((await insertPrivilege("bucket")).rows[0].allowed, true);
    await assertRejects(
      () =>
        storage.runtimePgDatabase!.query(
          `insert into bakery.skill_storage_settings (id, backend)
           values ('other', 'r2')`,
        ),
      Error,
      "permission denied",
    );
    await assertRejects(
      () =>
        storage.runtimePgDatabase!.query(
          "update bakery.skill_storage_settings set backend = 'r2'",
        ),
      Error,
      "permission denied",
    );
  } finally {
    await storage.finish();
  }
});
