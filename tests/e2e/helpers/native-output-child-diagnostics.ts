const MAX_DIAGNOSTIC_BYTES_PER_STREAM = 64 * 1024;
const MAX_DETAIL_CHARS = 512;
/** Marks the one line the child writes that the parent may relay. */
export const NATIVE_OUTPUT_DETAIL_PREFIX = "NATIVE_OUTPUT_DETAIL:";
/**
 * The child builds its detail from enumerated state fields (statuses, counts,
 * ids, error codes), never from raw output. The parent still relays a line
 * only when it matches this strict character set, so a line carrying anything
 * else (ANSI escapes, URLs, credentials, backslash escapes) is dropped.
 */
const SAFE_DETAIL = /^[A-Za-z0-9_.:;,={}[\]" -]+$/;

const phases = [
  ["native-output-e2e: happy-path", "happy-path"],
  ["native-output-e2e: cancellation", "cancellation"],
  ["native-output-e2e: inspection", "inspection"],
  ["native-output-e2e: producer-replacement", "producer-replacement"],
  ["native-output-e2e: total-drain", "total-drain"],
] as const;

const failureClasses = [
  ["BAKERY_NATIVE_OUTPUT_REPORT_REQUIRED", "report-path-missing"],
  ["NATIVE_OUTPUT_SOURCE_IDENTITY_FAILED", "source-identity"],
  ["NATIVE_OUTPUT_STREAM_CLOSE_TIMEOUT", "stream-close-timeout"],
  ["NATIVE_OUTPUT_RESULT_TIMEOUT", "result-timeout"],
  ["NATIVE_OUTPUT_INJECTED_DROPS_TIMEOUT", "injected-drops-timeout"],
  ["NATIVE_OUTPUT_HAPPY_PATH_RELEASE_TIMEOUT", "happy-path-release-timeout"],
  [
    "NATIVE_OUTPUT_CGROUP_DID_NOT_CLEAN_DURING_DRAIN",
    "drain-cgroup-cleanup-timeout",
  ],
  ["NATIVE_OUTPUT_CANCELLATION_START_TIMEOUT", "cancellation-start-timeout"],
  [
    "NATIVE_OUTPUT_CANCELLATION_CLEANUP_TIMEOUT",
    "cancellation-cleanup-timeout",
  ],
  [
    "NATIVE_OUTPUT_CANCELLATION_RELEASE_TIMEOUT",
    "cancellation-release-timeout",
  ],
  ["NATIVE_OUTPUT_TOTAL_DRAIN_CLOSE_TIMEOUT", "total-drain-close-timeout"],
  [
    "NATIVE_OUTPUT_REPLACEMENT_ORIGINAL_START_TIMEOUT",
    "original-start-timeout",
  ],
  [
    "NATIVE_OUTPUT_REPLACEMENT_SUCCESSOR_START_TIMEOUT",
    "successor-start-timeout",
  ],
  [
    "NATIVE_OUTPUT_REPLACEMENT_SOURCE_LOSS_TIMEOUT",
    "replacement-source-loss-timeout",
  ],
  ["NATIVE_OUTPUT_REPLACEMENT_REPLAY_TIMEOUT", "replacement-replay-timeout"],
  ["NATIVE_OUTPUT_REPLACEMENT_CLOSE_TIMEOUT", "replacement-close-timeout"],
  ["NATIVE_OUTPUT_REPLACEMENT_RELEASE_TIMEOUT", "replacement-release-timeout"],
  ["NATIVE_OUTPUT_INSPECTION_CLOSE_TIMEOUT", "inspection-close-timeout"],
  ["NATIVE_OUTPUT_INSPECTION_RESULT_TIMEOUT", "inspection-result-timeout"],
  ["NATIVE_OUTPUT_INSPECTION_RESULT", "inspection-result-invalid"],
  ["NATIVE_OUTPUT_INSPECTION_BYTES_MISSING", "inspection-bytes-missing"],
  ["NATIVE_OUTPUT_WORKER_MAIN_FAILED", "worker-main-failed"],
  ["AssertionError", "assertion"],
] as const;

export type NativeOutputChildPhase =
  | (typeof phases)[number][1]
  | "setup"
  | "unknown";

export type NativeOutputChildFailureClass =
  | (typeof failureClasses)[number][1]
  | "child-timeout"
  | "unknown";

export type NativeOutputChildDiagnostic = Readonly<{
  phase: NativeOutputChildPhase;
  failureClass: NativeOutputChildFailureClass;
  detail?: string;
}>;

type ChildOutput = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

function boundedTail(bytes: Uint8Array): string {
  const start = Math.max(0, bytes.byteLength - MAX_DIAGNOSTIC_BYTES_PER_STREAM);
  return new TextDecoder().decode(bytes.subarray(start));
}

export function classifyNativeOutputChildFailure(
  output: ChildOutput,
  timedOut = false,
): NativeOutputChildDiagnostic {
  const diagnosticText = `${boundedTail(output.stdout)}\n${
    boundedTail(output.stderr)
  }`;
  let phase: NativeOutputChildPhase = "setup";
  let lastPhaseIndex = -1;
  for (const [marker, candidate] of phases) {
    const index = diagnosticText.lastIndexOf(marker);
    if (index > lastPhaseIndex) {
      phase = candidate;
      lastPhaseIndex = index;
    }
  }
  if (lastPhaseIndex < 0 && diagnosticText.trim().length > 0) phase = "unknown";

  let failureClass: NativeOutputChildFailureClass = timedOut
    ? "child-timeout"
    : "unknown";
  if (!timedOut) {
    let lastFailureIndex = -1;
    for (const [label, candidate] of failureClasses) {
      const index = diagnosticText.lastIndexOf(label);
      if (index > lastFailureIndex) {
        failureClass = candidate;
        lastFailureIndex = index;
      }
    }
  }
  const detail = nativeOutputChildDetail(diagnosticText);
  return Object.freeze(
    detail === undefined
      ? { phase, failureClass }
      : { phase, failureClass, detail },
  );
}

function nativeOutputChildDetail(diagnosticText: string): string | undefined {
  const start = diagnosticText.lastIndexOf(NATIVE_OUTPUT_DETAIL_PREFIX);
  if (start < 0) return undefined;
  const line = diagnosticText
    .slice(start + NATIVE_OUTPUT_DETAIL_PREFIX.length)
    .split("\n", 1)[0]
    .trimEnd();
  if (line.length === 0 || line.length > MAX_DETAIL_CHARS) return undefined;
  return SAFE_DETAIL.test(line) ? line : undefined;
}

export function nativeOutputChildFailureMessage(
  code: number,
  output: ChildOutput,
  timedOut = false,
): string {
  const diagnostic = classifyNativeOutputChildFailure(output, timedOut);
  const base =
    `NATIVE_OUTPUT_CHILD_FAILED:${code};phase=${diagnostic.phase};class=${diagnostic.failureClass}`;
  return diagnostic.detail === undefined
    ? base
    : `${base};detail=${diagnostic.detail}`;
}
