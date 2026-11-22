/**
 * Running one plugin job behind a containment boundary (#29, B14.02, slice B).
 *
 * A plugin job is untrusted generated code. It runs in a runtime that has no
 * network and a read-only root, with memory, process, CPU and time limits, and
 * it talks to the host over stdin and stdout only. The host relays each request
 * to the install-scoped broker and holds the token itself, so the job never
 * sees one. When a host cannot give that boundary the job is refused with a
 * plain reason; it is never run uncontained.
 *
 * One job attempt yields at most one result. The result is keyed by an effect
 * identity (install, job, fence), so a duplicated or late attempt of the same
 * scheduled work is recorded once and the second is discarded.
 */

export type PluginJobLimits = Readonly<{
  cpus: number;
  memoryBytes: number;
  pids: number;
  /** Wall-clock budget; the job is killed when it runs out. */
  timeoutMs: number;
  /** Most bytes of stdout the host will read from the job. */
  outputBytes: number;
  /** Most bytes of one protocol line. */
  lineBytes: number;
}>;

export const DEFAULT_PLUGIN_JOB_LIMITS: PluginJobLimits = Object.freeze({
  cpus: 1,
  memoryBytes: 256 * 1024 * 1024,
  pids: 64,
  timeoutMs: 60_000,
  outputBytes: 1024 * 1024,
  lineBytes: 64 * 1024,
});

export type ContainmentProbe =
  | Readonly<{ supported: true; runtime: string }>
  | Readonly<{ supported: false; runtime: string; reason: string }>;

/** What the host hands a runtime to start one job. */
export type PluginJobSpec = Readonly<{
  /** Names the container or process so a stuck one can be found and removed. */
  name: string;
  /** Directory holding the job's code, mounted read-only. */
  codeDir: string;
  /** Command inside the boundary, relative to the code directory. */
  command: readonly string[];
  limits: PluginJobLimits;
}>;

/** A started job: lines in, lines out, and a way to stop it. */
export type RunningPluginJob = Readonly<{
  write(line: string): Promise<void>;
  /** Yields stdout one line at a time and ends when the job's stdout closes. */
  lines: AsyncIterable<string>;
  /** Resolves when the job has ended, however it ended. */
  exited: Promise<{ code: number | null; oomKilled?: boolean }>;
  /** Stops the job and removes the boundary. Safe to call more than once. */
  kill(): Promise<void>;
}>;

export type ContainmentRuntime = Readonly<{
  name: string;
  /** Proves the boundary on this host, or says plainly why it cannot. */
  probe(): Promise<ContainmentProbe>;
  start(spec: PluginJobSpec): Promise<RunningPluginJob>;
}>;

export type JobRelayCall = Readonly<{
  requestId: string;
  sequence: number;
  operation: string;
  args: Readonly<Record<string, unknown>>;
}>;

/** Sends one request to the broker for this job; the host holds the token. */
export type JobRelay = (
  call: JobRelayCall,
) => Promise<
  { ok: true; result: unknown } | { ok: false; denial: string }
>;

export type PluginJobEnd =
  | Readonly<{
    kind: "result";
    value: unknown;
    /** False when a result for this identity already existed and this one was discarded. */
    recorded: boolean;
  }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "start_failed" }>
  | Readonly<{ kind: "unsupported"; reason: string }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "output_limit" }>
  | Readonly<{ kind: "protocol_violation"; detail: string }>
  | Readonly<{ kind: "crashed"; code: number | null; oomKilled: boolean }>;

/** Records one result per effect identity; later ones are discarded. */
export type ResultSink = {
  /** True when this call recorded the result, false when one already existed. */
  record(identity: string, value: unknown): Promise<boolean>;
};

export function effectIdentity(
  parts: Readonly<{ installId: string; jobId: string; fence: number }>,
): string {
  return `${parts.installId}:${parts.jobId}:${parts.fence}`;
}

export function memoryResultSink(): ResultSink & {
  recorded: ReadonlyMap<string, unknown>;
} {
  const recorded = new Map<string, unknown>();
  return {
    recorded,
    record(identity, value) {
      if (recorded.has(identity)) return Promise.resolve(false);
      recorded.set(identity, value);
      return Promise.resolve(true);
    },
  };
}

/**
 * Runs one job. The protocol, one JSON object per line from the job:
 *   {"call": {requestId, sequence, operation, args}}  -> host writes
 *       {"requestId", "ok": true, "result"} or {"requestId", "ok": false, "denial"}
 *   {"result": <json>}                                 -> the job's one result
 * Anything else, an oversized line, or output past the cap ends the job.
 */
export async function runPluginJob(
  input: Readonly<{
    runtime: ContainmentRuntime;
    spec: PluginJobSpec;
    relay: JobRelay;
    identity: string;
    sink: ResultSink;
    /** Aborts the job, for example when the install is disabled or the lease is lost. */
    signal?: AbortSignal;
  }>,
): Promise<PluginJobEnd> {
  const probe = await input.runtime.probe();
  if (!probe.supported) return { kind: "unsupported", reason: probe.reason };

  let job: RunningPluginJob;
  try {
    job = await input.runtime.start(input.spec);
  } catch {
    // The runtime removed anything it half-made before throwing.
    return { kind: "start_failed" };
  }
  const { limits } = input.spec;
  let timedOut = false;
  let aborted = false;
  // Settles when the budget ends or the caller aborts. Every wait on something
  // the job or the relay controls races this, so neither can outlast it.
  let expire!: () => void;
  const expired = new Promise<"expired">((resolve) => {
    expire = () => resolve("expired");
  });
  const timer = setTimeout(() => {
    timedOut = true;
    expire();
    void job.kill();
  }, limits.timeoutMs);
  const onAbort = () => {
    aborted = true;
    expire();
    void job.kill();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const encoder = new TextEncoder();
  const stopped = (): PluginJobEnd =>
    aborted && !timedOut ? { kind: "aborted" } : { kind: "timeout" };

  let bytes = 0;
  let end: PluginJobEnd | null = null;
  try {
    for await (const line of job.lines) {
      // Bytes, not UTF-16 units: a multibyte line is three times its length.
      const lineBytes = encoder.encode(line).byteLength;
      bytes += lineBytes + 1;
      if (bytes > limits.outputBytes) {
        end = { kind: "output_limit" };
        break;
      }
      if (lineBytes > limits.lineBytes) {
        end = { kind: "output_limit" };
        break;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        end = { kind: "protocol_violation", detail: "not JSON" };
        break;
      }
      if (typeof message !== "object" || message === null) {
        end = { kind: "protocol_violation", detail: "not an object" };
        break;
      }
      const record = message as Record<string, unknown>;
      if ("result" in record && Object.keys(record).length === 1) {
        // The first result is the only one; the job ends here either way.
        end = { kind: "result", value: record.result, recorded: false };
        break;
      }
      const call = record.call;
      if (
        Object.keys(record).length !== 1 || typeof call !== "object" ||
        call === null
      ) {
        end = { kind: "protocol_violation", detail: "unknown message" };
        break;
      }
      const c = call as Record<string, unknown>;
      if (
        typeof c.requestId !== "string" || typeof c.sequence !== "number" ||
        typeof c.operation !== "string" || typeof c.args !== "object" ||
        c.args === null || Array.isArray(c.args)
      ) {
        end = { kind: "protocol_violation", detail: "malformed call" };
        break;
      }
      const answer = await Promise.race([
        input.relay({
          requestId: c.requestId,
          sequence: c.sequence,
          operation: c.operation,
          args: c.args as Record<string, unknown>,
        }).catch(() => ({ ok: false as const, denial: "relay_failed" })),
        expired,
      ]);
      if (answer === "expired") {
        end = stopped();
        break;
      }
      const written = await Promise.race([
        job.write(JSON.stringify({ requestId: c.requestId, ...answer })),
        expired,
      ]);
      if (written === "expired") {
        end = stopped();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    await job.kill();
  }
  const exit = await job.exited;
  if (end === null) {
    if (timedOut || aborted) return stopped();
    return {
      kind: "crashed",
      code: exit.code,
      oomKilled: exit.oomKilled === true,
    };
  }
  if (end.kind === "result") {
    return {
      ...end,
      recorded: await input.sink.record(input.identity, end.value),
    };
  }
  return end;
}
