import { assert, assertEquals } from "@std/assert";
import { startS3Receiver } from "../helpers/s3-receiver.ts";

/**
 * The runner as the host runs it: a `deno run` subprocess started from
 * apps/server with exactly the permission flags that scripts/deploy/runtime.sh
 * ships for its `backup-runner` action (only the backups directory is pointed
 * at a temporary one, and the run grant for backup.sh is left out because the
 * stand-in entry has no script to start). A permission the real unit lacks
 * therefore fails here, not on a production host.
 */

const TOKEN = "runner-credential-0123456789abcdef0123456789";
const LEASE = "lease-token-0123456789abcdef0123456789abcd";
const KEY_ID = "AKIAEXAMPLEKEY123456";
const KEY_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const RUN = "11111111-1111-4111-8111-111111111111";

const repository = new URL("../../", import.meta.url).pathname;

/** The flags of the shipped `exec deno run` line, tokens as the shell would see them. */
async function shippedFlags(): Promise<string[]> {
  const text = await Deno.readTextFile(
    `${repository}scripts/deploy/runtime.sh`,
  );
  const start = text.indexOf("  backup-runner)");
  assert(start >= 0, "runtime.sh has no backup-runner action");
  const block = text.slice(start, text.indexOf("    ;;", start));
  const line = block.split("\n").find((l) => l.includes("exec deno run"));
  assert(line !== undefined, "the backup-runner action does not exec deno run");
  return line.trim().split(/\s+/).map((t) => t.replace(/^"|"$/g, "")).filter((
    t,
  ) => t.startsWith("--"));
}

Deno.test("the shipped permission flags are scoped: no blanket grants, one fixed script", async () => {
  const flags = await shippedFlags();
  const names = flags.map((f) => f.split("=")[0]);
  assertEquals(names.sort(), [
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "--allow-run",
    "--allow-sys",
    "--allow-write",
    "--no-prompt",
  ]);
  const scoped = (name: string) => flags.find((f) => f.startsWith(`${name}=`));
  // Files: only the backups directory, for reading the set and for retention.
  assertEquals(scoped("--allow-read"), "--allow-read=/var/lib/bakery/backups");
  assertEquals(
    scoped("--allow-write"),
    "--allow-write=/var/lib/bakery/backups",
  );
  // Processes: exactly the one fixed script, never a shell or a general launcher.
  assertEquals(scoped("--allow-run"), "--allow-run=$root/deploy/backup.sh");
  // The AWS SDK reads the OS release for its user-agent; nothing else of the system.
  assertEquals(scoped("--allow-sys"), "--allow-sys=osRelease");
  assert(!flags.some((f) => /^(-A|--allow-all|--allow-ffi)/.test(f)));
});

function fakeApi(options: {
  claim: boolean;
  receiverEndpoint: string;
}) {
  const seen = {
    claims: 0,
    maintain: 0,
    cutoff: 0,
    settings: 0,
    reports: [] as { sequence: number; body: Record<string, unknown> }[],
    auth: new Set<string | null>(),
  };
  let claimed = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      seen.auth.add(request.headers.get("authorization"));
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return Response.json({ code: "AUTH_FORBIDDEN" }, { status: 403 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/claims")) {
        seen.claims++;
        if (options.claim && !claimed) {
          claimed = true;
          return Response.json({
            claimed: true,
            runId: RUN,
            leaseToken: LEASE,
            leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            triggerKind: "manual",
          });
        }
        return Response.json({
          claimed: false,
          runId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          triggerKind: null,
        });
      }
      if (
        request.method === "POST" && url.pathname.endsWith("/maintenance")
      ) {
        seen.maintain++;
        return Response.json({
          state: "quiesced",
          runId: RUN,
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          liveAttempts: 0,
          openTransactions: 0,
          retryAfterSeconds: 0,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/cutoff")) {
        seen.cutoff++;
        return Response.json({
          runId: RUN,
          cutoffAt: "2026-11-20T12:00:03.250Z",
          effectsTotal: 0,
          effectsPrepared: 0,
          effectsSubmitted: 0,
          effectsUncertain: 0,
          effectsByOperation: [],
          effectsDigest:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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
          offsiteEndpoint: options.receiverEndpoint,
          offsiteRegion: "us-east-1",
          offsiteBucket: "bakery-backups",
          offsitePrefix: "prod/",
          offsiteAccessKeyId: KEY_ID,
          offsiteSecretAccessKey: KEY_SECRET,
          offsiteRefusal: null,
          offsiteVersion: 1,
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/reports")) {
        const body = await request.json() as Record<string, unknown>;
        seen.reports.push({ sequence: Number(body.sequence), body });
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    },
  );
  return {
    seen,
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    stop: () => server.shutdown(),
  };
}

async function runProcess(apiUrl: string, root: string) {
  const flags = (await shippedFlags())
    // The stand-in entry starts no script, so the run grant is not needed here.
    .filter((f) => !f.startsWith("--allow-run"))
    .map((f) => f.replaceAll("/var/lib/bakery/backups", root));
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...flags, "../../tests/helpers/backup-runner-entry.ts"],
    cwd: `${repository}apps/server`,
    env: {
      BAKERY_API_URL: apiUrl,
      BAKERY_BACKUP_RUNNER_TOKEN: TOKEN,
      BAKERY_ENV: "test",
      STUB_BACKUPS_ROOT: root,
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

Deno.test("under the shipped flags the runner claims, backs up, uploads, verifies and completes", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-runner-proc-" });
  const receiver = startS3Receiver();
  const api = fakeApi({ claim: true, receiverEndpoint: receiver.endpoint });
  try {
    const { code, text } = await runProcess(api.url, root);
    assertEquals(
      code,
      0,
      `${text}\nlast report: ${JSON.stringify(api.seen.reports.at(-1)?.body)}`,
    );
    assert(!/NotCapable|Requires .* access|PermissionDenied/i.test(text), text);
    assertEquals(api.seen.claims, 1);
    // The installation is held once, before settings are read.
    assertEquals(api.seen.maintain, 1);
    // The cutoff is asked for once, after the installation is quiet.
    assertEquals(api.seen.cutoff, 1);
    assertEquals(api.seen.settings, 1);
    const last = api.seen.reports.at(-1)!.body;
    assertEquals(last.status, "completed");
    assertEquals(last.locations, ["server-host", "off-site"]);
    api.seen.reports.forEach((r, i) => assertEquals(r.sequence, i + 1));
    const prefix =
      "/bakery-backups/prod/20261120T030000Z-00000000-0000-4000-8000-000000000001/";
    assertEquals(
      [...receiver.objects.keys()].filter((k) => k.startsWith(prefix)).length,
      3,
    );
    // Nothing the process printed carries a credential, lease token or key.
    for (const secret of [TOKEN, LEASE, KEY_ID, KEY_SECRET]) {
      assert(!text.includes(secret), `output leaked ${secret.slice(0, 6)}…`);
    }
  } finally {
    await api.stop();
    await receiver.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("under the shipped flags an idle pass makes one claim and nothing else", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-runner-proc-" });
  const receiver = startS3Receiver();
  const api = fakeApi({ claim: false, receiverEndpoint: receiver.endpoint });
  try {
    const { code, text } = await runProcess(api.url, root);
    assertEquals(code, 0, text);
    assertEquals(api.seen.claims, 1);
    assertEquals(api.seen.settings, 0);
    assertEquals(api.seen.reports.length, 0);
    assertEquals(receiver.requests.length, 0);
  } finally {
    await api.stop();
    await receiver.stop();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a missing or short credential stops before any request", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-runner-proc-" });
  const api = fakeApi({ claim: true, receiverEndpoint: "http://127.0.0.1:1" });
  try {
    const flags = (await shippedFlags()).filter((f) =>
      !f.startsWith("--allow-run")
    ).map((f) => f.replaceAll("/var/lib/bakery/backups", root));
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...flags, "../../tests/helpers/backup-runner-entry.ts"],
      cwd: `${repository}apps/server`,
      env: {
        BAKERY_API_URL: api.url,
        BAKERY_BACKUP_RUNNER_TOKEN: "too-short",
        STUB_BACKUPS_ROOT: root,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 64);
    assertEquals(api.seen.claims, 0);
    assert(
      !new TextDecoder().decode(output.stderr).includes("too-short"),
    );
  } finally {
    await api.stop();
    await Deno.remove(root, { recursive: true });
  }
});
