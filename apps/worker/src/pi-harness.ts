import { join, relative, resolve } from "node:path";
import {
  boundedNativeDiagnostic,
  enforceWorkerFixedPolicy,
  type ExecutionOutcome,
  type WorkerExecutor,
} from "./executor.ts";
import type { NativeOutputSink } from "./native-output.ts";
import {
  buildRepairPrompt,
  createHarnessBusyLatch,
  HARNESS_REPAIR_ACTION,
  harnessCanceledOutcome,
  type HarnessChildEnvironment,
  harnessCredentialSecrets,
  harnessCredentialUnavailable,
  harnessFault as commonHarnessFault,
  type HarnessGroupTeardown,
  harnessHeadRevision,
  HarnessKillTracker,
  harnessReadinessChecks,
  type HarnessRestoreTarget,
  harnessTeardownFault,
  harnessWorktreeGuard,
  initializeHarnessWorktree,
  isHarnessEditAction,
  killHarnessProcessGroup,
  prepareHarnessHome,
  probeHarnessVersion,
  publishHarnessPatch,
  pumpHarnessOutput,
  readRepairInput,
  recordHarnessRestoreTarget,
  repairCommitMessage,
  repairRevisionMismatch,
  requireCleanHarnessWorktree,
  sha256Hex,
  spawnHarnessProcess,
  withHarnessRestore,
} from "./harness-common.ts";
import { provenCanceledOutcome, type PublishArtifact } from "./task-brief.ts";
import type { JobAssignment, JsonValue } from "./types.ts";
import { WORKER_RESULT_MAX_BYTES } from "./types.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";

const PI_ACTION = "harness.implement";
const MAX_STREAM_LINE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_EVENTS = 512;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_SESSION_PATH_LENGTH = 1_024;
const PI_CHECKPOINT_SIDECAR = ".bakery-checkpoint.json";
const PI_AUTH_FILE = "auth.json";
const PI_STOP_GRACE_MS = 1_000;
const PI_COMMAND_WAIT_MS = 750;
const PI_VERSION_WAIT_MS = 2_000;
const PI_TOOLS = "read,edit,write,grep,find,ls";

/** The edit actions implemented by the Pi RPC adapter. */
export const PI_HARNESS_SUPPORTED_ACTIONS = [
  PI_ACTION,
  HARNESS_REPAIR_ACTION,
] as const;
const PI_FAULT_NAMING = Object.freeze({
  prefix: "PI_HARNESS",
  title: "The Pi harness could not complete the bounded task",
});
/** Pi RPC supports streaming and resumable sessions; controls are opt-in. */
export const PI_HARNESS_CAPABILITIES: readonly string[] = Object.freeze([
  "stream",
  "resume",
  "steer",
  "follow_up",
]);
export const PI_HARNESS_DEFAULT_TIME_LIMIT_MS = 120_000;

export type PiHarnessControlAction = "steer_message" | "follow_up_message";
export type PiHarnessControlDisposition =
  | "accepted"
  | "unsupported"
  | "rejected";
export type PiHarnessControl = {
  send(
    action: PiHarnessControlAction,
    messageId: string,
    body: string,
  ): Promise<PiHarnessControlDisposition>;
};

export type PiHarnessOptions = {
  /** Configured output redaction secrets; also withheld from published patches. */
  readonly redactionSecrets?: readonly string[];
  /** Test seam: absolute group-kill helper used when Deno.kill is not granted. */
  readonly groupKillExecutable?: string;
  readonly publishFor: (assignment: JobAssignment) => PublishArtifact;
  readonly repositoryFor: (
    assignment: JobAssignment,
  ) => string | Promise<string>;
  readonly timeLimitMs?: number;
  readonly piExecutable?: string;
  /** Model pattern passed as --model; pi folds the effort into the pattern suffix. */
  readonly model?: string;
  /** Reasoning effort folded into the --model pattern's `:<level>` suffix. */
  readonly effort?: string;
  /** Private worker state root for per-attempt Pi agent/session files. */
  readonly stateDir?: string;
  /**
   * Fixed harness repository. With `stateDir`, a durable restore marker lets a
   * restarted worker recover an interrupted run and report a dirty clone.
   */
  readonly repository?: string;
  /**
   * Explicit source of the operator's Pi auth.json; never passed to the child.
   * Required: a run without credentials fails closed before the CLI starts.
   */
  readonly piAgentSourceDir: string;
  /** Worker-advertised control capabilities. */
  readonly capabilities?: readonly string[];
  readonly eventRecorder?: PiHarnessEventRecorder;
  readonly registerControl?: (control: PiHarnessControl | undefined) => void;
  readonly inner?: WorkerExecutor;
};

type JsonObject = Record<string, unknown>;
type PiHarnessEvent = JsonObject & { type: string };
type PiSessionEvidence = {
  readonly relativePath: string;
  readonly sha256: string;
};
type PiCheckpointMetadata = {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly agentSessionId: string;
  readonly nativeSessionId: string;
  readonly checkpointToken: string;
  readonly worktreeRevision: string;
  /** First line of `pi --version` that wrote the session; resume needs an exact match. */
  readonly harnessVersion: string;
  readonly sessionFile: string;
  readonly sessionFileSha256: string;
};

type PiStreamState = {
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  events: PiHarnessEvent[];
  currentMessage?: JsonObject;
  currentMessageBytes?: number;
  providerUsage: JsonObject | null;
  promptDisposition?: string;
  settled: boolean;
  aborted: boolean;
  providerFailure: boolean;
  malformed: boolean;
  truncated: boolean;
  contradictory: boolean;
  parseFailure: boolean;
};

export class PiHarnessEventRecorder {
  #events: PiHarnessEvent[] = [];

  record(event: PiHarnessEvent): void {
    if (this.#events.length < MAX_EVENTS) {
      this.#events.push(cloneRecord(event) as PiHarnessEvent);
    }
  }

  snapshot(): readonly PiHarnessEvent[] {
    return this.#events.map((value) => cloneRecord(value) as PiHarnessEvent);
  }
}
function isRecord(value: unknown): value is JsonObject {
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

function safeStateSegment(value: string | undefined): value is string {
  return value !== undefined && value !== "." && value !== ".." &&
    /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" ||
    (!child.startsWith("..") && child !== ".." && !child.includes("/../"));
}

function cloneRecord(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function checkpointToken(record: JsonObject): string | undefined {
  return textField(record, [
    "checkpointToken",
    "checkpoint",
    "sessionFile",
    "sessionPath",
    "resumeToken",
    "resumeHandleRef",
  ]);
}

function sessionIdentity(record: JsonObject): string | undefined {
  return textField(record, [
    "nativeSessionId",
    "sessionId",
    "piSessionId",
    "sessionIdentity",
  ]);
}

// Checkpoints ship inside worker results, where the server resolves every
// sessionId key as a Bakery agent session; the native Pi id never uses it.
function checkpointSessionIdentity(record: JsonObject): string | undefined {
  return textField(record, ["nativeSessionId"]);
}

// Keys the server resolves as run-scoped references anywhere in a result.
const WORKER_REFERENCE_KEYS = new Set([
  "sessionId",
  "checkRunIds",
  "snapshotId",
]);

function withoutReferenceKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReferenceKeys);
  if (!isRecord(value)) return value;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (!WORKER_REFERENCE_KEYS.has(key)) {
      result[key] = withoutReferenceKeys(child);
    }
  }
  return result;
}

function worktreeRevision(record: JsonObject): string | undefined {
  return textField(record, [
    "worktreeRevision",
    "baseSha",
    "revision",
    "headSha",
  ]);
}

function resumeRequest(input: JsonObject): JsonObject | undefined {
  for (const name of ["resume", "piResume", "resumeRequest"]) {
    if (isRecord(input[name])) return input[name];
  }
  if (
    typeof input.resumeSessionId === "string" ||
    typeof input.piSessionId === "string" ||
    typeof input.sessionFile === "string"
  ) return input;
  return undefined;
}

function matchingPiResumeCheckpoint(
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

/** Returns a session-file token only when identity, revision and checkpoint proof match. */
export function selectPiResumeSessionFile(
  assignment: Pick<JobAssignment, "agentSessionId" | "currentCheckpoints">,
  inputValue: unknown,
  baseSha: string,
): string | undefined {
  return checkpointToken(
    matchingPiResumeCheckpoint(assignment, inputValue, baseSha) ?? {},
  );
}

function piHarnessFault(
  code: string,
  detail: string,
  status: number,
  retryable: boolean,
): ExecutionOutcome {
  return commonHarnessFault(
    code,
    detail,
    status,
    retryable,
    "The Pi harness could not complete the bounded task",
  );
}

function boundedEvent(event: PiHarnessEvent): PiHarnessEvent {
  const serialized = JSON.stringify(event);
  if (utf8ByteLength(serialized) <= MAX_EVENT_BYTES) return event;
  return { type: event.type, truncated: true };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8ByteLength(value) <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function boundedMessage(message: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const field of ["role", "stopReason"] as const) {
    if (typeof message[field] === "string") {
      result[field] = truncateUtf8(message[field] as string, 128);
    }
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const boundedContent: JsonObject[] = [];
  for (const value of content.slice(0, 64)) {
    if (!isRecord(value)) continue;
    const block: JsonObject = {};
    for (const field of ["type", "id", "name"] as const) {
      if (typeof value[field] === "string") {
        block[field] = truncateUtf8(value[field] as string, 128);
      }
    }
    for (const field of ["text", "thinking"] as const) {
      if (typeof value[field] === "string") {
        block[field] = truncateUtf8(value[field] as string, 4 * 1024);
      }
    }
    if (isRecord(value.arguments)) {
      // Tool arguments are model-authored; drop server reference keys so they
      // cannot be resolved as Bakery references when the result is posted.
      const argumentsValue = withoutReferenceKeys(
        cloneRecord(value.arguments),
      ) as JsonObject;
      block.arguments = utf8ByteLength(JSON.stringify(argumentsValue)) <= 2_048
        ? argumentsValue
        : { truncated: true };
    } else if (typeof value.arguments === "string") {
      block.arguments = truncateUtf8(value.arguments, 2_048);
    }
    boundedContent.push(block);
  }
  let candidate: JsonObject = { ...result, content: boundedContent };
  while (
    boundedContent.length > 0 &&
    utf8ByteLength(JSON.stringify(candidate)) > MAX_EVENT_BYTES
  ) {
    boundedContent.pop();
    candidate = { ...result, content: boundedContent };
  }
  return utf8ByteLength(JSON.stringify(candidate)) <= MAX_EVENT_BYTES
    ? candidate
    : { truncated: true };
}

function boundedResultEvent(event: PiHarnessEvent): PiHarnessEvent {
  const result: JsonObject = { type: event.type };
  if (typeof event.aborted === "boolean") result.aborted = event.aborted;
  if (typeof event.willRetry === "boolean") result.willRetry = event.willRetry;
  if (isRecord(event.message)) result.message = boundedMessage(event.message);
  if (isRecord(event.toolCall)) {
    const bounded = boundedMessage({ content: [event.toolCall] }).content;
    if (Array.isArray(bounded) && isRecord(bounded[0])) {
      result.toolCall = bounded[0];
    }
  }
  return boundedEvent(result as PiHarnessEvent);
}

function boundedResultEvents(
  fixedResult: JsonObject,
  events: readonly PiHarnessEvent[],
): PiHarnessEvent[] {
  const selected: PiHarnessEvent[] = [];
  for (const event of events) {
    const candidate = {
      ...fixedResult,
      events: [...selected, boundedResultEvent(event)],
    };
    const envelope = { status: "completed", result: candidate };
    if (utf8ByteLength(JSON.stringify(envelope)) >= WORKER_RESULT_MAX_BYTES) {
      break;
    }
    selected.push(candidate.events.at(-1) as PiHarnessEvent);
  }
  return selected;
}

function numberIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 &&
      value < 1_024
    ? value
    : undefined;
}

function messageContent(message: JsonObject): unknown[] {
  return Array.isArray(message.content) ? [...message.content] : [];
}

function replaceMessageBlock(
  message: JsonObject,
  index: number,
  block: JsonObject,
): JsonObject {
  const content = messageContent(message);
  content[index] = block;
  return { ...message, content };
}

class PiRpcParser {
  #pending = new Uint8Array(0);
  #overflow = false;
  readonly state: PiStreamState = {
    events: [],
    providerUsage: null,
    settled: false,
    aborted: false,
    providerFailure: false,
    malformed: false,
    truncated: false,
    contradictory: false,
    parseFailure: false,
  };

  constructor(
    private readonly onResponse: (record: JsonObject) => void,
    private readonly onParseFailure: () => void,
    private readonly onSettled: () => void,
    private readonly eventRecorder?: PiHarnessEventRecorder,
  ) {}

  feed(chunk: Uint8Array): void {
    if (this.#overflow || chunk.byteLength === 0) return;
    const combined = new Uint8Array(
      this.#pending.byteLength + chunk.byteLength,
    );
    combined.set(this.#pending);
    combined.set(chunk, this.#pending.byteLength);
    let start = 0;
    for (let index = 0; index < combined.byteLength; index++) {
      if (combined[index] !== 0x0a) continue;
      let end = index;
      if (end > start && combined[end - 1] === 0x0d) end--;
      const line = combined.subarray(start, end);
      if (line.byteLength > MAX_STREAM_LINE_BYTES) {
        this.failOverflow();
        return;
      }
      this.parseLine(line);
      if (this.#overflow) return;
      start = index + 1;
    }
    this.#pending = combined.slice(start);
    if (this.#pending.byteLength > MAX_STREAM_LINE_BYTES) this.failOverflow();
  }

  finish(): void {
    if (this.#overflow) return;
    if (this.#pending.byteLength > 0) {
      this.state.truncated = true;
      this.state.malformed = true;
      this.state.parseFailure = true;
      this.onParseFailure();
      this.#pending = new Uint8Array(0);
    }
  }

  private failOverflow(): void {
    this.#overflow = true;
    this.state.malformed = true;
    this.state.truncated = true;
    this.state.parseFailure = true;
    this.onParseFailure();
  }

  private failParse(): void {
    this.state.malformed = true;
    this.state.parseFailure = true;
    this.onParseFailure();
  }

  private parseLine(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      this.failParse();
      return;
    }
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.failParse();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.failParse();
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.failParse();
      return;
    }
    if (value.type === "response") {
      if (typeof value.id !== "string" || value.id.length === 0) {
        this.failParse();
        return;
      }
      this.onResponse(value);
      return;
    }
    this.parseEvent(value);
  }

  private bindSession(value: string | undefined): void {
    if (
      !value || value.length > MAX_SESSION_ID_LENGTH || !safeStateSegment(value)
    ) {
      this.state.malformed = true;
      return;
    }
    if (this.state.sessionId && this.state.sessionId !== value) {
      this.state.contradictory = true;
      return;
    }
    this.state.sessionId = value;
  }

  private appendEvent(event: PiHarnessEvent): void {
    const bounded = boundedEvent(event);
    if (this.state.events.length < MAX_EVENTS) this.state.events.push(bounded);
    this.eventRecorder?.record(bounded);
  }

  private parseEvent(value: JsonObject): void {
    const eventSession = textField(value, ["sessionId", "session_id"]);
    if (eventSession) this.bindSession(eventSession);
    const type = value.type as string;
    switch (type) {
      case "session": {
        this.bindSession(textField(value, ["id", "sessionId"]));
        const sessionFile = textField(value, ["sessionFile", "sessionPath"]);
        if (sessionFile) this.state.sessionFile = sessionFile;
        this.appendEvent({ type });
        return;
      }
      case "agent_start":
      case "turn_start":
        this.appendEvent({ type });
        return;
      case "message_start": {
        const message = isRecord(value.message)
          ? cloneRecord(value.message)
          : undefined;
        if (message) this.setCurrentMessage(message);
        this.appendEvent({ type, ...(message ? { message } : {}) });
        return;
      }
      case "message_update": {
        const usage = isRecord(value.usage)
          ? cloneRecord(value.usage)
          : undefined;
        if (usage) this.state.providerUsage = usage;
        const assistantMessageEvent = isRecord(value.assistantMessageEvent)
          ? cloneRecord(value.assistantMessageEvent)
          : undefined;
        if (assistantMessageEvent) {
          this.applyAssistantMessageEvent(assistantMessageEvent);
        }
        this.appendEvent({
          type,
          ...(usage ? { usage } : {}),
          ...(assistantMessageEvent ? { assistantMessageEvent } : {}),
        });
        return;
      }
      case "message_end": {
        const message = isRecord(value.message)
          ? cloneRecord(value.message)
          : undefined;
        if (message) {
          this.setCurrentMessage(message);
          if (message.stopReason === "error") this.state.providerFailure = true;
        }
        this.appendEvent({ type, ...(message ? { message } : {}) });
        return;
      }
      case "turn_end": {
        const message = isRecord(value.message)
          ? cloneRecord(value.message)
          : undefined;
        this.appendEvent({
          type,
          ...(message ? { message } : {}),
          ...(Array.isArray(value.toolResults)
            ? { toolResults: value.toolResults }
            : {}),
        });
        return;
      }
      case "agent_end":
        this.appendEvent({
          type,
          ...(Array.isArray(value.messages)
            ? { messages: value.messages }
            : {}),
          ...(typeof value.willRetry === "boolean"
            ? { willRetry: value.willRetry }
            : {}),
        });
        return;
      case "agent_settled":
        this.state.settled = true;
        this.state.aborted = value.aborted === true;
        this.appendEvent({ type, aborted: this.state.aborted });
        this.onSettled();
        return;
      case "toolcall_end":
        if (isRecord(value.toolCall)) {
          this.applyAssistantMessageEvent({
            type,
            contentIndex: value.contentIndex,
            toolCall: value.toolCall,
          });
        }
        this.appendEvent({
          type,
          ...(isRecord(value.toolCall) ? { toolCall: value.toolCall } : {}),
        });
        return;
      case "message_error":
      case "extension_error":
        this.state.providerFailure = true;
        this.appendEvent({
          type,
          ...(textField(value, ["error"])
            ? { error: textField(value, ["error"]) }
            : {}),
        });
        return;
      default:
        return;
    }
  }

  private markStateOverflow(): void {
    this.state.truncated = true;
    this.state.malformed = true;
  }

  private setCurrentMessage(message: JsonObject): void {
    const messageBytes = utf8ByteLength(JSON.stringify(message));
    if (messageBytes > MAX_STATE_BYTES) {
      this.markStateOverflow();
      return;
    }
    this.state.currentMessage = message;
    this.state.currentMessageBytes = messageBytes;
  }

  private appendMessageText(
    current: JsonObject,
    index: number,
    existing: JsonObject,
    field: "text" | "thinking" | "arguments",
    delta: string,
    type?: string,
  ): void {
    const previous = typeof existing[field] === "string"
      ? existing[field] as string
      : "";
    const next = `${previous}${delta}`;
    if (utf8ByteLength(next) > MAX_STATE_BYTES) {
      this.markStateOverflow();
      return;
    }
    const nextMessage = replaceMessageBlock(current, index, {
      ...existing,
      ...(type === undefined ? {} : { type }),
      [field]: next,
    });
    if (typeof existing[field] !== "string") {
      this.setCurrentMessage(nextMessage);
      return;
    }
    const currentBytes = this.state.currentMessageBytes ??
      utf8ByteLength(JSON.stringify(current));
    const deltaBytes = Math.max(
      0,
      utf8ByteLength(JSON.stringify(delta)) - 2,
    );
    if (currentBytes + deltaBytes > MAX_STATE_BYTES) {
      this.markStateOverflow();
      return;
    }
    this.state.currentMessage = nextMessage;
    this.state.currentMessageBytes = currentBytes + deltaBytes;
  }

  private applyAssistantMessageEvent(event: JsonObject): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "error") this.state.providerFailure = true;
    const index = numberIndex(event.contentIndex);
    if (index === undefined || !this.state.currentMessage) return;
    const current = this.state.currentMessage;
    const currentContent = messageContent(current);
    const existing = isRecord(currentContent[index])
      ? currentContent[index] as JsonObject
      : {};
    if (type === "text_start") {
      this.setCurrentMessage(replaceMessageBlock(current, index, {
        type: "text",
        text: "",
      }));
    } else if (type === "text_delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      this.appendMessageText(current, index, existing, "text", delta, "text");
    } else if (type === "text_end") {
      const content = typeof event.content === "string" ? event.content : "";
      if (utf8ByteLength(content) > MAX_STATE_BYTES) {
        this.markStateOverflow();
        return;
      }
      this.setCurrentMessage(replaceMessageBlock(current, index, {
        ...existing,
        type: "text",
        text: content,
      }));
    } else if (type === "thinking_start") {
      this.setCurrentMessage(replaceMessageBlock(current, index, {
        type: "thinking",
        thinking: "",
      }));
    } else if (type === "thinking_delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      this.appendMessageText(
        current,
        index,
        existing,
        "thinking",
        delta,
        "thinking",
      );
    } else if (type === "thinking_end") {
      const content = typeof event.content === "string" ? event.content : "";
      if (utf8ByteLength(content) > MAX_STATE_BYTES) {
        this.markStateOverflow();
        return;
      }
      this.setCurrentMessage(replaceMessageBlock(current, index, {
        ...existing,
        type: "thinking",
        thinking: content,
      }));
    } else if (type === "toolcall_start") {
      this.setCurrentMessage(replaceMessageBlock(current, index, {
        type: "toolCall",
        id: textField(event, ["id"]) ?? "",
        name: textField(event, ["toolName"]) ?? "",
        arguments: "",
      }));
    } else if (type === "toolcall_delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      this.appendMessageText(
        current,
        index,
        existing,
        "arguments",
        delta,
      );
    } else if (type === "toolcall_end" && isRecord(event.toolCall)) {
      // The completed tool call replaces all deltas for this content block.
      this.setCurrentMessage(
        replaceMessageBlock(current, index, cloneRecord(event.toolCall)),
      );
    }
  }

  updateStateFromResponse(record: JsonObject): void {
    if (record.command !== "get_state" || record.success !== true) return;
    const data = isRecord(record.data) ? record.data : {};
    this.bindSession(textField(data, ["sessionId", "id"]));
    const sessionFile = textField(data, ["sessionFile", "sessionPath"]);
    if (sessionFile) {
      if (sessionFile.length > MAX_SESSION_PATH_LENGTH) {
        this.state.malformed = true;
      } else this.state.sessionFile = sessionFile;
    }
    const model = isRecord(data.model) ? data.model : undefined;
    if (model) {
      this.state.model = textField(model, ["id", "modelId", "name"]);
    }
  }
}

type PiResponseWaiter = {
  readonly resolve: (response: JsonObject) => void;
  readonly reject: (error: unknown) => void;
};

type PiRpcRun = {
  readonly parser: PiRpcParser;
  readonly stderrDiagnostic: () => string;
  readonly send: (
    command: JsonObject,
    timeoutMs?: number,
  ) => Promise<JsonObject>;
  readonly waitForSettledOrExit: () => Promise<void>;
  readonly close: (reason: "normal" | "abort" | "timeout") => Promise<{
    code: number;
    timedOut: boolean;
    teardown: HarnessGroupTeardown | "not-needed";
  }>;
  readonly control: PiHarnessControl;
};

async function createPiRpcRun(options: {
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment: HarnessChildEnvironment;
  readonly output?: NativeOutputSink;
  readonly capabilities: readonly string[];
  readonly eventRecorder?: PiHarnessEventRecorder;
  readonly groupKillExecutable?: string;
}): Promise<PiRpcRun> {
  const child = await spawnHarnessProcess(options);
  const writer = child.stdin.getWriter();
  const parserWaiters = new Map<string, PiResponseWaiter>();
  let writeTail = Promise.resolve();
  const kills = new HarnessKillTracker();
  let timedOut = false;
  let closed = false;
  let stopping = false;
  let canceling = false;
  let stopPromise: Promise<void> | undefined;
  let stderrBytes = new Uint8Array(0);
  const settled = Promise.withResolvers<void>();
  const processExited = Promise.withResolvers<number>();
  const protocolFailed = Promise.withResolvers<void>();

  const appendStderr = (chunk: Uint8Array) => {
    if (stderrBytes.byteLength >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - stderrBytes.byteLength;
    const next = new Uint8Array(
      stderrBytes.byteLength + Math.min(remaining, chunk.byteLength),
    );
    next.set(stderrBytes);
    next.set(chunk.subarray(0, remaining), stderrBytes.byteLength);
    stderrBytes = next;
  };
  const rejectWaiters = (error: Error) => {
    for (const waiter of parserWaiters.values()) waiter.reject(error);
    parserWaiters.clear();
  };
  const parser = new PiRpcParser(
    (record) => {
      if (record.command === "get_state") {
        parser.updateStateFromResponse(record);
      }
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id) {
        const waiter = parserWaiters.get(id);
        if (waiter) {
          parserWaiters.delete(id);
          waiter.resolve(record);
        }
      }
      if (record.command === "prompt" && record.success === true) {
        const data = isRecord(record.data) ? record.data : {};
        parser.state.promptDisposition = textField(data, ["disposition"]);
      }
    },
    () => {
      const error = new Error("PI_HARNESS_PARSE_RESPONSE");
      rejectWaiters(error);
      protocolFailed.resolve();
    },
    () => settled.resolve(),
    options.eventRecorder,
  );

  const stdoutPump = pumpHarnessOutput(
    child.stdout,
    "stdout",
    undefined,
    kills.cutLiveLeader,
    (channel, chunk) => {
      if (channel === "stdout") parser.feed(chunk);
    },
  );
  const stderrPump = pumpHarnessOutput(
    child.stderr,
    "stderr",
    options.output,
    kills.cutLiveLeader,
    (channel, chunk) => {
      if (channel === "stderr") appendStderr(chunk);
    },
  );
  const statusPromise = child.status.then(
    (status: { signal?: unknown; code: number }) => {
      const code = status.signal ? 128 + 9 : status.code;
      kills.markExited();
      processExited.resolve(code);
      rejectWaiters(new Error(`PI_HARNESS_CHILD_EXIT:${code}`));
      if (parser.state.settled) settled.resolve();
      return code;
    },
  );

  const send = async (
    command: JsonObject,
    timeoutMs = PI_COMMAND_WAIT_MS,
    internal = false,
  ): Promise<JsonObject> => {
    if (closed || (stopping && !internal)) {
      throw new Error("PI_HARNESS_RPC_CLOSED");
    }
    const id = typeof command.id === "string"
      ? command.id
      : crypto.randomUUID();
    const outbound = { ...command, id };
    const commandType = typeof command.type === "string"
      ? command.type
      : "unknown";
    const response = new Promise<JsonObject>((resolve, reject) => {
      parserWaiters.set(id, { resolve, reject });
    });
    writeTail = writeTail.then(async () => {
      const bytes = new TextEncoder().encode(`${JSON.stringify(outbound)}\n`);
      await writer.write(bytes);
    });
    try {
      await writeTail;
    } catch (error) {
      parserWaiters.delete(id);
      throw error;
    }
    const timer = setTimeout(() => {
      const waiter = parserWaiters.get(id);
      if (waiter) {
        parserWaiters.delete(id);
        waiter.reject(new Error(`PI_HARNESS_COMMAND_TIMEOUT:${commandType}`));
      }
    }, timeoutMs);
    try {
      return await Promise.race([
        response,
        protocolFailed.promise.then(() => {
          throw new Error("PI_HARNESS_PARSE_RESPONSE");
        }),
      ]);
    } finally {
      clearTimeout(timer);
      parserWaiters.delete(id);
    }
  };

  const closeWriter = async () => {
    try {
      await writer.close();
    } catch {
      // The child may have exited or already closed stdin.
    }
  };
  let teardownPromise: Promise<HarnessGroupTeardown> | undefined;
  const kill = () => {
    if (!kills.markKilled()) return;
    teardownPromise = killHarnessProcessGroup(
      child,
      options.groupKillExecutable,
    );
  };
  const settleTeardown = async (): Promise<
    HarnessGroupTeardown | "not-needed"
  > => teardownPromise ? await teardownPromise : "not-needed";
  const waitForExit = async (milliseconds: number): Promise<boolean> => {
    let timer = 0;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        milliseconds,
      ) as unknown as number;
    });
    const exited = processExited.promise.then(() => true as const);
    const result = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    return result;
  };
  const stop = (reason: "abort" | "timeout") => {
    if (stopPromise) return stopPromise;
    stopping = true;
    canceling = true;
    if (reason === "timeout") timedOut = true;
    stopPromise = (async () => {
      if (!kills.killed) {
        await send({ type: "clear_queue" }, PI_COMMAND_WAIT_MS, true).catch(
          () => undefined,
        );
        await send({ type: "abort" }, PI_STOP_GRACE_MS, true).catch(
          () => undefined,
        );
      }
      await closeWriter();
      // A leader that honors the RPC abort and exits can still leave detached
      // same-group descendants, so the group is always signaled and awaited.
      const exited = await waitForExit(PI_STOP_GRACE_MS);
      kill();
      if (!exited) await waitForExit(PI_STOP_GRACE_MS);
      await teardownPromise;
    })();
    return stopPromise;
  };
  const waitForSettledOrExit = async (): Promise<void> => {
    await Promise.race([
      settled.promise,
      processExited.promise.then(() => undefined),
      protocolFailed.promise,
    ]);
  };
  const control: PiHarnessControl = {
    send: async (action, messageId, body) => {
      const capability = action === "steer_message" ? "steer" : "follow_up";
      if (!options.capabilities.includes(capability)) return "unsupported";
      if (closed || kills.killed || stopping || parser.state.settled) {
        return "rejected";
      }
      const response = await send({
        type: "prompt",
        message: body,
        streamingBehavior: action === "steer_message" ? "steer" : "followUp",
        id: messageId,
      }).catch(() => undefined);
      if (
        canceling || closed || kills.killed || !response ||
        response.success !== true
      ) return "rejected";
      return "accepted";
    },
  };
  const close = async (reason: "normal" | "abort" | "timeout") => {
    if (closed) {
      return {
        code: await statusPromise,
        timedOut,
        teardown: await settleTeardown(),
      };
    }
    stopping = true;
    if (reason === "abort" || reason === "timeout") {
      await stop(reason);
    } else {
      await closeWriter();
      if (!await waitForExit(PI_STOP_GRACE_MS)) {
        kill();
        await waitForExit(PI_STOP_GRACE_MS);
      }
      await teardownPromise;
    }
    closed = true;
    parser.finish();
    const code = await statusPromise;
    await Promise.allSettled([stdoutPump, stderrPump]);
    return { code, timedOut, teardown: await settleTeardown() };
  };

  // Process completion before a settled event is a protocol failure, not success.
  void statusPromise.then(() => {
    if (!parser.state.settled) settled.resolve();
  });
  return {
    parser,
    stderrDiagnostic: () => boundedNativeDiagnostic(stderrBytes),
    send,
    waitForSettledOrExit,
    close,
    control,
  };
}

async function sweepPiAttemptDirectories(stateDir: string): Promise<void> {
  const root = join(stateDir, "pi-harness");
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

async function preparePiAuth(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const sourceInfo = await Deno.lstat(sourceRoot).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!sourceInfo) throw new Error("PI_HARNESS_AUTH_UNAVAILABLE");
  if (sourceInfo.isSymlink || !sourceInfo.isDirectory) {
    throw new Error("PI_HARNESS_AUTH_SOURCE_INVALID");
  }
  const source = join(sourceRoot, PI_AUTH_FILE);
  const info = await Deno.lstat(source).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!info) throw new Error("PI_HARNESS_AUTH_UNAVAILABLE");
  if (info.isSymlink || !info.isFile || info.size > MAX_STATE_BYTES) {
    throw new Error("PI_HARNESS_AUTH_FILE_INVALID");
  }
  await Deno.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await Deno.copyFile(source, join(destinationRoot, PI_AUTH_FILE));
  await Deno.chmod(join(destinationRoot, PI_AUTH_FILE), 0o600);
}

async function piAttemptDirectory(
  options: PiHarnessOptions,
  assignment: JobAssignment,
): Promise<
  { root: string; agentDir: string; sessionDir: string; home: string }
> {
  if (options.stateDir) {
    if (!safeStateSegment(assignment.attemptId)) {
      throw new Error("PI_HARNESS_ATTEMPT_ID_INVALID");
    }
    await sweepPiAttemptDirectories(options.stateDir);
    const root = join(options.stateDir, "pi-harness", assignment.attemptId);
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "session");
    try {
      await Deno.mkdir(agentDir, { recursive: true, mode: 0o700 });
      await Deno.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await Deno.chmod(root, 0o700);
      await Deno.chmod(agentDir, 0o700);
      await Deno.chmod(sessionDir, 0o700);
      const home = await prepareHarnessHome(root);
      return { root, agentDir, sessionDir, home };
    } catch (error) {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
      throw error;
    }
  }
  const root = await Deno.makeTempDir({ prefix: "bakery-pi-harness-" });
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "session");
  try {
    await Deno.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await Deno.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const home = await prepareHarnessHome(root);
    return { root, agentDir, sessionDir, home };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

function piRepositoryId(assignment: JobAssignment): string | undefined {
  const input = isRecord(assignment.input) ? assignment.input : {};
  const repositoryId = textField(input, ["repositoryId"]);
  return safeStateSegment(repositoryId) ? repositoryId : undefined;
}

function piSessionStatePath(
  options: PiHarnessOptions,
  assignment: JobAssignment,
  sessionId: string,
): string | undefined {
  const repositoryId = piRepositoryId(assignment);
  if (
    !options.stateDir || !repositoryId ||
    !safeStateSegment(assignment.agentSessionId) ||
    !safeStateSegment(sessionId)
  ) return undefined;
  return join(
    options.stateDir,
    "pi-harness",
    "sessions",
    repositoryId,
    assignment.agentSessionId,
    sessionId,
  );
}

function checkpointSidecarPath(statePath: string): string {
  return join(statePath, PI_CHECKPOINT_SIDECAR);
}

async function validatePiSessionFile(
  filePath: string,
  sessionId: string,
): Promise<PiSessionEvidence | undefined> {
  const info = await Deno.lstat(filePath).catch(() => undefined);
  if (!info || info.isSymlink || !info.isFile || info.size > MAX_STATE_BYTES) {
    return undefined;
  }
  const bytes = await Deno.readFile(filePath);
  let found = false;
  let recordCount = 0;
  const inspect = (line: Uint8Array): boolean => {
    if (line.byteLength === 0) return true;
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
    } catch {
      return false;
    }
    if (!isRecord(value) || ++recordCount > 4_096) return false;
    const identity = textField(value, ["id", "sessionId", "session_id"]);
    if (value.type === "session" && identity === sessionId) found = true;
    return true;
  };
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[index - 1] === 0x0d) end--;
    if (
      end - start > MAX_STREAM_LINE_BYTES ||
      !inspect(bytes.subarray(start, end))
    ) {
      return undefined;
    }
    start = index + 1;
  }
  if (
    bytes.byteLength - start > MAX_STREAM_LINE_BYTES ||
    (start < bytes.byteLength && !inspect(bytes.subarray(start)))
  ) return undefined;
  if (!found) return undefined;
  return {
    relativePath: filePath,
    sha256: await sha256Hex(bytes),
  };
}

async function verifiedPiCheckpointMetadata(
  statePath: string,
  assignment: JobAssignment,
  sessionId: string,
  checkpointTokenValue: string,
  baseSha: string,
  harnessVersion: string,
): Promise<PiCheckpointMetadata | undefined> {
  try {
    const metadataPath = checkpointSidecarPath(statePath);
    const info = await Deno.lstat(metadataPath);
    if (info.isSymlink || !info.isFile || info.size > 2_048) return undefined;
    const value: unknown = JSON.parse(await Deno.readTextFile(metadataPath));
    const repositoryId = piRepositoryId(assignment);
    if (
      !isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.repositoryId !== "string" ||
      typeof value.agentSessionId !== "string" ||
      typeof value.nativeSessionId !== "string" ||
      typeof value.checkpointToken !== "string" ||
      typeof value.worktreeRevision !== "string" ||
      typeof value.harnessVersion !== "string" ||
      value.harnessVersion !== harnessVersion ||
      typeof value.sessionFile !== "string" ||
      typeof value.sessionFileSha256 !== "string" ||
      value.repositoryId !== repositoryId ||
      value.agentSessionId !== assignment.agentSessionId ||
      value.nativeSessionId !== sessionId ||
      value.checkpointToken !== checkpointTokenValue ||
      value.worktreeRevision !== baseSha ||
      !/^[0-9a-f]{64}$/i.test(value.sessionFileSha256)
    ) return undefined;
    const filePath = pathInside(statePath, join(statePath, value.sessionFile))
      ? join(statePath, value.sessionFile)
      : undefined;
    if (!filePath) return undefined;
    const evidence = await validatePiSessionFile(filePath, sessionId);
    if (
      !evidence || evidence.sha256 !== value.sessionFileSha256.toLowerCase()
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      repositoryId: value.repositoryId,
      agentSessionId: value.agentSessionId,
      nativeSessionId: value.nativeSessionId,
      checkpointToken: value.checkpointToken,
      worktreeRevision: value.worktreeRevision,
      harnessVersion: value.harnessVersion,
      sessionFile: value.sessionFile,
      sessionFileSha256: value.sessionFileSha256.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

async function preparePiResumeSession(
  options: PiHarnessOptions,
  assignment: JobAssignment,
  checkpoint: JsonObject | undefined,
  baseSha: string,
  sessionDir: string,
  harnessVersion: string,
): Promise<{ sessionId: string; sessionPath: string } | undefined> {
  if (!checkpoint || !options.stateDir) return undefined;
  const sessionId = checkpointSessionIdentity(checkpoint);
  const token = checkpointToken(checkpoint);
  if (!sessionId || !token) return undefined;
  const statePath = piSessionStatePath(options, assignment, sessionId);
  if (!statePath || !pathInside(options.stateDir, statePath)) return undefined;
  const metadata = await verifiedPiCheckpointMetadata(
    statePath,
    assignment,
    sessionId,
    token,
    baseSha,
    harnessVersion,
  );
  if (!metadata) return undefined;
  const source = join(statePath, metadata.sessionFile);
  if (!pathInside(statePath, source)) return undefined;
  const destination = join(sessionDir, `${sessionId}.jsonl`);
  await Deno.copyFile(source, destination);
  await Deno.chmod(destination, 0o600);
  return { sessionId, sessionPath: destination };
}

function sessionFileWithinDirectory(
  sessionDir: string,
  announcedSessionFile: string,
): string | undefined {
  if (announcedSessionFile.length === 0) return undefined;
  const candidate = announcedSessionFile.startsWith("/")
    ? resolve(announcedSessionFile)
    : resolve(sessionDir, announcedSessionFile);
  return pathInside(sessionDir, candidate) ? candidate : undefined;
}

async function retainPiSession(
  options: PiHarnessOptions,
  assignment: JobAssignment,
  sessionDir: string,
  sessionId: string,
  announcedSessionFile: string | undefined,
  baseSha: string,
  harnessVersion: string,
): Promise<
  { checkpoint: PiCheckpointMetadata; sessionFile: string } | undefined
> {
  const repositoryId = piRepositoryId(assignment);
  const statePath = piSessionStatePath(options, assignment, sessionId);
  if (!options.stateDir || !repositoryId || !statePath) return undefined;
  const sessionPath = announcedSessionFile === undefined
    ? undefined
    : sessionFileWithinDirectory(sessionDir, announcedSessionFile);
  if (!sessionPath) return undefined;
  const evidence = await validatePiSessionFile(sessionPath, sessionId);
  if (!evidence) return undefined;
  const destination = join(statePath, "session.jsonl");
  await Deno.mkdir(statePath, { recursive: true, mode: 0o700 });
  await Deno.chmod(statePath, 0o700);
  await Deno.copyFile(sessionPath, destination);
  await Deno.chmod(destination, 0o600);
  const relativeSessionFile = "session.jsonl";
  const checkpointTokenValue = relative(options.stateDir, destination)
    .replaceAll("\\", "/");
  const checkpoint: PiCheckpointMetadata = {
    schemaVersion: 1,
    repositoryId,
    agentSessionId: assignment.agentSessionId!,
    nativeSessionId: sessionId,
    checkpointToken: checkpointTokenValue,
    worktreeRevision: baseSha,
    harnessVersion,
    sessionFile: relativeSessionFile,
    sessionFileSha256: evidence.sha256,
  };
  const serialized = JSON.stringify(checkpoint);
  if (utf8ByteLength(serialized) > 2_048) return undefined;
  await Deno.writeTextFile(checkpointSidecarPath(statePath), serialized);
  await Deno.chmod(checkpointSidecarPath(statePath), 0o600);
  return { checkpoint, sessionFile: checkpointTokenValue };
}

async function executePiHarness(
  assignment: JobAssignment,
  signal: AbortSignal,
  output: NativeOutputSink | undefined,
  options: PiHarnessOptions,
  restore: HarnessRestoreTarget,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const input = isRecord(assignment.input) ? assignment.input : {};
  const repair = assignment.action === HARNESS_REPAIR_ACTION
    ? readRepairInput(assignment, PI_FAULT_NAMING)
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
    return piHarnessFault(
      "PI_HARNESS_INPUT_INVALID",
      "The Pi harness needs a plan artifact and a repository profile.",
      500,
      false,
    );
  }
  if (!safeStateSegment(assignment.attemptId)) {
    return piHarnessFault(
      "PI_HARNESS_INPUT_INVALID",
      "The Pi harness needs a safe attempt identifier.",
      500,
      false,
    );
  }
  if (signal.aborted) return provenCanceledOutcome();

  const worktree = await options.repositoryFor(assignment);
  const dirty = await requireCleanHarnessWorktree(worktree, "PI_HARNESS");
  if (dirty) return dirty;
  const baseSha = await harnessHeadRevision(worktree, "PI_HARNESS");
  if (repair !== undefined) {
    // Before the restore target is recorded: nothing was changed to restore.
    const mismatch = repairRevisionMismatch(
      PI_FAULT_NAMING,
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
  const instructions = typeof input.instructions === "string" &&
      input.instructions.length > 0 && input.instructions.length <= 4_000
    ? input.instructions
    : undefined;
  const basePrompt = [
    "Implement the task pinned by plan artifact",
    planArtifact,
    "inside the current repository working tree.",
    "Edit files in place. Do not push, publish, or contact external services",
    "other than the model provider itself.",
  ].join(" ");
  const prompt = repair !== undefined
    ? buildRepairPrompt(repair)
    : instructions === undefined
    ? basePrompt
    : `${basePrompt}\n\nTask instructions:\n${instructions}`;
  const commitMessage = repair !== undefined
    ? repairCommitMessage(repair.revision)
    : `bakery: plan artifact ${planArtifact}`;
  const parserRecorder = options.eventRecorder;
  const resumeCheckpoint = matchingPiResumeCheckpoint(
    assignment,
    input,
    baseSha,
  );
  const config = await piAttemptDirectory(options, assignment);
  let rpc: PiRpcRun | undefined;
  let timer: number | undefined;
  try {
    try {
      await preparePiAuth(options.piAgentSourceDir, config.agentDir);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PI_HARNESS_AUTH_UNAVAILABLE"
      ) {
        return harnessCredentialUnavailable(
          "PI",
          "Pi",
          "The Pi harness could not complete the bounded task",
        );
      }
      return piHarnessFault(
        "PI_HARNESS_INPUT_INVALID",
        "Pi native authentication preparation was unavailable.",
        500,
        false,
      );
    }
    // Pi's read tool can open its auth copy: redact every token in it from
    // output and withhold them from patches.
    let credentialSecrets: readonly string[];
    try {
      credentialSecrets = await harnessCredentialSecrets(
        join(options.piAgentSourceDir, PI_AUTH_FILE),
      );
    } catch {
      return harnessCredentialUnavailable(
        "PI",
        "Pi",
        "The Pi harness could not complete the bounded task",
      );
    }
    const childEnvironment = {
      HOME: config.home,
      PI_CODING_AGENT_DIR: config.agentDir,
    };
    const versionProbe = await probeHarnessVersion(
      options.piExecutable ?? "pi",
      worktree,
      childEnvironment,
      signal,
      PI_VERSION_WAIT_MS,
    );
    if (signal.aborted) return harnessCanceledOutcome(versionProbe.teardown);
    if (
      versionProbe.teardown !== "not-needed" &&
      versionProbe.teardown.status === "unconfirmed"
    ) {
      return harnessTeardownFault("PI", versionProbe.teardown);
    }
    if (versionProbe.timedOut) {
      return piHarnessFault(
        "PI_HARNESS_TIMEOUT",
        "The pinned Pi CLI version probe exceeded its startup deadline.",
        504,
        true,
      );
    }
    const piVersion = versionProbe.version;
    if (!piVersion) {
      return piHarnessFault(
        "PI_HARNESS_EXIT_NONZERO",
        "The pinned Pi CLI version probe did not complete successfully.",
        502,
        false,
      );
    }
    const resume = await preparePiResumeSession(
      options,
      assignment,
      resumeCheckpoint,
      baseSha,
      config.sessionDir,
      piVersion,
    );
    // Pi's convention: the reasoning level rides the model pattern as a
    // `:<level>` suffix (`--model provider/id:high`).
    const modelPattern = options.model === undefined
      ? undefined
      : options.effort === undefined
      ? options.model
      : `${options.model}:${options.effort}`;
    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      config.sessionDir,
      "--no-context-files",
      "--tools",
      PI_TOOLS,
      ...(modelPattern === undefined ? [] : ["--model", modelPattern]),
      ...(resume ? ["--session", resume.sessionPath] : []),
    ];
    rpc = await createPiRpcRun({
      executable: options.piExecutable ?? "pi",
      cwd: worktree,
      args,
      environment: childEnvironment,
      output,
      capabilities: options.capabilities ?? [],
      eventRecorder: parserRecorder,
      groupKillExecutable: options.groupKillExecutable,
    });
    options.registerControl?.(rpc.control);
    const abort = () => {
      void rpc?.close("abort");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      const closed = await rpc.close("abort");
      return harnessCanceledOutcome(closed.teardown);
    }
    timer = setTimeout(
      () => {
        void rpc?.close("timeout");
      },
      options.timeLimitMs ?? PI_HARNESS_DEFAULT_TIME_LIMIT_MS,
    ) as unknown as number;
    try {
      const stateResponse = await rpc.send(
        { type: "get_state" },
        PI_COMMAND_WAIT_MS,
      );
      if (stateResponse.success !== true) {
        return piHarnessFault(
          "PI_HARNESS_INPUT_INVALID",
          "The Pi RPC session state could not be initialized.",
          500,
          false,
        );
      }
      const promptResponse = await rpc.send({
        type: "prompt",
        message: prompt,
      });
      if (promptResponse.success !== true) {
        return piHarnessFault(
          "PI_HARNESS_INPUT_INVALID",
          "The Pi RPC prompt was rejected before execution started.",
          500,
          false,
        );
      }
      if (parserRecorder && rpc.parser.state.promptDisposition) {
        parserRecorder.record({
          type: "prompt_accepted",
          disposition: rpc.parser.state.promptDisposition,
        });
      }
      if (rpc.parser.state.promptDisposition === "handled") {
        return piHarnessFault(
          "PI_HARNESS_INPUT_INVALID",
          "The Pi RPC prompt was handled without starting an agent run.",
          500,
          false,
        );
      }
      await rpc.waitForSettledOrExit();
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const run = await rpc.close(
      signal.aborted ? "abort" : rpc.parser.state.settled ? "normal" : "abort",
    );
    if (signal.aborted) return harnessCanceledOutcome(run.teardown);
    if (run.timedOut) {
      if (
        run.teardown !== "not-needed" && run.teardown.status === "unconfirmed"
      ) {
        return harnessTeardownFault("PI", run.teardown);
      }
      return piHarnessFault(
        "PI_HARNESS_TIMEOUT",
        "The pinned Pi RPC run exceeded its explicit time limit and was stopped.",
        504,
        true,
      );
    }
    rpc.parser.finish();
    if (
      run.code !== 0 || rpc.parser.state.malformed ||
      rpc.parser.state.truncated ||
      rpc.parser.state.parseFailure || rpc.parser.state.contradictory ||
      !rpc.parser.state.settled || rpc.parser.state.aborted ||
      rpc.parser.state.providerFailure || !rpc.parser.state.sessionId ||
      !safeStateSegment(rpc.parser.state.sessionId) ||
      !rpc.parser.state.sessionFile ||
      (resume !== undefined && rpc.parser.state.sessionId !== resume.sessionId)
    ) {
      return piHarnessFault(
        "PI_HARNESS_EXIT_NONZERO",
        rpc.parser.state.parseFailure
          ? "The Pi RPC stream reported a malformed command without a request id."
          : "The Pi RPC stream did not contain one consistent settled successful run.",
        502,
        false,
      );
    }
    const sessionPath = rpc.parser.state.sessionFile
      ? sessionFileWithinDirectory(
        config.sessionDir,
        rpc.parser.state.sessionFile,
      )
      : undefined;
    if (
      !sessionPath ||
      !await validatePiSessionFile(sessionPath, rpc.parser.state.sessionId)
    ) {
      return piHarnessFault(
        "PI_HARNESS_EXIT_NONZERO",
        "The Pi RPC run did not produce a verified session file.",
        502,
        false,
      );
    }
    const checkpoint = options.stateDir
      ? await retainPiSession(
        options,
        assignment,
        config.sessionDir,
        rpc.parser.state.sessionId,
        sessionPath,
        baseSha,
        piVersion,
      )
      : undefined;
    if (options.stateDir && !checkpoint) {
      return piHarnessFault(
        "PI_HARNESS_EXIT_NONZERO",
        "The Pi RPC run did not produce a verified session checkpoint.",
        502,
        false,
      );
    }
    // The child may have refreshed its token mid-run: scan for that too.
    let refreshedSecrets: readonly string[];
    try {
      refreshedSecrets = await harnessCredentialSecrets(
        join(config.agentDir, PI_AUTH_FILE),
      );
    } catch {
      return harnessCredentialUnavailable(
        "PI",
        "Pi",
        "The Pi harness could not complete the bounded task",
      );
    }
    const publication = await publishHarnessPatch({
      assignment,
      repository: worktree,
      baseSha,
      signal,
      publish: options.publishFor(assignment),
      commitMessage,
      commitUserEmail: "bakery-harness@bakery.local",
      commitUserName: "Bakery Pi Harness",
      artifactName: `pi-patch-${assignment.jobId}-${assignment.fence}.diff`,
      source: "pi-harness",
      commitFailureCode: "PI_HARNESS_COMMIT_FAILED",
      commitFailureRetryable: false,
      digestMismatchCode: "PI_HARNESS_ARTIFACT_DIGEST_MISMATCH",
      gitFailurePrefix: "PI_HARNESS",
      secrets: [
        assignment.leaseToken,
        ...(options.redactionSecrets ?? []),
        ...credentialSecrets,
        ...refreshedSecrets,
      ],
      faultTitle: "The Pi harness could not complete the bounded task",
    });
    if ("status" in publication) return publication;
    const resultBase: JsonObject = {
      baseSha,
      headSha: publication.headSha,
      // The server binds result sessionId to a Bakery agent session; the
      // native Pi session stays under checkpoint.nativeSessionId.
      sessionId: assignment.agentSessionId!,
      ...(checkpoint === undefined ? {} : {
        checkpoint: {
          ...checkpoint.checkpoint,
          eligible: true,
          resumeEligible: true,
          checkpointEligible: true,
        },
      }),
      artifacts: publication.artifacts,
      piVersion,
      model: rpc.parser.state.model ?? null,
      capabilities: [...(options.capabilities ?? [])],
      telemetry: {
        providerUsage: rpc.parser.state.providerUsage,
        costUsd: null,
      },
    };
    resultBase.events = boundedResultEvents(
      resultBase,
      rpc.parser.state.events,
    );
    return {
      status: "completed",
      result: resultBase as unknown as JsonValue,
    };
  } catch (error) {
    if (signal.aborted) {
      const closed = rpc
        ? await rpc.close("abort").catch(() => undefined)
        : undefined;
      return harnessCanceledOutcome(
        rpc && !closed
          ? { status: "unconfirmed", via: "none", reason: "close-failed" }
          : closed?.teardown ?? "not-needed",
      );
    }
    if (
      error instanceof Error &&
      error.message.startsWith("PI_HARNESS_COMMAND_TIMEOUT")
    ) {
      return piHarnessFault(
        "PI_HARNESS_TIMEOUT",
        "The Pi RPC command exceeded its bounded response deadline.",
        504,
        true,
      );
    }
    if (
      error instanceof Error &&
      error.message.startsWith("PI_HARNESS_PARSE_RESPONSE")
    ) {
      return piHarnessFault(
        "PI_HARNESS_EXIT_NONZERO",
        "The Pi RPC stream reported malformed input.",
        502,
        false,
      );
    }
    return piHarnessFault(
      "PI_HARNESS_EXIT_NONZERO",
      "The pinned Pi RPC process could not be completed.",
      502,
      false,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.registerControl?.(undefined);
    if (rpc) {
      await rpc.close(signal.aborted ? "abort" : "normal").catch(() =>
        undefined
      );
    }
    await Deno.remove(config.root, { recursive: true }).catch(() => undefined);
  }
}

/** Opt-in Pi RPC executor; all non-Pi actions delegate to the wrapped executor. */
export function createPiHarnessExecutor(
  options: PiHarnessOptions,
): WorkerExecutor {
  const inner = options.inner;
  const harnessBusy = createHarnessBusyLatch();
  const guard = harnessWorktreeGuard(options);
  let activeControl: PiHarnessControl | undefined;
  return {
    supportedActions: [
      ...new Set([
        ...(inner?.supportedActions ?? PI_HARNESS_SUPPORTED_ACTIONS),
        HARNESS_REPAIR_ACTION,
      ]),
    ],
    capturesNativeOutput: inner?.capturesNativeOutput ?? true,
    async initialize() {
      await inner?.initialize?.();
      await initializeHarnessWorktree(guard, harnessBusy);
    },
    readinessChecks: guard
      ? async () =>
        await harnessReadinessChecks(
          await inner?.readinessChecks?.() ?? [],
          guard,
          harnessBusy,
        )
      : inner?.readinessChecks?.bind(inner),
    async credentialRedactionSecrets(assignment) {
      if (!isHarnessEditAction(assignment.action)) {
        return await inner?.credentialRedactionSecrets?.(assignment) ?? [];
      }
      return await harnessCredentialSecrets(
        join(options.piAgentSourceDir, PI_AUTH_FILE),
      );
    },
    control: (assignment, action, messageId, body) => {
      if (!isHarnessEditAction(assignment.action) || !activeControl) {
        return Promise.resolve("rejected" as const);
      }
      return activeControl.send(action, messageId, body);
    },
    execute(assignment, signal, output, preparedSkills) {
      if (!isHarnessEditAction(assignment.action)) {
        if (!inner) {
          return Promise.resolve(
            piHarnessFault(
              "PI_HARNESS_ACTION_UNSUPPORTED",
              `The Pi harness supports only ${PI_ACTION} and ${HARNESS_REPAIR_ACTION}.`,
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
            piHarnessFault(
              "PI_HARNESS_BUSY",
              "The Pi harness is already running one bounded assignment against this repository; retry later.",
              503,
              true,
            ),
          );
        }
        const registerControl = (control: PiHarnessControl | undefined) => {
          activeControl = control;
          options.registerControl?.(control);
        };
        return withHarnessRestore((restore) =>
          executePiHarness(
            assignment,
            signal,
            output,
            { ...options, registerControl },
            restore,
          ), guard?.stateDir).finally(() => {
            activeControl = undefined;
            harnessBusy.release();
          });
      });
    },
  };
}
