import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const READ_TIMEOUT_MS = 250;
const STATUS_LIMIT = 4096;
const SMALL_LIMIT = 32;
const MAX_POLICY_NUMBER = 4_294_967_295;
const STATUS_VALUES = new Set([
  "missing",
  "denied",
  "invalid",
  "overflow",
  "unavailable",
]);

export const POLICY_PATHS = Object.freeze({
  status: "/proc/self/status",
  cgroup: "/proc/self/cgroup",
  unprivilegedUsernsClone: "/proc/sys/kernel/unprivileged_userns_clone",
  maxUserNamespaces: "/proc/sys/user/max_user_namespaces",
  apparmorRestrictUnprivilegedUserns:
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
});

const unavailable = (status) =>
  STATUS_VALUES.has(status) ? status : "unavailable";

export function createFixedBoundedReader(openFile = open) {
  return async function readFixedBounded(path, limit) {
    let handle;
    let timeout;
    try {
      handle = await openFile(path, "r");
      const buffer = Buffer.alloc(limit + 1);
      const result = await Promise.race([
        handle.read(buffer, 0, buffer.length, null),
        new Promise((resolve) => {
          timeout = setTimeout(
            () => resolve({ timeout: true }),
            READ_TIMEOUT_MS,
          );
        }),
      ]);
      if (result.timeout) return { status: "unavailable" };
      if (result.bytesRead > limit) return { status: "overflow" };
      return {
        status: "observed",
        bytes: buffer.subarray(0, result.bytesRead),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        return { status: "denied" };
      }
      return { status: "unavailable" };
    } finally {
      clearTimeout(timeout);
      await handle?.close().catch(() => undefined);
    }
  };
}

export const readFixedBounded = createFixedBoundedReader();

const decoded = (read) => {
  if (read.status !== "observed") return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch {
    return undefined;
  }
};

function numeric(read, maximum = MAX_POLICY_NUMBER) {
  if (read.status !== "observed") return unavailable(read.status);
  const text = decoded(read);
  if (text === undefined || !/^(?:0|[1-9][0-9]{0,9})\n?$/.test(text)) {
    return "invalid";
  }
  const value = Number(text.trimEnd());
  return Number.isSafeInteger(value) && value <= maximum ? value : "invalid";
}

function processField(read, name, maximum) {
  if (read.status !== "observed") return unavailable(read.status);
  const text = decoded(read);
  if (text === undefined) return "invalid";
  const values = [
    ...text.matchAll(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)$`, "gm")),
  ];
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0][1])) {
    return values.length === 0 ? "missing" : "invalid";
  }
  const value = Number(values[0][1]);
  return Number.isSafeInteger(value) && value <= maximum ? value : "invalid";
}

function currentRunnerUnit(read) {
  if (read.status !== "observed") return unavailable(read.status);
  const text = decoded(read);
  if (text === undefined || !/^[\x20-\x7e\n]*$/.test(text)) return "invalid";
  const units = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^(?:[0-9]+):(?:[A-Za-z0-9_,.-]*):\/(.*)$/.exec(line);
    if (!match) return "invalid";
    for (const segment of match[1].split("/")) {
      if (/^actions\.runner\.[A-Za-z0-9_.-]{1,96}\.service$/.test(segment)) {
        units.add(segment);
      }
    }
  }
  return units.size === 1 ? "observed" : "unavailable";
}

export async function collectPolicyDiagnostic(read = readFixedBounded) {
  const [status, cgroup, clone, maximum, apparmor] = await Promise.all([
    read(POLICY_PATHS.status, STATUS_LIMIT),
    read(POLICY_PATHS.cgroup, STATUS_LIMIT),
    read(POLICY_PATHS.unprivilegedUsernsClone, SMALL_LIMIT),
    read(POLICY_PATHS.maxUserNamespaces, SMALL_LIMIT),
    read(POLICY_PATHS.apparmorRestrictUnprivilegedUserns, SMALL_LIMIT),
  ]);
  return {
    seccomp: processField(status, "Seccomp", 2),
    noNewPrivs: processField(status, "NoNewPrivs", 1),
    unprivilegedUsernsClone: numeric(clone),
    maxUserNamespaces: numeric(maximum),
    apparmorRestrictUnprivilegedUserns: numeric(apparmor),
    currentRunnerUnit: currentRunnerUnit(cgroup),
  };
}

async function main() {
  const result = await collectPolicyDiagnostic();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
