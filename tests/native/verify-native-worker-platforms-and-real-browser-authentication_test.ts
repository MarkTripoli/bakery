import { assert, assertEquals, assertMatch } from "@std/assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  BootstrapError,
  environmentFilePath,
  environmentFileText,
  installFromOrigin,
  LINUX_SERVICE,
  LINUX_UNIT_PATH,
  linuxServiceState,
  pairInstallation,
  planLinuxService,
  type ReleaseConfig,
  renderSystemdUnit,
  type ServiceSpec,
  SUPPORTED_TARGETS,
  TOKEN_FILE,
} from "../../packages/worker-bootstrap/src/index.ts";

// #52 (B15.06): the rendered Linux service run for real. The bootstrap installs
// and pairs a signed release on this host; the plan's own commands then create
// the account and root inside a disposable systemd container, the rendered unit
// starts the worker, and the service is killed, restarted, frozen (a sleep),
// upgraded and rebooted. Nothing touches the host's own service manager: the
// container is the machine, and it is removed by its exact name at the end.
// The same file runs on Linux x64 and on Linux arm64 (agx64); a target joins
// SUPPORTED_TARGETS only after this file is green on a real host of it.

const IMAGE = "bakery-native-systemd:trixie";
const DOCKERFILE = [
  "FROM debian:trixie-slim",
  "RUN apt-get update \\",
  " && apt-get install -y --no-install-recommends systemd systemd-sysv dbus passwd procps \\",
  " && rm -rf /var/lib/apt/lists/*",
  'CMD ["/sbin/init"]',
  "",
].join("\n");
const ROOT = "/opt/bakery-worker";
const ACCOUNT = "bakery-worker";
const SECRET = "bk_setup_5e2c9a7d1b3f4e60";
const DAY = 24 * 60 * 60 * 1000;
const ARCH = ({ x64: "x64", arm64: "arm64" } as Record<string, string>)[
  process.arch
];
const TARGET = `linux-${ARCH}`;
const PREVIEW = {
  enrollmentId: "00000000-0000-4000-8000-0000000000e2",
  organizationName: "Acme",
  name: "build-linux-native",
  os: "linux",
  architecture: ARCH,
  slots: 1,
  capabilities: ["git", "shell"],
  expiresAt: new Date(Date.now() + DAY).toISOString(),
  state: "pending",
};

/**
 * The stand-in worker: a real program the unit starts, which reports who runs
 * it, its umask and its release, and beats once every 200 ms. The release
 * string is part of the signed bytes, so an upgrade is visible in the beat.
 */
function workerScript(release: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode([
    "#!/bin/sh",
    "set -eu",
    "while :; do",
    `  printf '%s %s %s %s %s\\n' "$(id -un)" "$(umask)" "$$" "$(date +%s%N)" "${release}" > heartbeat.tmp`,
    "  mv heartbeat.tmp heartbeat",
    "  sleep 0.2",
    "done",
    "",
  ].join("\n"));
}

const sha = (bytes: Uint8Array<ArrayBuffer>) =>
  createHash("sha256").update(bytes).digest("hex");

const key = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }))
    .subarray(-32);
  return {
    keyId: "native-52",
    privateKey,
    trust: { keyId: "native-52", publicKey: raw.toString("base64") },
  };
})();

function signedManifest(
  release: string,
  binary: Uint8Array<ArrayBuffer>,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      release,
      issuedAt: new Date(Date.now() - DAY).toISOString(),
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      protocol: { min: 3, max: 4 },
      stateFormat: 2,
      targets: {
        [TARGET]: {
          file: `bakery-worker-${release}-${TARGET}`,
          size: binary.byteLength,
          sha256: sha(binary),
        },
      },
    }),
    "utf8",
  );
  return JSON.stringify({
    keyId: key.keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key.privateKey).toString("base64"),
  });
}

/** A loopback release origin; `cut` releases answer with half the bytes. */
function releaseOrigin(cut: ReadonlySet<string>) {
  const abort = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abort.signal,
    onListen: () => undefined,
  }, (request) => {
    const path = new URL(request.url).pathname;
    const release = /^\/releases\/([^/]+)\//.exec(path)?.[1] ?? "";
    const binary = workerScript(release);
    if (path.endsWith("/manifest.json")) {
      return new Response(signedManifest(release, binary));
    }
    if (cut.has(release)) {
      return new Response(binary.subarray(0, binary.byteLength >> 1), {
        headers: { "content-length": String(binary.byteLength >> 1) },
      });
    }
    return new Response(binary);
  });
  return {
    origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: async () => {
      abort.abort();
      await server.finished.catch(() => undefined);
    },
  };
}

function config(origin: string): ReleaseConfig {
  return { origin, trustRoot: [key.trust], protocol: 3, stateFormat: 2 };
}

type Run = { code: number; out: string };

function run(program: string, args: readonly string[], input?: string): Run {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    input,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function must(program: string, args: readonly string[], input?: string) {
  const result = run(program, args, input);
  if (result.code !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} exited ${result.code}: ${result.out}`,
    );
  }
  return result.out;
}

const container = `bakery-native-52-${crypto.randomUUID().slice(0, 8)}`;
const inside = (...args: string[]) =>
  must("docker", ["exec", container, ...args]).trim();
const tryInside = (...args: string[]) =>
  run("docker", ["exec", container, ...args]);

async function until<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Beat = {
  user: string;
  umask: string;
  pid: number;
  at: bigint;
  release: string;
};

function beat(): Beat | undefined {
  const read = tryInside("cat", `${ROOT}/heartbeat`);
  const parts = read.out.trim().split(" ");
  if (read.code !== 0 || parts.length !== 5) return undefined;
  return {
    user: parts[0]!,
    umask: parts[1]!,
    pid: Number(parts[2]),
    at: BigInt(parts[3]!),
    release: parts[4]!,
  };
}

/** The service as the bootstrap's own status probe reads it. */
function serviceState() {
  const shown = tryInside(
    "systemctl",
    "show",
    LINUX_SERVICE,
    "--property=LoadState,ActiveState,MainPID,NRestarts,FreezerState",
  );
  const fields = Object.fromEntries(
    shown.out.trim().split("\n").map((line) => line.split("=", 2)),
  );
  return {
    state: linuxServiceState(shown.out, shown.code),
    mainPid: Number(fields.MainPID ?? 0),
    restarts: Number(fields.NRestarts ?? 0),
    freezer: fields.FreezerState ?? "",
  };
}

async function freshBeat(after: bigint, release?: string): Promise<Beat> {
  return await until("a fresh heartbeat", () => {
    const seen = beat();
    return seen && seen.at > after && (!release || seen.release === release)
      ? seen
      : undefined;
  });
}

/** Copies the host's install root into the machine as the plan's service account would hold it. */
function ship(hostRoot: string) {
  must("docker", ["cp", `${hostRoot}/.`, `${container}:${ROOT}/`]);
  inside("chown", "-R", `${ACCOUNT}:${ACCOUNT}`, ROOT);
}

Deno.test({
  name:
    "the rendered systemd unit runs a verified, paired worker and recovers from kill, restart, freeze, upgrade and reboot",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    assert(ARCH, `no Linux target for ${process.arch}`);
    assert(
      (SUPPORTED_TARGETS as readonly string[]).includes(TARGET),
      `${TARGET} is not in SUPPORTED_TARGETS: run this file with it added, and add it only if this file is green`,
    );
    must("docker", ["build", "--quiet", "-t", IMAGE, "-"], DOCKERFILE);
    const hostRoot = await mkdtemp(join(tmpdir(), "bakery-native-52-"));
    await chmod(hostRoot, 0o700);
    const releases = releaseOrigin(new Set(["1.0.2"]));
    const bakery = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => undefined },
      () => Response.json(PREVIEW),
    );
    const spec: ServiceSpec = {
      root: ROOT,
      account: ACCOUNT,
      settings: { BAKERY_SERVER_URL: "https://bakery.example" },
    };
    try {
      must("docker", [
        "run",
        "--detach",
        "--name",
        container,
        "--privileged",
        "--stop-signal",
        "SIGRTMIN+3",
        "--cgroupns=private",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/run/lock",
        IMAGE,
      ]);
      await until("systemd to boot", () => {
        const state = tryInside("systemctl", "is-system-running").out.trim();
        return state === "running" || state === "degraded" ? state : undefined;
      }, 60_000);

      await t.step(
        "the bootstrap installs a signed release and pairs it; the code file is owner-only",
        async () => {
          const installed = await installFromOrigin({
            root: hostRoot,
            release: "1.0.0",
            config: config(releases.origin),
            fetch,
            now: new Date(),
            platform: "linux",
            arch: ARCH!,
          });
          assertEquals(installed.release, "1.0.0");
          const codeFile = `${hostRoot}.code`;
          await writeFile(codeFile, `${SECRET}\n`, { mode: 0o600 });
          try {
            const paired = await pairInstallation({
              root: hostRoot,
              serverUrl: `http://localhost:${
                (bakery.addr as Deno.NetAddr).port
              }`,
              readToken: async () => (await readFile(codeFile, "utf8")).trim(),
              confirm: () => Promise.resolve(true),
              fetch: (input, init) =>
                fetch(
                  String(input instanceof Request ? input.url : input).replace(
                    "//localhost:",
                    "//127.0.0.1:",
                  ),
                  init,
                ),
              now: new Date(),
            });
            assertEquals(paired.status, "paired");
          } finally {
            await rm(codeFile, { force: true });
          }
        },
      );

      await t.step(
        "the plan's own commands create the dedicated account and an owner-only root",
        () => {
          for (const change of planLinuxService(spec)) {
            if (change.actor === "administrator" && change.command) {
              if (change.command[0] === "systemctl") continue;
              inside(...change.command);
            }
          }
          assertEquals(inside("stat", "-c", "%U %a", ROOT), `${ACCOUNT} 700`);
          assertEquals(
            inside("getent", "passwd", ACCOUNT).split(":")[6],
            "/usr/sbin/nologin",
          );
        },
      );

      await t.step(
        "secret and settings files are mode 0600 and owned by the service account",
        () => {
          ship(hostRoot);
          must("docker", [
            "exec",
            "-i",
            "--user",
            ACCOUNT,
            container,
            "sh",
            "-c",
            `umask 077 && cat > ${environmentFilePath(ROOT)}`,
          ], environmentFileText(spec));
          for (
            const file of [environmentFilePath(ROOT), `${ROOT}/${TOKEN_FILE}`]
          ) {
            assertEquals(
              inside("stat", "-c", "%U %a", file),
              `${ACCOUNT} 600`,
              file,
            );
          }
          assertEquals(inside("cat", `${ROOT}/${TOKEN_FILE}`), SECRET);
        },
      );

      await t.step(
        "the rendered unit installs and starts the worker as the service account with umask 0077",
        async () => {
          must("docker", [
            "exec",
            "-i",
            container,
            "sh",
            "-c",
            `cat > ${LINUX_UNIT_PATH}`,
          ], renderSystemdUnit(spec));
          assertEquals(
            inside("stat", "-c", "%U %a", LINUX_UNIT_PATH),
            "root 644",
          );
          assertEquals(
            tryInside("systemd-analyze", "verify", LINUX_UNIT_PATH).out
              .includes("Unknown key"),
            false,
          );
          for (const change of planLinuxService(spec)) {
            if (change.command?.[0] === "systemctl") inside(...change.command);
          }
          const first = await freshBeat(0n, "1.0.0");
          assertEquals(first.user, ACCOUNT);
          assertEquals(first.umask, "0077");
          assertEquals(serviceState().state, "active");
          assertEquals(
            inside("systemctl", "is-enabled", LINUX_SERVICE),
            "enabled",
          );
          assertEquals(
            inside("stat", "-c", "%U %a", `${ROOT}/heartbeat`),
            `${ACCOUNT} 600`,
          );
        },
      );

      await t.step("a killed worker is restarted by systemd", async () => {
        const before = serviceState();
        inside("kill", "-KILL", String(before.mainPid));
        const after = await until("a restarted main process", () => {
          const now = serviceState();
          return now.state === "active" && now.mainPid > 0 &&
              now.mainPid !== before.mainPid
            ? now
            : undefined;
        });
        assertEquals(after.restarts, before.restarts + 1);
        assertEquals((await freshBeat(0n)).pid, after.mainPid);
      });

      await t.step(
        "a restart replaces the process and the service stays active",
        async () => {
          const before = serviceState();
          inside("systemctl", "restart", LINUX_SERVICE);
          const after = serviceState();
          assertEquals(after.state, "active");
          assert(after.mainPid !== before.mainPid);
          assertEquals(
            (await until("the new process's beat", () => {
              const seen = beat();
              return seen?.pid === after.mainPid ? seen : undefined;
            })).user,
            ACCOUNT,
          );
        },
      );

      await t.step(
        "a frozen service (the machine asleep) stops beating and resumes on thaw",
        async () => {
          const before = serviceState();
          inside("systemctl", "freeze", LINUX_SERVICE);
          assertEquals(serviceState().freezer, "frozen");
          const frozenAt = (await freshBeat(0n)).at;
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          assertEquals(beat()?.at, frozenAt, "no beat while frozen");
          inside("systemctl", "thaw", LINUX_SERVICE);
          const resumed = await freshBeat(frozenAt);
          assertEquals(resumed.pid, before.mainPid, "the same process resumes");
          assertEquals(serviceState().state, "active");
        },
      );

      await t.step(
        "an upgrade to a new signed release is picked up on restart",
        async () => {
          const upgraded = await installFromOrigin({
            root: hostRoot,
            release: "1.0.1",
            config: config(releases.origin),
            fetch,
            now: new Date(),
            platform: "linux",
            arch: ARCH!,
            upgrade: true,
          });
          assertEquals(upgraded.release, "1.0.1");
          ship(hostRoot);
          inside("systemctl", "restart", LINUX_SERVICE);
          assertEquals((await freshBeat(0n, "1.0.1")).user, ACCOUNT);
        },
      );

      await t.step(
        "a canceled download leaves the running release unchanged",
        async () => {
          let code = "no error";
          try {
            await installFromOrigin({
              root: hostRoot,
              release: "1.0.2",
              config: config(releases.origin),
              fetch,
              now: new Date(),
              platform: "linux",
              arch: ARCH!,
              upgrade: true,
            });
          } catch (error) {
            if (!(error instanceof BootstrapError)) throw error;
            code = error.code;
          }
          assertMatch(code, /^ARTIFACT_(DOWNLOAD_INTERRUPTED|SIZE_MISMATCH)$/);
          assertEquals(
            await Deno.readLink(join(hostRoot, "current")),
            `releases/1.0.1-${TARGET}`,
          );
          ship(hostRoot);
          inside("systemctl", "restart", LINUX_SERVICE);
          assertEquals((await freshBeat(0n)).release, "1.0.1");
        },
      );

      await t.step(
        "a reboot brings the enabled service back by itself",
        async () => {
          must("docker", ["restart", "--time", "20", container]);
          await until("systemd to boot again", () => {
            const state = tryInside("systemctl", "is-system-running").out
              .trim();
            return state === "running" || state === "degraded"
              ? state
              : undefined;
          }, 60_000);
          const back = await until("the service after reboot", () => {
            const now = serviceState();
            return now.state === "active" ? now : undefined;
          });
          assertEquals((await freshBeat(0n, "1.0.1")).pid, back.mainPid);
        },
      );

      await t.step(
        "a stop ends every process in the service's control group",
        () => {
          inside("systemctl", "stop", LINUX_SERVICE);
          assertEquals(serviceState().state, "inactive");
          assertEquals(
            tryInside("pgrep", "-u", ACCOUNT).code,
            1,
            "no process left",
          );
        },
      );
    } finally {
      run("docker", ["rm", "--force", "--volumes", container]);
      await releases.close();
      await bakery.shutdown();
      await rm(hostRoot, { recursive: true, force: true });
    }
  },
});
