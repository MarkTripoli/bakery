import { assertEquals } from "@std/assert";
import {
  type HostResolver,
  HostUnresolvable,
} from "../../apps/server/src/modules/backups/dns.ts";
import type { probeBackupDestination } from "../../apps/server/src/modules/backups/s3.ts";
import { authTestOrigin } from "./auth.ts";
import { call, openInstallationFixture } from "./installation-settings.ts";

/** Fixtures for #80 slice S1b: backup schedule and off-site destination. */

export const schedulePath = "/v1/installation/backup-schedule";
export const offsitePath = "/v1/installation/backup-offsite";
export const verificationPath = `${offsitePath}/verification`;
export const runnerSettingsPath = "/v1/backup-runner/settings";
/** A destination host that only a steered resolver knows. */
export const namedHost = "backups.example.test";
export const publicAddress = "93.184.216.34";

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
  // The destination's host names the test steers: what each resolves to, or
  // that it cannot be resolved. A name with no answer is unresolvable.
  const hosts = new Map<string, readonly string[] | "unresolvable">();
  const resolverCalls: string[] = [];
  const resolve: HostResolver = (hostname) => {
    resolverCalls.push(hostname);
    const answer = hosts.get(hostname);
    return answer === undefined || answer === "unresolvable"
      ? Promise.reject(new HostUnresolvable())
      : Promise.resolve(answer);
  };
  const fixture = await openInstallationFixture(true, {
    secretsKey: { file, keyId: "backup-settings-fixture-key-v1" },
    backupDestinationProbe: options.realProbe ? undefined : probe,
    backupDestinationResolver: resolve,
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
    resolverCalls,
    setProbe: (next: Probe) => {
      behave = next;
    },
    /** What `hostname` resolves to from now on, or "unresolvable". */
    setHost: (hostname: string, answer: readonly string[] | "unresolvable") => {
      hosts.set(hostname, answer);
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

export { startS3Receiver } from "./s3-receiver.ts";
