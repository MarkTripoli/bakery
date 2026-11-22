import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  accessKeyId,
  offsiteBody,
  offsitePath,
  openBackupSettingsFixture,
  runnerSettingsPath,
  schedulePath,
  secretAccessKey,
  verificationPath,
} from "../helpers/backup-settings.ts";

/**
 * #80 slice S1b: the off-site credential pair is write-only. After it is saved
 * no user-facing response, audit row, stored plaintext or log line carries it;
 * only the runner credential can read it back, and no session can. A developer
 * (not an installation administrator) and the runner credential reach none of
 * the administrator settings routes.
 */

const schedule = {
  enabled: true,
  interval: "daily",
  timeOfDayUtc: "03:00",
  daysToKeep: 30,
};

function captureConsole() {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        }).join(" "),
      );
    };
  }
  return {
    lines,
    restore: () => {
      methods.forEach((m, i) => (console[m] = original[i]));
    },
  };
}

Deno.test("the credential pair is in no response, audit row, stored plaintext or log line", async () => {
  const log = captureConsole();
  const o = await openBackupSettingsFixture();
  try {
    const bodies: string[] = [];
    const take = async (response: Response) => {
      bodies.push(await response.text());
      return response;
    };
    assertEquals(
      (await take(await o.putOffsite(offsiteBody()))).status,
      200,
    );
    assertEquals(
      (await take(
        await o.putOffsite(
          offsiteBody({
            bucket: "other-bucket",
            accessKeyId: "AKIASECONDACCESSKEY",
            secretAccessKey: "second/secret/value",
          }),
          { version: 1 },
        ),
      )).status,
      200,
    );
    await take(await o.admin("GET", offsitePath));
    await take(await o.admin("POST", verificationPath, {}, { keyed: true }));
    await take(await o.putSchedule(schedule));
    await take(await o.admin("GET", schedulePath));
    await take(await o.admin("GET", "/v1/installation/backups/status"));
    await take(await o.admin("GET", "/v1/installation/backups"));
    // A refused save names the cause but never the pair that was supplied.
    o.setProbe(() =>
      Promise.resolve({ outcome: "destination_refused", detail: "denied" })
    );
    await take(
      await o.putOffsite(
        offsiteBody({
          accessKeyId: "AKIAREFUSEDACCESSKEY",
          secretAccessKey: "refused/secret/value",
        }),
        { version: 2 },
      ),
    );
    // The runner's own read releases the CURRENT pair, by design and to the
    // runner credential only; that response is not scanned, but the audit row
    // and every log line it caused are.
    // Count what is already there: another file's fixture may have left runner
    // reads behind in the shared database, and this test owns only its own.
    const releasesBefore = (await o.f.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.audit_events
        where operation = 'backupRunner.settings'`,
    )).rows[0]!.n;
    const credential = await o.issueCredential();
    const released = await o.runner(credential, "GET", runnerSettingsPath);
    assertEquals(released.status, 200);
    const releasedBody = await released.json() as {
      offsiteSecretAccessKey: string;
    };
    assertEquals(releasedBody.offsiteSecretAccessKey, "second/secret/value");
    const runnerRows = await o.f.pgDatabase.query<{ text: string }>(
      `select details::text as text from bakery.audit_events
        where operation = 'backupRunner.settings'`,
    );
    assertEquals(
      runnerRows.rows.length - releasesBefore,
      1,
      "one release is one audit row",
    );
    const secrets = [
      accessKeyId,
      secretAccessKey,
      "AKIASECONDACCESSKEY",
      "second/secret/value",
      "AKIAREFUSEDACCESSKEY",
      "refused/secret/value",
    ];
    for (const body of bodies) {
      for (const secret of secrets) assert(!body.includes(secret), secret);
    }

    // Audit rows of every backup action hold no part of any pair.
    const audit = await o.f.pgDatabase.query<{ text: string }>(
      `select details::text as text from bakery.audit_events
        where operation like 'backup%'`,
    );
    assert(audit.rows.length >= 4);
    for (const row of audit.rows) {
      for (const secret of secrets) assert(!row.text.includes(secret), secret);
    }

    // The stored ciphertext is not the plaintext: no secret appears as bytes.
    const stored = await o.f.pgDatabase.query<{ ciphertext: Uint8Array }>(
      `select version.ciphertext from bakery.secret_versions version
         join bakery.secrets secret on secret.id = version.secret_id
        where secret.provider = 's3-backup'`,
    );
    assertEquals(stored.rows.length, 2);
    for (const row of stored.rows) {
      const text = new TextDecoder("latin1").decode(row.ciphertext);
      for (const secret of secrets) assert(!text.includes(secret), secret);
    }

    // And no log line, even for the refused save.
    for (const line of log.lines) {
      for (const secret of secrets) assert(!line.includes(secret), secret);
    }
  } finally {
    log.restore();
    await o.finish();
  }
});

Deno.test("a developer reaches none of the backup settings routes and nothing is stored or called", async () => {
  const o = await openBackupSettingsFixture();
  try {
    const cookie = o.f.developerCookie;
    const attempts: [string, string, unknown?][] = [
      ["GET", schedulePath],
      ["PUT", schedulePath, schedule],
      ["GET", offsitePath],
      ["PUT", offsitePath, offsiteBody()],
      ["POST", verificationPath, {}],
    ];
    for (const [method, path, body] of attempts) {
      const response = await o.admin(method, path, body, {
        cookie,
        keyed: method !== "GET",
      });
      assertEquals(response.status, 403, `${method} ${path}`);
      assertEquals(
        (await response.json() as { code: string }).code,
        "AUTH_FORBIDDEN",
      );
    }
    assertEquals(o.calls.length, 0);
    for (
      const table of ["backup_schedule_settings", "backup_offsite_settings"]
    ) {
      const count = await o.f.pgDatabase.query<{ count: string }>(
        `select count(*) from bakery.${table}`,
      );
      assertEquals(Number(count.rows[0].count), 0, table);
    }
  } finally {
    await o.finish();
  }
});

Deno.test("the runner credential reaches no administrator settings route", async () => {
  const o = await openBackupSettingsFixture();
  try {
    assertEquals((await o.putOffsite(offsiteBody())).status, 200);
    assertEquals((await o.putSchedule(schedule)).status, 200);
    const credential = await o.issueCredential();
    const attempts: [string, string, unknown?][] = [
      ["GET", schedulePath],
      ["PUT", schedulePath, { ...schedule, enabled: false }],
      ["GET", offsitePath],
      ["PUT", offsitePath, offsiteBody({ bucket: "taken-over" })],
      ["POST", verificationPath, {}],
      ["GET", "/v1/installation/backups"],
      ["POST", "/v1/installation/backup-runner/credential", {}],
    ];
    for (const [method, path, body] of attempts) {
      const response = await o.f.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            origin: authTestOrigin,
            "idempotency-key": crypto.randomUUID(),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      assert(
        response.status >= 400 && response.status < 500,
        `${method} ${path} -> ${response.status}`,
      );
      assert(!(await response.text()).includes(secretAccessKey));
    }
    // The refused calls changed nothing.
    const row = await o.f.pgDatabase.query<{ bucket: string; version: number }>(
      "select bucket, version from bakery.backup_offsite_settings",
    );
    assertEquals(row.rows[0], { bucket: "bakery-backups", version: 1 });
  } finally {
    await o.finish();
  }
});
