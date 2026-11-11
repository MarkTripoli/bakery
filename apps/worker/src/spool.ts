import {
  OUTPUT_STATUS_RESERVE_BYTES,
  OUTPUT_STATUS_RESERVE_RECORDS,
  type UsageReceipt,
} from "./types.ts";
export { terminalReservationBytes } from "./types.ts";
import type { JsonValue, SpoolRecord } from "./types.ts";
import {
  acquireStateLock,
  ensurePrivateDirectory,
  readJsonIfExists,
  writeJsonAtomically,
} from "./storage.ts";
import type {
  AuthorityDecision,
  AuthorityRejection,
  PublicationAuthority,
} from "./quarantine.ts";
import { validatePublicationAuthority } from "./quarantine.ts";
import type { StateLock, StateLockFactory } from "./storage.ts";

const DECIMAL = /^[1-9][0-9]*$/;
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const TERMINAL_EVENT_TYPES: Record<string, true> = {
  "job.succeeded": true,
  "job.failed": true,
  "job.cancelled": true,
};

export type PersistedOutputClose = {
  attemptId: string;
  leaseToken: string;
  fence: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  idempotencyKey: string;
  sessionId: string;
  writerGeneration: string;
  capture: "complete" | "truncated" | "interrupted";
  reason:
    | "clean-end"
    | "text-limit"
    | "source-lost"
    | "lease-lost"
    | "producer-replaced";
};

type OutputStatusUsage = { records: number; bytes: number };

type PersistedSpool = {
  version: 1;
  records: SpoolRecord[];
  nextLocalSeq: Record<string, string>;
  ackedLocalSeq: Record<string, string>;
  terminalReservations: Record<string, number>;
  outputStatusUsage: Record<string, OutputStatusUsage>;
  outputCloses: Record<string, PersistedOutputClose>;
};

const GLOBAL_OUTPUT_MAX_RECORDS = 1_024;
const GLOBAL_OUTPUT_MAX_BYTES = 12 * 1024 * 1024;
const NATIVE_OUTPUT_MAX_RECORDS = 32;
const NATIVE_OUTPUT_MAX_BYTES = 256 * 1024;

export class SpoolError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SpoolError";
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${
    Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")
  }}`;
}

export async function canonicalDigest(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertDecimal(value: string, field: string): void {
  if (!DECIMAL.test(value)) {
    throw new SpoolError(`SPOOL_${field.toUpperCase()}_INVALID`);
  }
}

function assertNonNegativeDecimal(value: string, field: string): void {
  if (!NON_NEGATIVE_DECIMAL.test(value)) {
    throw new SpoolError(`SPOOL_${field.toUpperCase()}_INVALID`);
  }
}

function validateRecord(value: unknown): SpoolRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SpoolError("SPOOL_RECORD_INVALID");
  }
  const record = value as Record<string, unknown>;
  for (
    const field of [
      "attemptId",
      "leaseToken",
      "fence",
      "localSeq",
      "eventId",
      "type",
      "digest",
    ]
  ) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new SpoolError("SPOOL_RECORD_INVALID");
    }
  }
  if (record.kind !== "event" && record.kind !== "result") {
    throw new SpoolError("SPOOL_RECORD_KIND_INVALID");
  }
  assertDecimal(record.fence as string, "fence");
  assertDecimal(record.localSeq as string, "localSeq");
  if (!record.payload || typeof record.payload !== "object") {
    throw new SpoolError("SPOOL_RECORD_PAYLOAD_INVALID");
  }
  return clone(record) as SpoolRecord;
}

export class EventSpool {
  readonly path: string;
  readonly maxRecords: number;
  readonly maxBytes: number;
  private state: PersistedSpool;
  private encodedBytes = 0;
  private readonly acquireLock: StateLockFactory;
  private mutationTail = Promise.resolve();
  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let lock: StateLock | null = null;
    try {
      lock = await this.acquireLock(`${this.path}.lock`);
      const persisted = await readJsonIfExists<unknown>(this.path);
      if (persisted !== null) {
        this.state = EventSpool.validateState(persisted);
        this.encodedBytes = this.measure(this.state);
      }
      return await work();
    } finally {
      try {
        if (lock) await lock.release();
      } finally {
        release();
      }
    }
  }

  private constructor(
    path: string,
    maxRecords: number,
    maxBytes: number,
    state: PersistedSpool,
    acquireLock: StateLockFactory,
  ) {
    this.path = path;
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.state = state;
    this.encodedBytes = this.measure(state);
    this.acquireLock = acquireLock;
  }

  static async open(options: {
    path: string;
    maxRecords: number;
    maxBytes: number;
    acquireStateLock?: StateLockFactory;
  }): Promise<EventSpool> {
    const directory = options.path.slice(0, options.path.lastIndexOf("/")) ||
      "/";
    await ensurePrivateDirectory(directory);
    const acquireLock = options.acquireStateLock ?? acquireStateLock;
    const lock = await acquireLock(`${options.path}.lock`);
    try {
      const persisted = await readJsonIfExists<unknown>(options.path);
      const state: PersistedSpool = persisted === null
        ? {
          version: 1,
          records: [],
          nextLocalSeq: {},
          ackedLocalSeq: {},
          terminalReservations: {},
          outputStatusUsage: {},
          outputCloses: {},
        }
        : EventSpool.validateState(persisted);
      if (state.records.length > options.maxRecords) {
        throw new SpoolError("SPOOL_CAPACITY_EXCEEDED");
      }
      for (const record of state.records) {
        if (await canonicalDigest(record.payload) !== record.digest) {
          throw new SpoolError("SPOOL_DIGEST_MISMATCH");
        }
      }
      const spool = new EventSpool(
        options.path,
        options.maxRecords,
        options.maxBytes,
        state,
        acquireLock,
      );
      if (spool.encodedBytes > options.maxBytes) {
        throw new SpoolError("SPOOL_CAPACITY_EXCEEDED");
      }
      if (persisted === null) await spool.persist();
      return spool;
    } finally {
      await lock.release();
    }
  }

  private static validateState(value: unknown): PersistedSpool {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SpoolError("SPOOL_STATE_INVALID");
    }
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || !Array.isArray(state.records)) {
      throw new SpoolError("SPOOL_STATE_INVALID");
    }
    const records = state.records.map(validateRecord);
    const nextLocalSeq = state.nextLocalSeq;
    const ackedLocalSeq = state.ackedLocalSeq;
    const terminalReservations = state.terminalReservations ?? {};
    const outputStatusUsage = state.outputStatusUsage ?? {};
    const outputCloses = state.outputCloses ?? {};
    if (
      !nextLocalSeq || typeof nextLocalSeq !== "object" ||
      Array.isArray(nextLocalSeq) || !ackedLocalSeq ||
      typeof ackedLocalSeq !== "object" || Array.isArray(ackedLocalSeq) ||
      !terminalReservations || typeof terminalReservations !== "object" ||
      Array.isArray(terminalReservations) || !outputStatusUsage ||
      typeof outputStatusUsage !== "object" ||
      Array.isArray(outputStatusUsage) ||
      !outputCloses || typeof outputCloses !== "object" ||
      Array.isArray(outputCloses)
    ) {
      throw new SpoolError("SPOOL_STATE_INVALID");
    }
    for (
      const [name, values] of [
        ["nextLocalSeq", nextLocalSeq],
        ["ackedLocalSeq", ackedLocalSeq],
      ] as const
    ) {
      for (
        const [attemptId, seq] of Object.entries(
          values as Record<string, unknown>,
        )
      ) {
        if (!attemptId || typeof seq !== "string") {
          throw new SpoolError("SPOOL_STATE_INVALID");
        }
        if (name === "ackedLocalSeq") {
          assertNonNegativeDecimal(seq, "sequence");
        } else {
          assertDecimal(seq, "sequence");
        }
      }
    }
    for (const [attemptId, bytes] of Object.entries(terminalReservations)) {
      if (!attemptId || !Number.isSafeInteger(bytes) || bytes < 1) {
        throw new SpoolError("SPOOL_RESERVATION_INVALID");
      }
    }
    for (const [attemptId, usage] of Object.entries(outputStatusUsage)) {
      if (
        !attemptId || !usage || typeof usage !== "object" ||
        !Number.isSafeInteger((usage as OutputStatusUsage).records) ||
        !Number.isSafeInteger((usage as OutputStatusUsage).bytes) ||
        (usage as OutputStatusUsage).records < 0 ||
        (usage as OutputStatusUsage).records > OUTPUT_STATUS_RESERVE_RECORDS ||
        (usage as OutputStatusUsage).bytes < 0 ||
        (usage as OutputStatusUsage).bytes > OUTPUT_STATUS_RESERVE_BYTES
      ) throw new SpoolError("SPOOL_STATUS_RESERVE_INVALID");
    }
    for (const [attemptId, close] of Object.entries(outputCloses)) {
      if (!attemptId || !close || typeof close !== "object") {
        throw new SpoolError("SPOOL_OUTPUT_CLOSE_INVALID");
      }
      const value = close as PersistedOutputClose;
      if (
        value.attemptId !== attemptId || !value.leaseToken ||
        !value.workerSessionId || !value.idempotencyKey || !value.sessionId ||
        !["complete", "truncated", "interrupted"].includes(value.capture) ||
        ![
          "clean-end",
          "text-limit",
          "source-lost",
          "lease-lost",
          "producer-replaced",
        ].includes(value.reason)
      ) throw new SpoolError("SPOOL_OUTPUT_CLOSE_INVALID");
      assertDecimal(value.fence, "fence");
      assertDecimal(value.workerSessionGeneration, "worker_session_generation");
      assertDecimal(value.writerGeneration, "writer_generation");
    }
    return {
      version: 1,
      records,
      nextLocalSeq: clone(nextLocalSeq) as Record<string, string>,
      ackedLocalSeq: clone(ackedLocalSeq) as Record<string, string>,
      terminalReservations: clone(terminalReservations) as Record<
        string,
        number
      >,
      outputStatusUsage: clone(outputStatusUsage) as Record<
        string,
        OutputStatusUsage
      >,
      outputCloses: clone(outputCloses) as Record<string, PersistedOutputClose>,
    };
  }

  private measure(state: PersistedSpool): number {
    return new TextEncoder().encode(JSON.stringify(state)).byteLength;
  }

  private async persist(state = this.state): Promise<void> {
    await writeJsonAtomically(this.path, state, 0o600);
    this.encodedBytes = this.measure(state);
  }

  private reservationBytes(state: PersistedSpool): number {
    return Object.values(state.terminalReservations).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
  }

  private effectiveMaxRecords(): number {
    return Math.min(this.maxRecords, GLOBAL_OUTPUT_MAX_RECORDS);
  }

  private effectiveMaxBytes(): number {
    return Math.min(this.maxBytes, GLOBAL_OUTPUT_MAX_BYTES);
  }

  private assertCapacity(state: PersistedSpool): void {
    let statusRecords = 0;
    let statusBytes = 0;
    for (const attemptId of Object.keys(state.terminalReservations)) {
      const used = state.outputStatusUsage[attemptId];
      statusRecords += OUTPUT_STATUS_RESERVE_RECORDS - (used?.records ?? 0);
      statusBytes += OUTPUT_STATUS_RESERVE_BYTES - (used?.bytes ?? 0);
    }
    if (
      state.records.length + Object.keys(state.terminalReservations).length +
            statusRecords > this.effectiveMaxRecords() ||
      this.measure(state) + this.reservationBytes(state) + statusBytes >
        this.effectiveMaxBytes()
    ) {
      throw new SpoolError("SPOOL_CAPACITY_EXCEEDED");
    }
  }

  async reserveTerminal(attemptId: string, bytes: number): Promise<void> {
    if (!attemptId || !Number.isSafeInteger(bytes) || bytes < 1) {
      throw new SpoolError("SPOOL_RESERVATION_INVALID");
    }
    await this.mutate(async () => {
      if (this.state.terminalReservations[attemptId] === bytes) return;
      if (this.state.terminalReservations[attemptId] !== undefined) {
        throw new SpoolError("SPOOL_RESERVATION_CONFLICT");
      }
      const nextState = {
        ...this.state,
        terminalReservations: {
          ...this.state.terminalReservations,
          [attemptId]: bytes,
        },
      };
      this.assertCapacity(nextState);
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  async enqueueNextOutputEvent(input: {
    attemptId: string;
    leaseToken: string;
    fence: string;
    eventId: string;
    payload: JsonValue;
    status: boolean;
  }, authorized: () => boolean = () => true): Promise<SpoolRecord> {
    return await this.mutate(async () => {
      const localSeq = this.state.nextLocalSeq[input.attemptId] || "1";
      const digest = await canonicalDigest(input.payload);
      const record: SpoolRecord = {
        attemptId: input.attemptId,
        leaseToken: input.leaseToken,
        fence: input.fence,
        localSeq,
        eventId: input.eventId,
        kind: "event",
        type: "job.output",
        payload: clone(input.payload),
        digest,
      };
      const recordBytes =
        new TextEncoder().encode(JSON.stringify(record)).byteLength;
      const previousUsage = this.state.outputStatusUsage[input.attemptId] ?? {
        records: 0,
        bytes: 0,
      };
      const nextUsage = input.status
        ? {
          records: previousUsage.records + 1,
          bytes: previousUsage.bytes + recordBytes,
        }
        : previousUsage;
      if (
        nextUsage.records > OUTPUT_STATUS_RESERVE_RECORDS ||
        nextUsage.bytes > OUTPUT_STATUS_RESERVE_BYTES
      ) throw new SpoolError("SPOOL_STATUS_RESERVE_EXCEEDED");
      const nextState: PersistedSpool = {
        ...this.state,
        records: [...this.state.records, record],
        nextLocalSeq: {
          ...this.state.nextLocalSeq,
          [input.attemptId]: (BigInt(localSeq) + 1n).toString(),
        },
        outputStatusUsage: {
          ...this.state.outputStatusUsage,
          [input.attemptId]: nextUsage,
        },
      };
      const remainingStatusRecords = OUTPUT_STATUS_RESERVE_RECORDS -
        nextUsage.records;
      const remainingStatusBytes = OUTPUT_STATUS_RESERVE_BYTES -
        nextUsage.bytes;
      const attemptOutput = nextState.records.filter((candidate) =>
        candidate.attemptId === input.attemptId &&
        candidate.type === "job.output"
      );
      const attemptOutputBytes = attemptOutput.reduce(
        (sum, candidate) =>
          sum + new TextEncoder().encode(JSON.stringify(candidate)).byteLength,
        0,
      );
      if (
        attemptOutput.length + remainingStatusRecords >
          NATIVE_OUTPUT_MAX_RECORDS ||
        attemptOutputBytes + remainingStatusBytes > NATIVE_OUTPUT_MAX_BYTES
      ) throw new SpoolError("SPOOL_CAPACITY_EXCEEDED");
      this.assertCapacity(nextState);
      if (!authorized()) {
        throw new SpoolError("SPOOL_PUBLICATION_NOT_AUTHORIZED");
      }
      await this.persist(nextState);
      this.state = nextState;
      return clone(record);
    });
  }

  async enqueueNextResult(input: {
    attemptId: string;
    leaseToken: string;
    fence: string;
    eventId: string;
    status: "completed" | "failed" | "canceled";
    result?: JsonValue;
    fault?: JsonValue;
    cancellation?: JsonValue;
    usage?: UsageReceipt;
  }, authorized: () => boolean = () => true): Promise<SpoolRecord> {
    return await this.mutate(async () => {
      if (!authorized()) {
        throw new SpoolError("SPOOL_PUBLICATION_NOT_AUTHORIZED");
      }
      if (this.state.outputCloses[input.attemptId]) {
        throw new SpoolError("SPOOL_OUTPUT_CLOSE_PENDING");
      }
      if (this.state.terminalReservations[input.attemptId] === undefined) {
        throw new SpoolError("SPOOL_TERMINAL_RESERVATION_REQUIRED");
      }
      const localSeq = this.state.nextLocalSeq[input.attemptId] || "1";
      const payload: JsonValue = {
        status: input.status,
        ...(input.result === undefined ? {} : { result: clone(input.result) }),
        ...(input.fault === undefined ? {} : { fault: clone(input.fault) }),
        ...(input.cancellation === undefined
          ? {}
          : { cancellation: clone(input.cancellation) }),
        ...(input.usage === undefined ? {} : { usage: clone(input.usage) }),
      };
      const record: SpoolRecord = {
        attemptId: input.attemptId,
        leaseToken: input.leaseToken,
        fence: input.fence,
        localSeq,
        eventId: input.eventId,
        kind: "result",
        type: "result",
        payload,
        digest: await canonicalDigest(payload),
      };
      const terminalReservations = { ...this.state.terminalReservations };
      const outputStatusUsage = { ...this.state.outputStatusUsage };
      delete terminalReservations[input.attemptId];
      delete outputStatusUsage[input.attemptId];
      const nextState: PersistedSpool = {
        ...this.state,
        records: [...this.state.records, record],
        nextLocalSeq: {
          ...this.state.nextLocalSeq,
          [input.attemptId]: (BigInt(localSeq) + 1n).toString(),
        },
        terminalReservations,
        outputStatusUsage,
      };
      this.assertCapacity(nextState);
      if (!authorized()) {
        throw new SpoolError("SPOOL_PUBLICATION_NOT_AUTHORIZED");
      }
      await this.persist(nextState);
      this.state = nextState;
      return clone(record);
    });
  }

  async persistOutputClose(
    close: PersistedOutputClose,
    authorized: () => boolean = () => true,
  ): Promise<void> {
    await this.mutate(async () => {
      const existing = this.state.outputCloses[close.attemptId];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(close)) {
          throw new SpoolError("SPOOL_OUTPUT_CLOSE_CONFLICT");
        }
        return;
      }
      const nextState = {
        ...this.state,
        outputCloses: {
          ...this.state.outputCloses,
          [close.attemptId]: clone(close),
        },
      };
      this.assertCapacity(nextState);
      if (!authorized()) {
        throw new SpoolError("SPOOL_PUBLICATION_NOT_AUTHORIZED");
      }
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  pendingOutputCloses(): PersistedOutputClose[] {
    return Object.values(clone(this.state.outputCloses));
  }

  async acknowledgeOutputClose(attemptId: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.state.outputCloses[attemptId]) return;
      const outputCloses = { ...this.state.outputCloses };
      delete outputCloses[attemptId];
      const nextState = { ...this.state, outputCloses };
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  private async append(
    record: Omit<SpoolRecord, "digest"> & { digest?: string },
  ): Promise<SpoolRecord> {
    return await this.mutate(async () => {
      assertDecimal(record.fence, "fence");
      assertDecimal(record.localSeq, "localSeq");
      const expected = BigInt(
        this.state.nextLocalSeq[record.attemptId] || "1",
      );
      if (BigInt(record.localSeq) !== expected) {
        throw new SpoolError("SPOOL_SEQUENCE_GAP");
      }
      const digest = await canonicalDigest(record.payload);
      if (record.digest && record.digest !== digest) {
        throw new SpoolError("SPOOL_DIGEST_MISMATCH");
      }
      const immutable = {
        ...clone(record),
        digest,
      } as SpoolRecord;
      const nextState: PersistedSpool = {
        ...this.state,
        records: [...this.state.records, immutable],
        nextLocalSeq: {
          ...this.state.nextLocalSeq,
          [record.attemptId]: (expected + 1n).toString(),
        },
      };
      if (
        record.kind === "result" &&
        nextState.terminalReservations[record.attemptId] !== undefined
      ) {
        if (nextState.outputCloses[record.attemptId]) {
          throw new SpoolError("SPOOL_OUTPUT_CLOSE_PENDING");
        }
        nextState.terminalReservations = { ...nextState.terminalReservations };
        nextState.outputStatusUsage = { ...nextState.outputStatusUsage };
        delete nextState.terminalReservations[record.attemptId];
        delete nextState.outputStatusUsage[record.attemptId];
      }
      this.assertCapacity(nextState);
      await this.persist(nextState);
      this.state = nextState;
      return clone(immutable);
    });
  }

  async enqueueEvent(input: {
    attemptId: string;
    leaseToken: string;
    fence: string;
    localSeq: string;
    eventId: string;
    eventType: string;
    payload: JsonValue;
  }): Promise<SpoolRecord> {
    if (TERMINAL_EVENT_TYPES[input.eventType]) {
      throw new SpoolError("SPOOL_TERMINAL_EVENT_UNSUPPORTED");
    }
    return await this.append({
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      fence: input.fence,
      localSeq: input.localSeq,
      eventId: input.eventId,
      kind: "event",
      type: input.eventType,
      payload: clone(input.payload),
    });
  }

  async enqueueResult(input: {
    attemptId: string;
    leaseToken: string;
    fence: string;
    localSeq: string;
    eventId: string;
    status: "completed" | "failed" | "canceled";
    result?: JsonValue;
    fault?: JsonValue;
    cancellation?: JsonValue;
    usage?: UsageReceipt;
  }): Promise<SpoolRecord> {
    const payload: JsonValue = {
      status: input.status,
      ...(input.result === undefined ? {} : { result: clone(input.result) }),
      ...(input.fault === undefined ? {} : { fault: clone(input.fault) }),
      ...(input.cancellation === undefined
        ? {}
        : { cancellation: clone(input.cancellation) }),
      ...(input.usage === undefined ? {} : { usage: clone(input.usage) }),
    };
    return await this.append({
      attemptId: input.attemptId,
      leaseToken: input.leaseToken,
      fence: input.fence,
      localSeq: input.localSeq,
      eventId: input.eventId,
      kind: "result",
      type: "result",
      payload,
    });
  }

  async acknowledge(attemptId: string, lastEventSeq: string): Promise<void> {
    await this.mutate(async () => {
      assertDecimal(lastEventSeq, "last_event_seq");
      const previous = BigInt(this.state.ackedLocalSeq[attemptId] || "0");
      const target = BigInt(lastEventSeq);
      if (target <= previous) return;
      const next = BigInt(this.state.nextLocalSeq[attemptId] || "1");
      if (target >= next) throw new SpoolError("SPOOL_ACK_OUT_OF_RANGE");
      const attemptRecords = this.state.records.filter((record) =>
        record.attemptId === attemptId
      );
      const present = new Set(attemptRecords.map((record) => record.localSeq));
      for (let sequence = previous + 1n; sequence <= target; sequence++) {
        if (!present.has(sequence.toString())) {
          throw new SpoolError("SPOOL_ACK_GAP");
        }
      }
      const nextState: PersistedSpool = {
        ...this.state,
        records: this.state.records.filter(
          (record) =>
            record.attemptId !== attemptId ||
            BigInt(record.localSeq) > target,
        ),
        ackedLocalSeq: {
          ...this.state.ackedLocalSeq,
          [attemptId]: target.toString(),
        },
      };
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  async restoreJournalState(
    attemptId: string,
    nextLocalSeq: string,
    ackedLocalSeq: string,
  ): Promise<void> {
    await this.mutate(async () => {
      assertDecimal(nextLocalSeq, "next_sequence");
      assertNonNegativeDecimal(ackedLocalSeq, "acked_sequence");
      if (BigInt(ackedLocalSeq) >= BigInt(nextLocalSeq)) {
        throw new SpoolError("SPOOL_SEQUENCE_INVALID");
      }
      const currentNext = BigInt(this.state.nextLocalSeq[attemptId] || "1");
      const currentAcked = BigInt(this.state.ackedLocalSeq[attemptId] || "0");
      const nextState: PersistedSpool = {
        ...this.state,
        nextLocalSeq: {
          ...this.state.nextLocalSeq,
          [attemptId]: BigInt(nextLocalSeq) > currentNext
            ? nextLocalSeq
            : currentNext.toString(),
        },
        ackedLocalSeq: {
          ...this.state.ackedLocalSeq,
          [attemptId]: BigInt(ackedLocalSeq) > currentAcked
            ? ackedLocalSeq
            : currentAcked.toString(),
        },
      };
      if (
        BigInt(nextState.ackedLocalSeq[attemptId]) >=
          BigInt(nextState.nextLocalSeq[attemptId])
      ) {
        throw new SpoolError("SPOOL_SEQUENCE_INVALID");
      }
      if (
        nextState.nextLocalSeq[attemptId] ===
          this.state.nextLocalSeq[attemptId] &&
        nextState.ackedLocalSeq[attemptId] ===
          this.state.ackedLocalSeq[attemptId]
      ) return;
      this.assertCapacity(nextState);
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  async discardAttempt(attemptId: string): Promise<void> {
    await this.mutate(async () => {
      const records = this.state.records.filter((record) =>
        record.attemptId !== attemptId
      );
      const nextLocalSeq = { ...this.state.nextLocalSeq };
      const ackedLocalSeq = { ...this.state.ackedLocalSeq };
      const terminalReservations = { ...this.state.terminalReservations };
      const outputStatusUsage = { ...this.state.outputStatusUsage };
      const outputCloses = { ...this.state.outputCloses };
      delete nextLocalSeq[attemptId];
      delete ackedLocalSeq[attemptId];
      delete terminalReservations[attemptId];
      delete outputStatusUsage[attemptId];
      delete outputCloses[attemptId];
      if (
        records.length === this.state.records.length &&
        !(attemptId in this.state.nextLocalSeq) &&
        !(attemptId in this.state.ackedLocalSeq) &&
        !(attemptId in this.state.terminalReservations) &&
        !(attemptId in this.state.outputStatusUsage) &&
        !(attemptId in this.state.outputCloses)
      ) return;
      const nextState = {
        ...this.state,
        records,
        nextLocalSeq,
        ackedLocalSeq,
        terminalReservations,
        outputStatusUsage,
        outputCloses,
      };
      await this.persist(nextState);
      this.state = nextState;
    });
  }

  journalState(attemptId: string): {
    nextLocalSeq: string;
    ackedLocalSeq: string;
  } {
    return {
      nextLocalSeq: this.state.nextLocalSeq[attemptId] || "1",
      ackedLocalSeq: this.state.ackedLocalSeq[attemptId] || "0",
    };
  }

  peek(): SpoolRecord | null {
    return this.state.records.length === 0
      ? null
      : clone(this.state.records[0]);
  }

  records(): SpoolRecord[] {
    return clone(this.state.records);
  }

  hasRecord(attemptId: string, localSeq: string): boolean {
    return this.state.records.some((record) =>
      record.attemptId === attemptId && record.localSeq === localSeq
    );
  }
  hasReplaySafeRecord(attemptId: string): boolean {
    return this.state.records.some((record) => {
      if (record.attemptId !== attemptId) return false;
      if (record.kind === "event") return true; // eventId makes replay idempotent
      const payload = record.payload;
      if (
        payload === null || typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        return false;
      }
      const status = (payload as Record<string, unknown>).status;
      return status === "completed" || status === "failed";
    });
  }

  nextLocalSeq(attemptId: string): string {
    return this.state.nextLocalSeq[attemptId] || "1";
  }

  attemptIds(): string[] {
    return [
      ...new Set([
        ...this.state.records.map((record) => record.attemptId),
        ...Object.keys(this.state.terminalReservations),
        ...Object.keys(this.state.outputCloses),
      ]),
    ];
  }

  outputDepth(attemptId: string): { records: number; bytes: number } {
    const records = this.state.records.filter((record) =>
      record.attemptId === attemptId && record.type === "job.output"
    );
    return {
      records: records.length,
      bytes: records.reduce(
        (sum, record) =>
          sum + new TextEncoder().encode(JSON.stringify(record)).byteLength,
        0,
      ),
    };
  }

  hasPendingOutputClose(attemptId: string): boolean {
    return this.state.outputCloses[attemptId] !== undefined;
  }
  /** Return only records authorized by the latest server heartbeat. */
  authorizedRecords(
    authority: PublicationAuthority,
    session: { workerSessionId: string; workerSessionGeneration: string },
    now = performance.now(),
  ): { records: SpoolRecord[]; rejections: AuthorityRejection[] } {
    const records: SpoolRecord[] = [];
    const rejections: AuthorityRejection[] = [];
    for (const record of this.state.records) {
      if (record.attemptId !== authority.attemptId) continue;
      const decision: AuthorityDecision = validatePublicationAuthority(
        {
          ...record,
          workerSessionId: session.workerSessionId,
          workerSessionGeneration: session.workerSessionGeneration,
        },
        authority,
        now,
      );
      if (decision.allowed) records.push(clone(record));
      else rejections.push(decision.reason);
    }
    return { records, rejections };
  }

  get depth(): { records: number; bytes: number } {
    return { records: this.state.records.length, bytes: this.encodedBytes };
  }
}

export const createEventSpool = EventSpool.open;
