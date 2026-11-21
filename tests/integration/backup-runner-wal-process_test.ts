/**
 * #80 P1b: the backup runner's WAL pass as a process, under the exact Deno
 * flags runtime.sh ships, against a fake API and an S3 receiver. A stand-in
 * `age` on the PATH marks what it encrypted, so an unencrypted upload or a
 * dropped window report fails here. (Lifted from QA's #865 probes.)
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { startS3Receiver } from "../helpers/s3-receiver.ts";

const TOKEN = "runner-credential-0123456789abcdef0123456789";
const KEY_ID = "AKIAEXAMPLEKEY123456";
const KEY_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const SEG1 = "000000010000000000000041";
const SEG2 = "000000010000000000000042";
const repository = new URL("../../", import.meta.url).pathname;
const AGE_STUB = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "@@ARGS@@"',
  'for a in "$@"; do last=$a; done',
  'printf "AGE-ENCRYPTED:"',
  'cat "$last"',
  "",
].join("\n");

async function shippedFlags(): Promise<string[]> {
  const text = await Deno.readTextFile(
    repository + "scripts/deploy/runtime.sh",
  );
  const start = text.indexOf("  backup-runner)");
  const block = text.slice(start, text.indexOf("    ;;", start));
  const line = block.split("\n").find((l) => l.includes("exec deno run"))!;
  return line.trim().split(/\s+/).map((t) => t.replace(/^"|"$/g, "")).filter((
    t,
  ) => t.startsWith("--"));
}

function fakeApi(options: { endpoint: string; pointInTime: boolean }) {
  const seen = { claims: 0, settings: 0, wal: [] as Record<string, unknown>[] };
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== "Bearer " + TOKEN) {
      return Response.json({ code: "AUTH_FORBIDDEN" }, { status: 403 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/claims")) {
      seen.claims++;
      return Response.json({
        claimed: false,
        runId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        triggerKind: null,
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/settings")) {
      seen.settings++;
      return Response.json({
        scheduleEnabled: true,
        scheduleInterval: "daily",
        scheduleTimeOfDayUtc: "03:00",
        daysToKeep: 30,
        scheduleVersion: 1,
        offsiteConfigured: true,
        offsiteEndpoint: options.endpoint,
        offsiteRegion: "us-east-1",
        offsiteBucket: "bakery-backups",
        offsitePrefix: "prod/",
        offsiteAccessKeyId: KEY_ID,
        offsiteSecretAccessKey: KEY_SECRET,
        offsiteRefusal: null,
        offsiteVersion: 1,
        pointInTimeEnabled: options.pointInTime,
      });
    }
    if (
      request.method === "POST" && url.pathname.endsWith("/backup-runner/wal")
    ) {
      seen.wal.push(await request.json() as Record<string, unknown>);
      return Response.json({});
    }
    return new Response(null, { status: 404 });
  });
  return {
    seen,
    url: "http://127.0.0.1:" + (server.addr as Deno.NetAddr).port,
    stop: () => server.shutdown(),
  };
}

async function world(spoolFiles: Record<string, string>) {
  const root = await Deno.makeTempDir({ prefix: "bakery-wal-process-root-" });
  const spool = await Deno.makeTempDir({ prefix: "bakery-wal-process-spool-" });
  const bin = await Deno.makeTempDir({ prefix: "bakery-wal-process-bin-" });
  const envFile = join(root, "backup.env");
  await Deno.writeTextFile(
    envFile,
    'BAKERY_BACKUP_RECIPIENT="age1bakerywalrecipient"\n',
  );
  const argsLog = join(bin, "age.args");
  await Deno.writeTextFile(
    join(bin, "age"),
    AGE_STUB.replace("@@ARGS@@", argsLog),
  );
  await Deno.chmod(join(bin, "age"), 0o755);
  const set = "20261120T030000Z-00000000-0000-4000-8000-000000000001";
  await Deno.mkdir(join(root, set));
  await Deno.writeTextFile(join(root, set, "base.tar.age"), "base");
  for (const [name, text] of Object.entries(spoolFiles)) {
    const path = join(spool, name);
    await Deno.writeTextFile(path, text);
    const at = new Date(Date.UTC(2026, 10, 21, 10, name === SEG1 ? 0 : 1));
    await Deno.utime(path, at, at);
  }
  return { root, spool, bin, envFile, argsLog };
}

async function runRunnerProcess(
  w: Awaited<ReturnType<typeof world>>,
  apiUrl: string,
) {
  const flags = (await shippedFlags())
    .map((f) =>
      f.replaceAll("/var/lib/bakery/backups", w.root).replaceAll(
        "/var/lib/bakery/wal-spool",
        w.spool,
      ).replaceAll("/etc/bakery/backup.env", w.envFile)
    )
    .map((f) => f.startsWith("--allow-run") ? "--allow-run=age" : f);
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...flags, "../../tests/helpers/backup-runner-wal-entry.ts"],
    cwd: repository + "apps/server",
    env: {
      BAKERY_API_URL: apiUrl,
      BAKERY_BACKUP_RUNNER_TOKEN: TOKEN,
      BAKERY_ENV: "test",
      STUB_BACKUPS_ROOT: w.root,
      STUB_WAL_SPOOL: w.spool,
      STUB_BACKUP_ENV: w.envFile,
      PATH: w.bin + ":" + Deno.env.get("PATH"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    text: new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr),
  };
}

const left = async (dir: string) => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
};
const cleanup = async (w: Awaited<ReturnType<typeof world>>) => {
  await Deno.remove(w.root, { recursive: true });
  await Deno.remove(w.spool, { recursive: true });
  await Deno.remove(w.bin, { recursive: true });
};

Deno.test("switch on, under the shipped flags: spooled WAL is encrypted, uploaded, removed, and the window reported", async () => {
  const w = await world({
    [SEG1]: "wal-one-plaintext",
    [SEG2]: "wal-two-plaintext",
    "stray.tmp": "x",
    [SEG1 + ".00000028.backup"]: "label-plaintext",
  });
  const receiver = startS3Receiver();
  const api = fakeApi({ endpoint: receiver.endpoint, pointInTime: true });
  try {
    const r = await runRunnerProcess(w, api.url);
    const keys = [...receiver.objects.keys()].filter((k) => k.includes("/wal/"))
      .sort();
    const bodies = keys.map((k) =>
      new TextDecoder().decode(receiver.objects.get(k)!)
    );
    assertEquals(r.code, 0, r.text);
    assert(
      !/NotCapable|Requires .* access|PermissionDenied/i.test(r.text),
      r.text,
    );
    assertEquals(
      keys,
      [
        "/bakery-backups/prod/wal/" + SEG1 + ".00000028.backup.age",
        "/bakery-backups/prod/wal/" + SEG1 + ".age",
        "/bakery-backups/prod/wal/" + SEG2 + ".age",
      ].sort(),
    );
    for (const b of bodies) {
      assert(
        b.startsWith("AGE-ENCRYPTED:"),
        "uploaded body is not the encrypted form: " + b,
      );
    }
    assertEquals(await left(w.spool), ["stray.tmp"]);
    assertEquals(api.seen.wal.length, 1);
    assertEquals(api.seen.wal[0].latestSegment, SEG2);
    assertEquals(
      api.seen.wal[0].earliestBaseBackupAt,
      "2026-11-20T03:00:00.000Z",
    );
    for (const secret of [TOKEN, KEY_ID, KEY_SECRET]) {
      assert(!r.text.includes(secret), "output leaked a secret");
    }
  } finally {
    await api.stop();
    await receiver.stop();
    await cleanup(w);
  }
});

Deno.test("switch off, under the shipped flags: the spool is only pruned, nothing uploaded or reported", async () => {
  const w = await world({ [SEG1]: "one", [SEG2]: "two" });
  const receiver = startS3Receiver();
  const api = fakeApi({ endpoint: receiver.endpoint, pointInTime: false });
  try {
    const r = await runRunnerProcess(w, api.url);
    assertEquals(r.code, 0, r.text);
    assertEquals(await left(w.spool), []);
    assertEquals(receiver.signedRequests, []);
    assertEquals(api.seen.wal.length, 0);
    assertEquals(
      await Deno.stat(w.argsLog).then(() => true, () => false),
      false,
    );
  } finally {
    await api.stop();
    await receiver.stop();
    await cleanup(w);
  }
});

Deno.test("the destination refuses an upload: the spool is kept, the pass fails, nothing is reported", async () => {
  const w = await world({ [SEG1]: "one", [SEG2]: "two" });
  const receiver = startS3Receiver({ failPutUnder: "/wal/" });
  const api = fakeApi({ endpoint: receiver.endpoint, pointInTime: true });
  try {
    const r = await runRunnerProcess(w, api.url);
    assert(r.code !== 0, "a failed shipment must not exit 0");
    assertEquals(await left(w.spool), [SEG1, SEG2]);
    assertEquals(api.seen.wal.length, 0);
  } finally {
    await api.stop();
    await receiver.stop();
    await cleanup(w);
  }
});
