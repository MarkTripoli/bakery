/**
 * The one table from a problem code to its HTTP status, whether a retry can
 * help, and its problem type slug. The server answers with it (http.ts) and
 * the OpenAPI generator documents it (contracts.ts). It imports nothing, so
 * both can use it without an import cycle.
 */
export const FAULTS = {
  AUTH_REQUIRED: [401, false, "auth-required"],
  AUTH_FORBIDDEN: [403, false, "auth-forbidden"],
  RESOURCE_NOT_FOUND: [404, false, "resource-not-found"],
  ARTIFACT_CONTENT_EXPIRED: [410, false, "artifact-content-expired"],
  // The stored bytes are not the bytes the version recorded (#437). This is not
  // a missing file and must never be reported as one: the version is intact and
  // its record is intact, and what is stored under it hashes to something else.
  // A reader refuses to serve it, and the page that asked shows that the file
  // does not match its record rather than an error it cannot explain.
  ARTIFACT_CONTENT_MISMATCH: [409, false, "artifact-content-mismatch"],
  // Declared in the transport schema and unused until now. A range the server
  // will not serve for this object: the bytes exist and the range is valid, but
  // serving it would cost more than the server is willing to spend. 416 is the
  // status a client already understands for "not this range", and its fallback
  // - fetch the whole object - is the right one here.
  RANGE_NOT_SATISFIABLE: [416, false, "range-not-satisfiable"],
  MALFORMED_REQUEST: [400, false, "malformed-request"],
  VALIDATION_FAILED: [422, false, "validation-failed"],
  UNPROCESSABLE: [422, false, "unprocessable"],
  IDEMPOTENCY_PAYLOAD_MISMATCH: [422, false, "idempotency-payload-mismatch"],
  IDEMPOTENCY_IN_FLIGHT: [409, true, "idempotency-in-flight"],
  PRECONDITION_FAILED: [412, false, "precondition-failed"],
  PRECONDITION_REQUIRED: [428, false, "precondition-required"],
  STATE_CONFLICT: [409, false, "state-conflict"],
  // The storage tree's folder policy refused the operation (#447): rm or mv in a
  // record area, a file write into the library, /trash or /system, or a change
  // to a folder Bakery made. `reason` names which.
  STORAGE_AREA_REFUSED: [409, false, "storage-area-refused"],
  // New writes are paused: usage would pass 90% of a quota (#447). `reason`
  // names the quota: organization, project or personal.
  STORAGE_QUOTA_EXCEEDED: [409, false, "storage-quota-exceeded"],
  // The file is larger than the organization's maximum file size (#447).
  STORAGE_FILE_TOO_LARGE: [422, false, "storage-file-too-large"],
  // An agent step wrote as much as its step write limits allow (O49, #448):
  // `reason` is files or bytes and `limit` the value of the limit it hit. A
  // person's own writes are never limited this way.
  STEP_WRITE_LIMIT_EXCEEDED: [409, false, "step-write-limit-exceeded"],
  VERSION_CONFLICT: [409, false, "version-conflict"],
  EXPECTED_SEQUENCE: [409, true, "expected-sequence"],
  LEASE_EXPIRED: [409, true, "lease-expired"],
  LEASE_FENCED: [409, false, "lease-fenced"],
  CANCEL_REQUESTED: [409, false, "cancel-requested"],
  ALREADY_TERMINAL: [409, false, "already-terminal"],
  SCOPE_REQUIRED: [403, false, "scope-required"],
  INSUFFICIENT_SCOPE: [403, false, "insufficient-scope"],
  SESSION_REQUIRED: [403, false, "session-required"],
  PROVIDER_QUOTA_EXCEEDED: [429, true, "provider-quota-exceeded"],
  BUDGET_CAP_EXCEEDED: [429, false, "budget-cap-exceeded"],
  EXTERNAL_EFFECT_UNCERTAIN: [409, false, "external-effect-uncertain"],
  DEPENDENCY_UNAVAILABLE: [503, true, "dependency-unavailable"],
  DEPENDENCY_TIMEOUT: [504, true, "dependency-timeout"],
  REVIEWER_UNAVAILABLE: [503, true, "reviewer-unavailable"],
  WORKER_UNAVAILABLE: [503, true, "worker-unavailable"],
  // The installation is held for a backup snapshot (#64): no new work is
  // admitted until the lease on the maintenance switch ends. Retry-After says
  // when to ask again.
  INSTALLATION_QUIESCED: [503, true, "installation-quiesced"],
  // A restore replaced the installation's state (#64 slice E). The fence has
  // run and every door stays closed until an administrator completes the
  // ordered steps. Asking again does not help, so it is not retryable.
  INSTALLATION_RESTORING: [503, false, "installation-restoring"],
  // The ordered re-enable of a restored installation (#64 slice E3). Each is a
  // refusal an administrator can act on, named so a script can tell them apart.
  RESTORE_NOT_HELD: [409, false, "restore-not-held"],
  RESTORE_CONFIRMATION_MISMATCH: [422, false, "restore-confirmation-mismatch"],
  RESTORE_STEP_OUT_OF_ORDER: [409, false, "restore-step-out-of-order"],
  RESTORE_STEP_ALREADY_TAKEN: [409, false, "restore-step-already-taken"],
  SNAPSHOT_SCOPE_TOO_LARGE: [413, false, "snapshot-scope-too-large"],
  AUTH_INVALID: [401, false, "auth-invalid"],
  AUTH_EXPIRED: [401, false, "auth-expired"],
  AUTH_FACTOR_REQUIRED: [401, false, "auth-factor-required"],
  MALFORMED_JSON: [400, false, "malformed-json"],
  INVALID_CURSOR: [400, false, "invalid-cursor"],
  BODY_TOO_LARGE: [413, false, "body-too-large"],
  UNSUPPORTED_MEDIA_TYPE: [415, false, "unsupported-media-type"],
  WORKER_PROTOCOL_UNSUPPORTED: [426, false, "worker-protocol-unsupported"],
  METHOD_NOT_ALLOWED: [405, false, "method-not-allowed"],
  RATE_LIMITED: [429, true, "rate-limited"],
  INTERNAL: [500, false, "internal"],
  WORKER_ACTION_CAPABILITIES_INVALID: [
    500,
    false,
    "worker-action-capabilities-invalid",
  ],
  WORKER_ACTION_CONTRACT_DRIFT: [
    500,
    false,
    "worker-action-contract-drift",
  ],
  SKILL_CONTENT_INTEGRITY_FAILED: [
    409,
    false,
    "skill-content-integrity-failed",
  ],
} as const;

export type FaultCode = keyof typeof FAULTS;

export function isFaultCode(value: string): value is FaultCode {
  return Object.hasOwn(FAULTS, value);
}
