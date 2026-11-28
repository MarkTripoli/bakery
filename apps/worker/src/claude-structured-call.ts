import type { NativeOutputSink } from "./native-output.ts";
import { runBoundedHarness } from "./harness-common.ts";
import {
  CLAUDE_MODEL_KEY_VARIABLES,
  CLAUDE_UUID_PATTERN,
  claudeConfigDirectory,
  type ClaudeHarnessOptions,
  ClaudeStreamParser,
  type ClaudeStreamState,
  type JsonObject,
  prepareClaudeAuth,
} from "./claude-harness.ts";
import type { JobAssignment } from "./types.ts";
import { type MeteredModelKey, meteredModelKey } from "./model-key.ts";

/**
 * One bounded, structured-output Claude Code CLI call: credentials staged into
 * a private config directory, `-p` with a JSON schema, a hard time limit, and
 * a stream that must end in exactly one consistent terminal result. Shared by
 * the coordinator turn and the evaluation judge so both pick the model,
 * credentials and bounds the same way.
 */

const CREDENTIAL_FAILURE_PATTERN =
  /not logged in|please run \/login|authentication|invalid api key|oauth|credential|unauthori[sz]ed|\b401\b/i;

/** The harness options one structured call reads. */
export type ClaudeStructuredCallOptions = Pick<
  ClaudeHarnessOptions,
  | "authSourceDir"
  | "claudeExecutable"
  | "model"
  | "stateDir"
  | "eventRecorder"
  | "readModelKey"
>;

export type ClaudeStructuredCallRequest = Readonly<{
  /** Directory the CLI runs in; the caller owns what it contains. */
  cwd: string;
  prompt: string;
  /** JSON schema the CLI enforces on the structured answer. */
  jsonSchema: unknown;
  /** Comma-separated tool names, or "" for no tools at all. */
  tools: string;
  effort: string;
  timeLimitMs: number;
  /** Extra fixed child environment entries (for example an output-token cap). */
  environment?: Readonly<Record<string, string>>;
  signal: AbortSignal;
  output?: NativeOutputSink;
}>;

/** Token and cost figures the terminal result record reported, when any. */
export type ClaudeCallUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}>;

export type ClaudeStructuredCallResult =
  | Readonly<{ kind: "credential_unavailable" }>
  | Readonly<{ kind: "canceled" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "exit_nonzero"; code: number }>
  | Readonly<{ kind: "invalid_stream" }>
  | Readonly<{ kind: "credential_rejected"; sessionId: string }>
  | Readonly<{ kind: "failure_result"; sessionId: string }>
  | Readonly<{
    kind: "answered";
    /** The structured answer, or undefined when the result held none. */
    structured: unknown;
    record: JsonObject;
    state: ClaudeStreamState;
    sessionId: string;
    claudeCodeVersion: string;
    model: string | undefined;
    usage: ClaudeCallUsage;
  }>;

/**
 * Escapes angle brackets so a JSON data block can never contain a forged
 * closing delimiter. The result stays valid JSON.
 */
export function dataBlockJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function singleJsonObject(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith("{")) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The structured answer of a terminal result record. */
export function structuredOutput(record: JsonObject): unknown {
  const structured = record.structured_output;
  if (structured !== undefined && structured !== null) return structured;
  return typeof record.result === "string"
    ? singleJsonObject(record.result)
    : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Reads token counts from the result record's `usage` object. Input tokens
 * include cache reads and writes, since the provider bills them as input.
 */
export function claudeCallUsage(
  record: JsonObject,
  costUsd: number | null,
): ClaudeCallUsage {
  const usage = record.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return { inputTokens: null, outputTokens: null, costUsd };
  }
  const fields = usage as JsonObject;
  const input = count(fields.input_tokens);
  return {
    inputTokens: input === null ? null : input +
      (count(fields.cache_creation_input_tokens) ?? 0) +
      (count(fields.cache_read_input_tokens) ?? 0),
    outputTokens: count(fields.output_tokens),
    costUsd,
  };
}

/** Runs one structured call and classifies how it ended. */
export async function runClaudeStructuredCall(
  assignment: JobAssignment,
  options: ClaudeStructuredCallOptions,
  request: ClaudeStructuredCallRequest,
): Promise<ClaudeStructuredCallResult> {
  const config = await claudeConfigDirectory(options, assignment);
  try {
    let metered: MeteredModelKey | null;
    try {
      metered = await meteredModelKey(
        assignment,
        options.readModelKey,
        CLAUDE_MODEL_KEY_VARIABLES,
      );
      if (metered === null) {
        if (!options.authSourceDir) {
          throw new Error("CLAUDE_HARNESS_AUTH_UNAVAILABLE");
        }
        await prepareClaudeAuth(options.authSourceDir, config.path);
      }
    } catch {
      return { kind: "credential_unavailable" };
    }
    const parser = new ClaudeStreamParser(options.eventRecorder);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--tools",
      request.tools,
      ...(request.tools === "" ? [] : ["--allowedTools", request.tools]),
      "--permission-prompts",
      "none",
      "--json-schema",
      JSON.stringify(request.jsonSchema),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      "--effort",
      request.effort,
    ];
    const run = await runBoundedHarness({
      executable: options.claudeExecutable ?? "claude",
      cwd: request.cwd,
      prompt: request.prompt,
      timeLimitMs: request.timeLimitMs,
      signal: request.signal,
      output: request.output,
      environment: {
        ...request.environment,
        ...metered?.environment,
        HOME: config.home,
        CLAUDE_CONFIG_DIR: config.path,
      },
      onOutput: (channel, chunk) => {
        if (channel === "stdout") parser.feed(chunk);
      },
      args,
    });
    parser.finish();
    if (request.signal.aborted) return { kind: "canceled" };
    if (run.timedOut) return { kind: "timeout" };
    if (run.code !== 0) return { kind: "exit_nonzero", code: run.code };
    const state = parser.state;
    const record = state.resultRecord;
    const sessionId = state.sessionId;
    if (
      state.malformed || state.truncated || state.contradictory ||
      !state.initialized || state.terminalRecords !== 1 || !record ||
      !state.claudeCodeVersion || !sessionId ||
      !CLAUDE_UUID_PATTERN.test(sessionId)
    ) {
      return { kind: "invalid_stream" };
    }
    if (state.terminal !== "success") {
      const text = typeof record.result === "string" ? record.result : "";
      return CREDENTIAL_FAILURE_PATTERN.test(text)
        ? { kind: "credential_rejected", sessionId }
        : { kind: "failure_result", sessionId };
    }
    return {
      kind: "answered",
      structured: structuredOutput(record),
      record,
      state,
      sessionId,
      claudeCodeVersion: state.claudeCodeVersion,
      model: state.model ?? options.model,
      usage: claudeCallUsage(record, state.totalCostUsd),
    };
  } finally {
    await Deno.remove(config.root, { recursive: true }).catch(() => undefined);
  }
}
