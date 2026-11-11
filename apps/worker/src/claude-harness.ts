import { basename, join, relative, resolve } from "node:path";
import { enforceWorkerFixedPolicy, type WorkerExecutor } from "./executor.ts";
import type { ExecutionOutcome } from "./executor.ts";
import type { NativeOutputSink } from "./native-output.ts";
import {
  buildRepairPrompt,
  createHarnessBusyLatch,
  HARNESS_REPAIR_ACTION,
  harnessCanceledOutcome,
  harnessCredentialSecrets,
  harnessCredentialUnavailable,
  harnessFault as commonHarnessFault,
  harnessHeadRevision,
  harnessReadinessChecks,
  type HarnessRestoreTarget,
  harnessTeardownFault,
  harnessWorktreeGuard,
  initializeHarnessWorktree,
  isHarnessEditAction,
  prepareHarnessHome,
  probeHarnessVersion,
  publishHarnessPatch,
  readRepairInput,
  recordHarnessRestoreTarget,
  repairCommitMessage,
  repairRevisionMismatch,
  requireCleanHarnessWorktree,
  runBoundedHarness,
  withHarnessRestore,
} from "./harness-common.ts";
import { executeClaudeCoordinatorTurn } from "./claude-coordinator.ts";
import { provenCanceledOutcome, type PublishArtifact } from "./task-brief.ts";
import type {
  JobAssignment,
  JsonValue,
  WorkerInventoryCheck,
} from "./types.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import { COORDINATOR_TURN_ACTION } from "../../../packages/contracts/src/coordinator-turn.ts";

const CLAUDE_ACTION = "harness.implement";
const CLAUDE_MODEL_CHECK_ID = "capability:model";
const CLAUDE_MODEL_CHECK_VERSION = "claude-auth-1";
const CLAUDE_AUTH_UNAVAILABLE_REASON =
  "Claude Code credentials are unavailable to the worker.";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STREAM_LINE_BYTES = 64 * 1024;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 100;
const MAX_API_RETRY_EVENTS = 32;
const MAX_RETRY_DETAIL_BYTES = 1_800;
const MAX_NATIVE_STATE_FILES = 256;
const MAX_NATIVE_STATE_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_STATE_DEPTH = 6;
const MAX_NATIVE_SESSION_RECORDS = 4_096;
const MAX_NATIVE_RECORD_LINE_BYTES = 64 * 1024;
const MAX_CHECKPOINT_SIDECAR_BYTES = 2_048;
const CLAUDE_FILE_TOOLS = "Read,Edit,Write,Glob,Grep";
const CLAUDE_AUTH_ALLOWLIST = [".credentials.json"] as const;
const CLAUDE_CHECKPOINT_SIDECAR = ".bakery-checkpoint.json";
const CLAUDE_STATE_ALLOWLIST = [
  "projects",
  "sessions",
  "todos",
  "file-history",
] as const;
const CLAUDE_NATIVE_SESSION_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const CLAUDE_STARTUP_SYSTEM_SUBTYPES = new Set([
  "plugin_install",
  "hook_started",
  "hook_progress",
  "hook_response",
]);

/** The edit actions implemented by the Claude Code print interface. */
export const CLAUDE_HARNESS_SUPPORTED_ACTIONS = [
  CLAUDE_ACTION,
  HARNESS_REPAIR_ACTION,
] as const;
const CLAUDE_FAULT_NAMING = Object.freeze({
  prefix: "CLAUDE_HARNESS",
  title: "The Claude Code harness could not complete the bounded task",
});
/** Headless `-p` has no in-flight steering or follow-up channel. */
export const CLAUDE_HARNESS_CAPABILITIES: readonly string[] = Object.freeze([]);
export const CLAUDE_HARNESS_DEFAULT_TIME_LIMIT_MS = 120_000;
export const CLAUDE_UUID_PATTERN = UUID_PATTERN;
/** The pinned CLI's reasoning-effort vocabulary for `--effort`. */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(
  [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ] as const,
);

export type ClaudeHarnessOptions = {
  /** Configured output redaction secrets; also withheld from published patches. */
  readonly redactionSecrets?: readonly string[];
  /** Test seam: absolute group-kill helper used when Deno.kill is not granted. */
  readonly groupKillExecutable?: string;
  readonly publishFor: (assignment: JobAssignment) => PublishArtifact;
  readonly repositoryFor: (
    assignment: JobAssignment,
  ) => string | Promise<string>;
  readonly timeLimitMs?: number;
  /** Time limit of one coordinator turn; defaults to 180000 ms. */
  readonly coordinatorTimeLimitMs?: number;
  /** Reasoning effort of coordinator turns; defaults to `low`. */
  readonly coordinatorEffort?: string;
  readonly claudeExecutable?: string;
  /** Model selector passed as --model; validated against the CLI's vocabulary. */
  readonly model?: string;
  /** Reasoning effort passed as --effort; validated against CLAUDE_EFFORT_LEVELS. */
  readonly effort?: string;
  /** Private worker state root for per-attempt Claude session/config files. */
  readonly stateDir?: string;
  /**
   * Fixed harness repository. With `stateDir`, a durable restore marker lets a
   * restarted worker recover an interrupted run and report a dirty clone.
   */
  readonly repository?: string;
  /**
   * Explicit source of native Claude auth files; never read implicitly by tests.
   * Required: a run without credentials fails closed before the CLI starts.
   */
  readonly authSourceDir: string;
  readonly eventRecorder?: ClaudeHarnessEventRecorder;
  readonly inner?: WorkerExecutor;
};

export type JsonObject = Record<string, unknown>;
type ClaudeApiRetryEvent = {
  readonly type: "api_retry";
  readonly attempt: number | null;
  readonly delayMs: number | null;
};
type ClaudeSessionEvidence = {
  readonly relativePath: string;
  readonly sha256: string;
};
type ClaudeCheckpointMetadata = {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly agentSessionId: string;
  readonly sessionId: string;
  readonly checkpointToken: string;
  readonly worktreeRevision: string;
  /** First line of `claude --version` that wrote the session; resume needs an exact match. */
  readonly harnessVersion: string;
  readonly nativeFile: string;
  readonly nativeFileSha256: string;
};

export class ClaudeHarnessEventRecorder {
  #events: ClaudeApiRetryEvent[] = [];

  record(event: ClaudeApiRetryEvent): void {
    if (this.#events.length < MAX_API_RETRY_EVENTS) this.#events.push(event);
  }

  snapshot(): readonly ClaudeApiRetryEvent[] {
    return [...this.#events];
  }
}

/**
 * Quota evidence from the stream: the closed `rateLimitType` vocabulary and a
 * reset time, never provider message text.
 */
type ClaudeQuotaEvidence = {
  readonly rateLimitType: string | null;
  readonly resetsAt: number | null;
};

const CLAUDE_RATE_LIMIT_TYPES = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
]);

export type ClaudeStreamState = {
  initialized: boolean;
  /** Set by a rejected rate-limit event or a rate-limit/billing assistant error. */
  quota?: ClaudeQuotaEvidence;
  sessionId?: string;
  claudeCodeVersion?: string;
  model?: string;
  capabilities: string[];
  apiRetryEvents: ClaudeApiRetryEvent[];
  totalCostUsd: number | null;
  terminal: "success" | "failure" | undefined;
  terminalRecords: number;
  contradictory: boolean;
  malformed: boolean;
  truncated: boolean;
  /** The terminal `result` record, kept for structured-output readers. */
  resultRecord?: JsonObject;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
      ? 3
      : 4;
  }
  return bytes;
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textField(
  record: JsonObject,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function numberField(
  record: JsonObject,
  names: readonly string[],
): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function arrayOfText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && item.length > 0 &&
      item.length <= MAX_CAPABILITY_LENGTH
      ? [item]
      : []
  ).slice(0, MAX_CAPABILITIES);
}

function checkpointToken(record: JsonObject): string | undefined {
  const direct = textField(record, [
    "checkpoint",
    "checkpointId",
    "resumeHandleRef",
    "checkpointRef",
  ]);
  if (direct) return direct;
  const artifact = isRecord(record.artifact) ? record.artifact : undefined;
  return artifact
    ? textField(artifact, ["versionId", "artifactId", "sha256"])
    : undefined;
}

function worktreeRevision(record: JsonObject): string | undefined {
  return textField(record, [
    "worktreeRevision",
    "baseSha",
    "revision",
    "headSha",
  ]);
}

function sessionIdentity(record: JsonObject): string | undefined {
  return textField(record, [
    "nativeSessionId",
    "sessionId",
    "claudeSessionId",
    "sessionIdentity",
  ]);
}

// Checkpoint records carry the native id under nativeSessionId; sessionId in
// worker payloads always names a Bakery agent session.
function checkpointSessionIdentity(record: JsonObject): string | undefined {
  return textField(record, ["nativeSessionId"]);
}

function resumeRequest(input: JsonObject): JsonObject | undefined {
  for (const name of ["resume", "claudeResume", "resumeRequest"]) {
    if (isRecord(input[name])) return input[name];
  }
  if (
    typeof input.resumeSessionId === "string" ||
    typeof input.claudeSessionId === "string"
  ) {
    return input;
  }
  return undefined;
}

function matchingClaudeResumeCheckpoint(
  assignment: Pick<JobAssignment, "agentSessionId" | "currentCheckpoints">,
  inputValue: unknown,
  baseSha: string,
): JsonObject | undefined {
  const input = isRecord(inputValue) ? inputValue : {};
  const request = resumeRequest(input);
  const checkpoints: JsonObject[] = [];
  for (const value of assignment.currentCheckpoints) {
    if (isRecord(value)) checkpoints.push(value);
  }
  if (request) {
    const requestedSession = sessionIdentity(request) ??
      textField(request, ["resumeSessionId"]);
    const requestedRevision = worktreeRevision(request);
    const requestedCheckpoint = checkpointToken(request);
    if (
      !requestedSession || !requestedRevision ||
      requestedRevision !== baseSha ||
      !requestedCheckpoint || request.eligible === false ||
      request.resumeEligible === false || request.checkpointEligible === false
    ) return undefined;
    return checkpoints.find((checkpoint) =>
      assignment.agentSessionId !== undefined &&
      checkpoint.agentSessionId === assignment.agentSessionId &&
      checkpoint.eligible !== false &&
      checkpoint.resumeEligible !== false &&
      checkpoint.checkpointEligible !== false &&
      checkpointSessionIdentity(checkpoint) === requestedSession &&
      worktreeRevision(checkpoint) === baseSha &&
      checkpointToken(checkpoint) === requestedCheckpoint
    );
  }
  return checkpoints.find((checkpoint) =>
    assignment.agentSessionId !== undefined &&
    checkpoint.agentSessionId === assignment.agentSessionId &&
    checkpoint.eligible !== false &&
    checkpoint.resumeEligible !== false &&
    checkpoint.checkpointEligible !== false &&
    checkpointSessionIdentity(checkpoint) !== undefined &&
    worktreeRevision(checkpoint) === baseSha &&
    checkpointToken(checkpoint) !== undefined
  );
}

/**
 * Returns a Claude session only when the durable checkpoint proves all three
 * bindings: the same Claude identity, current worktree revision, and a
 * retained checkpoint/resume handle. Missing or mismatched proof starts fresh.
 */
export function selectClaudeResumeSession(
  assignment: Pick<JobAssignment, "agentSessionId" | "currentCheckpoints">,
  inputValue: unknown,
  baseSha: string,
): string | undefined {
  return checkpointSessionIdentity(
    matchingClaudeResumeCheckpoint(assignment, inputValue, baseSha) ?? {},
  );
}

function claudeRetryDetail(
  detail: string,
  events: readonly ClaudeApiRetryEvent[],
): string {
  if (events.length === 0) return detail;
  const prefix = `${detail} api_retry_events=`;
  const bounded: ClaudeApiRetryEvent[] = [];
  let serialized = "[]";
  let truncated = false;
  for (const event of events.slice(0, MAX_API_RETRY_EVENTS)) {
    const candidate = JSON.stringify([...bounded, event]);
    if (
      utf8ByteLength(`${prefix}${candidate}`) > MAX_RETRY_DETAIL_BYTES
    ) {
      truncated = true;
      break;
    }
    bounded.push(event);
    serialized = candidate;
  }
  if (bounded.length < events.length) truncated = true;
  return `${prefix}${serialized}${truncated ? ";truncated" : ""}`;
}

function withClaudeRetryDetail(
  outcome: ExecutionOutcome,
  events: readonly ClaudeApiRetryEvent[],
): ExecutionOutcome {
  if (outcome.status !== "failed" || events.length === 0) return outcome;
  if (!isRecord(outcome.fault) || typeof outcome.fault.detail !== "string") {
    return outcome;
  }
  return {
    ...outcome,
    fault: {
      ...outcome.fault,
      detail: claudeRetryDetail(outcome.fault.detail, events),
    },
  };
}

function claudeHarnessFault(
  code: string,
  detail: string,
  status: number,
  retryable: boolean,
  apiRetryEvents: readonly ClaudeApiRetryEvent[] = [],
): ExecutionOutcome {
  return commonHarnessFault(
    code,
    claudeRetryDetail(detail, apiRetryEvents),
    status,
    retryable,
    "The Claude Code harness could not complete the bounded task",
  );
}

export class ClaudeStreamParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private line = "";
  private lineBytes = 0;
  private overflow = false;
  readonly state: ClaudeStreamState = {
    initialized: false,
    capabilities: [],
    apiRetryEvents: [],
    totalCostUsd: null,
    terminal: undefined,
    terminalRecords: 0,
    contradictory: false,
    malformed: false,
    truncated: false,
  };

  constructor(private readonly eventRecorder?: ClaudeHarnessEventRecorder) {}

  feed(chunk: Uint8Array): void {
    if (this.overflow) return;
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      this.state.malformed = true;
      this.overflow = true;
      return;
    }
    for (const character of text) {
      if (character === "\n") {
        this.parseLine(this.line.replace(/\r$/, ""));
        this.line = "";
        this.lineBytes = 0;
        continue;
      }
      this.line += character;
      this.lineBytes += utf8ByteLength(character);
      if (this.lineBytes > MAX_STREAM_LINE_BYTES) {
        this.state.malformed = true;
        this.overflow = true;
        return;
      }
    }
  }

  finish(): void {
    let trailing = "";
    try {
      trailing = this.decoder.decode();
    } catch {
      this.state.malformed = true;
      return;
    }
    if (trailing) {
      this.line += trailing;
      this.lineBytes += utf8ByteLength(trailing);
    }
    if (this.lineBytes > MAX_STREAM_LINE_BYTES) {
      this.state.malformed = true;
      this.overflow = true;
      return;
    }
    if (this.overflow) return;
    if (this.line.trim().length > 0) {
      this.parseLine(this.line.replace(/\r$/, ""));
      if (this.state.malformed) this.state.truncated = true;
    }
  }

  private bindSession(sessionId: string | undefined): void {
    if (!sessionId) {
      this.state.malformed = true;
      return;
    }
    if (this.state.sessionId && this.state.sessionId !== sessionId) {
      this.state.contradictory = true;
      return;
    }
    this.state.sessionId = sessionId;
  }

  private bindText(
    field: "claudeCodeVersion" | "model",
    value: string | undefined,
  ): void {
    if (!value) return;
    const current = this.state[field];
    if (current && current !== value) this.state.contradictory = true;
    else this.state[field] = value;
  }

  private parseLine(line: string): void {
    if (line.trim().length === 0) return;
    if (this.state.terminalRecords > 0) {
      this.state.contradictory = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.state.malformed = true;
      return;
    }
    if (!isRecord(value)) {
      this.state.malformed = true;
      return;
    }
    const type = value.type;
    const subtype = typeof value.subtype === "string" ? value.subtype : "";
    const preInitSystem = type === "system" &&
      (subtype === "init" || CLAUDE_STARTUP_SYSTEM_SUBTYPES.has(subtype));
    if (!this.state.initialized && !preInitSystem) {
      this.state.malformed = true;
      return;
    }
    const eventSession = textField(value, ["session_id", "sessionId"]);
    if (eventSession) this.bindSession(eventSession);
    if (type === "system") this.parseSystem(value);
    else if (type === "api_retry") this.parseApiRetry(value);
    else if (type === "result") this.parseResult(value);
    else if (type === "rate_limit_event") this.parseRateLimit(value);
    else if (type === "assistant") this.parseAssistantError(value);
  }

  private recordQuota(evidence: Partial<ClaudeQuotaEvidence>): void {
    const current = this.state.quota;
    this.state.quota = {
      rateLimitType: evidence.rateLimitType ?? current?.rateLimitType ?? null,
      resetsAt: evidence.resetsAt ?? current?.resetsAt ?? null,
    };
  }

  // Only a rejected limit is quota; allowed and allowed_warning are not.
  private parseRateLimit(value: JsonObject): void {
    const info = value.rate_limit_info;
    if (!isRecord(info) || info.status !== "rejected") return;
    const type = info.rateLimitType;
    const resetsAt = info.resetsAt;
    this.recordQuota({
      rateLimitType: typeof type === "string" &&
          CLAUDE_RATE_LIMIT_TYPES.has(type)
        ? type
        : null,
      resetsAt: typeof resetsAt === "number" && Number.isSafeInteger(resetsAt)
        ? resetsAt
        : null,
    });
  }

  // A usage-limit refusal arrives as an assistant record with a top-level
  // error. api_retry also says `rate_limit` but is retried, so it is not quota.
  private parseAssistantError(value: JsonObject): void {
    if (value.error === "rate_limit" || value.error === "billing_error") {
      this.recordQuota({});
    }
  }

  private parseSystem(value: JsonObject): void {
    const subtype = typeof value.subtype === "string" ? value.subtype : "";
    const version = textField(value, [
      "claude_code_version",
      "claudeCodeVersion",
      "version",
    ]);
    const model = textField(value, ["model"]);
    if (subtype === "init") {
      if (this.state.initialized) this.state.contradictory = true;
      this.state.initialized = true;
      this.bindSession(textField(value, ["session_id", "sessionId"]));
      this.bindText("claudeCodeVersion", version);
      this.bindText("model", model);
      const capabilities = arrayOfText(value.capabilities);
      this.state.capabilities = capabilities.length > 0
        ? capabilities
        : arrayOfText(value.tools);
      return;
    }
    this.bindText("claudeCodeVersion", version);
    this.bindText("model", model);
    if (subtype === "api_retry") this.parseApiRetry(value);
  }

  private parseApiRetry(value: JsonObject): void {
    if (this.state.apiRetryEvents.length >= MAX_API_RETRY_EVENTS) return;
    const event = {
      type: "api_retry" as const,
      attempt: numberField(value, ["attempt", "retry_attempt"]),
      delayMs: numberField(value, [
        "retry_delay_ms",
        "retry_after_ms",
        "retryAfterMs",
        "delay_ms",
      ]),
    };
    this.state.apiRetryEvents.push(event);
    this.eventRecorder?.record(event);
  }

  private parseResult(value: JsonObject): void {
    if (!this.state.initialized) this.state.malformed = true;
    this.bindSession(textField(value, ["session_id", "sessionId"]));
    const cost = numberField(value, ["total_cost_usd"]);
    if (cost !== null) this.state.totalCostUsd = cost;
    const subtype = typeof value.subtype === "string" ? value.subtype : "";
    const failure = value.is_error === true || subtype !== "success";
    this.state.terminalRecords++;
    this.state.resultRecord = value;
    if (failure) this.state.terminal = "failure";
    else if (this.state.terminal !== "failure") this.state.terminal = "success";
  }
}

// The result shape is validated by workerActionOutputSchema at the supervisor boundary.

type ClaudeCopyBudget = {
  files: number;
  bytes: number;
};

function pathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" ||
    (!child.startsWith("..") && child !== ".." && !child.includes("/../"));
}

function safeStateSegment(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

async function sweepClaudeAttemptDirectories(stateDir: string): Promise<void> {
  const root = join(stateDir, "claude-harness");
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await Deno.chmod(root, 0o700);
  for await (const entry of Deno.readDir(root)) {
    if (entry.name === "sessions" && entry.isDirectory) continue;
    await Deno.remove(join(root, entry.name), { recursive: true }).catch(
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
  }
}

async function copyClaudeEntry(
  source: string,
  destination: string,
  budget: ClaudeCopyBudget,
  depth: number,
  skipNames: readonly string[],
): Promise<boolean> {
  if (depth > MAX_NATIVE_STATE_DEPTH) {
    throw new Error("CLAUDE_HARNESS_NATIVE_STATE_DEPTH");
  }
  const info = await Deno.lstat(source);
  if (info.isSymlink) throw new Error("CLAUDE_HARNESS_NATIVE_STATE_SYMLINK");
  if (info.isFile) {
    // Session state never carries credentials, whatever depth the child hid
    // an auth file at.
    if (skipNames.includes(basename(source))) return false;
    if (info.size > MAX_NATIVE_STATE_BYTES) {
      throw new Error("CLAUDE_HARNESS_NATIVE_STATE_FILE_TOO_LARGE");
    }
    if (
      budget.files >= MAX_NATIVE_STATE_FILES ||
      budget.bytes + info.size > MAX_NATIVE_STATE_BYTES
    ) {
      throw new Error("CLAUDE_HARNESS_NATIVE_STATE_TOO_LARGE");
    }
    await Deno.mkdir(resolve(destination, ".."), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.copyFile(source, destination);
    await Deno.chmod(destination, 0o600);
    budget.files++;
    budget.bytes += info.size;
    return true;
  }
  if (!info.isDirectory) {
    throw new Error("CLAUDE_HARNESS_NATIVE_STATE_ENTRY_UNSUPPORTED");
  }
  await Deno.mkdir(destination, { recursive: true, mode: 0o700 });
  await Deno.chmod(destination, 0o700);
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(source)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  let copied = false;
  for (const entry of entries) {
    copied = await copyClaudeEntry(
      join(source, entry.name),
      join(destination, entry.name),
      budget,
      depth + 1,
      skipNames,
    ) || copied;
  }
  return copied;
}

async function copyClaudeAllowlist(
  sourceRoot: string,
  destinationRoot: string,
  allowlist: readonly string[],
  skipNames: readonly string[] = [],
): Promise<boolean> {
  const rootInfo = await Deno.lstat(sourceRoot).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!rootInfo) return false;
  if (rootInfo.isSymlink || !rootInfo.isDirectory) {
    throw new Error("CLAUDE_HARNESS_NATIVE_STATE_ROOT_INVALID");
  }
  await Deno.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await Deno.chmod(destinationRoot, 0o700);
  const budget = { files: 0, bytes: 0 };
  let copied = false;
  for (const name of allowlist) {
    const source = join(sourceRoot, name);
    const destination = join(destinationRoot, name);
    if (
      !pathInside(sourceRoot, source) ||
      !pathInside(destinationRoot, destination)
    ) {
      throw new Error("CLAUDE_HARNESS_NATIVE_STATE_PATH");
    }
    const info = await Deno.lstat(source).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (!info) continue;
    copied = await copyClaudeEntry(source, destination, budget, 0, skipNames) ||
      copied;
  }
  return copied;
}

type ClaudeSessionScanBudget = {
  files: number;
  bytes: number;
};

function isSupportedClaudeNativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    parts.length < 2 ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    !["projects", "sessions"].includes(parts[0])
  ) return false;
  const name = parts[parts.length - 1];
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return CLAUDE_NATIVE_SESSION_EXTENSIONS.has(extension);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

type ClaudeNativeRecordFileResult =
  | { readonly kind: "match"; readonly evidence: ClaudeSessionEvidence }
  | { readonly kind: "none" | "invalid" };

async function validateClaudeNativeRecordFile(
  statePath: string,
  relativePath: string,
  sessionId: string,
  budget: ClaudeSessionScanBudget,
): Promise<ClaudeNativeRecordFileResult> {
  if (!isSupportedClaudeNativePath(relativePath)) {
    return { kind: "invalid" };
  }
  const parts = relativePath.replaceAll("\\", "/").split("/");
  let current = resolve(statePath);
  const rootInfo = await Deno.lstat(current).catch(() => undefined);
  if (!rootInfo || rootInfo.isSymlink || !rootInfo.isDirectory) {
    return { kind: "invalid" };
  }
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await Deno.lstat(current).catch(() => undefined);
    if (!info || info.isSymlink || !info.isDirectory) {
      return { kind: "invalid" };
    }
  }
  const filePath = join(current, parts[parts.length - 1]);
  const info = await Deno.lstat(filePath).catch(() => undefined);
  if (
    !info || info.isSymlink || !info.isFile ||
    info.size > MAX_NATIVE_STATE_BYTES ||
    budget.files >= MAX_NATIVE_STATE_FILES ||
    budget.bytes + info.size > MAX_NATIVE_STATE_BYTES
  ) return { kind: "invalid" };
  const bytes = await Deno.readFile(filePath);
  budget.files++;
  budget.bytes += bytes.byteLength;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "invalid" };
  }
  let found = false;
  let wrongSession = false;
  let recordCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    if (utf8ByteLength(line) > MAX_NATIVE_RECORD_LINE_BYTES) {
      return { kind: "invalid" };
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return { kind: "invalid" };
    }
    if (!isRecord(record) || ++recordCount > MAX_NATIVE_SESSION_RECORDS) {
      return { kind: "invalid" };
    }
    const hasSnake = Object.hasOwn(record, "session_id");
    const hasCamel = Object.hasOwn(record, "sessionId");
    if (
      (hasSnake && typeof record.session_id !== "string") ||
      (hasCamel && typeof record.sessionId !== "string")
    ) return { kind: "invalid" };
    const snake = hasSnake ? record.session_id as string : undefined;
    const camel = hasCamel ? record.sessionId as string : undefined;
    if (snake !== undefined && camel !== undefined && snake !== camel) {
      return { kind: "invalid" };
    }
    const recordSession = snake ?? camel;
    if (recordSession === undefined) continue;
    if (recordSession === sessionId) found = true;
    else wrongSession = true;
  }
  if (found && wrongSession) return { kind: "invalid" };
  if (!found) return { kind: "none" };
  return {
    kind: "match",
    evidence: {
      relativePath: parts.join("/"),
      sha256: await sha256Hex(bytes),
    },
  };
}

type ClaudeNativeScanResult = {
  evidence?: ClaudeSessionEvidence;
  invalid: boolean;
};

async function scanClaudeNativeRecords(
  statePath: string,
  source: string,
  sessionId: string,
  budget: ClaudeSessionScanBudget,
  depth: number,
): Promise<ClaudeNativeScanResult> {
  if (depth > MAX_NATIVE_STATE_DEPTH) {
    return { invalid: true };
  }
  const info = await Deno.lstat(source).catch(() => undefined);
  if (!info || info.isSymlink) return { invalid: true };
  if (info.isFile) {
    const relativePath = relative(resolve(statePath), resolve(source));
    if (!isSupportedClaudeNativePath(relativePath)) return { invalid: false };
    const result = await validateClaudeNativeRecordFile(
      statePath,
      relativePath,
      sessionId,
      budget,
    );
    return result.kind === "match"
      ? { evidence: result.evidence, invalid: false }
      : { invalid: result.kind === "invalid" };
  }
  if (!info.isDirectory) return { invalid: true };
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(source)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  let evidence: ClaudeSessionEvidence | undefined;
  for (const entry of entries) {
    const result = await scanClaudeNativeRecords(
      statePath,
      join(source, entry.name),
      sessionId,
      budget,
      depth + 1,
    );
    if (result.invalid) return result;
    if (result.evidence) {
      if (evidence) return { invalid: true };
      evidence = result.evidence;
    }
  }
  return { evidence, invalid: false };
}

async function findClaudeSessionEvidence(
  statePath: string,
  sessionId: string,
): Promise<ClaudeSessionEvidence | undefined> {
  const budget = { files: 0, bytes: 0 };
  let evidence: ClaudeSessionEvidence | undefined;
  for (const name of ["projects", "sessions"] as const) {
    const root = join(statePath, name);
    const info = await Deno.lstat(root).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (!info) continue;
    const result = await scanClaudeNativeRecords(
      statePath,
      root,
      sessionId,
      budget,
      0,
    );
    if (result.invalid) return undefined;
    if (result.evidence) {
      if (evidence) return undefined;
      evidence = result.evidence;
    }
  }
  return evidence;
}

async function validateClaudeSessionEvidence(
  statePath: string,
  evidence: ClaudeSessionEvidence,
  sessionId: string,
): Promise<boolean> {
  const budget = { files: 0, bytes: 0 };
  const result = await validateClaudeNativeRecordFile(
    statePath,
    evidence.relativePath,
    sessionId,
    budget,
  );
  return result.kind === "match" &&
    result.evidence.sha256 === evidence.sha256;
}

function claudeSessionStatePath(
  options: ClaudeHarnessOptions,
  assignment: JobAssignment,
  sessionId: string,
): string | undefined {
  const input = isRecord(assignment.input) ? assignment.input : {};
  const repositoryId = typeof input.repositoryId === "string"
    ? input.repositoryId
    : undefined;
  if (
    !options.stateDir ||
    !safeStateSegment(repositoryId) ||
    !safeStateSegment(assignment.agentSessionId) ||
    !safeStateSegment(sessionId)
  ) return undefined;
  return join(
    options.stateDir,
    "claude-harness",
    "sessions",
    repositoryId,
    assignment.agentSessionId,
    sessionId,
  );
}

function explicitResumeStatePath(
  options: ClaudeHarnessOptions,
  checkpoint: JsonObject,
): string | undefined {
  const path = textField(checkpoint, [
    "localStatePath",
    "resumeStatePath",
    "statePath",
    "configPath",
  ]);
  return options.stateDir && path && pathInside(options.stateDir, path)
    ? path
    : undefined;
}
function checkpointSidecarPath(statePath: string): string {
  return join(statePath, CLAUDE_CHECKPOINT_SIDECAR);
}

function claudeRepositoryId(assignment: JobAssignment): string | undefined {
  const input = isRecord(assignment.input) ? assignment.input : {};
  const repositoryId = textField(input, ["repositoryId"]);
  return safeStateSegment(repositoryId) ? repositoryId : undefined;
}

async function verifiedClaudeCheckpointMetadata(
  statePath: string,
  assignment: JobAssignment,
  sessionId: string,
  checkpointTokenValue: string,
  baseSha: string,
  harnessVersion: string,
): Promise<ClaudeCheckpointMetadata | undefined> {
  try {
    const metadataPath = checkpointSidecarPath(statePath);
    const info = await Deno.lstat(metadataPath);
    if (
      info.isSymlink || !info.isFile ||
      info.size > MAX_CHECKPOINT_SIDECAR_BYTES
    ) return undefined;
    const value: unknown = JSON.parse(await Deno.readTextFile(metadataPath));
    const repositoryId = claudeRepositoryId(assignment);
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.repositoryId !== "string" ||
      typeof value.agentSessionId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.checkpointToken !== "string" ||
      typeof value.worktreeRevision !== "string" ||
      value.repositoryId !== repositoryId ||
      value.agentSessionId !== assignment.agentSessionId ||
      value.sessionId !== sessionId ||
      value.checkpointToken !== checkpointTokenValue ||
      value.worktreeRevision !== baseSha ||
      typeof value.harnessVersion !== "string" ||
      value.harnessVersion !== harnessVersion ||
      typeof value.nativeFile !== "string" ||
      !isSupportedClaudeNativePath(value.nativeFile) ||
      typeof value.nativeFileSha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(value.nativeFileSha256)
    ) return undefined;
    return {
      schemaVersion: 1,
      repositoryId: value.repositoryId,
      agentSessionId: value.agentSessionId,
      sessionId: value.sessionId,
      checkpointToken: value.checkpointToken,
      worktreeRevision: value.worktreeRevision,
      harnessVersion: value.harnessVersion,
      nativeFile: value.nativeFile,
      nativeFileSha256: value.nativeFileSha256.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

async function writeClaudeCheckpointMetadata(
  statePath: string,
  metadata: ClaudeCheckpointMetadata,
): Promise<void> {
  const serialized = JSON.stringify(metadata);
  if (utf8ByteLength(serialized) > MAX_CHECKPOINT_SIDECAR_BYTES) {
    throw new Error("CLAUDE_HARNESS_CHECKPOINT_METADATA_TOO_LARGE");
  }
  const metadataPath = checkpointSidecarPath(statePath);
  await Deno.writeTextFile(metadataPath, serialized);
  await Deno.chmod(metadataPath, 0o600);
}

/**
 * True when the Claude credentials file under `sourceRoot` is a regular,
 * non-symlink file. Any lstat failure (missing, permission, other) is
 * "unavailable"; this never throws. Shared by the auth copy and the
 * `capability:model` readiness check so both judge the same condition.
 */
export async function claudeAuthSourceAvailable(
  sourceRoot: string,
): Promise<boolean> {
  try {
    const info = await Deno.lstat(join(sourceRoot, ".credentials.json"));
    return !info.isSymlink && info.isFile;
  } catch {
    return false;
  }
}

export async function prepareClaudeAuth(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  if (!(await claudeAuthSourceAvailable(sourceRoot))) {
    throw new Error("CLAUDE_HARNESS_AUTH_UNAVAILABLE");
  }
  const copied = await copyClaudeAllowlist(
    sourceRoot,
    destinationRoot,
    CLAUDE_AUTH_ALLOWLIST,
  );
  if (!copied) throw new Error("CLAUDE_HARNESS_AUTH_UNAVAILABLE");
}

async function prepareClaudeResume(
  options: ClaudeHarnessOptions,
  assignment: JobAssignment,
  input: JsonObject,
  baseSha: string,
  configPath: string,
  harnessVersion: string,
): Promise<string | undefined> {
  const checkpoint = matchingClaudeResumeCheckpoint(
    assignment,
    input,
    baseSha,
  );
  if (!checkpoint) return undefined;
  const resumeSession = checkpointSessionIdentity(checkpoint);
  const resumeToken = checkpointToken(checkpoint);
  if (!resumeSession || !resumeToken) return undefined;
  const statePath = explicitResumeStatePath(options, checkpoint) ??
    claudeSessionStatePath(options, assignment, resumeSession);
  if (
    !statePath || !options.stateDir || !pathInside(options.stateDir, statePath)
  ) {
    return undefined;
  }
  const metadata = await verifiedClaudeCheckpointMetadata(
    statePath,
    assignment,
    resumeSession,
    resumeToken,
    baseSha,
    harnessVersion,
  );
  if (!metadata) return undefined;
  if (
    !await validateClaudeSessionEvidence(
      statePath,
      {
        relativePath: metadata.nativeFile,
        sha256: metadata.nativeFileSha256,
      },
      resumeSession,
    )
  ) return undefined;
  const copied = await copyClaudeAllowlist(
    statePath,
    configPath,
    CLAUDE_STATE_ALLOWLIST,
    CLAUDE_AUTH_ALLOWLIST,
  );
  if (!copied) return undefined;
  return await validateClaudeSessionEvidence(
      configPath,
      {
        relativePath: metadata.nativeFile,
        sha256: metadata.nativeFileSha256,
      },
      resumeSession,
    )
    ? resumeSession
    : undefined;
}

async function retainClaudeSessionState(
  options: ClaudeHarnessOptions,
  assignment: JobAssignment,
  configPath: string,
  sessionId: string | undefined,
  checkpointTokenValue: string | undefined,
  baseSha: string,
  harnessVersion: string,
): Promise<void> {
  if (!sessionId || !checkpointTokenValue) return;
  const repositoryId = claudeRepositoryId(assignment);
  const statePath = claudeSessionStatePath(options, assignment, sessionId);
  if (!statePath || !options.stateDir || !repositoryId) return;
  const copied = await copyClaudeAllowlist(
    configPath,
    statePath,
    CLAUDE_STATE_ALLOWLIST,
    CLAUDE_AUTH_ALLOWLIST,
  );
  if (!copied) return;
  const evidence = await findClaudeSessionEvidence(statePath, sessionId);
  if (!evidence) return;
  await writeClaudeCheckpointMetadata(statePath, {
    schemaVersion: 1,
    repositoryId,
    agentSessionId: assignment.agentSessionId!,
    sessionId,
    checkpointToken: checkpointTokenValue,
    worktreeRevision: baseSha,
    harnessVersion,
    nativeFile: evidence.relativePath,
    nativeFileSha256: evidence.sha256,
  });
}

export async function claudeConfigDirectory(
  options: ClaudeHarnessOptions,
  assignment: JobAssignment,
): Promise<{ root: string; path: string; home: string }> {
  let root: string;
  if (options.stateDir) {
    if (!safeStateSegment(assignment.attemptId)) {
      throw new Error("CLAUDE_HARNESS_ATTEMPT_ID_INVALID");
    }
    await sweepClaudeAttemptDirectories(options.stateDir);
    root = join(options.stateDir, "claude-harness", assignment.attemptId);
    await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  } else {
    root = await Deno.makeTempDir({ prefix: "bakery-claude-config-" });
  }
  await Deno.chmod(root, 0o700);
  // CLAUDE_CONFIG_DIR and the child HOME both live under the attempt root, so
  // one recursive removal clears them and the child never sees operator HOME.
  const path = join(root, "config");
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
  return { root, path, home: await prepareHarnessHome(root) };
}

async function executeClaudeHarness(
  assignment: JobAssignment,
  signal: AbortSignal,
  output: NativeOutputSink | undefined,
  options: ClaudeHarnessOptions,
  restore: HarnessRestoreTarget,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const input = isRecord(assignment.input) ? assignment.input : {};
  const repair = assignment.action === HARNESS_REPAIR_ACTION
    ? readRepairInput(assignment, CLAUDE_FAULT_NAMING)
    : undefined;
  if (repair !== undefined && "status" in repair) return repair;
  const planArtifact = input.planArtifact;
  const profile = RepositoryExecutionContextSchema.safeParse(
    input.repositoryProfile,
  );
  if (
    repair === undefined &&
    (typeof planArtifact !== "string" || !profile.success)
  ) {
    return claudeHarnessFault(
      "CLAUDE_HARNESS_INPUT_INVALID",
      "The Claude Code harness needs a plan artifact and a repository profile.",
      500,
      false,
    );
  }
  if (options.stateDir && !safeStateSegment(assignment.attemptId)) {
    return claudeHarnessFault(
      "CLAUDE_HARNESS_INPUT_INVALID",
      "The Claude Code harness needs a safe attempt identifier.",
      500,
      false,
    );
  }
  if (signal.aborted) return provenCanceledOutcome();

  const worktree = await options.repositoryFor(assignment);
  const dirty = await requireCleanHarnessWorktree(worktree, "CLAUDE_HARNESS");
  if (dirty) return dirty;
  const baseSha = await harnessHeadRevision(worktree, "CLAUDE_HARNESS");
  if (repair !== undefined) {
    // Before the restore target is recorded: nothing was changed to restore.
    const mismatch = repairRevisionMismatch(
      CLAUDE_FAULT_NAMING,
      repair.revision,
      baseSha,
    );
    if (mismatch) return mismatch;
  }
  await recordHarnessRestoreTarget(
    restore,
    worktree,
    baseSha,
    harnessWorktreeGuard(options)?.stateDir,
  );
  const basePrompt = [
    "Implement the task pinned by plan artifact",
    planArtifact,
    "inside the current repository working tree.",
    "Edit files in place. Do not push, publish, or contact external services",
    "other than the model provider itself.",
  ].join(" ");
  const instructions = typeof input.instructions === "string" &&
      input.instructions.length > 0 && input.instructions.length <= 4_000
    ? input.instructions
    : undefined;
  const prompt = repair !== undefined
    ? buildRepairPrompt(repair)
    : instructions === undefined
    ? basePrompt
    : `${basePrompt}\n\nTask instructions:\n${instructions}`;
  const commitMessage = repair !== undefined
    ? repairCommitMessage(repair.revision)
    : `bakery: plan artifact ${planArtifact}`;
  const parser = new ClaudeStreamParser(options.eventRecorder);
  const resumeCheckpoint = matchingClaudeResumeCheckpoint(
    assignment,
    input,
    baseSha,
  );
  const config = await claudeConfigDirectory(options, assignment);
  try {
    try {
      await prepareClaudeAuth(options.authSourceDir, config.path);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CLAUDE_HARNESS_AUTH_UNAVAILABLE"
      ) {
        return harnessCredentialUnavailable(
          "CLAUDE",
          "Claude Code",
          "The Claude Code harness could not complete the bounded task",
        );
      }
      return claudeHarnessFault(
        "CLAUDE_HARNESS_INPUT_INVALID",
        "Claude native authentication preparation was unavailable.",
        500,
        false,
      );
    }
    // The child can read its auth copy through the model's file tools, so
    // every token in it must be redacted from output and withheld from patches.
    let credentialSecrets: readonly string[];
    try {
      credentialSecrets = await harnessCredentialSecrets(
        join(options.authSourceDir, CLAUDE_AUTH_ALLOWLIST[0]),
      );
    } catch {
      return harnessCredentialUnavailable(
        "CLAUDE",
        "Claude Code",
        "The Claude Code harness could not complete the bounded task",
      );
    }
    const childEnvironment = {
      HOME: config.home,
      CLAUDE_CONFIG_DIR: config.path,
    };
    const claudeExecutable = options.claudeExecutable ?? "claude";
    const versionProbe = await probeHarnessVersion(
      claudeExecutable,
      worktree,
      childEnvironment,
      signal,
    );
    if (signal.aborted) return harnessCanceledOutcome(versionProbe.teardown);
    if (
      versionProbe.teardown !== "not-needed" &&
      versionProbe.teardown.status === "unconfirmed"
    ) {
      return harnessTeardownFault("CLAUDE", versionProbe.teardown);
    }
    if (versionProbe.timedOut) {
      return claudeHarnessFault(
        "CLAUDE_HARNESS_TIMEOUT",
        "The pinned Claude Code CLI version probe exceeded its startup deadline.",
        504,
        true,
      );
    }
    const harnessVersion = versionProbe.version;
    if (!harnessVersion) {
      return claudeHarnessFault(
        "CLAUDE_HARNESS_EXIT_NONZERO",
        "The pinned Claude Code CLI version probe did not complete successfully.",
        502,
        false,
      );
    }
    let resumeSession: string | undefined;
    try {
      resumeSession = await prepareClaudeResume(
        options,
        assignment,
        input,
        baseSha,
        config.path,
        harnessVersion,
      );
    } catch {
      return claudeHarnessFault(
        "CLAUDE_HARNESS_INPUT_INVALID",
        "Claude native state preparation was unavailable.",
        500,
        false,
      );
    }
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--tools",
      CLAUDE_FILE_TOOLS,
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--allowedTools",
      CLAUDE_FILE_TOOLS,
      // Deny wins over the allow list: the model's file tools never open the
      // attempt config dir that holds the auth copy. Gitignore-style `//`
      // marks an absolute path; `config.path` is worker-owned, never data from
      // the assignment.
      "--disallowedTools",
      `Read(/${resolve(config.path)}/**)`,
      `Edit(/${resolve(config.path)}/**)`,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
      ...(resumeSession ? ["--resume", resumeSession] : []),
    ];
    const run = await runBoundedHarness({
      executable: claudeExecutable,
      cwd: worktree,
      prompt,
      timeLimitMs: options.timeLimitMs ?? CLAUDE_HARNESS_DEFAULT_TIME_LIMIT_MS,
      signal,
      output,
      groupKillExecutable: options.groupKillExecutable,
      environment: childEnvironment,
      onOutput: (channel, chunk) => {
        if (channel === "stdout") parser.feed(chunk);
      },
      args,
    });
    parser.finish();
    const sessionId = parser.state.sessionId;
    if (signal.aborted) return harnessCanceledOutcome(run.teardown);
    if (run.timedOut) {
      if (
        run.teardown !== "not-needed" && run.teardown.status === "unconfirmed"
      ) {
        return harnessTeardownFault("CLAUDE", run.teardown);
      }
      return claudeHarnessFault(
        "CLAUDE_HARNESS_TIMEOUT",
        "The pinned Claude Code run exceeded its explicit time limit and was stopped.",
        504,
        true,
        parser.state.apiRetryEvents,
      );
    }
    const quota = parser.state.quota;
    if (
      quota !== undefined && parser.state.initialized &&
      !parser.state.malformed && !parser.state.contradictory &&
      parser.state.terminal !== "success"
    ) {
      // Lowercase on purpose: the public run reasonCode vocabulary is
      // `quota_exceeded` and the server projects result.fault.code straight
      // into it (apps/server/src/modules/execution/attempt-read-query.ts),
      // so no mapping layer is needed. Not retryable: the quota stays gone.
      return claudeHarnessFault(
        "quota_exceeded",
        `The Claude Code provider reported exhausted quota or rate limit.${
          quota.rateLimitType ? ` rate_limit_type=${quota.rateLimitType}` : ""
        }${quota.resetsAt !== null ? ` resets_at=${quota.resetsAt}` : ""}`,
        429,
        false,
        parser.state.apiRetryEvents,
      );
    }
    if (run.code !== 0) {
      return claudeHarnessFault(
        "CLAUDE_HARNESS_EXIT_NONZERO",
        `claude exited with code ${run.code}.`,
        502,
        false,
        parser.state.apiRetryEvents,
      );
    }
    if (
      parser.state.malformed || parser.state.truncated ||
      parser.state.contradictory ||
      !parser.state.initialized ||
      parser.state.terminalRecords !== 1 ||
      parser.state.terminal !== "success" ||
      !parser.state.claudeCodeVersion ||
      !sessionId || !UUID_PATTERN.test(sessionId) ||
      (resumeSession !== undefined && sessionId !== resumeSession)
    ) {
      return claudeHarnessFault(
        "CLAUDE_HARNESS_EXIT_NONZERO",
        "The Claude Code stream did not contain a valid, consistent successful terminal result.",
        502,
        false,
        parser.state.apiRetryEvents,
      );
    }
    // The child may have refreshed its token mid-run: scan for that too.
    let refreshedSecrets: readonly string[];
    try {
      refreshedSecrets = await harnessCredentialSecrets(
        join(config.path, CLAUDE_AUTH_ALLOWLIST[0]),
      );
    } catch {
      return harnessCredentialUnavailable(
        "CLAUDE",
        "Claude Code",
        "The Claude Code harness could not complete the bounded task",
      );
    }
    await retainClaudeSessionState(
      options,
      assignment,
      config.path,
      sessionId,
      checkpointToken(resumeCheckpoint ?? {}),
      baseSha,
      harnessVersion,
    ).catch(() => undefined);

    const publication = await publishHarnessPatch({
      assignment,
      repository: worktree,
      baseSha,
      signal,
      publish: options.publishFor(assignment),
      commitMessage,
      commitUserEmail: "bakery-harness@bakery.local",
      commitUserName: "Bakery Claude Code Harness",
      artifactName: `claude-patch-${assignment.jobId}-${assignment.fence}.diff`,
      source: "claude-harness",
      commitFailureCode: "CLAUDE_HARNESS_COMMIT_FAILED",
      digestMismatchCode: "CLAUDE_HARNESS_ARTIFACT_DIGEST_MISMATCH",
      gitFailurePrefix: "CLAUDE_HARNESS",
      secrets: [
        assignment.leaseToken,
        ...(options.redactionSecrets ?? []),
        ...credentialSecrets,
        ...refreshedSecrets,
      ],
      faultTitle: "The Claude Code harness could not complete the bounded task",
    });
    if ("status" in publication) {
      return withClaudeRetryDetail(
        publication,
        parser.state.apiRetryEvents,
      );
    }

    return {
      status: "completed",
      result: {
        baseSha,
        headSha: publication.headSha,
        // The server binds result sessionId to a Bakery agent session; the
        // native CLI session stays in the retained checkpoint sidecar.
        sessionId: assignment.agentSessionId!,
        artifacts: publication.artifacts,
        claudeCodeVersion: parser.state.claudeCodeVersion,
        model: parser.state.model ?? null,
        capabilities: parser.state.capabilities,
        events: parser.state.apiRetryEvents,
        telemetry: { total_cost_usd: parser.state.totalCostUsd },
      } as unknown as JsonValue,
    };
  } finally {
    await Deno.remove(config.root, { recursive: true }).catch(() => undefined);
  }
}

async function claudeModelCheck(
  authSourceDir: string,
): Promise<WorkerInventoryCheck> {
  const available = await claudeAuthSourceAvailable(authSourceDir);
  return {
    checkId: CLAUDE_MODEL_CHECK_ID,
    checkVersion: CLAUDE_MODEL_CHECK_VERSION,
    status: available ? "pass" : "fail",
    ...(available ? {} : { reason: CLAUDE_AUTH_UNAVAILABLE_REASON }),
    observedAt: new Date().toISOString(),
  };
}

/**
 * Opt-in real Claude Code executor. Unsupported actions remain delegated to
 * the wrapped deterministic/native executor.
 */
export function createClaudeHarnessExecutor(
  options: ClaudeHarnessOptions,
): WorkerExecutor {
  if (
    options.effort !== undefined &&
    !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(options.effort)
  ) {
    throw new Error(
      `CLAUDE_HARNESS_EFFORT_INVALID:${CLAUDE_EFFORT_LEVELS.join("|")}`,
    );
  }
  if (
    options.coordinatorEffort !== undefined &&
    !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(
      options.coordinatorEffort,
    )
  ) {
    throw new Error(
      `CLAUDE_COORDINATOR_EFFORT_INVALID:${CLAUDE_EFFORT_LEVELS.join("|")}`,
    );
  }
  const inner = options.inner;
  const harnessBusy = createHarnessBusyLatch();
  const guard = harnessWorktreeGuard(options);
  return {
    supportedActions: [
      ...new Set([
        ...(inner?.supportedActions ?? CLAUDE_HARNESS_SUPPORTED_ACTIONS),
        HARNESS_REPAIR_ACTION,
        COORDINATOR_TURN_ACTION,
      ]),
    ],
    capturesNativeOutput: inner?.capturesNativeOutput ?? true,
    async initialize() {
      await inner?.initialize?.();
      await initializeHarnessWorktree(guard, harnessBusy);
    },
    async credentialRedactionSecrets(assignment) {
      if (!isHarnessEditAction(assignment.action)) {
        return await inner?.credentialRedactionSecrets?.(assignment) ?? [];
      }
      return await harnessCredentialSecrets(
        join(options.authSourceDir, CLAUDE_AUTH_ALLOWLIST[0]),
      );
    },
    async readinessChecks() {
      const delegated = await inner?.readinessChecks?.() ?? [];
      const checks = [
        ...delegated.filter((check) => check.checkId !== CLAUDE_MODEL_CHECK_ID),
        await claudeModelCheck(options.authSourceDir),
      ];
      return await harnessReadinessChecks(checks, guard, harnessBusy);
    },
    execute(assignment, signal, output, preparedSkills) {
      if (assignment.action === COORDINATOR_TURN_ACTION) {
        if (!harnessBusy.acquire()) {
          return Promise.resolve(
            commonHarnessFault(
              "CLAUDE_COORDINATOR_BUSY",
              "The Claude Code harness is already running one bounded assignment; ask again later.",
              503,
              false,
              "The Claude Code coordinator could not complete the turn",
            ),
          );
        }
        return executeClaudeCoordinatorTurn(assignment, signal, options, output)
          .finally(harnessBusy.release);
      }
      if (!isHarnessEditAction(assignment.action)) {
        if (!inner) {
          return Promise.resolve(
            claudeHarnessFault(
              "CLAUDE_HARNESS_ACTION_UNSUPPORTED",
              `The Claude Code harness supports only ${CLAUDE_ACTION} and ${HARNESS_REPAIR_ACTION}.`,
              500,
              false,
            ),
          );
        }
        return inner.execute(assignment, signal, output, preparedSkills);
      }
      // Wait for an in-flight readiness pass instead of failing as busy.
      return harnessBusy.settled().then(() => {
        if (!harnessBusy.acquire()) {
          return Promise.resolve(
            claudeHarnessFault(
              "CLAUDE_HARNESS_BUSY",
              "The Claude Code harness is already running one bounded assignment against this repository; retry later.",
              503,
              true,
            ),
          );
        }
        return withHarnessRestore(
          (restore) =>
            executeClaudeHarness(assignment, signal, output, options, restore),
          guard?.stateDir,
        ).finally(harnessBusy.release);
      });
    },
  };
}
