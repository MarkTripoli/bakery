import {
  OUTPUT_LIMITS,
  OutputBatchSchema,
  outputDigest,
} from "../../../packages/contracts/src/output.ts";
import type { WorkerApiClient } from "./client.ts";
import { type EventSpool, SpoolError } from "./spool.ts";
import type {
  JobAssignment,
  OutputBatch,
  WorkerOutputBinding,
} from "./types.ts";

export const NATIVE_OUTPUT_LIMITS = Object.freeze({
  redactorLookbehindBytes: 64 * 1024,
  configuredSecretBytes: 4_096,
  /** Per-attempt harness credential values; a budget of its own (#430). */
  credentialSecretBytes: 4_096,
  outstandingRecords: 32,
  outstandingBytes: 256 * 1024,
  statusReserveRecords: 8,
  statusReserveBytes: 64 * 1024,
  appendBytes: 16 * 1024,
  flushCadenceMs: 250,
  drainMs: 5_000,
  globalRecords: 1_024,
  globalBytes: 12 * 1024 * 1024,
});

export type NativeOutputChannel = "stdout" | "stderr";

export type NativeOutputSink = {
  write(channel: NativeOutputChannel, chunk: Uint8Array): Promise<void>;
  sourceLost(channel: NativeOutputChannel, reason?: string): Promise<void>;
};

export type NativeOutputCaptureOptions = {
  assignment: JobAssignment;
  binding: WorkerOutputBinding;
  client: WorkerApiClient;
  spool: EventSpool;
  workerSessionId: string;
  workerSessionGeneration: string;
  configuredSecrets?: readonly string[];
  /**
   * Per-attempt credential values a harness child can read (for example
   * OAuth tokens); redacted like configured secrets. Never logged.
   */
  credentialSecrets?: readonly string[];
  /** True only while publication is authorized right now. */
  leaseActive: () => boolean;
  /**
   * Resolves true once publication is authorized again after a transient
   * fence (a heartbeat applying its commands), false as soon as authority is
   * really lost. Without it, `leaseActive() === false` is final.
   */
  awaitPublication?: () => Promise<boolean>;
  waitForAck: () => Promise<void>;
};

type CaptureDisposition =
  | { capture: "complete"; reason: "clean-end" }
  | { capture: "truncated"; reason: "text-limit" }
  | { capture: "interrupted"; reason: "source-lost" };

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function validateSecrets(
  values: readonly string[],
  maximumBytes: number,
): readonly string[] {
  const unique = [...new Set(values.filter((value) => value.length > 0))];
  const total = unique.reduce((sum, value) => sum + byteLength(value), 0);
  if (total > maximumBytes) {
    throw new Error("NATIVE_OUTPUT_SECRETS_TOO_LARGE");
  }
  return Object.freeze(unique);
}

/**
 * Every spelling of each secret that a JSON or ASCII-escaping producer could
 * emit: the original, its JSON string body, and the same body with non-ASCII
 * as \uXXXX. Longest first so a needle never shadows a longer one it prefixes.
 */
export function secretNeedleVariants(
  secrets: readonly string[],
): readonly string[] {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    needles.add(secret);
    const json = JSON.stringify(secret).slice(1, -1);
    needles.add(json);
    needles.add(
      json.replace(
        /[\u007f-\uffff]/g,
        (character) =>
          "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
      ),
    );
  }
  return Object.freeze(
    [...needles].filter((needle) => needle.length > 0).sort((a, b) =>
      b.length - a.length
    ),
  );
}

// The replacement must not introduce a configured secret or join two secret
// fragments. Pick a delimiter absent from every configured secret.
function redactionMarker(secrets: readonly string[]): string {
  if (
    secrets.every((secret) =>
      !"[REDACTED]".includes(secret) && !secret.includes("[") &&
      !secret.includes("]")
    )
  ) {
    return "[REDACTED]";
  }
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const marker = String.fromCodePoint(code);
    if (secrets.every((secret) => !secret.includes(marker))) return marker;
  }
  throw new Error("NATIVE_OUTPUT_REDACTION_MARKER_UNAVAILABLE");
}

function splitUtf8(value: string, maximum: number): string[] {
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (current && currentBytes + size > maximum) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current) parts.push(current);
  return parts;
}

type Observation = {
  channel: NativeOutputChannel;
  text: string;
  pending: number;
  bytes: number;
};
type ObservedCharacter = { text: string; owner: Observation };

// Normalize first, then redact the normalized stream. Attribution survives both
// transforms: a delayed character still belongs to the read that supplied it.
class ChannelSanitizer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private raw: ObservedCharacter[] = [];
  private secret: ObservedCharacter[] = [];
  private undecodedBytes = 0;
  private undecodedOwner: Observation | undefined;
  private readonly marker: string;

  constructor(private readonly secrets: readonly string[]) {
    this.marker = redactionMarker(secrets);
  }

  push(chunk: Uint8Array, owner: Observation): void {
    const decoded = this.decoder.decode(chunk, { stream: true });
    const previousOwner = this.undecodedOwner;
    const remaining = this.undecodedBytes + chunk.length - byteLength(decoded);
    if (decoded && previousOwner) previousOwner.pending--;
    let first = true;
    for (const text of decoded) {
      const origin = first && previousOwner ? previousOwner : owner;
      origin.pending++;
      this.raw.push({ text, owner: origin });
      first = false;
    }
    this.undecodedBytes = remaining;
    if (remaining > 0) {
      if (decoded || !previousOwner) {
        this.undecodedOwner = owner;
        owner.pending++;
      }
    } else this.undecodedOwner = undefined;
    this.normalize(false);
  }

  private consume(characters: ObservedCharacter[], replacement = ""): void {
    if (characters[0]) characters[0].owner.text += replacement;
    for (const character of characters) character.owner.pending--;
  }

  private redact(final: boolean): void {
    while (this.secret.length) {
      const text = this.secret.map((item) => item.text).join("");
      const match = this.secrets.find((secret) => text.startsWith(secret));
      if (match) {
        this.consume(this.secret.splice(0, [...match].length), this.marker);
      } else if (
        !final && this.secrets.some((secret) => secret.startsWith(text))
      ) {
        return;
      } else {
        const character = this.secret.shift()!;
        this.consume([character], character.text);
      }
    }
  }

  private normalize(final: boolean): void {
    let index = 0;
    while (index < this.raw.length) {
      const character = this.raw[index];
      const code = character.text.codePointAt(0)!;
      let removed = 0;
      if (code === 27) {
        const kind = this.raw[index + 1]?.text;
        if (kind === undefined && !final) break;
        if (kind === "[" || kind === "]") {
          let end = index + 2;
          while (end < this.raw.length) {
            const token = this.raw[end].text;
            if (kind === "[" && token >= "@" && token <= "~") break;
            if (kind === "]" && token === "\x07") break;
            if (
              kind === "]" && token === "\x1b" &&
              this.raw[end + 1]?.text === "\\"
            ) {
              end++;
              break;
            }
            end++;
          }
          if (end >= this.raw.length && !final) break;
          removed = Math.min(end + 1, this.raw.length) - index;
        } else removed = 1;
      } else if (character.text === "<") {
        const suffix = this.raw.slice(index).map((item) => item.text).join("");
        const tag = suffix.match(
          /^<\/?(?:script|style|iframe|object|embed)\b[^>]*>/i,
        );
        if (tag) removed = [...tag[0]].length;
        else if (!suffix.includes(">") && !final) break;
      } else if (
        !(code === 9 || code === 10 || code === 13 ||
          (code >= 32 && !(code >= 127 && code <= 159)))
      ) removed = 1;
      if (removed) {
        this.consume(this.raw.slice(index, index + removed));
        index += removed;
      } else {
        this.secret.push(character);
        this.redact(false);
        index++;
      }
    }
    this.raw = this.raw.slice(index);
    if (
      byteLength(this.raw.map((item) => item.text).join("")) +
          byteLength(this.secret.map((item) => item.text).join("")) >
        NATIVE_OUTPUT_LIMITS.redactorLookbehindBytes
    ) {
      throw new Error("NATIVE_OUTPUT_REDACTOR_CARRY_EXCEEDED");
    }
    if (final) this.redact(true);
  }

  finish(): void {
    this.decoder.decode(); // Fatal for incomplete UTF-8; never invent bytes.
    this.normalize(true);
  }

  discard(): void {
    this.raw = [];
    this.secret = [];
  }
}

export class NativeOutputCapture implements NativeOutputSink {
  private readonly secrets: readonly string[];
  private readonly sanitizers: Record<NativeOutputChannel, ChannelSanitizer>;
  private tail: Promise<void> = Promise.resolve();
  private sequence: bigint;
  private displayBytes = 0;
  private observations: Observation[] = [];
  private disposition: CaptureDisposition = {
    capture: "complete",
    reason: "clean-end",
  };
  private accepting = true;
  private finalizing = false;

  constructor(private readonly options: NativeOutputCaptureOptions) {
    // Each group has its own budget on the originals; escaped variants are
    // derived from them. The lease token is a bounded server secret (at most
    // 512 bytes) and sits outside both budgets.
    this.secrets = secretNeedleVariants([
      ...validateSecrets([options.assignment.leaseToken], 512),
      ...validateSecrets(
        options.configuredSecrets ?? [],
        NATIVE_OUTPUT_LIMITS.configuredSecretBytes,
      ),
      ...validateSecrets(
        options.credentialSecrets ?? [],
        NATIVE_OUTPUT_LIMITS.credentialSecretBytes,
      ),
    ]);
    this.sanitizers = {
      stdout: new ChannelSanitizer(this.secrets),
      stderr: new ChannelSanitizer(this.secrets),
    };
    this.sequence = BigInt(options.binding.nextSequence);
  }

  write(channel: NativeOutputChannel, chunk: Uint8Array): Promise<void> {
    const copy = chunk.slice();
    return this.serialize(async () => {
      if (!this.accepting || !(await this.ready())) return;
      try {
        const observation: Observation = {
          channel,
          text: "",
          pending: 0,
          bytes: copy.length + 1,
        };
        this.observations.push(observation);
        if (
          this.observations.reduce((sum, item) => sum + item.bytes, 0) >
            2 * NATIVE_OUTPUT_LIMITS.redactorLookbehindBytes
        ) {
          throw new Error("NATIVE_OUTPUT_OBSERVATION_CARRY_EXCEEDED");
        }
        this.sanitizers[channel].push(copy, observation);
        await this.flushObservations();
      } catch (error) {
        await this.interrupt(channel, error);
      }
    });
  }

  sourceLost(
    channel: NativeOutputChannel,
    reason = "source-lost",
  ): Promise<void> {
    return this.serialize(async () => {
      await this.interrupt(channel, new Error(reason));
    });
  }

  /**
   * Flushes the capture. With `leaveOpen` the server-side binding is not
   * closed: the attempt failed retryably, the job may be requeued, and a
   * closed stream cannot take the next attempt's producer. The result route
   * closes the stream itself when no retry follows.
   */
  async finish(
    options: { readonly leaveOpen?: boolean } = {},
  ): Promise<CaptureDisposition | null> {
    try {
      await this.serialize(async () => {
        if (this.finalizing) return;
        this.finalizing = true;
        if (!(await this.ready())) return;
        if (this.accepting) {
          for (const channel of ["stdout", "stderr"] as const) {
            try {
              this.sanitizers[channel].finish();
            } catch (error) {
              await this.interrupt(channel, error);
            }
          }
          await this.flushObservations();
          this.accepting = false;
        }
        if (!(await this.ready())) return;
        if (options.leaveOpen) return;
        await this.publish((authorized) =>
          this.options.spool.persistOutputClose({
            attemptId: this.options.assignment.attemptId,
            leaseToken: this.options.assignment.leaseToken,
            fence: String(this.options.assignment.fence),
            workerSessionId: this.options.workerSessionId,
            workerSessionGeneration: this.options.workerSessionGeneration,
            idempotencyKey: crypto.randomUUID(),
            sessionId: this.options.binding.sessionId,
            writerGeneration: this.options.binding.writerGeneration,
            ...this.disposition,
          }, authorized)
        );
      });
    } catch (error) {
      if (
        error instanceof SpoolError &&
        error.code === "SPOOL_PUBLICATION_NOT_AUTHORIZED"
      ) return null;
      throw error;
    }
    await this.tail;
    return await this.ready() ? this.disposition : null;
  }

  // A fence that clears is waited out; lost authority stays final.
  private async ready(): Promise<boolean> {
    if (this.options.leaseActive()) return true;
    return await this.options.awaitPublication?.() === true;
  }

  // The spool re-checks authority at write time, so a fence that closes
  // between ready() and the write is retried rather than dropped.
  private async publish(
    write: (authorized: () => boolean) => Promise<unknown>,
  ): Promise<void> {
    while (await this.ready()) {
      try {
        await write(this.options.leaseActive);
        return;
      } catch (error) {
        if (
          !(error instanceof SpoolError &&
            error.code === "SPOOL_PUBLICATION_NOT_AUTHORIZED") ||
          this.options.leaseActive() || !this.options.awaitPublication
        ) throw error;
      }
    }
    throw new SpoolError("SPOOL_PUBLICATION_NOT_AUTHORIZED");
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async flushObservations(): Promise<void> {
    while (this.accepting && this.observations[0]?.pending === 0) {
      const observation = this.observations.shift()!;
      await this.appendText(observation.channel, observation.text);
    }
  }

  private async appendText(
    channel: NativeOutputChannel,
    text: string,
  ): Promise<void> {
    if (!text) return;
    for (const part of splitUtf8(text, OUTPUT_LIMITS.partBytes)) {
      if (!this.accepting || !(await this.ready())) return;
      const size = byteLength(part);
      if (this.displayBytes + size > OUTPUT_LIMITS.displayBytes) {
        await this.truncate("display-byte-limit");
        return;
      }
      await this.waitForNativeCapacity();
      if (!(await this.ready())) return;
      const envelope = {
        sessionId: this.options.binding.sessionId,
        writerGeneration: this.options.binding.writerGeneration,
        batchId: crypto.randomUUID(),
        sequence: this.sequence.toString(),
        parts: [{ itemId: crypto.randomUUID(), channel, text: part }],
        capture: "capturing" as const,
        reason: null,
      };
      const batch: OutputBatch = OutputBatchSchema.parse({
        ...envelope,
        digest: await outputDigest(envelope),
      });
      try {
        await this.publish((authorized) =>
          this.options.spool.enqueueNextOutputEvent({
            attemptId: this.options.assignment.attemptId,
            leaseToken: this.options.assignment.leaseToken,
            fence: String(this.options.assignment.fence),
            eventId: crypto.randomUUID(),
            payload: batch,
            status: false,
          }, authorized)
        );
      } catch (error) {
        if (
          error instanceof SpoolError &&
          error.code === "SPOOL_CAPACITY_EXCEEDED"
        ) {
          await this.truncate("spool-capacity");
          return;
        }
        throw error;
      }
      this.displayBytes += size;
      this.sequence++;
    }
  }

  private async waitForNativeCapacity(): Promise<void> {
    while (await this.ready()) {
      const depth = this.options.spool.outputDepth(
        this.options.assignment.attemptId,
      );
      if (
        depth.records <
          NATIVE_OUTPUT_LIMITS.outstandingRecords -
            NATIVE_OUTPUT_LIMITS.statusReserveRecords &&
        depth.bytes <
          NATIVE_OUTPUT_LIMITS.outstandingBytes -
            NATIVE_OUTPUT_LIMITS.statusReserveBytes
      ) return;
      await this.options.waitForAck();
    }
  }

  private async truncate(detail: string): Promise<void> {
    if (!this.accepting) return;
    this.disposition = { capture: "truncated", reason: "text-limit" };
    this.accepting = false;
    await this.appendStatus(`Native output truncated: ${detail}.`);
  }

  private async interrupt(
    channel: NativeOutputChannel,
    error: unknown,
  ): Promise<void> {
    if (!this.accepting) return;
    this.observations = [];
    this.sanitizers.stdout.discard();
    this.sanitizers.stderr.discard();
    this.disposition = { capture: "interrupted", reason: "source-lost" };
    this.accepting = false;
    const code = error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
      ? error.message
      : "SOURCE_LOST";
    await this.appendStatus(
      `Native ${channel} capture interrupted; unknown bytes discarded (${code}).`,
    );
  }

  private async appendStatus(text: string): Promise<void> {
    if (!(await this.ready())) return;
    const observation: Observation = {
      channel: "stdout",
      text: "",
      pending: 0,
      bytes: 0,
    };
    const sanitizer = new ChannelSanitizer(this.secrets);
    sanitizer.push(encoder.encode(text), observation);
    sanitizer.finish();
    const bounded = splitUtf8(
      observation.text,
      Math.min(OUTPUT_LIMITS.partBytes, OUTPUT_LIMITS.statusBytes),
    )[0];
    if (!bounded) return;
    const envelope = {
      sessionId: this.options.binding.sessionId,
      writerGeneration: this.options.binding.writerGeneration,
      batchId: crypto.randomUUID(),
      sequence: this.sequence.toString(),
      parts: [{
        itemId: crypto.randomUUID(),
        channel: "status" as const,
        text: bounded,
      }],
      capture: this.disposition.capture === "complete"
        ? "capturing" as const
        : this.disposition.capture,
      reason: this.disposition.capture === "complete"
        ? null
        : this.disposition.reason,
    };
    const batch = OutputBatchSchema.parse({
      ...envelope,
      digest: await outputDigest(envelope),
    });
    await this.publish((authorized) =>
      this.options.spool.enqueueNextOutputEvent({
        attemptId: this.options.assignment.attemptId,
        leaseToken: this.options.assignment.leaseToken,
        fence: String(this.options.assignment.fence),
        eventId: crypto.randomUUID(),
        payload: batch,
        status: true,
      }, authorized)
    );
    this.sequence++;
  }
}

export async function openNativeOutputCapture(
  options: Omit<
    NativeOutputCaptureOptions,
    "binding"
  >,
): Promise<NativeOutputCapture> {
  const binding = (await options.client.openOutput(
    options.assignment.attemptId,
    {
      leaseToken: options.assignment.leaseToken,
      fence: String(options.assignment.fence),
      workerSessionId: options.workerSessionId,
      workerSessionGeneration: options.workerSessionGeneration,
    },
    crypto.randomUUID(),
  )).value;
  return new NativeOutputCapture({ ...options, binding });
}
