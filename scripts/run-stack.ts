import {
  type CgroupLease,
  provisionDelegatedCgroupV2,
} from "./lib/cgroup-v2.ts";
import {
  readWorkerLaunchPermissions,
  WORKER_RUNTIME_ENVIRONMENT_NAMES,
} from "../apps/worker/src/config.ts";

export type StackMode = "dev" | "start";

export type Service = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly clearEnv: boolean;
  readonly env: Readonly<Record<string, string>>;
};

function readWebHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (/\s/.test(host)) throw new Error("WEB_HOST_INVALID");
  return host;
}

function readWebPort(value: string | undefined): number {
  const source = value?.trim() || "5173";
  if (!/^\d+$/.test(source)) throw new Error("WEB_PORT_INVALID");
  const port = Number(source);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WEB_PORT_INVALID");
  }
  return port;
}

function selectEnvironment(
  inherited: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    names
      .filter((name) => inherited[name] !== undefined)
      .map((name) => [name, inherited[name]]),
  );
}

export function createStackServices({
  mode,
  root,
  inherited,
  denoPath,
}: {
  mode: StackMode;
  root: string;
  inherited: Record<string, string>;
  denoPath: string;
}): readonly Service[] {
  const webHost = readWebHost(inherited.BAKERY_WEB_HOST);
  const webPort = readWebPort(inherited.BAKERY_WEB_PORT);
  const webEnv = selectEnvironment(inherited, [
    "PATH",
    "HOME",
    "TMPDIR",
    "BAKERY_WEB_HOST",
    "BAKERY_WEB_PORT",
    "BAKERY_SERVER_HOST",
    "BAKERY_SERVER_PORT",
    "BAKERY_ENV",
    "VITE_SENTRY_DSN",
    "VITE_SENTRY_ENABLED",
    "VITE_SENTRY_ENVIRONMENT",
    "VITE_SENTRY_RELEASE",
    "VITE_SENTRY_TRACES_SAMPLE_RATE",
    ...(mode === "start"
      // `start` builds before it previews, so an instrumented local build
      // needs its upload declaration along with the target and token.
      ? [
        "SENTRY_UPLOAD_SOURCEMAPS",
        "SENTRY_AUTH_TOKEN",
        "SENTRY_ORG",
        "SENTRY_PROJECT",
      ]
      : []),
  ]);
  webEnv.BAKERY_WEB_HOST = webHost;
  webEnv.BAKERY_WEB_PORT = String(webPort);

  const services: Service[] = [{
    command: "bash",
    args: ["scripts/run-main.sh"],
    cwd: `${root}apps/server`,
    clearEnv: false,
    env: inherited,
  }];

  if (inherited.BAKERY_WORKER_PROFILE?.trim() === "worker") {
    const workerHost = inherited.BAKERY_SERVER_HOST?.trim() || "127.0.0.1";
    const workerPort = inherited.BAKERY_SERVER_PORT?.trim() || "8000";
    const workerEnvironmentNames = inherited.BAKERY_ENV?.trim() === "production"
      ? WORKER_RUNTIME_ENVIRONMENT_NAMES.filter((name) =>
        name !== "BAKERY_WORKER_NATIVE_SMOKE"
      )
      : WORKER_RUNTIME_ENVIRONMENT_NAMES;
    const workerEnv = selectEnvironment(inherited, workerEnvironmentNames);
    workerEnv.BAKERY_SERVER_URL ||= `http://${workerHost}:${workerPort}`;
    workerEnv.BAKERY_WORKER_CAPABILITIES ||= "git";
    const permissions = readWorkerLaunchPermissions(workerEnv, root);
    const denoCommand = [
      "run",
      "--no-prompt",
      "--preload=src/cgroup-permission-preload.ts",
      `--allow-env=${workerEnvironmentNames.join(",")}`,
      `--allow-read=${permissions.read.join(",")}`,
      `--allow-write=${permissions.write.join(",")}`,
      `--allow-run=${permissions.run.join(",")}`,
      `--allow-net=${permissions.net.join(",")}`,
      `--allow-sys=${permissions.sys.join(",")}`,
      "src/main.ts",
    ] as const;
    services.push({
      command: denoPath,
      args: denoCommand,
      cwd: `${root}apps/worker`,
      clearEnv: true,
      env: workerEnv,
    });
  }

  services.push({
    command: "pnpm",
    args: ["--filter", "@bakery/web", mode],
    cwd: root,
    clearEnv: true,
    env: webEnv,
  });
  return services;
}

async function runStack(mode: StackMode): Promise<never> {
  const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
  const inherited = Deno.env.toObject();
  let cgroupLease: CgroupLease | undefined;
  if (
    inherited.BAKERY_WORKER_PROFILE?.trim() === "worker" &&
    !inherited.BAKERY_WORKER_CGROUP_ROOT?.trim()
  ) {
    cgroupLease = await provisionDelegatedCgroupV2();
    inherited.BAKERY_WORKER_CGROUP_ROOT = cgroupLease.root;
  }
  let services: readonly Service[];
  try {
    services = createStackServices({
      mode,
      root,
      inherited,
      denoPath: Deno.execPath(),
    });
  } catch (error) {
    await cgroupLease?.release();
    throw error;
  }
  let children: Deno.ChildProcess[];
  try {
    children = services.map((service) =>
      new Deno.Command(service.command, {
        args: [...service.args],
        cwd: service.cwd,
        clearEnv: service.clearEnv,
        env: service.env,
        stdout: "inherit",
        stderr: "inherit",
      }).spawn()
    );
  } catch (error) {
    await cgroupLease?.release();
    throw error;
  }

  let stopping = false;
  let probing = false;
  let cgroupReleased = false;
  const parentPid = Deno.ppid;
  const releaseCgroup = async (): Promise<boolean> => {
    if (cgroupReleased || !cgroupLease) return true;
    cgroupReleased = true;
    try {
      await cgroupLease.release();
      return true;
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "WORKER_CGROUP_CLEANUP_FAILED",
      );
      return false;
    }
  };
  const monitor = setInterval(() => {
    if (stopping || parentPid <= 1 || probing) return;
    probing = true;
    void new Deno.Command("kill", {
      args: ["-0", String(parentPid)],
      stdout: "null",
      stderr: "null",
    }).output().then((result) => {
      if (!result.success) void stopAll("SIGTERM", 0);
    }).catch(() => void stopAll("SIGTERM", 1)).finally(() => probing = false);
  }, 250);

  async function stopAll(signal: Deno.Signal, exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the status check and the signal.
      }
    }
    const statuses = children.map((child) => child.status);
    await Promise.race([
      Promise.all(statuses),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already stopped.
      }
    }
    await Promise.all(statuses);
    const cleanupSucceeded = await releaseCgroup();
    Deno.exit(cleanupSucceeded ? exitCode : 1);
  }

  Deno.addSignalListener("SIGTERM", () => void stopAll("SIGTERM", 0));
  Deno.addSignalListener("SIGINT", () => void stopAll("SIGINT", 0));

  // pnpm does not forward SIGTERM to descendants. Reap the stack when its
  // parent disappears so root commands cannot strand a child service.
  const firstExit = await Promise.race(children.map((child) => child.status));
  if (!stopping) await stopAll("SIGTERM", firstExit.success ? 0 : 1);
  throw new Error("STACK_STOP_FAILED");
}

if (import.meta.main) {
  const mode = Deno.args[0];
  if (mode !== "dev" && mode !== "start") {
    console.error("Expected one of: dev, start");
    Deno.exit(2);
  }
  await runStack(mode);
}
