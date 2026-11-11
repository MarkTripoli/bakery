export const DEFAULT_LEASE_SECONDS = 45;
export const IDEMPOTENCY_REPLAY_TTL_SECONDS = 24 * 60 * 60;
export const RECLAIM_CLAIM_BATCH_SIZE = 50;
export const RETENTION_SWEEP_BATCH_SIZE = 500;
/** Expired artifact preview grants and sessions are deleted after this grace. */
export const ARTIFACT_PREVIEW_RETENTION_GRACE_SECONDS = 24 * 60 * 60;
export const WORKER_COMMAND_TERMINAL_RETENTION_SECONDS = 24 * 60 * 60;
/** Worker readiness checks expire five minutes after the server receives them. */
export const WORKER_CHECK_EXPIRY_SECONDS = 300;
/** Authenticated heartbeat receipts go stale after 30 seconds and offline after 60. */
export const WORKER_STALE_AFTER_SECONDS = 30;
export const WORKER_OFFLINE_AFTER_SECONDS = 60;
/** Provider auth attempts are bounded and expire quickly. */
export const WORKER_PROVIDER_AUTH_TTL_SECONDS = 300;
/** Bounded safe safe reason/problem text for machine records and events. */
export const WORKER_SAFE_TEXT_MAX_BYTES = 8_192;
