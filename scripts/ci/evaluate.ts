export type LaneStatus =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "missing";

export type ArtifactVerifier =
  | "runtime-manifest"
  | "paper-comparison"
  | "enterprise-runtime-manifest"
  | "enterprise-paper-comparison";

export type ArtifactPolicy = {
  readonly path: string;
  readonly verify: ArtifactVerifier;
};

const artifactVerifiers: readonly string[] = [
  "runtime-manifest",
  "paper-comparison",
  "enterprise-runtime-manifest",
  "enterprise-paper-comparison",
];

export type LanePolicy = {
  readonly lane: string;
  readonly job: string;
  /**
   * Whether a pull request run must execute this lane. A pull request gets the
   * bounded fast gate; the heavy evidence lanes run on main pushes, the nightly
   * schedule and manual dispatch. Omitted means `true`: an unmarked lane is
   * required everywhere, so a new heavy lane that forgets the flag fails the
   * pull request loudly instead of silently dropping out of the gate.
   */
  readonly pullRequestRequired?: boolean;
  readonly artifacts: readonly ArtifactPolicy[];
};

export type RequiredChecksPolicy = {
  readonly workflow: string;
  readonly workflowPath: string;
  readonly aggregateJob: string;
  readonly dependencies: string;
  readonly lanes: readonly LanePolicy[];
};

const invalidPolicy = () => new Error("policy: invalid required-checks policy");

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const positiveRunAttempt = (value: string): bigint | null => {
  if (!/^\d+$/.test(value)) return null;
  const attempt = BigInt(value);
  return attempt > 0n ? attempt : null;
};

const isValidArtifactPath = (path: unknown): path is string =>
  isNonEmptyString(path) && !path.startsWith("/") &&
  !path.split("/").includes("..");

export function parsePolicy(text: string): RequiredChecksPolicy {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalidPolicy();
  }
  if (typeof document !== "object" || document === null) throw invalidPolicy();
  const candidate = document as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.workflow) ||
    !isNonEmptyString(candidate.workflowPath) ||
    !isNonEmptyString(candidate.aggregateJob) ||
    !isNonEmptyString(candidate.dependencies) ||
    !Array.isArray(candidate.lanes) || candidate.lanes.length === 0
  ) {
    throw invalidPolicy();
  }
  const lanes: LanePolicy[] = [];
  const seenLanes = new Set<string>();
  const seenJobs = new Set<string>();
  for (const entry of candidate.lanes) {
    if (typeof entry !== "object" || entry === null) throw invalidPolicy();
    const lane = entry as Record<string, unknown>;
    if (
      !isNonEmptyString(lane.lane) || !isNonEmptyString(lane.job) ||
      !Array.isArray(lane.artifacts) ||
      (lane.pullRequestRequired !== undefined &&
        typeof lane.pullRequestRequired !== "boolean")
    ) {
      throw invalidPolicy();
    }
    if (seenLanes.has(lane.lane) || seenJobs.has(lane.job)) {
      throw invalidPolicy();
    }
    seenLanes.add(lane.lane);
    seenJobs.add(lane.job);
    const artifacts: ArtifactPolicy[] = [];
    for (const artifactEntry of lane.artifacts) {
      if (typeof artifactEntry !== "object" || artifactEntry === null) {
        throw invalidPolicy();
      }
      const artifact = artifactEntry as Record<string, unknown>;
      if (
        !isValidArtifactPath(artifact.path) ||
        typeof artifact.verify !== "string" ||
        !artifactVerifiers.includes(artifact.verify)
      ) {
        throw invalidPolicy();
      }
      artifacts.push({
        path: artifact.path as string,
        verify: artifact.verify as ArtifactVerifier,
      });
    }
    lanes.push({
      lane: lane.lane,
      job: lane.job,
      pullRequestRequired: lane.pullRequestRequired !== false,
      artifacts,
    });
  }
  return {
    workflow: candidate.workflow,
    workflowPath: candidate.workflowPath,
    aggregateJob: candidate.aggregateJob,
    dependencies: candidate.dependencies,
    lanes,
  };
}

export function evaluateRequiredLanes(
  lanes: Record<string, LaneStatus | undefined>,
  required: readonly string[],
): { ok: boolean; failures: string[] } {
  const failures = required.filter((name) => lanes[name] !== "success");
  return { ok: failures.length === 0, failures };
}

/**
 * What a lane's job must report for the run that produced the evidence. A
 * pull request runs the fast gate, so a lane that is not pull-request required
 * must be absent from it — reported as `skipped`, and *only* `skipped`: a
 * heavy lane that still ran (or failed, or vanished) on a pull request is a
 * routing bug, not a pass.
 */
export function expectedLaneStatus(
  lane: LanePolicy,
  event: string | undefined,
): LaneStatus {
  if (lane.pullRequestRequired !== false) return "success";
  return event === "pull_request" ? "skipped" : "success";
}

export function evaluateLaneExpectations(
  lanes: Record<string, LaneStatus | undefined>,
  policy: RequiredChecksPolicy,
  event: string | undefined,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const lane of policy.lanes) {
    const expected = expectedLaneStatus(lane, event);
    const actual = lanes[lane.lane];
    if (actual !== expected) {
      failures.push(
        `${lane.lane}: expected ${expected}, observed ${actual ?? "missing"}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

export async function evaluateEvidence(
  directory: string,
  required: readonly string[],
  candidateSha: string,
  baseSha: string,
  workflowSha: string,
  runId: string,
  runAttempt: string,
  dependencies: string,
): Promise<string[]> {
  const failures: string[] = [];
  if (required.length === 0) return ["required lane set is empty"];
  if (
    !candidateSha.trim() || !baseSha.trim() || !workflowSha.trim() ||
    !runId.trim() || !runAttempt.trim() || !dependencies.trim()
  ) {
    return ["candidate, base, workflow, and run identity are required"];
  }
  const currentAttempt = positiveRunAttempt(runAttempt);
  for (const lane of required) {
    const path = `${directory}/${lane}.txt`;
    const text = await Deno.readTextFile(path).catch(() => "");
    const values = new Map<string, string>();
    let duplicate = false;
    for (const line of text.split("\n")) {
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      if (values.has(key)) duplicate = true;
      values.set(key, line.slice(separator + 1));
    }
    const evidenceAttempt = values.get("run_attempt");
    const embeddedAttempt = evidenceAttempt === undefined
      ? null
      : positiveRunAttempt(evidenceAttempt);
    if (
      duplicate || values.get("lane") !== lane ||
      values.get("candidate_sha") !== candidateSha ||
      values.get("base_sha") !== baseSha ||
      values.get("workflow_sha") !== workflowSha ||
      values.get("run_id") !== runId ||
      currentAttempt === null || embeddedAttempt === null ||
      embeddedAttempt > currentAttempt ||
      values.get("dependencies") !== dependencies ||
      !values.get("command")?.trim() || !values.get("test_cases")?.trim() ||
      !values.get("coverage")?.trim() ||
      !values.get("artifacts")?.trim() ||
      values.get("redacted") !== "true"
    ) {
      failures.push(`${lane}: missing or candidate-mismatched evidence`);
      continue;
    }
    if (values.get("exit_code") !== "0") {
      failures.push(`${lane}: nonzero exit code`);
    }
  }
  return failures;
}

const parseArtifactDeclaration = (
  declaration: string,
): Map<string, string> | null => {
  const entries = new Map<string, string>();
  for (const item of declaration.split(",")) {
    const separator = item.lastIndexOf(":");
    if (separator < 1) return null;
    const path = item.slice(0, separator);
    const digest = item.slice(separator + 1);
    if (!path || entries.has(path)) return null;
    entries.set(path, digest);
  }
  return entries;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

// Terminal result statuses a passing Paper comparison may carry. Deliberately
// restated here rather than imported from packages/ui/scripts/compare-paper.mjs:
// this evaluator is the independent reader of the candidate's artifact, so
// candidate code must not get to define what counts as accepted.
//
// "introduced" is a baseline with no predecessor on the merge base.
// "excluded" is a design artboard the branch deliberately keeps outside Paper
// parity, reported with its reason instead of silently vanishing from coverage
// (compare-paper.mjs excludedResult). Accepting it cannot shrink what is
// compared: moving a case out of `cases` into `excluded` is refused by
// baselineMutationIssues ("<id> removed without refreshed immutable Paper
// source identity"), which blocks the whole report, and coverage.expected
// below is asserted non-zero.
const acceptedPaperResultStatuses: Record<string, true> = {
  passed: true,
  introduced: true,
  excluded: true,
};

// The route reference ledger is a trusted input, like the policy: when this
// verifier is run from the pull request's base checkout (the deployment
// docs/technical-design/ci-evidence-storage.md describes; this repository
// ships no such workflow itself), the ledger it reads is the base's, never
// the candidate's. Ledger, enterprise manifest and catalog edits are also
// flagged by verify-run.ts GATE_PATH_FILES. A candidate therefore
// cannot mark its own cases `planned` to dodge scoring; a case becomes
// acceptable as `planned` only once a merged ledger says so. Unreadable or
// malformed means no planned case is acceptable (fail closed).
export const ROUTE_LEDGER_DEFAULT_PATH =
  "docs/technical-design/ui-baselines/route-references.json";

export async function readTrustedRouteLedger(): Promise<unknown> {
  const path = Deno.env.get("ROUTE_REFERENCE_LEDGER") ??
    ROUTE_LEDGER_DEFAULT_PATH;
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Enterprise baseline manifest, read the same way as the ledger: from the
// verifier's own checkout, with an env override. Unreadable means empty.
export const ENTERPRISE_BASELINES_DEFAULT_PATH =
  "docs/technical-design/ui-baselines/enterprise-baselines.json";

export async function readTrustedEnterpriseBaselines(): Promise<unknown> {
  const path = Deno.env.get("ENTERPRISE_BASELINES") ??
    ENTERPRISE_BASELINES_DEFAULT_PATH;
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

// Case ids a `--changed` run may report as `not-selected`: ids in the trusted
// baseline manifest that the trusted ledger does not mark `baselined`,
// `planned` or `debt` for the enterprise manifest. The verifier cannot tell from trusted
// inputs whether a run is full (--all) or changed, so a baselined case must
// always be `passed`/`introduced`; the capture side always selects them.
// Fail closed: an unreadable ledger or baseline manifest allows none.
export function enterpriseNotSelectableIds(
  ledger: unknown,
  baselines: unknown,
): Set<string> {
  const allowed = new Set<string>();
  if (!isObject(ledger) || !Array.isArray(ledger.entries)) return allowed;
  if (!isObject(baselines) || !Array.isArray(baselines.cases)) return allowed;
  // A debt case is reported as `debt`, never as `not-selected`.
  const held = enterpriseDebtCaseIds(ledger, baselines);
  for (const entry of ledger.entries) {
    if (!isObject(entry) || entry.manifest !== "enterprise") continue;
    if (entry.status !== "baselined" && entry.status !== "planned") continue;
    if (!Array.isArray(entry.cases)) continue;
    for (const id of entry.cases) if (typeof id === "string") held.add(id);
  }
  for (const entry of baselines.cases) {
    const id = isObject(entry) ? entry.id : undefined;
    if (typeof id === "string" && !held.has(id)) allowed.add(id);
  }
  return allowed;
}

// Case ids the ledger marks `planned` for the enterprise manifest. Restated
// from packages/ui/scripts/paper-manifests.mjs plannedCases for the same
// reason as acceptedPaperResultStatuses: candidate code must not define it.
export function enterprisePlannedCaseIds(ledger: unknown): Set<string> {
  const planned = new Set<string>();
  if (typeof ledger !== "object" || ledger === null) return planned;
  const entries = (ledger as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return planned;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (value.status !== "planned" || value.manifest !== "enterprise") continue;
    if (!Array.isArray(value.cases)) continue;
    for (const id of value.cases) {
      if (typeof id === "string" && id) planned.add(id);
    }
  }
  return planned;
}

// Case ids of the trusted enterprise manifest whose design frame belongs to a
// `debt` entry of the trusted ledger. A debt entry lists Paper frames, not
// cases, so the map goes through `case.frameId`. Restated from
// packages/ui/scripts/paper-manifests.mjs debtCases for the same reason as
// enterprisePlannedCaseIds. Fail closed: an unreadable or malformed ledger or
// manifest yields no debt id. The auth manifest has no debt cases.
export function enterpriseDebtCaseIds(
  ledger: unknown,
  baselines: unknown,
): Set<string> {
  const debt = new Set<string>();
  if (!isObject(ledger) || !Array.isArray(ledger.entries)) return debt;
  if (!isObject(baselines) || !Array.isArray(baselines.cases)) return debt;
  const frames = new Set<string>();
  for (const entry of ledger.entries) {
    if (!isObject(entry) || entry.status !== "debt") continue;
    if (!Array.isArray(entry.frames)) continue;
    for (const frame of entry.frames) {
      if (
        isObject(frame) && typeof frame.frameId === "string" && frame.frameId
      ) {
        frames.add(frame.frameId);
      }
    }
  }
  for (const entry of baselines.cases) {
    if (!isObject(entry) || entry.reference !== "design") continue;
    if (typeof entry.id !== "string" || typeof entry.frameId !== "string") {
      continue;
    }
    if (frames.has(entry.frameId)) debt.add(entry.id);
  }
  return debt;
}

// Enterprise-only: a planned or debt golden has no shipped route or honest
// golden yet, and a changed run deliberately skips unchanged cases. None of
// them is accepted for auth.
const enterpriseOnlyStatuses: Record<string, true> = {
  planned: true,
  debt: true,
  "not-selected": true,
};

const resultStatus = (entry: unknown): string | undefined =>
  typeof entry === "object" && entry !== null
    ? (entry as Record<string, unknown>).status as string | undefined
    : undefined;

// compare-paper.mjs reports the baseline file itself as a pseudo-case
// `manifest` (passed, or introduced when the file has no predecessor). It is
// not a captured case, so it does not count against an empty runtime manifest.
const isManifestSelfCheck = (entry: unknown): boolean =>
  isObject(entry) && entry.baselineId === "manifest" &&
  (entry.status === "passed" || entry.status === "introduced");

const verifyArtifactContent = (
  verify: ArtifactPolicy["verify"],
  document: unknown,
  plannedIds: ReadonlySet<string>,
  notSelectableIds: ReadonlySet<string> = new Set(),
  debtIds: ReadonlySet<string> = new Set(),
): boolean => {
  if (!isObject(document)) return false;
  const value = document;
  const coverage = value.coverage as Record<string, unknown> | undefined;
  if (verify === "runtime-manifest") {
    return value.schemaVersion === 2 &&
      Array.isArray(value.cases) && value.cases.length > 0 &&
      value.cases.every((entry) => resultStatus(entry) === "passed") &&
      typeof coverage === "object" && coverage !== null &&
      coverage.failed === 0 && coverage.blocked === 0 &&
      Array.isArray(coverage.missing) && coverage.missing.length === 0;
  }
  if (verify === "enterprise-runtime-manifest") {
    // Possibly empty: a run whose every case is planned, debt or not-selected
    // captures nothing. The lane-level check below ties emptiness to the
    // comparison.
    return value.schemaVersion === 2 &&
      Array.isArray(value.cases) &&
      value.cases.every((entry) => resultStatus(entry) === "passed") &&
      typeof coverage === "object" && coverage !== null &&
      coverage.failed === 0 && coverage.blocked === 0 &&
      Array.isArray(coverage.missing) && coverage.missing.length === 0;
  }
  const enterprise = verify === "enterprise-paper-comparison";
  return value.schemaVersion === 2 && value.threshold === 0.95 &&
    value.status === "passed" &&
    Array.isArray(value.results) && value.results.length > 0 &&
    value.results.every((entry) => {
      const status = resultStatus(entry);
      if (status === undefined) return false;
      if (acceptedPaperResultStatuses[status] === true) return true;
      if (!enterprise || enterpriseOnlyStatuses[status] !== true) return false;
      const id = (entry as Record<string, unknown>).baselineId;
      if (typeof id !== "string") return false;
      if (status === "not-selected") return notSelectableIds.has(id);
      return status === "debt" ? debtIds.has(id) : plannedIds.has(id);
    }) &&
    typeof coverage === "object" && coverage !== null &&
    typeof coverage.expected === "number" && coverage.expected > 0 &&
    coverage.failed === 0 && coverage.blocked === 0 &&
    Array.isArray(coverage.missing) && coverage.missing.length === 0;
};

const failureMessage = (lane: string, verify: ArtifactVerifier): string => {
  switch (verify) {
    case "runtime-manifest":
      return `${lane}: runtime manifest rejects capture`;
    case "paper-comparison":
      return `${lane}: paper comparison not passed`;
    case "enterprise-runtime-manifest":
      return `${lane}: enterprise runtime manifest rejects capture`;
    case "enterprise-paper-comparison":
      return `${lane}: enterprise paper comparison not passed`;
  }
};

export async function evaluateArtifacts(
  evidenceDir: string,
  artifactDir: string,
  lanes: readonly LanePolicy[],
  readLedger: () => Promise<unknown> = readTrustedRouteLedger,
  readBaselines: () => Promise<unknown> = readTrustedEnterpriseBaselines,
): Promise<string[]> {
  const failures: string[] = [];
  let plannedIds: ReadonlySet<string> | null = null;
  let notSelectableIds: ReadonlySet<string> | null = null;
  let debtIds: ReadonlySet<string> | null = null;
  for (const lane of lanes) {
    const text = await Deno.readTextFile(`${evidenceDir}/${lane.lane}.txt`)
      .catch(() => "");
    const declaration = text.split("\n").find((line) =>
      line.startsWith("artifacts=")
    )?.slice("artifacts=".length) ?? "";
    if (lane.artifacts.length === 0) {
      if (declaration !== "none") {
        failures.push(`${lane.lane}: artifact declaration mismatch`);
      }
      continue;
    }
    const declared = parseArtifactDeclaration(declaration);
    const expectedPaths = new Set(lane.artifacts.map((a) =>
      a.path
    ));
    if (
      !declared || declared.size !== expectedPaths.size ||
      [...declared.keys()].some((path) => !expectedPaths.has(path)) ||
      [...declared.values()].some((digest) => !/^[0-9a-f]{64}$/.test(digest))
    ) {
      failures.push(`${lane.lane}: artifact declaration mismatch`);
      continue;
    }
    const documents = new Map<ArtifactVerifier, unknown>();
    for (const artifact of lane.artifacts) {
      const declaredDigest = declared.get(artifact.path)!;
      const bytes = await Deno.readFile(`${artifactDir}/${artifact.path}`)
        .catch(() => null);
      const actualDigest = bytes ? await sha256Hex(bytes) : null;
      if (!bytes || actualDigest !== declaredDigest) {
        failures.push(
          `${lane.lane}: artifact ${artifact.path} missing or digest mismatch`,
        );
        continue;
      }
      const contentFailure = failureMessage(lane.lane, artifact.verify);
      let document: unknown;
      try {
        document = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        failures.push(contentFailure);
        continue;
      }
      if (artifact.verify === "enterprise-paper-comparison") {
        if (plannedIds === null) {
          const ledger = await readLedger();
          const baselines = await readBaselines();
          plannedIds = enterprisePlannedCaseIds(ledger);
          debtIds = enterpriseDebtCaseIds(ledger, baselines);
          notSelectableIds = enterpriseNotSelectableIds(ledger, baselines);
        }
      }
      if (
        !verifyArtifactContent(
          artifact.verify,
          document,
          plannedIds ?? new Set(),
          notSelectableIds ?? new Set(),
          debtIds ?? new Set(),
        )
      ) {
        failures.push(contentFailure);
        continue;
      }
      documents.set(artifact.verify, document);
    }
    // An enterprise capture with no cases is only coherent when the comparison
    // shows every case was planned, debt or not selected; otherwise an empty
    // manifest would hide cases that should have been captured.
    const manifest = documents.get("enterprise-runtime-manifest") as
      | Record<string, unknown>
      | undefined;
    // A comparison that failed its own check was already reported; do not
    // double-report it as an empty-manifest failure.
    const comparisonDeclared = lane.artifacts.some((artifact) =>
      artifact.verify === "enterprise-paper-comparison"
    );
    if (
      manifest && Array.isArray(manifest.cases) &&
      manifest.cases.length === 0 &&
      (!comparisonDeclared || documents.has("enterprise-paper-comparison"))
    ) {
      const comparison = documents.get("enterprise-paper-comparison") as
        | Record<string, unknown>
        | undefined;
      const results = Array.isArray(comparison?.results)
        ? comparison.results
        : null;
      if (
        !results ||
        !results.every((entry) =>
          enterpriseOnlyStatuses[resultStatus(entry) ?? ""] === true ||
          isManifestSelfCheck(entry)
        )
      ) {
        failures.push(
          failureMessage(lane.lane, "enterprise-runtime-manifest"),
        );
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const policyPath = Deno.env.get("REQUIRED_CHECKS_POLICY") ??
    "scripts/ci/required-checks.json";
  const reasonPath = Deno.env.get("VERIFIER_REASON_PATH");
  let policy: RequiredChecksPolicy;
  try {
    policy = parsePolicy(await Deno.readTextFile(policyPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (reasonPath) await Deno.writeTextFile(reasonPath, `${message}\n`);
    Deno.exit(1);
  }
  const required = policy.lanes.map((lane) => lane.lane);
  const lanes: Record<string, LaneStatus | undefined> = {};
  for (const name of required) {
    lanes[name] = Deno.env.get(`LANE_${name.toUpperCase()}`) as
      | LaneStatus
      | undefined;
  }
  const result = evaluateLaneExpectations(
    lanes,
    policy,
    Deno.env.get("GITHUB_EVENT_NAME"),
  );
  const successful = policy.lanes.filter((lane) =>
    lanes[lane.lane] === "success"
  );
  const successfulNames = successful.map((lane) => lane.lane);
  const evidenceDir = Deno.env.get("EVIDENCE_DIR") ?? "evidence";
  const evidenceFailures = successfulNames.length === 0
    ? []
    : await evaluateEvidence(
      evidenceDir,
      successfulNames,
      Deno.env.get("CANDIDATE_SHA") ?? "",
      Deno.env.get("BASE_SHA") ?? "",
      Deno.env.get("EXPECTED_WORKFLOW_SHA") ?? "",
      Deno.env.get("EXPECTED_RUN_ID") ?? "",
      Deno.env.get("EXPECTED_RUN_ATTEMPT") ?? "",
      policy.dependencies,
    );
  const artifactFailures = await evaluateArtifacts(
    evidenceDir,
    Deno.env.get("ARTIFACT_DIR") ?? "candidate-artifacts",
    successful,
  );
  result.failures.push(...evidenceFailures, ...artifactFailures);
  result.ok = result.ok && evidenceFailures.length === 0 &&
    artifactFailures.length === 0;
  console.log(
    JSON.stringify({
      required,
      successful: successfulNames,
      lanes,
      ok: result.ok,
      failures: result.failures,
    }),
  );
  if (reasonPath) {
    await Deno.writeTextFile(
      reasonPath,
      `${result.failures[0] ?? "all required evidence accepted"}\n`,
    );
  }
  if (!result.ok) Deno.exit(1);
}
