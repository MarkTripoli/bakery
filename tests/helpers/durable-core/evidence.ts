export type DurableCoreAuditRef = {
  readonly id: string;
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operation: string;
  readonly outcome: string;
  readonly requestId: string;
  readonly traceId: string;
};

export type DurableCoreCaseOutcome = "passed" | "failed";

export type DurableCoreCase = {
  readonly name: string;
  readonly outcome: DurableCoreCaseOutcome;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditReason?: string;
  readonly auditRefs: readonly DurableCoreAuditRef[];
};

export type DurableCoreAuditExpectation = {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operation: string;
  readonly outcome: string;
};

export type DurableCoreQuery = <T extends object>(
  sql: string,
  params?: unknown[],
) => Promise<readonly T[]>;

export type DurableCoreArtifactRef = {
  readonly artifactId: string;
  readonly versionId: string;
  readonly sha256: string;
};

export type DurableCoreBoundaryKind = "worker" | "engine";

type DurableCoreCheckpointObservation = {
  readonly checkpointAttemptId: string;
  readonly checkpointEventId: string;
  readonly checkpointLocalSeq: "3";
  readonly checkpointAckedLocalSeq: string;
  readonly nextLocalSeq: string;
};

export type DurableCoreJournalObservation =
  & DurableCoreCheckpointObservation
  & { readonly kind: "journal" };

export type DurableCoreSpoolRecord = {
  readonly attemptId: string;
  readonly eventId: string;
  readonly localSeq: string;
  readonly fence: string;
  readonly kind: string;
  readonly type: string;
};

type DurableCoreSpoolPresentObservation =
  & Omit<
    DurableCoreCheckpointObservation,
    "checkpointAckedLocalSeq" | "nextLocalSeq"
  >
  & {
    readonly kind: "spool";
    readonly spoolState: "present";
    readonly checkpointAckedLocalSeq: string;
    readonly nextLocalSeq: string;
    readonly version: number;
    readonly recordCount: number;
    readonly records: readonly DurableCoreSpoolRecord[];
  };

type DurableCoreSpoolAbsentObservation = {
  readonly kind: "spool";
  readonly spoolState: "absent";
  readonly checkpointAckedLocalSeq: null;
  readonly nextLocalSeq: null;
  readonly version: number;
  readonly recordCount: 0;
  readonly records: readonly [];
};

export type DurableCoreSpoolObservation =
  | DurableCoreSpoolPresentObservation
  | DurableCoreSpoolAbsentObservation;

type DurableCoreEngineObservationBase = {
  readonly processId: string;
  readonly runId: string;
  readonly organizationId: string;
  readonly outboxStatus: "delivered";
  readonly engineEventId: string;
  readonly functionRunId: string;
  readonly functionEventId: string;
  readonly functionEventInternalId: string;
  readonly functionDefinitionId: string;
  readonly runStatus: string;
  readonly engineOwnerPresent: true;
  readonly engineOwnerGeneration: string;
  readonly jobStatus: string;
  readonly checkpointAttemptId: string;
  readonly checkpointEventId: string;
  readonly checkpointLocalSeq: "3";
  readonly checkpointAckedLocalSeq: "3";
  readonly observedAt: string;
};

export type DurableCoreEngineObservation = DurableCoreEngineObservationBase;

export type DurableCoreEngineRecoveryObservation =
  & DurableCoreEngineObservationBase
  & (
    | {
      readonly recoveryMode: "natural";
      readonly recoveryFunctionRunId: string;
      readonly recoveryFunctionEventId: string;
      readonly recoveryFunctionDefinitionId: string;
      readonly recoveryFunctionRunStartedAt: string;
      readonly recoveryInvocationCount: number;
      readonly recoveryTriggerSource?: "cron";
    }
    | {
      readonly recoveryMode: "reconciliation";
      readonly recoveryFunctionRunId: string;
      readonly recoveryFunctionEventId: string;
      readonly recoveryFunctionDefinitionId: string;
      readonly recoveryFunctionRunStartedAt: string;
      readonly recoveryInvocationCount: number;
      readonly recoveryEventId: string;
      readonly recoveryEventInternalId: string;
      readonly recoveryTriggerFunctionId: string;
      readonly recoveryTriggerFunctionDefinitionId: string;
      readonly recoveryTriggerFunctionRunId: string;
      readonly recoveryTriggerFunctionEventId: string;
    }
  );

export type DurableCoreObservation =
  | DurableCoreJournalObservation
  | DurableCoreSpoolObservation
  | DurableCoreEngineObservation;
export type DurableCoreTerminalProof = {
  readonly attemptId: string;
  readonly eventId: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly taskStatus: "completed";
  readonly runId: string;
  readonly runStatus: "completed";
  readonly runStepId: string;
  readonly runStepStatus: "completed";
  readonly terminalTaskCount: 1;
  readonly terminalRunCount: 1;
  readonly terminalStepCount: 1;
  readonly acceptedCount: 1;
  readonly effectCount: 1;
  readonly artifactCount: 1;
};

type DurableCoreBoundaryProofBase = {
  readonly revision: string;
  readonly configuration: {
    readonly project: string;
    readonly ports: Readonly<Record<string, number>>;
  };
  readonly runId: string;
  readonly effectKey: string;
  readonly checkpoint: {
    readonly attemptId: string;
    readonly jobId: string;
    readonly runId: string;
    readonly runStepId: string;
    readonly fence: string;
    readonly workerSessionId: string;
    readonly workerSessionGeneration: string;
    readonly eventId: string;
    readonly localSeq: "3";
    readonly ackedLocalSeq: "3";
    readonly artifactRef: DurableCoreArtifactRef;
  };
  readonly restart: {
    readonly service: "worker" | "inngest";
    readonly beforeProcessId: string;
    readonly afterProcessId: string;
  };
  readonly terminal: DurableCoreTerminalProof;
  readonly artifact: {
    readonly ref: DurableCoreArtifactRef;
    readonly sha256: string;
    readonly verifiedSha256: string;
  };
  readonly observations: {
    readonly journalBefore: DurableCoreObservation;
    readonly journalAfter: DurableCoreObservation;
    readonly spoolBefore: DurableCoreObservation;
    readonly spoolAfter: DurableCoreObservation;
    readonly engineBefore?: DurableCoreEngineObservation;
    readonly engineAfter?: DurableCoreEngineRecoveryObservation;
  };
};

type DurableCoreWorkerBoundaryProof = DurableCoreBoundaryProofBase & {
  readonly kind: "worker";
  readonly replacementAttempt: {
    readonly attemptId: string;
    readonly fence: string;
    readonly workerSessionId: string;
    readonly workerSessionGeneration: string;
    readonly checkpointEventId: string;
    readonly checkpointLocalSeq: "3";
  };
  readonly secondCheckpoint: {
    readonly attemptId: string;
    readonly eventId: string;
    readonly localSeq: "3";
    readonly ackedLocalSeq: "3";
    readonly artifactRef: DurableCoreArtifactRef;
  };
};

type DurableCoreEngineBoundaryProof = DurableCoreBoundaryProofBase & {
  readonly kind: "engine";
  readonly replacementAttempt?: never;
  readonly secondCheckpoint?: never;
};

export type DurableCoreBoundaryProof =
  | DurableCoreWorkerBoundaryProof
  | DurableCoreEngineBoundaryProof;

export const DURABLE_CORE_REQUIRED_CASES = Object.freeze(
  [
    "duplicate",
    "out-of-order",
    "stale",
    "lost-acknowledgement",
    "completion-before-wait",
    "persisted-checkpoint",
    "server-restart",
    "cursor-replay",
    "one-terminal-winner",
    "completion-before-wait-durable-read",
    "cancellation-drain-after-checkpoint",
    "reject-success-after-cancellation",
    "cancellation-completion-before-wait-durable-read",
    "foreign-run-reference",
    "foreign-progress-reference",
    "foreign-artifact-reference",
    "anonymous-artifact-reference",
    "canceled-success-mutation",
  ] as const,
);
const DURABLE_CORE_SECURITY_CASES = new Set([
  "foreign-run-reference",
  "foreign-progress-reference",
  "foreign-artifact-reference",
  "anonymous-artifact-reference",
  "canceled-success-mutation",
]);

type AuditRow = {
  id: string;
  organizationId: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  outcome: string;
  requestId: string;
  traceId: string;
};

const MAX_CASES = 32;
const MAX_CASE_NAME_BYTES = 200;
const MAX_IDENTIFIER_BYTES = 200;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const MAX_AUDIT_REFS = 16;
const MAX_AUDIT_REASON_BYTES = 200;
const SHA256 = /^[0-9a-f]{64}$/i;
const REVISION = /^[0-9a-f]{40}$/i;
const SYNTHETIC_MARKER = /\b(?:fake|mock|simulated|synthetic|placeholder)\b/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertBoundedText(
  value: string,
  name: string,
  maxBytes: number,
): void {
  if (
    value.trim() === "" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
}
function assertClosedRecord(
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_UNEXPECTED_FIELD`,
      );
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_MISSING_FIELD`,
      );
    }
  }
  return record;
}

function assertRealIdentity(value: string, name: string): void {
  assertBoundedText(value, name, MAX_IDENTIFIER_BYTES);
  if (SYNTHETIC_MARKER.test(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_SYNTHETIC_${name.toUpperCase()}`);
  }
}
function assertUuid(value: string, name: string): void {
  assertRealIdentity(value, name);
  if (!UUID.test(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
}
function assertProcessIdentity(value: string, name: string): void {
  assertRealIdentity(value, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
}

function assertEventInternalId(value: string, name: string): void {
  assertRealIdentity(value, name);
  if (!/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
}

function assertDigest(value: string, name: string): void {
  if (!SHA256.test(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name.toUpperCase()}`);
  }
}
function assertFence(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`DURABLE_CORE_PROOF_INVALID_${name.toUpperCase()}`);
  }
  return BigInt(value);
}

function assertArtifactRef(
  value: unknown,
  name: string,
): asserts value is DurableCoreArtifactRef {
  const candidate = assertClosedRecord(
    value,
    name,
    ["artifactId", "versionId", "sha256"],
  );
  for (const field of ["artifactId", "versionId"] as const) {
    if (typeof candidate[field] !== "string") {
      throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
    }
    assertUuid(candidate[field], `${name}_${field}`);
  }
  if (typeof candidate.sha256 !== "string") {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_sha256`);
  }
  assertDigest(candidate.sha256 as string, `${name}_sha256`);
}

function assertObservation(
  value: unknown,
  name: string,
  allowedAttemptIds: ReadonlySet<string>,
  allowedEventIds: ReadonlySet<string>,
  requireAckedCheckpoint: boolean,
): asserts value is
  | DurableCoreJournalObservation
  | DurableCoreSpoolObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}`);
  }
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_OBSERVATION_BYTES ||
    SYNTHETIC_MARKER.test(serialized)
  ) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "journal" && record.kind !== "spool") {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_KIND`);
  }
  if (record.kind === "journal") {
    assertClosedRecord(
      record,
      name,
      [
        "kind",
        "checkpointAttemptId",
        "checkpointEventId",
        "checkpointLocalSeq",
        "checkpointAckedLocalSeq",
        "nextLocalSeq",
      ],
    );
  }
  if (record.kind === "spool" && record.spoolState === "absent") {
    assertClosedRecord(
      record,
      name,
      [
        "kind",
        "spoolState",
        "checkpointAckedLocalSeq",
        "nextLocalSeq",
        "version",
        "recordCount",
        "records",
      ],
    );
  }
  if (record.kind === "spool" && record.spoolState === "present") {
    assertClosedRecord(
      record,
      name,
      [
        "kind",
        "spoolState",
        "checkpointAttemptId",
        "checkpointEventId",
        "checkpointLocalSeq",
        "checkpointAckedLocalSeq",
        "nextLocalSeq",
        "version",
        "recordCount",
        "records",
      ],
    );
  }

  if (record.kind === "spool" && record.spoolState === "absent") {
    if (name !== "spoolAfter") {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_SPOOL_ABSENT`,
      );
    }
    for (
      const field of [
        "checkpointAttemptId",
        "checkpointEventId",
        "checkpointLocalSeq",
      ] as const
    ) {
      if (field in record) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_ABSENT_PROVENANCE`,
        );
      }
    }
    if (
      record.checkpointAckedLocalSeq !== null ||
      record.nextLocalSeq !== null ||
      !Number.isSafeInteger(record.version) ||
      (record.version as number) < 1 ||
      record.recordCount !== 0 ||
      !Array.isArray(record.records) ||
      record.records.length !== 0
    ) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_ABSENT_STATE`,
      );
    }
    return;
  }

  if (record.kind === "spool" && record.spoolState !== "present") {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_SPOOL_STATE`);
  }
  for (
    const field of [
      "checkpointAttemptId",
      "checkpointEventId",
      "checkpointLocalSeq",
    ] as const
  ) {
    if (typeof record[field] !== "string") {
      throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
    }
    assertRealIdentity(record[field] as string, `${name}_${field}`);
  }
  const checkpointAttemptId = record.checkpointAttemptId as string;
  const checkpointEventId = record.checkpointEventId as string;
  assertUuid(checkpointAttemptId, `${name}_checkpoint_attempt_id`);
  assertUuid(checkpointEventId, `${name}_checkpoint_event_id`);
  if (
    !allowedAttemptIds.has(checkpointAttemptId) ||
    !allowedEventIds.has(checkpointEventId)
  ) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_CHECKPOINT_MISMATCH`,
    );
  }
  if (record.checkpointLocalSeq !== "3") {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_LOCAL_SEQ_INVALID`,
    );
  }

  for (const field of ["checkpointAckedLocalSeq", "nextLocalSeq"] as const) {
    if (typeof record[field] !== "string") {
      throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
    }
    assertRealIdentity(record[field], `${name}_${field}`);
  }
  const ackedLocalSeq = assertFence(
    record.checkpointAckedLocalSeq as string,
    `${name}_checkpoint_acked_local_seq`,
  );
  const nextLocalSeq = assertFence(
    record.nextLocalSeq as string,
    `${name}_next_local_seq`,
  );
  if (ackedLocalSeq > 3n || nextLocalSeq < 3n) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_SEQUENCE_INVALID`,
    );
  }
  if (requireAckedCheckpoint && ackedLocalSeq !== 3n) {
    throw new Error(`DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_NOT_ACKED`);
  }
  if (record.kind !== "spool") return;

  if (
    !Number.isSafeInteger(record.version) ||
    (record.version as number) < 1 ||
    !Number.isSafeInteger(record.recordCount) ||
    (record.recordCount as number) < 0 ||
    !Array.isArray(record.records) ||
    record.records.length > 64 ||
    (record.recordCount as number) !== record.records.length
  ) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_RECORDS`);
  }
  let linkedRecord = false;
  for (const candidate of record.records) {
    const spoolRecord = assertClosedRecord(
      candidate,
      `${name}_record`,
      ["attemptId", "eventId", "localSeq", "fence", "kind", "type"],
    );
    for (
      const field of [
        "attemptId",
        "eventId",
        "localSeq",
        "fence",
        "kind",
        "type",
      ] as const
    ) {
      if (typeof spoolRecord[field] !== "string") {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_INVALID_${name}_RECORD_${field}`,
        );
      }
      assertRealIdentity(spoolRecord[field], `${name}_record_${field}`);
    }
    const attemptId = spoolRecord.attemptId as string;
    const eventId = spoolRecord.eventId as string;
    const localSeq = spoolRecord.localSeq as string;
    const fence = spoolRecord.fence as string;
    assertUuid(attemptId, `${name}_record_attempt_id`);
    assertUuid(eventId, `${name}_record_event_id`);
    assertFence(localSeq, `${name}_record_local_seq`);
    assertFence(fence, `${name}_record_fence`);
    if (
      spoolRecord.attemptId === record.checkpointAttemptId &&
      spoolRecord.eventId === record.checkpointEventId &&
      spoolRecord.localSeq === record.checkpointLocalSeq
    ) {
      linkedRecord = true;
    }
  }
  if (!linkedRecord && ackedLocalSeq < 3n) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECORD_UNLINKED`,
    );
  }
}
const TERMINAL_STATUSES = new Set([
  "completed",
  "canceled",
  "cancelled",
  "failed",
  "succeeded",
  "success",
  "terminated",
]);

function assertEngineObservation(
  value: unknown,
  name: string,
  proof: {
    readonly runId: string;
    readonly checkpoint: {
      readonly attemptId: string;
      readonly eventId: string;
    };
  },
): asserts value is DurableCoreEngineObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}`);
  }
  const record = value as Record<string, unknown>;
  const stringFields = [
    "processId",
    "runId",
    "organizationId",
    "engineEventId",
    "functionRunId",
    "functionEventId",
    "functionEventInternalId",
    "functionDefinitionId",
    "runStatus",
    "engineOwnerGeneration",
    "jobStatus",
    "checkpointEventId",
    "checkpointAttemptId",
    "checkpointLocalSeq",
    "checkpointAckedLocalSeq",
    "observedAt",
  ] as const;
  const recoveryStringFields = [
    "recoveryFunctionRunId",
    "recoveryFunctionEventId",
    "recoveryFunctionDefinitionId",
    "recoveryFunctionRunStartedAt",
  ] as const;
  const recoveryFields = [
    "recoveryMode",
    ...recoveryStringFields,
    "recoveryInvocationCount",
    "recoveryEventId",
    "recoveryEventInternalId",
    "recoveryTriggerFunctionId",
    "recoveryTriggerFunctionDefinitionId",
    "recoveryTriggerFunctionRunId",
    "recoveryTriggerFunctionEventId",
    "recoveryTriggerSource",
  ] as const;
  assertClosedRecord(
    record,
    name,
    [
      ...stringFields,
      "outboxStatus",
      "engineOwnerPresent",
      ...(name === "engineAfter"
        ? ["recoveryMode", ...recoveryStringFields, "recoveryInvocationCount"]
        : []),
    ],
    name === "engineAfter"
      ? [
        "recoveryEventId",
        "recoveryEventInternalId",
        "recoveryTriggerFunctionId",
        "recoveryTriggerFunctionDefinitionId",
        "recoveryTriggerFunctionRunId",
        "recoveryTriggerFunctionEventId",
        "recoveryTriggerSource",
      ]
      : [],
  );
  for (const field of stringFields) {
    if (typeof record[field] !== "string") {
      throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
    }
    if (field === "functionDefinitionId") {
      assertUuid(record[field], `${name}_${field}`);
    } else if (field === "functionEventInternalId") {
      assertEventInternalId(record[field], `${name}_${field}`);
    } else {
      assertRealIdentity(record[field], `${name}_${field}`);
    }
  }
  if (record.engineOwnerPresent !== true) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_OWNER_MISSING`,
    );
  }
  if (record.outboxStatus !== "delivered") {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_OUTBOX_INVALID`,
    );
  }
  if (name === "engineAfter") {
    if (
      record.recoveryMode !== "natural" &&
      record.recoveryMode !== "reconciliation"
    ) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECOVERY_MODE_INVALID`,
      );
    }
    for (const field of recoveryStringFields) {
      if (typeof record[field] !== "string") {
        throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
      }
      if (field === "recoveryFunctionDefinitionId") {
        assertUuid(record[field], `${name}_${field}`);
      } else {
        assertRealIdentity(record[field], `${name}_${field}`);
      }
    }
    if (
      !Number.isSafeInteger(record.recoveryInvocationCount) ||
      (record.recoveryInvocationCount as number) < 1
    ) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECOVERY_COUNT_INVALID`,
      );
    }
    if (
      typeof record.recoveryFunctionRunStartedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recoveryFunctionRunStartedAt))
    ) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECOVERY_TIME_INVALID`,
      );
    }
    if (record.recoveryMode === "natural") {
      for (
        const field of [
          "recoveryEventId",
          "recoveryEventInternalId",
          "recoveryTriggerFunctionId",
          "recoveryTriggerFunctionDefinitionId",
          "recoveryTriggerFunctionRunId",
          "recoveryTriggerFunctionEventId",
        ] as const
      ) {
        if (field in record) {
          throw new Error(
            `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_NATURAL_TRIGGER_UNEXPECTED`,
          );
        }
      }
      if (
        "recoveryTriggerSource" in record &&
        record.recoveryTriggerSource !== "cron"
      ) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_TRIGGER_SOURCE_INVALID`,
        );
      }
    } else {
      if ("recoveryTriggerSource" in record) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECONCILIATION_SOURCE_UNEXPECTED`,
        );
      }
      for (
        const field of [
          "recoveryEventId",
          "recoveryEventInternalId",
          "recoveryTriggerFunctionId",
          "recoveryTriggerFunctionDefinitionId",
          "recoveryTriggerFunctionRunId",
          "recoveryTriggerFunctionEventId",
        ] as const
      ) {
        if (typeof record[field] !== "string") {
          throw new Error(`DURABLE_CORE_EVIDENCE_INVALID_${name}_${field}`);
        }
        if (field === "recoveryTriggerFunctionDefinitionId") {
          assertUuid(record[field], `${name}_${field}`);
        } else if (field === "recoveryEventInternalId") {
          assertEventInternalId(record[field], `${name}_${field}`);
        } else {
          assertRealIdentity(record[field], `${name}_${field}`);
        }
      }
      if (
        record.recoveryTriggerFunctionEventId !== record.recoveryEventId
      ) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_TRIGGER_EVENT_MISMATCH`,
        );
      }
      if (
        record.recoveryTriggerFunctionRunId === record.recoveryFunctionRunId
      ) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_TRIGGER_RUN_MISMATCH`,
        );
      }
    }
  } else if (recoveryFields.some((field) => field in record)) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RECOVERY_UNEXPECTED`,
    );
  }
  const processId = record.processId as string;
  const organizationId = record.organizationId as string;
  const ownerGeneration = record.engineOwnerGeneration as string;
  const checkpointAttemptId = record.checkpointAttemptId as string;
  const checkpointEventId = record.checkpointEventId as string;
  const observedAt = record.observedAt as string;
  const runStatus = record.runStatus as string;
  const jobStatus = record.jobStatus as string;
  assertProcessIdentity(processId, `${name}_process_id`);
  assertUuid(organizationId, `${name}_organization_id`);
  assertFence(ownerGeneration, `${name}_owner_generation`);
  assertUuid(checkpointAttemptId, `${name}_checkpoint_attempt_id`);
  assertUuid(checkpointEventId, `${name}_checkpoint_event_id`);
  if (
    record.checkpointLocalSeq !== "3" ||
    record.checkpointAckedLocalSeq !== "3"
  ) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_CHECKPOINT_INVALID`,
    );
  }
  if (record.runId !== proof.runId) {
    throw new Error(`DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_RUN_MISMATCH`);
  }
  if (checkpointAttemptId !== proof.checkpoint.attemptId) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_ATTEMPT_MISMATCH`,
    );
  }
  if (checkpointEventId !== proof.checkpoint.eventId) {
    throw new Error(
      `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_EVENT_MISMATCH`,
    );
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error(`DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_TIME_INVALID`);
  }
  for (const status of [runStatus, jobStatus]) {
    if (TERMINAL_STATUSES.has(status.toLowerCase())) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_${name.toUpperCase()}_STATUS_TERMINAL`,
      );
    }
  }
}

function assertPorts(
  value: unknown,
): asserts value is Readonly<Record<string, number>> {
  const ports = assertClosedRecord(
    value,
    "ports",
    ["server", "postgres", "inngest"],
  );
  for (const [name, port] of Object.entries(ports)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      throw new Error("DURABLE_CORE_EVIDENCE_INVALID_PORT_NAME");
    }
    assertBoundedText(name, "port_name", 64);
    if (
      !Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535
    ) {
      throw new Error("DURABLE_CORE_EVIDENCE_INVALID_PORT");
    }
  }
}

function assertCaseShape(candidate: DurableCoreCase): void {
  assertBoundedText(candidate.name, "case_name", MAX_CASE_NAME_BYTES);
  assertBoundedText(candidate.requestId, "request_id", MAX_IDENTIFIER_BYTES);
  assertBoundedText(candidate.traceId, "trace_id", MAX_IDENTIFIER_BYTES);
  if (!(["passed", "failed"] as const).includes(candidate.outcome)) {
    throw new Error("DURABLE_CORE_EVIDENCE_INVALID_OUTCOME");
  }
  if (candidate.auditReason !== undefined) {
    if (candidate.auditRefs.length !== 0) {
      throw new Error(
        "DURABLE_CORE_EVIDENCE_AUDIT_REASON_REQUIRES_EMPTY_REFS",
      );
    }
    if (!DURABLE_CORE_SECURITY_CASES.has(candidate.name)) {
      throw new Error("DURABLE_CORE_EVIDENCE_AUDIT_REASON_SECURITY_ONLY");
    }
    assertBoundedText(
      candidate.auditReason,
      "audit_reason",
      MAX_AUDIT_REASON_BYTES,
    );
  }
  if (candidate.auditRefs.length > MAX_AUDIT_REFS) {
    throw new Error("DURABLE_CORE_EVIDENCE_AUDIT_REFS_LIMIT");
  }
  const refs = new Set<string>();
  for (const ref of candidate.auditRefs) {
    const auditRef = assertClosedRecord(
      ref,
      "audit_ref",
      [
        "id",
        "organizationId",
        "resourceType",
        "resourceId",
        "operation",
        "outcome",
        "requestId",
        "traceId",
      ],
    );
    for (
      const field of [
        "organizationId",
        "resourceType",
        "resourceId",
        "operation",
        "outcome",
        "requestId",
        "traceId",
      ] as const
    ) {
      if (typeof auditRef[field] !== "string") {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_INVALID_AUDIT_REF_${field.toUpperCase()}`,
        );
      }
      assertBoundedText(
        auditRef[field],
        `audit_ref_${field}`,
        MAX_IDENTIFIER_BYTES,
      );
    }
    if (typeof auditRef.id !== "string") {
      throw new Error("DURABLE_CORE_EVIDENCE_INVALID_AUDIT_REF_ID");
    }
    assertUuid(auditRef.id, "audit_ref_id");
    assertUuid(auditRef.organizationId as string, "audit_ref_organization_id");
    if (
      auditRef.requestId !== candidate.requestId ||
      auditRef.traceId !== candidate.traceId
    ) {
      throw new Error("DURABLE_CORE_EVIDENCE_AUDIT_IDENTITY_MISMATCH");
    }
    if (refs.has(auditRef.id)) {
      throw new Error("DURABLE_CORE_EVIDENCE_DUPLICATE_AUDIT_REF");
    }
    refs.add(auditRef.id);
  }
}

export function createDurableCoreCase(input: {
  readonly name: string;
  readonly outcome: DurableCoreCaseOutcome;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditReason?: string;
  readonly auditRefs?: readonly DurableCoreAuditRef[];
}): DurableCoreCase {
  const result: DurableCoreCase = {
    name: input.name,
    outcome: input.outcome,
    requestId: input.requestId,
    traceId: input.traceId,
    ...(input.auditReason === undefined
      ? {}
      : { auditReason: input.auditReason }),
    auditRefs: Object.freeze(
      [...(input.auditRefs ?? [])].map((ref) => Object.freeze({ ...ref })),
    ),
  };
  assertCaseShape(result);
  return Object.freeze(result);
}

export function assertDurableCoreBoundaryProof(
  candidate: unknown,
  options: { readonly revision?: string; readonly runId?: string } = {},
): asserts candidate is DurableCoreBoundaryProof {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("DURABLE_CORE_PROOF_INVALID_ROOT");
  }
  const proof = assertClosedRecord(
    candidate,
    "proof",
    [
      "kind",
      "revision",
      "configuration",
      "runId",
      "effectKey",
      "checkpoint",
      "restart",
      "terminal",
      "artifact",
      "observations",
    ],
    ["replacementAttempt", "secondCheckpoint"],
  );
  if (proof.kind !== "worker" && proof.kind !== "engine") {
    throw new Error("DURABLE_CORE_PROOF_INVALID_KIND");
  }
  if (typeof proof.revision !== "string" || !REVISION.test(proof.revision)) {
    throw new Error("DURABLE_CORE_PROOF_INVALID_REVISION");
  }
  if (options.revision !== undefined && proof.revision !== options.revision) {
    throw new Error("DURABLE_CORE_PROOF_REVISION_MISMATCH");
  }
  for (const field of ["runId", "effectKey"] as const) {
    if (typeof proof[field] !== "string") {
      throw new Error(`DURABLE_CORE_PROOF_INVALID_${field.toUpperCase()}`);
    }
    assertRealIdentity(proof[field], field);
  }
  assertUuid(proof.runId as string, "run_id");
  if (options.runId !== undefined && proof.runId !== options.runId) {
    throw new Error("DURABLE_CORE_PROOF_RUN_ID_MISMATCH");
  }

  const config = assertClosedRecord(
    proof.configuration,
    "configuration",
    ["project", "ports"],
  );
  if (
    typeof config.project !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.project)
  ) {
    throw new Error("DURABLE_CORE_PROOF_INVALID_PROJECT");
  }
  assertPorts(config.ports);

  const checkpointRecord = assertClosedRecord(
    proof.checkpoint,
    "checkpoint",
    [
      "attemptId",
      "jobId",
      "runId",
      "runStepId",
      "fence",
      "workerSessionId",
      "workerSessionGeneration",
      "eventId",
      "localSeq",
      "ackedLocalSeq",
      "artifactRef",
    ],
  );
  for (
    const field of [
      "attemptId",
      "jobId",
      "runId",
      "runStepId",
      "fence",
      "workerSessionId",
      "workerSessionGeneration",
      "eventId",
    ] as const
  ) {
    if (typeof checkpointRecord[field] !== "string") {
      throw new Error(
        `DURABLE_CORE_PROOF_INVALID_CHECKPOINT_${field.toUpperCase()}`,
      );
    }
    assertRealIdentity(checkpointRecord[field], `checkpoint_${field}`);
  }
  for (
    const field of ["attemptId", "jobId", "runId", "runStepId"] as const
  ) {
    assertUuid(
      checkpointRecord[field] as string,
      `checkpoint_${field}`,
    );
  }
  assertUuid(
    checkpointRecord.workerSessionId as string,
    "checkpoint_worker_session_id",
  );
  const checkpointGeneration = assertFence(
    checkpointRecord.workerSessionGeneration as string,
    "checkpoint_worker_session_generation",
  );
  assertUuid(checkpointRecord.eventId as string, "checkpoint_event_id");
  if (
    checkpointRecord.localSeq !== "3" ||
    checkpointRecord.ackedLocalSeq !== "3"
  ) {
    throw new Error("DURABLE_CORE_PROOF_CHECKPOINT_SEQUENCE_INVALID");
  }
  assertArtifactRef(checkpointRecord.artifactRef, "checkpoint_artifact_ref");
  const checkpointFence = assertFence(
    checkpointRecord.fence as string,
    "checkpoint_fence",
  );
  let replacementAttemptRecord: Record<string, unknown> | undefined;
  let replacementCheckpointRecord: Record<string, unknown> | undefined;
  if (proof.kind === "worker") {
    const replacement = proof.replacementAttempt;
    if (
      !replacement || typeof replacement !== "object" ||
      Array.isArray(replacement)
    ) {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_ATTEMPT_MISSING");
    }
    replacementAttemptRecord = assertClosedRecord(
      replacement,
      "replacement_attempt",
      [
        "attemptId",
        "fence",
        "workerSessionId",
        "workerSessionGeneration",
        "checkpointEventId",
        "checkpointLocalSeq",
      ],
    );
    for (
      const field of [
        "attemptId",
        "fence",
        "workerSessionId",
        "workerSessionGeneration",
        "checkpointEventId",
        "checkpointLocalSeq",
      ] as const
    ) {
      if (typeof replacementAttemptRecord[field] !== "string") {
        throw new Error(
          `DURABLE_CORE_PROOF_INVALID_REPLACEMENT_${field.toUpperCase()}`,
        );
      }
      assertRealIdentity(
        replacementAttemptRecord[field],
        `replacement_${field}`,
      );
    }
    if (replacementAttemptRecord.checkpointLocalSeq !== "3") {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_SEQUENCE_INVALID");
    }
    assertUuid(
      replacementAttemptRecord.attemptId as string,
      "replacement_attempt_id",
    );
    assertUuid(
      replacementAttemptRecord.workerSessionId as string,
      "replacement_worker_session_id",
    );
    assertUuid(
      replacementAttemptRecord.checkpointEventId as string,
      "replacement_checkpoint_event",
    );
    const replacementGeneration = assertFence(
      replacementAttemptRecord.workerSessionGeneration as string,
      "replacement_worker_session_generation",
    );
    const replacementFence = assertFence(
      replacementAttemptRecord.fence as string,
      "replacement_fence",
    );
    if (replacementFence <= checkpointFence) {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_FENCE_NOT_INCREASED");
    }
    if (replacementAttemptRecord.attemptId === checkpointRecord.attemptId) {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_ATTEMPT_NOT_NEW");
    }
    if (
      replacementAttemptRecord.workerSessionId ===
        checkpointRecord.workerSessionId ||
      replacementGeneration <= checkpointGeneration
    ) {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_SESSION_NOT_NEW");
    }
    if (
      replacementAttemptRecord.checkpointEventId === checkpointRecord.eventId
    ) {
      throw new Error("DURABLE_CORE_PROOF_REPLACEMENT_EVENT_NOT_NEW");
    }

    replacementCheckpointRecord = assertClosedRecord(
      proof.secondCheckpoint,
      "second_checkpoint",
      [
        "attemptId",
        "eventId",
        "localSeq",
        "ackedLocalSeq",
        "artifactRef",
      ],
    );
    for (const field of ["attemptId", "eventId"] as const) {
      if (typeof replacementCheckpointRecord[field] !== "string") {
        throw new Error(
          `DURABLE_CORE_PROOF_INVALID_SECOND_CHECKPOINT_${field.toUpperCase()}`,
        );
      }
      assertUuid(
        replacementCheckpointRecord[field] as string,
        `second_checkpoint_${field}`,
      );
    }
    if (
      replacementCheckpointRecord.localSeq !== "3" ||
      replacementCheckpointRecord.ackedLocalSeq !== "3"
    ) {
      throw new Error(
        "DURABLE_CORE_PROOF_SECOND_CHECKPOINT_SEQUENCE_INVALID",
      );
    }
    if (
      replacementCheckpointRecord.attemptId !==
        replacementAttemptRecord.attemptId
    ) {
      throw new Error("DURABLE_CORE_PROOF_SECOND_CHECKPOINT_ATTEMPT_MISMATCH");
    }
    if (
      replacementCheckpointRecord.eventId !==
        replacementAttemptRecord.checkpointEventId
    ) {
      throw new Error("DURABLE_CORE_PROOF_SECOND_CHECKPOINT_EVENT_MISMATCH");
    }
    assertArtifactRef(
      replacementCheckpointRecord.artifactRef,
      "second_checkpoint_artifact_ref",
    );
    const firstRef = checkpointRecord.artifactRef as DurableCoreArtifactRef;
    const secondRef = replacementCheckpointRecord
      .artifactRef as DurableCoreArtifactRef;
    if (
      secondRef.artifactId !== firstRef.artifactId ||
      secondRef.versionId !== firstRef.versionId ||
      secondRef.sha256 !== firstRef.sha256
    ) {
      throw new Error(
        "DURABLE_CORE_PROOF_SECOND_CHECKPOINT_ARTIFACT_MISMATCH",
      );
    }
  } else if (
    proof.replacementAttempt !== undefined ||
    proof.secondCheckpoint !== undefined
  ) {
    throw new Error("DURABLE_CORE_PROOF_ENGINE_REPLACEMENT_UNEXPECTED");
  }

  const restart = proof.restart;
  if (!restart || typeof restart !== "object") {
    throw new Error("DURABLE_CORE_PROOF_INVALID_RESTART");
  }
  const restartRecord = assertClosedRecord(
    proof.restart,
    "restart",
    ["service", "beforeProcessId", "afterProcessId"],
  );
  const expectedService = proof.kind === "worker" ? "worker" : "inngest";
  if (restartRecord.service !== expectedService) {
    throw new Error("DURABLE_CORE_PROOF_RESTART_SERVICE_MISMATCH");
  }
  for (const field of ["beforeProcessId", "afterProcessId"] as const) {
    if (typeof restartRecord[field] !== "string") {
      throw new Error(
        `DURABLE_CORE_PROOF_INVALID_RESTART_${field.toUpperCase()}`,
      );
    }
    assertProcessIdentity(restartRecord[field], `restart_${field}`);
  }
  if (restartRecord.beforeProcessId === restartRecord.afterProcessId) {
    throw new Error("DURABLE_CORE_PROOF_PROCESS_IDENTITY_UNCHANGED");
  }

  const terminal = proof.terminal;
  if (!terminal || typeof terminal !== "object") {
    throw new Error("DURABLE_CORE_PROOF_INVALID_TERMINAL");
  }
  const terminalRecord = assertClosedRecord(
    proof.terminal,
    "terminal",
    [
      "attemptId",
      "eventId",
      "taskId",
      "jobId",
      "taskStatus",
      "runId",
      "runStatus",
      "runStepId",
      "runStepStatus",
      "terminalTaskCount",
      "terminalRunCount",
      "terminalStepCount",
      "acceptedCount",
      "effectCount",
      "artifactCount",
    ],
  );
  for (
    const field of [
      "attemptId",
      "eventId",
      "taskId",
      "jobId",
      "runId",
      "runStepId",
    ] as const
  ) {
    if (typeof terminalRecord[field] !== "string") {
      throw new Error(
        `DURABLE_CORE_PROOF_INVALID_TERMINAL_${field.toUpperCase()}`,
      );
    }
    assertUuid(terminalRecord[field], `terminal_${field}`);
  }
  if (terminalRecord.taskStatus !== "completed") {
    throw new Error("DURABLE_CORE_PROOF_TERMINAL_TASK_STATUS_INVALID");
  }
  if (terminalRecord.runStatus !== "completed") {
    throw new Error("DURABLE_CORE_PROOF_TERMINAL_RUN_STATUS_INVALID");
  }
  if (terminalRecord.runStepStatus !== "completed") {
    throw new Error("DURABLE_CORE_PROOF_TERMINAL_STEP_STATUS_INVALID");
  }
  if (terminalRecord.runId !== proof.runId) {
    throw new Error("DURABLE_CORE_PROOF_TERMINAL_RUN_ID_MISMATCH");
  }
  if (checkpointRecord.runId !== proof.runId) {
    throw new Error("DURABLE_CORE_PROOF_CHECKPOINT_RUN_ID_MISMATCH");
  }
  if (checkpointRecord.runStepId !== terminalRecord.runStepId) {
    throw new Error("DURABLE_CORE_PROOF_CHECKPOINT_RUN_STEP_ID_MISMATCH");
  }
  if (checkpointRecord.jobId !== terminalRecord.jobId) {
    throw new Error("DURABLE_CORE_PROOF_CHECKPOINT_JOB_ID_MISMATCH");
  }
  for (
    const field of [
      "terminalTaskCount",
      "terminalRunCount",
      "terminalStepCount",
      "acceptedCount",
      "effectCount",
      "artifactCount",
    ] as const
  ) {
    if (terminalRecord[field] !== 1) {
      throw new Error(`DURABLE_CORE_PROOF_${field.toUpperCase()}_INVALID`);
    }
  }
  const expectedTerminalAttemptId = replacementAttemptRecord?.attemptId ??
    checkpointRecord.attemptId;
  if (terminalRecord.attemptId !== expectedTerminalAttemptId) {
    throw new Error("DURABLE_CORE_PROOF_ATTEMPT_ID_MISMATCH");
  }

  const artifact = proof.artifact;
  if (!artifact || typeof artifact !== "object") {
    throw new Error("DURABLE_CORE_PROOF_INVALID_ARTIFACT");
  }
  const artifactRecord = assertClosedRecord(
    proof.artifact,
    "artifact",
    ["ref", "sha256", "verifiedSha256"],
  );
  assertArtifactRef(artifactRecord.ref, "artifact_ref");
  for (const field of ["sha256", "verifiedSha256"] as const) {
    if (typeof artifactRecord[field] !== "string") {
      throw new Error(
        `DURABLE_CORE_PROOF_INVALID_ARTIFACT_${field.toUpperCase()}`,
      );
    }
    assertDigest(artifactRecord[field] as string, `artifact_${field}`);
  }
  const checkpointRef = checkpointRecord.artifactRef as DurableCoreArtifactRef;
  const artifactRef = artifactRecord.ref as DurableCoreArtifactRef;
  if (
    artifactRef.artifactId !== checkpointRef.artifactId ||
    artifactRef.versionId !== checkpointRef.versionId ||
    artifactRef.sha256 !== checkpointRef.sha256 ||
    artifactRecord.sha256 !== artifactRecord.verifiedSha256 ||
    artifactRecord.sha256 !== artifactRef.sha256
  ) {
    throw new Error("DURABLE_CORE_PROOF_ARTIFACT_DIGEST_MISMATCH");
  }

  const observations = proof.observations;
  if (
    !observations || typeof observations !== "object" ||
    Array.isArray(observations)
  ) {
    throw new Error("DURABLE_CORE_PROOF_INVALID_OBSERVATIONS");
  }
  const observationRecord = assertClosedRecord(
    proof.observations,
    "observations",
    proof.kind === "engine"
      ? [
        "journalBefore",
        "journalAfter",
        "spoolBefore",
        "spoolAfter",
        "engineBefore",
        "engineAfter",
      ]
      : ["journalBefore", "journalAfter", "spoolBefore", "spoolAfter"],
  );
  const proofIdentity = {
    runId: proof.runId as string,
    checkpoint: {
      attemptId: checkpointRecord.attemptId as string,
      eventId: checkpointRecord.eventId as string,
    },
  };

  const allowedAttemptIds = new Set(
    [
      checkpointRecord.attemptId,
      replacementAttemptRecord?.attemptId,
      replacementCheckpointRecord?.attemptId,
    ].filter((value): value is string => value !== undefined),
  );
  const allowedEventIds = new Set(
    [
      checkpointRecord.eventId,
      replacementAttemptRecord?.checkpointEventId,
      replacementCheckpointRecord?.eventId,
    ].filter((value): value is string => typeof value === "string"),
  );
  for (
    const field of [
      "journalBefore",
      "journalAfter",
      "spoolBefore",
      "spoolAfter",
    ] as const
  ) {
    assertObservation(
      observationRecord[field],
      field,
      allowedAttemptIds,
      allowedEventIds,
      proof.kind === "engine" || field === "spoolBefore" ||
        field.endsWith("After"),
    );
  }
  if (proof.kind === "engine") {
    const engineBefore = observationRecord.engineBefore;
    const engineAfter = observationRecord.engineAfter as
      | DurableCoreEngineRecoveryObservation
      | undefined;
    assertEngineObservation(engineBefore, "engineBefore", proofIdentity);
    assertEngineObservation(engineAfter, "engineAfter", proofIdentity);
    if (
      engineBefore.processId !== restartRecord.beforeProcessId ||
      engineAfter.processId !== restartRecord.afterProcessId ||
      engineBefore.processId === engineAfter.processId
    ) {
      throw new Error("DURABLE_CORE_PROOF_ENGINE_PROCESS_IDENTITY_MISMATCH");
    }
    for (
      const field of [
        "runId",
        "organizationId",
        "outboxStatus",
        "engineEventId",
        "checkpointAttemptId",
        "checkpointEventId",
        "checkpointLocalSeq",
        "checkpointAckedLocalSeq",
      ] as const
    ) {
      if (engineBefore[field] !== engineAfter[field]) {
        throw new Error(
          `DURABLE_CORE_PROOF_ENGINE_${field.toUpperCase()}_CHANGED`,
        );
      }
    }
    if (
      engineAfter.functionRunId === engineBefore.functionRunId ||
      engineAfter.functionEventId === engineBefore.functionEventId ||
      engineAfter.functionEventInternalId ===
        engineBefore.functionEventInternalId
    ) {
      throw new Error(
        "DURABLE_CORE_PROOF_ENGINE_FUNCTION_INVOCATION_NOT_NEW",
      );
    }
    if (
      engineAfter.recoveryFunctionRunId !== engineAfter.functionRunId ||
      engineAfter.recoveryFunctionEventId !== engineAfter.functionEventId ||
      engineAfter.recoveryFunctionDefinitionId !==
        engineAfter.functionDefinitionId
    ) {
      throw new Error(
        "DURABLE_CORE_PROOF_ENGINE_RECOVERY_FUNCTION_MISMATCH",
      );
    }
    if (
      BigInt(engineAfter.engineOwnerGeneration) <=
        BigInt(engineBefore.engineOwnerGeneration)
    ) {
      throw new Error(
        "DURABLE_CORE_PROOF_ENGINE_OWNER_GENERATION_NOT_INCREASED",
      );
    }
    if (
      engineAfter.recoveryMode === "reconciliation" &&
      (
        engineAfter.recoveryEventId === engineBefore.engineEventId ||
        engineAfter.recoveryEventId === engineBefore.functionEventId ||
        engineAfter.recoveryEventId === engineAfter.functionEventId ||
        engineAfter.recoveryEventInternalId ===
          engineAfter.functionEventInternalId
      )
    ) {
      throw new Error("DURABLE_CORE_PROOF_ENGINE_RECOVERY_NOT_NEW");
    }
    const beforeObservedAt = Date.parse(engineBefore.observedAt);
    const afterObservedAt = Date.parse(engineAfter.observedAt);
    const recoveryStartedAt = Date.parse(
      engineAfter.recoveryFunctionRunStartedAt,
    );
    if (
      afterObservedAt <= beforeObservedAt ||
      recoveryStartedAt <= beforeObservedAt ||
      recoveryStartedAt > afterObservedAt
    ) {
      throw new Error("DURABLE_CORE_PROOF_ENGINE_OBSERVATION_ORDER_INVALID");
    }
  } else if (
    observationRecord.engineBefore !== undefined ||
    observationRecord.engineAfter !== undefined
  ) {
    throw new Error("DURABLE_CORE_PROOF_WORKER_ENGINE_OBSERVATION_UNEXPECTED");
  }
  const spoolBefore = observationRecord.spoolBefore as
    | DurableCoreSpoolObservation
    | undefined;
  const spoolAfter = observationRecord.spoolAfter as
    | DurableCoreSpoolObservation
    | undefined;
  if (
    !spoolBefore ||
    spoolBefore.spoolState !== "present" ||
    spoolBefore.checkpointAckedLocalSeq !== "3"
  ) {
    throw new Error("DURABLE_CORE_PROOF_SPOOL_BEFORE_NOT_PERSISTED");
  }
  if (!spoolAfter || spoolAfter.spoolState !== "absent") {
    throw new Error("DURABLE_CORE_PROOF_SPOOL_AFTER_NOT_ABSENT");
  }
}

/**
 * Only supplied references are checked here; this helper never invents
 * rejection or success evidence.
 */
export async function assertDurableCoreAuditLinks(
  query: DurableCoreQuery,
  cases: readonly DurableCoreCase[],
  expectations: Readonly<Record<string, DurableCoreAuditExpectation>> = {},
): Promise<void> {
  if (cases.length > MAX_CASES) {
    throw new Error("DURABLE_CORE_EVIDENCE_CASE_LIMIT");
  }
  for (const candidate of cases) assertCaseShape(candidate);

  for (const candidate of cases) {
    if (candidate.auditRefs.length === 0) continue;
    const expected = expectations[candidate.name];
    if (!expected) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_AUDIT_EXPECTATION_MISSING:${candidate.name}`,
      );
    }
    const rows = await query<AuditRow>(
      `select id,
              organization_id as "organizationId",
              resource_type as "resourceType",
              resource_id as "resourceId",
              operation,
              outcome,
              request_id as "requestId",
              trace_id as "traceId"
         from bakery.audit_events
        where id = any($1::uuid[])`,
      [candidate.auditRefs.map((ref) => ref.id)],
    );
    if (rows.length !== candidate.auditRefs.length) {
      throw new Error(
        `DURABLE_CORE_EVIDENCE_AUDIT_REFERENCE_MISSING:${candidate.name}`,
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const ref of candidate.auditRefs) {
      const row = byId.get(ref.id);
      if (
        !row ||
        row.id !== ref.id ||
        row.organizationId !== ref.organizationId ||
        row.resourceType !== ref.resourceType ||
        row.resourceId !== ref.resourceId ||
        row.operation !== ref.operation ||
        row.outcome !== ref.outcome ||
        row.requestId !== ref.requestId ||
        row.traceId !== ref.traceId ||
        row.organizationId !== expected.organizationId ||
        row.resourceType !== expected.resourceType ||
        row.resourceId !== expected.resourceId ||
        row.operation !== expected.operation ||
        row.outcome !== expected.outcome
      ) {
        throw new Error(
          `DURABLE_CORE_EVIDENCE_AUDIT_REFERENCE_MISMATCH:${candidate.name}`,
        );
      }
    }
  }
}
