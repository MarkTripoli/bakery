import { z } from "zod";
import {
  CHECK_KINDS,
  CHECK_OBSERVATION_MAX_ITEMS,
  CHECK_REASONS,
  CHECK_RESULTS,
  type CheckReason,
  deriveCheckVerdict,
  isCoherentCheckOutcome,
} from "@bakery/contracts/check-evidence";
import { StandardError } from "@bakery/contracts/http";
import { REPOSITORY_RULE_KEYS } from "@bakery/contracts/repository-rules";
import {
  CHECK_POLICY_MISSING_REASON,
  type CheckPins,
  type CommandPin,
} from "./check-pins.ts";
import { DigestSchema, nullable } from "./identity.ts";

/**
 * The worker's `quality.check` report as the server reads it, and the rules a
 * report must satisfy before any row is written. The registry already parsed
 * the wire shape; this parse gives typed access and fails closed if the two
 * ever disagree. Nothing in a report is an identity the server believes: the
 * server derives every identity from the job's own pins and only compares.
 */

/** `VALIDATION_FAILED` reason: the report contradicts what the server derived. */
export const CHECK_OUTPUT_MISMATCH_REASON = "check_output_mismatch";
/** `VALIDATION_FAILED` reason: an evidence reference is not the step's own. */
export const CHECK_EVIDENCE_INVALID_REASON = "check_evidence_invalid";

/** Longest process time one observation can report: the contract's one day. */
export const CHECK_DURATION_MAX_MS = 86_400_000;

/**
 * The reasons a worker can give for a command. The metadata reasons
 * (`rule_violation`, `metadata_missing`, ...) and the lifecycle reasons
 * (`awaiting_result`, `canceled`) never describe an executed command, so a
 * report carrying one is refused. `skipped` is accepted for a command the
 * worker did not start because its attempt budget was spent: it is
 * `unavailable`, carries no exit code and no duration, and blocks a required
 * check like any other missing evidence. A worker that claims it for a command
 * it could have run gains nothing: no unavailable result ever satisfies a
 * required check.
 */
export const COMMAND_CHECK_REASONS: readonly CheckReason[] = Object.freeze([
  "verified",
  "exit_nonzero",
  "signal",
  "deadline",
  "output_limit",
  "tool_missing",
  "unsupported_checker",
  "revision_unavailable",
  "rule_binding_ambiguous",
  "skipped",
]);

const ReportEvidenceSchema = z.object({
  artifactId: z.uuid().describe(
    "Artifact that holds the captured output of one check.",
  ),
  versionId: z.uuid().describe(
    "Immutable version of that artifact; recorded as the row's evidence.",
  ),
  sha256: DigestSchema.describe(
    "Content digest of that version; it must equal the observation's outputDigest.",
  ),
}).strict().describe(
  "Immutable reference to the evidence artifact version of one observation.",
);

const ReportObservationSchema = z.object({
  checkRunId: z.uuid().describe(
    "Row id the worker generated; it becomes the check_runs id and may never repeat.",
  ),
  checkId: z.string().min(1).max(100).describe(
    "Fixed policy command this observation belongs to.",
  ),
  kind: z.enum(CHECK_KINDS).describe(
    "What was checked; a worker observation is always a command.",
  ),
  ruleKey: nullable(
    z.enum(REPOSITORY_RULE_KEYS).describe("A repository rule key."),
    "no single enabled pinned rule binds the command.",
  ),
  result: z.enum(CHECK_RESULTS).describe("Observed outcome of the command."),
  reason: z.enum(CHECK_REASONS).describe("Why the command has that outcome."),
  exitCode: nullable(
    z.number().int().min(0).max(255).describe("Process exit code."),
    "the process produced no exit status.",
  ),
  durationMs: z.number().int().min(0).max(CHECK_DURATION_MAX_MS).describe(
    "Wall-clock milliseconds the command ran; zero when it never started.",
  ),
  outputDigest: nullable(
    DigestSchema.describe("SHA-256 of the captured output bytes."),
    "no output was captured.",
  ),
  evidence: nullable(
    ReportEvidenceSchema,
    "no evidence artifact was published.",
  ),
}).strict().describe("One worker-reported observation of a fixed command.");

export const CheckReportSchema = z.object({
  allRequired: z.boolean().describe(
    "The worker's claim that every required command passed; the server recomputes it.",
  ),
  checkRunIds: z.array(z.uuid().describe("One reported row id.")).min(1).max(
    CHECK_OBSERVATION_MAX_ITEMS,
  ).describe("Row ids of the observations, in observation order."),
  failedCheckIds: z.array(z.uuid().describe("One failed required row id."))
    .max(CHECK_OBSERVATION_MAX_ITEMS).describe(
      "Row ids of required observations that did not pass, as the worker computed them.",
    ),
  observations: z.array(ReportObservationSchema).min(1).max(
    CHECK_OBSERVATION_MAX_ITEMS,
  ).describe("One observation per selected command, in input order."),
  headSha: z.string().min(1).describe("Commit the worker says it tested."),
  baseSha: z.string().min(1).describe("Base commit the worker says it echoed."),
  policyDigest: z.string().min(1).describe(
    "Effective policy digest the worker says it ran under.",
  ),
}).strict().describe(
  "A quality.check result as reported by the worker; every field is a claim.",
);

export type CheckReport = z.output<typeof CheckReportSchema>;
export type CheckReportObservation = CheckReport["observations"][number];

function reject(reason: string): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason },
  });
}

function mismatch(): never {
  return reject(CHECK_OUTPUT_MISMATCH_REASON);
}

/** Parses a result payload into a report, or refuses it as a mismatch. */
export function parseCheckReport(payload: unknown): CheckReport {
  const parsed = CheckReportSchema.safeParse(payload);
  if (!parsed.success) mismatch();
  return parsed.data;
}

/**
 * Decides the verdict of a report from its observations and the fixed policy
 * decisions. An empty decision list is a missing policy, never a delivery with
 * nothing to enforce: `deriveCheckVerdict` answers `allRequired: true` for
 * empty input, so the list is checked before it is asked.
 */
export function expectedVerdict(
  observations: ReadonlyArray<
    {
      checkRunId: string;
      checkId: string;
      result: CheckReportObservation["result"];
    }
  >,
  decisions: CheckPins["decisions"] | null | undefined,
) {
  if (!decisions || decisions.length === 0) {
    reject(CHECK_POLICY_MISSING_REASON);
  }
  return deriveCheckVerdict(observations, decisions);
}

/**
 * True when the observation is something a process that really ran, or one the
 * worker could not run, can produce. `passed` needs exit code 0 and `verified`;
 * `failed` never carries `verified`; `unavailable` carries no exit code and no
 * duration; a process reason other than `exit_nonzero` carries no exit code.
 */
function observationIsCoherent(
  observation: CheckReportObservation,
  pin: CommandPin,
): boolean {
  const { result, reason, exitCode, durationMs } = observation;
  if (
    observation.kind !== "command" ||
    !COMMAND_CHECK_REASONS.includes(reason) ||
    !(result === "passed" || result === "failed" || result === "unavailable") ||
    !isCoherentCheckOutcome(result, reason)
  ) return false;
  if (result === "passed") {
    if (exitCode !== 0 || reason !== "verified") return false;
  } else if (result === "failed") {
    if (reason === "verified") return false;
    if (reason === "exit_nonzero" ? exitCode === 0 : exitCode !== null) {
      return false;
    }
  } else if (exitCode !== null || durationMs !== 0) return false;
  // The binding is a pin: the report names the one enabled rule the server
  // found, or none; two rules on one command can only be unavailable. An
  // unreachable revision wins over that per-command property (see
  // `verifyCheckReport`), so the ambiguous pin also accepts it.
  if (observation.ruleKey !== pin.ruleKey) return false;
  if (pin.ambiguous) {
    return result === "unavailable" &&
      (reason === "rule_binding_ambiguous" ||
        reason === "revision_unavailable");
  }
  if (reason === "rule_binding_ambiguous") return false;
  if (reason === "unsupported_checker" && pin.ruleKey === null) return false;
  return true;
}

/**
 * Verifies a report against the pins and the attempt window. Pure: throws
 * `VALIDATION_FAILED` and writes nothing. `windowMs` is how long the attempt
 * has existed on the server clock; commands run one after the other inside it,
 * so their durations cannot add up to more.
 */
export function verifyCheckReport(
  report: CheckReport,
  pins: CheckPins,
  windowMs: number,
): void {
  const { observations } = report;
  // Exact selection, in input order: no extra, missing, duplicate or foreign id.
  if (
    observations.length !== pins.commands.length ||
    observations.some((observation, index) =>
      observation.checkId !== pins.commands[index]!.checkId
    )
  ) mismatch();
  const ids = observations.map(({ checkRunId }) => checkRunId);
  if (
    new Set(ids).size !== ids.length ||
    report.checkRunIds.length !== ids.length ||
    report.checkRunIds.some((id, index) => id !== ids[index])
  ) mismatch();
  // Precedence shared with the worker (`executeCheck` in check-runner.ts): the
  // worker tries the checkout before it plans any command, so an unreachable
  // revision is a property of the whole attempt and wins over every
  // per-command reason, `rule_binding_ambiguous` included. A report therefore
  // carries `revision_unavailable` for every command or for none; a mixture is
  // something no worker produces.
  const unreachable =
    observations.filter(({ reason }) => reason === "revision_unavailable")
      .length;
  if (unreachable !== 0 && unreachable !== observations.length) mismatch();
  let total = 0;
  const versions = new Set<string>();
  observations.forEach((observation, index) => {
    if (!observationIsCoherent(observation, pins.commands[index]!)) mismatch();
    total += observation.durationMs;
    const { evidence, outputDigest } = observation;
    if (
      evidence === null || outputDigest === null ||
      evidence.sha256 !== outputDigest || versions.has(evidence.versionId)
    ) reject(CHECK_EVIDENCE_INVALID_REASON);
    versions.add(evidence.versionId);
  });
  if (!Number.isFinite(windowMs) || total > windowMs) mismatch();
  const verdict = expectedVerdict(observations, pins.decisions);
  if (
    report.allRequired !== verdict.allRequired ||
    report.failedCheckIds.length !== verdict.failedCheckIds.length ||
    report.failedCheckIds.some((id, index) =>
      id !== verdict.failedCheckIds[index]
    ) ||
    report.headSha !== pins.headSha || report.baseSha !== pins.baseSha ||
    report.policyDigest !== pins.policyDigest
  ) mismatch();
}
