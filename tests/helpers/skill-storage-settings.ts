import { assertEquals } from "@std/assert";
import {
  DatabaseSkillObjectStore,
  type probeSkillStorage,
  type SkillStorageResolverOptions,
} from "../../apps/server/src/modules/catalog/storage-backend.ts";
import { deleteSkillStorageRows } from "./auth.ts";
import { call, openInstallationFixture } from "./installation-settings.ts";
import type { InstallationFixture } from "./installation-settings.ts";

export const storagePath = "/v1/installation/skill-storage";
export const verificationPath = `${storagePath}/verification`;
/** A well-formed Cloudflare account id; no request ever reaches this host. */
export const fixtureAccountId = "a".repeat(32);
export const fixtureBucket = "bakery-skill-fixture";

export type StorageBody = {
  accountId?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  [extra: string]: unknown;
};

export function storageBody(extra: StorageBody = {}): StorageBody {
  return {
    accountId: fixtureAccountId,
    bucket: fixtureBucket,
    accessKeyId: "fixture-access-key-id",
    secretAccessKey: "fixture-secret-access-key",
    ...extra,
  };
}

type FixtureOptions = {
  skillFileRoot?: string;
  skillStorageProbe?: typeof probeSkillStorage;
};

/**
 * Installation fixture with a mounted AES key. Skill storage settings are
 * installation-wide, so the row and its secret are cleared before and after.
 */
export async function openSkillStorageFixture(options: FixtureOptions = {}) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-skill-storage-" });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const secretsKey = { file, keyId: "skill-storage-fixture-key-v1" };
  const fixture = await openInstallationFixture(true, {
    secretsKey,
    skillFileRoot: options.skillFileRoot,
    skillStorageProbe: options.skillStorageProbe,
  });
  const clear = () =>
    deleteSkillStorageRows(
      fixture.pgDatabase,
      "select id from bakery.principals",
      [],
    );
  await clear();
  return {
    ...fixture,
    secretsKey,
    clear,
    /** The store the server holds, rebuilt here against the same database. */
    openStore(
      resolver: Partial<SkillStorageResolverOptions> & {
        filesystemRoot: string;
      },
    ) {
      return new DatabaseSkillObjectStore(fixture.runtimePgDatabase!, {
        secretsKey,
        allowLoopbackEndpoint: true,
        ...resolver,
      });
    },
    finish: async () => {
      try {
        await clear();
      } finally {
        try {
          await fixture.finish();
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      }
    },
  };
}
export type SkillStorageFixture = Awaited<
  ReturnType<typeof openSkillStorageFixture>
>;

export function getStorage(
  fixture: InstallationFixture,
  cookie = fixture.adminCookie,
): Promise<Response> {
  return call(fixture, "GET", storagePath, cookie);
}

export function putStorage(
  fixture: InstallationFixture,
  body: unknown,
  options: { version?: number; cookie?: string; key?: string } = {},
): Promise<Response> {
  return call(
    fixture,
    "PUT",
    storagePath,
    options.cookie ?? fixture.adminCookie,
    {
      body,
      headers: {
        "Idempotency-Key": options.key ?? crypto.randomUUID(),
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"v${options.version}"` }),
      },
    },
  );
}

export function verifyStorage(
  fixture: InstallationFixture,
  options: { cookie?: string; key?: string } = {},
): Promise<Response> {
  return call(
    fixture,
    "POST",
    verificationPath,
    options.cookie ?? fixture.adminCookie,
    {
      body: {},
      headers: { "Idempotency-Key": options.key ?? crypto.randomUUID() },
    },
  );
}

/** Saves settings as the administrator and returns the parsed projection. */
export async function savedStorage(
  fixture: InstallationFixture,
  body: unknown = storageBody(),
  version?: number,
) {
  const response = await putStorage(fixture, body, { version });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as {
    backend: string;
    configured: boolean;
    accountId: string | null;
    bucket: string | null;
    credentialRevision: number | null;
    credentialUpdatedAt: string | null;
    version: number;
  };
}

/**
 * Test-only owner-role write standing in for the paused switch procedure and
 * for the loopback endpoint the application never writes. Bumps the version so
 * every running resolver re-reads, exactly as the real writers do.
 */
export async function pointStorage(
  fixture: Pick<SkillStorageFixture, "pgDatabase">,
  change: { endpoint?: string | null; backend?: "filesystem" | "r2" },
): Promise<void> {
  const result = await fixture.pgDatabase.query(
    `update bakery.skill_storage_settings
        set endpoint_override = case when $1::boolean then $2
              else endpoint_override end,
            backend = coalesce($3, backend),
            version = version + 1, updated_at = now()
      where id = 'installation'
      returning version`,
    [
      change.endpoint !== undefined,
      change.endpoint ?? null,
      change.backend ?? null,
    ],
  );
  assertEquals(result.rows.length, 1);
}

/** A loopback HTTP server that plays the S3 API and records each request. */
export function startFakeS3(
  respond: (request: Request) => Response | Promise<Response> = () =>
    s3Error(404, "NoSuchKey"),
) {
  const seen: { method: string; path: string; accessKeyId: string | null }[] =
    [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const authorization = request.headers.get("authorization") ?? "";
    seen.push({
      method: request.method,
      path: new URL(request.url).pathname,
      accessKeyId: /Credential=([^/]+)\//.exec(authorization)?.[1] ?? null,
    });
    await request.body?.cancel();
    return await respond(request);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    seen,
    close: () => server.shutdown(),
  };
}

export function s3Error(status: number, code: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>provider-text-canary</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}
