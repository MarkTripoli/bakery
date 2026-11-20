import { assertEquals } from "@std/assert";
import type { probeBackupDestination } from "../../apps/server/src/modules/backups/s3.ts";
import { authTestOrigin } from "./auth.ts";
import { call, openInstallationFixture } from "./installation-settings.ts";

/** Fixtures for #80 slice S1b: backup schedule and off-site destination. */

export const schedulePath = "/v1/installation/backup-schedule";
export const offsitePath = "/v1/installation/backup-offsite";
export const verificationPath = `${offsitePath}/verification`;
export const runnerSettingsPath = "/v1/backup-runner/settings";

export const accessKeyId = "AKIAFIXTUREACCESSKEY";
export const secretAccessKey = "fixture/Secret+Access/Key0123456789";

export type Probe = typeof probeBackupDestination;
export type ProbeCall = {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type Problem = {
  code: string;
  issues?: { path: (string | number)[]; code: string; message: string }[];
};

export function offsiteBody(extra: Record<string, unknown> = {}) {
  return {
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    bucket: "bakery-backups",
    prefix: "prod",
    accessKeyId,
    secretAccessKey,
    ...extra,
  };
}

/**
 * Installation fixture with a mounted AES key and a destination test the test
 * steers: `behave` replaces what the next tests answer, `calls` records what
 * reached the destination (including the credentials the server used).
 */
export async function openBackupSettingsFixture(
  options: { realProbe?: boolean } = {},
) {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-backup-settings-",
  });
  const file = `${directory}/key`;
  await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)), {
    mode: 0o600,
  });
  const calls: ProbeCall[] = [];
  let behave: Probe = () =>
    Promise.resolve({ outcome: "verified" as const, detail: null });
  const probe: Probe = (destination, credentials, signal) => {
    calls.push({
      endpoint: destination.endpoint,
      bucket: destination.bucket,
      prefix: destination.prefix,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    return behave(destination, credentials, signal);
  };
  const fixture = await openInstallationFixture(true, {
    secretsKey: { file, keyId: "backup-settings-fixture-key-v1" },
    backupDestinationProbe: options.realProbe ? undefined : probe,
  });
  const clear = async () => {
    await fixture.pgDatabase.query("delete from bakery.backup_runs");
    await fixture.pgDatabase.query(
      "delete from bakery.backup_runner_credentials",
    );
    await fixture.pgDatabase.query(
      "delete from bakery.backup_schedule_settings",
    );
    await fixture.pgDatabase.query(
      "delete from bakery.backup_offsite_settings",
    );
    const secrets = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.secrets
        where organization_id is null and provider = 's3-backup'`,
    )).rows.map((row) => row.id);
    if (secrets.length === 0) return;
    await fixture.pgDatabase.query(
      "update bakery.secrets set active_version_id = null where id = any($1::uuid[])",
      [secrets],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.secret_versions where secret_id = any($1::uuid[])",
      [secrets],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.secrets where id = any($1::uuid[])",
      [secrets],
    );
  };
  await clear();
  const key = () => ({ "Idempotency-Key": crypto.randomUUID() });
  const admin = (
    method: string,
    path: string,
    body?: unknown,
    options: { keyed?: boolean; version?: number; cookie?: string } = {},
  ) =>
    call(fixture, method, path, options.cookie ?? fixture.adminCookie, {
      body,
      headers: {
        ...(options.keyed ? key() : {}),
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"v${options.version}"` }),
      },
    });
  const runner = (
    credential: string,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    fixture.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          origin: authTestOrigin,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const issueCredential = async () => {
    const response = await admin(
      "POST",
      "/v1/installation/backup-runner/credential",
      {},
    );
    assertEquals(response.status, 201, await response.clone().text());
    return (await response.json() as { credential: string }).credential;
  };
  const putSchedule = (
    body: Record<string, unknown>,
    options: { version?: number; cookie?: string } = {},
  ) => admin("PUT", schedulePath, body, { keyed: true, ...options });
  const putOffsite = (
    body: Record<string, unknown>,
    options: { version?: number; cookie?: string } = {},
  ) => admin("PUT", offsitePath, body, { keyed: true, ...options });
  return {
    f: fixture,
    calls,
    setProbe: (next: Probe) => {
      behave = next;
    },
    admin,
    runner,
    issueCredential,
    putSchedule,
    putOffsite,
    clear,
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
export type BackupSettingsFixture = Awaited<
  ReturnType<typeof openBackupSettingsFixture>
>;

/**
 * A tiny in-process S3-compatible receiver on loopback: path-style PUT, GET and
 * DELETE of objects, with one access key it answers 403 to in the way a real
 * service does (naming the key in its message).
 */
export function startS3Receiver(options: { rejectKey?: string } = {}) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const authorization = request.headers.get("authorization") ?? "";
      const used = /Credential=([^/]+)\//.exec(authorization)?.[1] ?? "";
      if (options.rejectKey !== undefined && used === options.rejectKey) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code><Message>The access key ${used} does not exist in our records.</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }
      if (request.method === "PUT") {
        objects.set(
          url.pathname,
          new Uint8Array(await request.arrayBuffer()),
        );
        return new Response(null, {
          status: 200,
          headers: { etag: '"fixture"' },
        });
      }
      if (request.method === "GET") {
        const body = objects.get(url.pathname);
        return body === undefined
          ? new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "content-type": "application/xml" },
          })
          : new Response(body, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    stop: () => server.shutdown(),
  };
}
