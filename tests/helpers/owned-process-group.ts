import type { WorkerShutdownReceipt } from "../../apps/worker/src/shutdown-receipt.ts";
import { parseWorkerShutdownReceipt } from "../../apps/worker/src/shutdown-receipt.ts";

export type OwnedSystemdUnitStatus = Readonly<{
  success: boolean;
  code: number;
}>;

export type OwnedSystemdUnitStop = Readonly<{
  status: OwnedSystemdUnitStatus;
  forced: boolean;
  workerShutdownReceipt?: WorkerShutdownReceipt;
}>;

export type OwnedSystemdUnitCommand = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  bindToUnit?: string;
  workerShutdownReceipt?: Readonly<{
    path: string;
    launchId: string;
  }>;
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
}>;

const OWNED_SYSTEMD_UNIT = Symbol("owned-systemd-unit");
const TIMEOUT = Symbol("owned-systemd-unit-timeout");
const START_TIMEOUT_MS = 5_000;

type OwnedSystemdUnit = Readonly<{
  [OWNED_SYSTEMD_UNIT]: true;
}>;

type UnitState = Readonly<{
  loadState: string;
  activeState: string;
  subState: string;
  invocationId: string;
  description: string;
}>;

type OwnedSystemdUnitRuntime = {
  unitName: string;
  description: string;
  invocationId: string;
  expectedWorkerShutdownReceipt?: Readonly<{
    path: string;
    launchId: string;
  }>;
  output: { value: string };
  completion: Promise<OwnedSystemdUnitStatus>;
  completeForced: () => void;
  statusSettled: () => boolean;
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
  stop?: Promise<OwnedSystemdUnitStop>;
};

const runtimes = new WeakMap<OwnedSystemdUnit, OwnedSystemdUnitRuntime>();

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  if (timeoutMs <= 0) return TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collectOutput(
  stream: ReadableStream<Uint8Array>,
  output: { value: string },
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    output.value += decoder.decode(chunk, { stream: true });
    if (output.value.length > 256_000) {
      output.value = output.value.slice(-256_000);
    }
  }
  output.value += decoder.decode();
}

async function createOutputPipe(path: string): Promise<{
  keeper: Deno.FsFile;
  reader: Deno.FsFile;
}> {
  const result = await new Deno.Command("mkfifo", {
    args: ["--mode=600", path],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("OWNED_SYSTEMD_UNIT_PIPE_CREATE_FAILED");
  const keeper = await Deno.open(path, { read: true, write: true });
  try {
    return { keeper, reader: await Deno.open(path, { read: true }) };
  } catch (error) {
    keeper.close();
    throw error;
  }
}

function parseProperties(value: string): ReadonlyMap<string, string> {
  return new Map(
    value.trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? [line, ""] as const
        : [line.slice(0, separator), line.slice(separator + 1)] as const;
    }),
  );
}

async function unitState(unitName: string): Promise<UnitState> {
  const result = await new Deno.Command("systemctl", {
    args: [
      "--user",
      "show",
      unitName,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=InvocationID",
      "--property=Description",
      "--no-pager",
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("OWNED_SYSTEMD_UNIT_INSPECTION_FAILED");
  const properties = parseProperties(new TextDecoder().decode(result.stdout));
  return {
    loadState: properties.get("LoadState") ?? "",
    activeState: properties.get("ActiveState") ?? "",
    subState: properties.get("SubState") ?? "",
    invocationId: properties.get("InvocationID") ?? "",
    description: properties.get("Description") ?? "",
  };
}

function runtimeFor(unit: OwnedSystemdUnit): OwnedSystemdUnitRuntime {
  const runtime = runtimes.get(unit);
  if (!runtime) throw new Error("OWNED_SYSTEMD_UNIT_HANDLE_INVALID");
  return runtime;
}

function assertOwnedIdentity(
  runtime: OwnedSystemdUnitRuntime,
  state: UnitState,
): void {
  if (
    state.invocationId !== runtime.invocationId ||
    state.description !== runtime.description
  ) {
    throw new Error("OWNED_SYSTEMD_UNIT_IDENTITY_MISMATCH");
  }
}

async function waitForUnitStopped(
  runtime: OwnedSystemdUnitRuntime,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    const state = await unitState(runtime.unitName);
    if (
      state.loadState === "not-found" || state.activeState === "inactive" ||
      state.activeState === "failed"
    ) return true;
    assertOwnedIdentity(runtime, state);
    await sleep(10);
  }
  return false;
}

async function resetFailedOwnedUnit(
  runtime: OwnedSystemdUnitRuntime,
): Promise<void> {
  const state = await unitState(runtime.unitName);
  if (state.loadState === "not-found") return;
  assertOwnedIdentity(runtime, state);
  const reset = await new Deno.Command("systemctl", {
    args: ["--user", "reset-failed", runtime.unitName],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!reset.success) throw new Error("OWNED_SYSTEMD_UNIT_RELEASE_FAILED");
  if ((await unitState(runtime.unitName)).loadState !== "not-found") {
    throw new Error("OWNED_SYSTEMD_UNIT_RELEASE_FAILED");
  }
}

function environmentArguments(
  environment: Readonly<Record<string, string>> | undefined,
): string[] {
  return Object.entries(environment ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw new Error("OWNED_SYSTEMD_UNIT_ENVIRONMENT_INVALID");
    }
    return `${name}=${value}`;
  });
}

export async function observeOwnedSystemdUnitStatus(
  path: string,
  settled: () => boolean = () => false,
): Promise<OwnedSystemdUnitStatus | undefined> {
  while (!settled()) {
    try {
      const value = (await Deno.readTextFile(path)).trim();
      const matched = /^(\d{1,3})$/.exec(value);
      if (!matched) throw new Error("OWNED_SYSTEMD_UNIT_STATUS_INVALID");
      const code = Number(matched[1]);
      if (code > 255) {
        throw new Error("OWNED_SYSTEMD_UNIT_STATUS_INVALID");
      }
      return { success: code === 0, code };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "OWNED_SYSTEMD_UNIT_STATUS_INVALID"
      ) {
        throw error;
      }
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error("OWNED_SYSTEMD_UNIT_STATUS_FAILED", { cause: error });
      }
    }
    await sleep(10);
  }
  return undefined;
}

export const ownedSystemdUnitWrapper = `
status_path="$1"; stdout="$2"; stderr="$3"; shift 3
child=""
finish() {
  code="$1"
  status_tmp="\${status_path}.tmp"
  printf '%s\\n' "$code" >"$status_tmp"
  mv -- "$status_tmp" "$status_path"
  exit "$code"
}
on_term() {
  trap - TERM
  if [ -n "$child" ]; then
    wait "$child"
    # SIGTERM hit the whole cgroup. If the child handled it and exited 0
    # (e.g., Deno graceful drain), honour that. Otherwise (e.g., pnpm
    # reports a killed child as exit 1), the shutdown receipt decides.
    if [ "$?" -eq 0 ]; then
      finish 0
    fi
  fi
  finish 143
}
trap on_term TERM
"$@" >"$stdout" 2>"$stderr" &
child="$!"
wait "$child"
finish "$?"
`;

async function readExpectedWorkerShutdownReceipt(
  expected: OwnedSystemdUnitRuntime["expectedWorkerShutdownReceipt"],
): Promise<WorkerShutdownReceipt | undefined> {
  if (!expected) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(expected.path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error("OWNED_SYSTEMD_UNIT_SHUTDOWN_RECEIPT_INVALID", {
      cause: error,
    });
  }
  let receipt: WorkerShutdownReceipt;
  try {
    receipt = parseWorkerShutdownReceipt(value);
  } catch (error) {
    throw new Error("OWNED_SYSTEMD_UNIT_SHUTDOWN_RECEIPT_INVALID", {
      cause: error,
    });
  }
  if (receipt.launchId !== expected.launchId) {
    throw new Error("OWNED_SYSTEMD_UNIT_SHUTDOWN_RECEIPT_MISMATCH");
  }
  return receipt;
}

function successfulStatus(
  status: OwnedSystemdUnitStatus,
  receipt: WorkerShutdownReceipt | undefined,
): OwnedSystemdUnitStatus {
  return {
    code: status.code,
    success: status.code === 0 ||
      (status.code === 143 && receipt !== undefined),
  };
}

export async function startOwnedSystemdUnit(
  command: OwnedSystemdUnitCommand,
): Promise<OwnedSystemdUnit> {
  if (
    !Number.isSafeInteger(command.gracefulTimeoutMs) ||
    command.gracefulTimeoutMs <= 0 ||
    !Number.isSafeInteger(command.forceTimeoutMs) ||
    command.forceTimeoutMs <= 0
  ) throw new Error("OWNED_SYSTEMD_UNIT_TIMEOUT_INVALID");
  if (
    command.bindToUnit !== undefined &&
    !/^bakery-[a-zA-Z0-9_.@:-]+\.(?:scope|service)$/.test(
      command.bindToUnit,
    )
  ) throw new Error("OWNED_SYSTEMD_UNIT_BINDING_INVALID");
  if (
    command.workerShutdownReceipt !== undefined &&
    (!command.workerShutdownReceipt.path.startsWith("/") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(command.workerShutdownReceipt.launchId))
  ) throw new Error("OWNED_SYSTEMD_UNIT_SHUTDOWN_RECEIPT_CONFIG_INVALID");

  const ownershipId = crypto.randomUUID();
  const unitName = `bakery-owned-process-${ownershipId}.service`;
  const description = `Bakery owned process ${ownershipId}`;
  const outputDirectory = await Deno.makeTempDir({
    prefix: "bakery-owned-systemd-unit-",
  });
  let standardOutput: Awaited<ReturnType<typeof createOutputPipe>>;
  try {
    standardOutput = await createOutputPipe(`${outputDirectory}/stdout`);
  } catch (error) {
    await Deno.remove(outputDirectory, { recursive: true }).catch(() => {});
    throw error;
  }
  let standardError: Awaited<ReturnType<typeof createOutputPipe>>;
  try {
    standardError = await createOutputPipe(`${outputDirectory}/stderr`);
  } catch (error) {
    standardOutput.keeper.close();
    standardOutput.reader.close();
    await Deno.remove(outputDirectory, { recursive: true }).catch(() => {});
    throw error;
  }

  const statusPath = `${outputDirectory}/status`;
  const args = [
    "--user",
    "--quiet",
    "--no-block",
    "--service-type=exec",
    // systemd expands ${name} in ExecStart arguments by default. Expanded, the
    // wrapper's "${status_path}.tmp" became "<cwd>/.tmp", one staging file for
    // every unit sharing a working directory, so a concurrent finish could
    // publish another unit's empty or partial status.
    "--expand-environment=no",
    `--unit=${unitName}`,
    `--description=${description}`,
    "--remain-after-exit",
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${
      command.gracefulTimeoutMs + command.forceTimeoutMs
    }ms`,
    "--property=SendSIGKILL=yes",
    "--property=FinalKillSignal=SIGKILL",
    ...(command.bindToUnit === undefined ? [] : [
      `--property=BindsTo=${command.bindToUnit}`,
      `--property=After=${command.bindToUnit}`,
    ]),
    ...(command.cwd === undefined
      ? []
      : [`--working-directory=${command.cwd}`]),
    "/usr/bin/env",
    "-i",
    ...environmentArguments(command.environment),
    "/bin/bash",
    "-c",
    ownedSystemdUnitWrapper,
    "bash",
    statusPath,
    `${outputDirectory}/stdout`,
    `${outputDirectory}/stderr`,
    command.command,
    ...(command.args ?? []),
  ];
  const launch = await new Deno.Command("systemd-run", {
    args,
    stdout: "null",
    stderr: "null",
  }).output();
  if (!launch.success) {
    standardOutput.keeper.close();
    standardOutput.reader.close();
    standardError.keeper.close();
    standardError.reader.close();
    await Deno.remove(outputDirectory, { recursive: true });
    throw new Error("OWNED_SYSTEMD_UNIT_START_FAILED");
  }

  const output = { value: "" };
  const streamsDrained = Promise.all([
    collectOutput(standardOutput.reader.readable, output),
    collectOutput(standardError.reader.readable, output),
  ]);
  let statusSettled = false;
  let statusObserved = false;
  let resolveStatus!: (status: OwnedSystemdUnitStatus) => void;
  let rejectStatus!: (error: Error) => void;
  const status = new Promise<OwnedSystemdUnitStatus>((resolve, reject) => {
    resolveStatus = (value) => {
      if (statusSettled) return;
      statusSettled = true;
      standardOutput.keeper.close();
      standardError.keeper.close();
      resolve(value);
    };
    rejectStatus = (error) => {
      if (statusSettled) return;
      statusSettled = true;
      standardOutput.keeper.close();
      standardError.keeper.close();
      reject(error);
    };
  });
  const completion = status.then(async (value) => {
    await streamsDrained;
    return value;
  }).finally(async () => {
    await Deno.remove(outputDirectory, { recursive: true }).catch(() => {});
  });
  void observeOwnedSystemdUnitStatus(statusPath, () => statusSettled).then(
    (value) => {
      if (value !== undefined) {
        statusObserved = true;
        resolveStatus(value);
      }
    },
    rejectStatus,
  );

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await unitState(unitName);
    if (state.invocationId) {
      if (state.description !== description) {
        throw new Error("OWNED_SYSTEMD_UNIT_IDENTITY_MISMATCH");
      }
      // A short-lived command may publish its terminal status before the first
      // inspection observes an active unit. Its owned handle still needs cleanup.
      if (
        state.loadState === "loaded" &&
        (state.activeState === "active" || statusObserved)
      ) {
        const unit = Object.freeze({
          [OWNED_SYSTEMD_UNIT]: true as const,
        });
        runtimes.set(unit, {
          unitName,
          description,
          invocationId: state.invocationId,
          expectedWorkerShutdownReceipt: command.workerShutdownReceipt,
          output,
          completion,
          completeForced: () =>
            resolveStatus({
              success: false,
              code: 137,
            }),
          statusSettled: () => statusSettled,
          gracefulTimeoutMs: command.gracefulTimeoutMs,
          forceTimeoutMs: command.forceTimeoutMs,
        });
        return unit;
      }
    }
    if (statusSettled && !statusObserved) {
      throw new Error("OWNED_SYSTEMD_UNIT_START_FAILED");
    }
    await sleep(10);
  }
  throw new Error("OWNED_SYSTEMD_UNIT_START_TIMEOUT");
}

export function ownedSystemdUnitOutput(unit: OwnedSystemdUnit): string {
  return runtimeFor(unit).output.value;
}

export async function ownedSystemdUnitMainRunning(
  unit: OwnedSystemdUnit,
): Promise<boolean> {
  const runtime = runtimeFor(unit);
  const state = await unitState(runtime.unitName);
  if (state.loadState === "not-found") return false;
  assertOwnedIdentity(runtime, state);
  return state.activeState === "active" && state.subState === "running";
}

async function completeGracefulStop(
  runtime: OwnedSystemdUnitRuntime,
  status: OwnedSystemdUnitStatus,
): Promise<OwnedSystemdUnitStop> {
  const workerShutdownReceipt = await readExpectedWorkerShutdownReceipt(
    runtime.expectedWorkerShutdownReceipt,
  );
  return {
    status: successfulStatus(status, workerShutdownReceipt),
    forced: false,
    ...(workerShutdownReceipt ? { workerShutdownReceipt } : {}),
  };
}

async function stop(
  runtime: OwnedSystemdUnitRuntime,
): Promise<OwnedSystemdUnitStop> {
  const state = await unitState(runtime.unitName);
  if (state.loadState === "not-found") {
    const completed = await settleWithin(
      runtime.completion,
      runtime.gracefulTimeoutMs + runtime.forceTimeoutMs,
    );
    if (completed === TIMEOUT) {
      throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
    }
    return await completeGracefulStop(runtime, completed);
  }
  assertOwnedIdentity(runtime, state);
  const stopping = await new Deno.Command("systemctl", {
    args: ["--user", "stop", "--no-block", runtime.unitName],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!stopping.success) throw new Error("OWNED_SYSTEMD_UNIT_STOP_FAILED");

  const gracefulDeadline = Date.now() + runtime.gracefulTimeoutMs;
  const graceful = await settleWithin(
    runtime.completion,
    gracefulDeadline - Date.now(),
  );
  if (
    graceful !== TIMEOUT &&
    await waitForUnitStopped(runtime, gracefulDeadline)
  ) {
    await resetFailedOwnedUnit(runtime);
    return await completeGracefulStop(runtime, graceful);
  }

  const forceState = await unitState(runtime.unitName);
  if (forceState.loadState === "not-found") {
    const completed = await settleWithin(
      runtime.completion,
      runtime.forceTimeoutMs,
    );
    if (completed === TIMEOUT) {
      throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
    }
    return await completeGracefulStop(runtime, completed);
  }
  assertOwnedIdentity(runtime, forceState);
  const forcing = await new Deno.Command("systemctl", {
    args: [
      "--user",
      "kill",
      "--kill-whom=all",
      "--signal=SIGKILL",
      runtime.unitName,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!forcing.success) {
    throw new Error("OWNED_SYSTEMD_UNIT_FORCE_FAILED");
  }

  const forceDeadline = Date.now() + runtime.forceTimeoutMs;
  if (!(await waitForUnitStopped(runtime, forceDeadline))) {
    throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
  }
  if (!runtime.statusSettled()) runtime.completeForced();
  const forced = await settleWithin(
    runtime.completion,
    forceDeadline - Date.now(),
  );
  if (forced === TIMEOUT) {
    throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
  }
  await resetFailedOwnedUnit(runtime);
  return {
    status: forced.success ? { success: false, code: 137 } : forced,
    forced: true,
  };
}

export function stopOwnedSystemdUnit(
  unit: OwnedSystemdUnit,
): Promise<OwnedSystemdUnitStop> {
  const runtime = runtimeFor(unit);
  runtime.stop ??= stop(runtime);
  return runtime.stop;
}

/**
 * Delivers SIGKILL to every process of the owned unit with no drain and no
 * shutdown receipt, then settles the unit so a replacement can be started.
 */
export async function killOwnedSystemdUnit(
  unit: OwnedSystemdUnit,
): Promise<void> {
  const runtime = runtimeFor(unit);
  const state = await unitState(runtime.unitName);
  if (state.loadState !== "not-found") {
    assertOwnedIdentity(runtime, state);
    const killing = await new Deno.Command("systemctl", {
      args: [
        "--user",
        "kill",
        "--kill-whom=all",
        "--signal=SIGKILL",
        runtime.unitName,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!killing.success) throw new Error("OWNED_SYSTEMD_UNIT_KILL_FAILED");
    const deadline = Date.now() + runtime.forceTimeoutMs;
    if (!(await waitForUnitStopped(runtime, deadline))) {
      throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
    }
    if (!runtime.statusSettled()) runtime.completeForced();
    const settled = await settleWithin(
      runtime.completion,
      deadline - Date.now(),
    );
    if (settled === TIMEOUT) {
      throw new Error("OWNED_SYSTEMD_UNIT_CLEANUP_TIMEOUT");
    }
    await resetFailedOwnedUnit(runtime);
  }
  runtime.stop ??= Promise.resolve({
    status: { success: false, code: 137 },
    forced: true,
  });
}
