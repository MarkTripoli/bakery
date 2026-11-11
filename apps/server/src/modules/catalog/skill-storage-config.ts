import { z } from "zod";
import { SkillFileStoreError } from "./storage-port.ts";

/** Backends that can hold skill bundle objects. */
export const SkillStorageBackend = Object.freeze(
  { Filesystem: "filesystem", R2: "r2" } as const,
);
export type SkillStorageBackend =
  (typeof SkillStorageBackend)[keyof typeof SkillStorageBackend];
export const skillStorageBackends = Object.freeze(
  Object.values(SkillStorageBackend),
);
export function isSkillStorageBackend(
  value: unknown,
): value is SkillStorageBackend {
  return skillStorageBackends.includes(value as SkillStorageBackend);
}

/** Code every invalid stored or supplied storage setting collapses to. */
export const SKILL_STORAGE_CONFIG_INVALID = "SKILL_STORAGE_CONFIG_INVALID";

export const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Hosts a loopback S3 fixture may use, and only when BAKERY_ENV is test. */
const TEST_ENDPOINT_HOSTS: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "[::1]",
  "s3-fixture",
];

export const R2CredentialsSchema = z.object({
  accessKeyId: z.string().min(1).max(256).describe(
    "R2 API token access key id; sent to R2 as the S3 access key id.",
  ),
  secretAccessKey: z.string().min(1).max(1024).describe(
    "R2 API token secret access key; only ever held in memory or as installation-scoped AES-GCM ciphertext.",
  ),
}).strict().describe(
  "R2 credential pair stored as one encrypted installation secret payload; never returned, logged, traced or audited.",
);
export type R2Credentials = z.infer<typeof R2CredentialsSchema>;

/** True when a credential has no whitespace or control characters. */
export function isCredentialText(value: string): boolean {
  return value.length > 0 && !Array.from(value).some((c) => {
    const code = c.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

export const R2ConnectionSchema = z.object({
  accountId: z.string().regex(ACCOUNT_ID_PATTERN).describe(
    "Cloudflare account identifier owning the private skill bucket; 32 lowercase hex characters.",
  ),
  bucket: z.string().regex(BUCKET_NAME_PATTERN).describe(
    "Private bucket containing immutable skill objects.",
  ),
  endpoint: z.url().describe(
    "S3 API origin; production is always the account R2 endpoint, tests may use loopback.",
  ),
}).strict().describe(
  "Validated, non-secret R2 connection settings resolved from the installation settings row.",
);
export type R2Connection = z.infer<typeof R2ConnectionSchema>;

export const R2ConnectionSourceSchema = z.object({
  accountId: z.string().describe(
    "Account identifier as stored in the settings row; validated before use.",
  ),
  bucket: z.string().describe(
    "Bucket as stored in the settings row; validated before use.",
  ),
  endpointOverride: z.string().nullable().describe(
    "Loopback fixture endpoint stored in the settings row, or null; honoured only when BAKERY_ENV is test.",
  ),
}).strict().describe(
  "Untrusted R2 connection values read from the installation settings row.",
);
export type R2ConnectionSource = z.infer<typeof R2ConnectionSourceSchema>;

/** The fixed Cloudflare endpoint of one R2 account. */
export function r2AccountEndpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * Validates DB-sourced R2 settings and pins the endpoint to
 * `<account>.r2.cloudflarestorage.com`, so no stored or typed value can
 * redirect the client to another host (SSRF). Only a test environment may
 * name a loopback http endpoint.
 */
export function resolveR2Connection(
  source: R2ConnectionSource,
  options: { readonly allowLoopbackEndpoint: boolean },
): R2Connection {
  if (
    !ACCOUNT_ID_PATTERN.test(source.accountId) ||
    !BUCKET_NAME_PATTERN.test(source.bucket)
  ) throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
  const expected = r2AccountEndpoint(source.accountId);
  let endpoint = expected;
  if (source.endpointOverride !== null) {
    let url: URL;
    try {
      url = new URL(source.endpointOverride);
    } catch {
      throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
    }
    const testEndpoint = options.allowLoopbackEndpoint &&
      url.protocol === "http:" && TEST_ENDPOINT_HOSTS.includes(url.hostname);
    if (
      (url.origin !== expected && !testEndpoint) || url.username ||
      url.password || url.search || url.hash || url.pathname !== "/"
    ) throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
    endpoint = url.origin;
  }
  const parsed = R2ConnectionSchema.safeParse({
    accountId: source.accountId,
    bucket: source.bucket,
    endpoint,
  });
  if (!parsed.success) {
    throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
  }
  return parsed.data;
}
