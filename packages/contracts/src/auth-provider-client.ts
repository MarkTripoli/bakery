import { z } from "zod";

/**
 * Stable, safe failure classification for the Better Auth provider
 * endpoints (`/api/auth/*`). Never exposes the provider's raw `code` or
 * `message` to callers — only this closed set, mapped from the documented
 * Better Auth 1.7.3 and Bakery `bakerySessionAssurance`/`twoFactor` plugin
 * error codes (`node_modules/better-auth`, `session-assurance.ts`).
 */
export type AuthProviderFailureCode =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_EXISTS"
  | "TWO_FACTOR_INVALID"
  | "TWO_FACTOR_SESSION_EXPIRED"
  /** The new password fails the installation's length policy (sign-up). */
  | "WEAK_PASSWORD"
  | "TWO_FACTOR_REQUIRED"
  | "FACTOR_PROOF_REQUIRED"
  | "FRESH_SIGN_IN_REQUIRED"
  /** Removing the passkey would leave no usable sign-in method. */
  | "LAST_SIGN_IN_METHOD"
  /** Password change only: the current password was wrong. */
  | "INVALID_PASSWORD"
  /** Password change only: the new password is below the length policy. */
  | "PASSWORD_TOO_SHORT"
  /** Password change only: the new password is above the length policy. */
  | "PASSWORD_TOO_LONG"
  /** Re-authentication only: the account has no password to re-prove. */
  | "PASSWORD_NOT_SET"
  | "LOCKED"
  | "RATE_LIMITED"
  | "CROSS_ORIGIN_BLOCKED"
  | "UNAVAILABLE"
  | "NETWORK";

export class AuthProviderError extends Error {
  override readonly name = "AuthProviderError";
  readonly code: AuthProviderFailureCode;
  readonly status: number | null;
  readonly requestId: string;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: AuthProviderFailureCode,
    options: {
      status: number | null;
      requestId: string;
      retryAfterSeconds: number | null;
      cause?: unknown;
    },
  ) {
    super(`Auth provider request failed (${code})`, { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export type SignInResult =
  | { kind: "signed-in" }
  | { kind: "two-factor-required" };

/** Public, safe fields of one registered passkey; the public key is never surfaced. */
export type PasskeySummary = {
  id: string;
  name: string | null;
  credentialId: string;
  deviceType: string;
  backedUp: boolean;
  transports: readonly string[];
  createdAt: string | null;
};

/**
 * WebAuthn creation options as the provider sends them (JSON dialect: binary
 * members are base64url strings). The web app decodes them and runs the
 * native `navigator.credentials.create` ceremony (`apps/web/src/app/webauthn.ts`).
 */
export type PasskeyRegistrationOptions =
  & { challenge: string }
  & Record<
    string,
    unknown
  >;

export type AuthProviderClient = {
  signInEmail(
    input: { email: string; password: string },
    signal?: AbortSignal,
  ): Promise<SignInResult>;
  /** Always resolves 200 regardless of acceptance (anti-enumeration). */
  signUpEmail(
    input: { name: string; email: string; password: string },
    signal?: AbortSignal,
  ): Promise<{ kind: "submitted" }>;
  signOut(signal?: AbortSignal): Promise<void>;
  twoFactor: {
    verifyTotp(
      input: { code: string },
      signal?: AbortSignal,
    ): Promise<void>;
    verifyBackupCode(
      input: { code: string },
      signal?: AbortSignal,
    ): Promise<void>;
    enable(
      input: { password: string },
      signal?: AbortSignal,
    ): Promise<{ totpUri: string; backupCodes: readonly string[] }>;
    generateBackupCodes(
      input: { password: string },
      signal?: AbortSignal,
    ): Promise<{ backupCodes: readonly string[] }>;
    disable(
      input: { password: string },
      signal?: AbortSignal,
    ): Promise<void>;
  };
  /**
   * Changes the signed-in person's password. `revokeOtherSessions` deletes
   * every other session; the calling session is replaced by a fresh one.
   */
  changePassword(
    input: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions: boolean;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Re-proves the password on the CURRENT full session (no session is created
   * or replaced), unlocking the ten-minute fresh window for passkey
   * management. A pending-factor session is refused with `TWO_FACTOR_REQUIRED`.
   */
  reauthenticate(
    input: { password: string },
    signal?: AbortSignal,
  ): Promise<void>;
  passkey: {
    /** Starts a registration ceremony; needs a sign-in within ten minutes. */
    generateRegisterOptions(
      input: { name?: string },
      signal?: AbortSignal,
    ): Promise<PasskeyRegistrationOptions>;
    /** Finishes registration with the authenticator's response; never starts a session. */
    verifyRegistration(
      input: { response: Record<string, unknown>; name?: string },
      signal?: AbortSignal,
    ): Promise<PasskeySummary>;
    listUserPasskeys(
      signal?: AbortSignal,
    ): Promise<readonly PasskeySummary[]>;
    updatePasskey(
      input: { id: string; name: string },
      signal?: AbortSignal,
    ): Promise<PasskeySummary>;
    /** Removes a passkey and every session it created, the calling one included. */
    deletePasskey(
      input: { id: string },
      signal?: AbortSignal,
    ): Promise<void>;
  };
};

/**
 * Provider `code` → safe failure code. Keys are Better Auth 1.7.3 core codes
 * (`@better-auth/core` `BASE_ERROR_CODES`) and Bakery's
 * `bakerySessionAssurance`/`twoFactor` plugin codes (`session-assurance.ts`,
 * `better-auth`'s `two-factor` plugin `error-code.mjs`). Never keyed by
 * `message`.
 */
const PROVIDER_CODE_MAP: Readonly<Record<string, AuthProviderFailureCode>> = {
  INVALID_EMAIL_OR_PASSWORD: "INVALID_CREDENTIALS",
  // Better Auth 1.7.3 throws this exact key for a conflicting sign-up email
  // (`BASE_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`); the shorter
  // `USER_ALREADY_EXISTS` key exists but is not what `sign-up/email` throws.
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "ACCOUNT_EXISTS",
  // `sign-up/email` rejects a password outside the configured length bounds
  // with these two `BASE_ERROR_CODES`; the person needs a field error, not
  // the unavailable-service screen.
  PASSWORD_TOO_SHORT: "WEAK_PASSWORD",
  PASSWORD_TOO_LONG: "WEAK_PASSWORD",
  INVALID_CODE: "TWO_FACTOR_INVALID",
  INVALID_BACKUP_CODE: "TWO_FACTOR_INVALID",
  // Distinct from `INVALID_CODE`/`INVALID_BACKUP_CODE`: this is what Better
  // Auth 1.7.3 throws once the 10-minute `two_factor` challenge cookie has
  // lapsed, not a wrong code. Mapping it to the same `TWO_FACTOR_INVALID`
  // code (the plan's original Phase 1 mapping) makes `/two-factor`'s
  // `expired` state permanently unreachable — a lapsed cookie shows "Invalid
  // code" forever with no escape. Deviation from the plan, recorded here.
  INVALID_TWO_FACTOR_COOKIE: "TWO_FACTOR_SESSION_EXPIRED",
  // Better Auth's `two-factor` plugin throws this for a wrong password on
  // enable/regenerate/disable; the plan's Phase 1 map had no entry for it,
  // so it fell through to `UNAVAILABLE` instead of the generic credential
  // failure copy every other wrong-password path already uses.
  INVALID_PASSWORD: "INVALID_CREDENTIALS",
  TWO_FACTOR_REQUIRED: "TWO_FACTOR_REQUIRED",
  FACTOR_PROOF_REQUIRED: "FACTOR_PROOF_REQUIRED",
  FRESH_SIGN_IN_REQUIRED: "FRESH_SIGN_IN_REQUIRED",
  ACCOUNT_TEMPORARILY_LOCKED: "LOCKED",
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "CROSS_ORIGIN_BLOCKED",
  MISSING_OR_NULL_ORIGIN: "CROSS_ORIGIN_BLOCKED",
  LAST_SIGN_IN_METHOD: "LAST_SIGN_IN_METHOD",
  PASSWORD_NOT_SET: "PASSWORD_NOT_SET",
};

/**
 * `/bakery/reauthenticate` per-call override: a wrong password is a field
 * error for the re-authentication form, not the generic sign-in failure.
 */
const REAUTHENTICATE_CODE_MAP: Readonly<
  Record<string, AuthProviderFailureCode>
> = { INVALID_PASSWORD: "INVALID_PASSWORD" };

/**
 * `/change-password` per-call overrides: the shared map folds these into
 * sign-up/TOTP classes, but a password-change form needs its own field
 * errors for a wrong current password and a too short or too long new one.
 */
const CHANGE_PASSWORD_CODE_MAP: Readonly<
  Record<string, AuthProviderFailureCode>
> = {
  INVALID_PASSWORD: "INVALID_PASSWORD",
  PASSWORD_TOO_SHORT: "PASSWORD_TOO_SHORT",
  PASSWORD_TOO_LONG: "PASSWORD_TOO_LONG",
};

function mapProviderFailure(
  status: number,
  code: string | undefined,
  overrides?: Readonly<Record<string, AuthProviderFailureCode>>,
): AuthProviderFailureCode {
  if (code !== undefined) {
    const override = overrides && Object.hasOwn(overrides, code)
      ? overrides[code]
      : undefined;
    if (override) return override;
    const mapped = PROVIDER_CODE_MAP[code];
    if (mapped) return mapped;
  }
  if (status === 429) return "RATE_LIMITED";
  return "UNAVAILABLE";
}

function readRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("X-Retry-After") ?? headers.get("Retry-After");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

const providerErrorBodySchema = z.looseObject({
  code: z.string().describe(
    "Better Auth provider error code identifying the failure kind.",
  ),
}).describe(
  "Better Auth provider error response envelope; only `code` is read, `message` is never surfaced.",
);

async function readProviderCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const parsed = providerErrorBodySchema.safeParse(body);
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    return undefined;
  }
}

async function throwProviderFailure(
  response: Response,
  requestId: string,
  overrides?: Readonly<Record<string, AuthProviderFailureCode>>,
): Promise<never> {
  const code = mapProviderFailure(
    response.status,
    await readProviderCode(response),
    overrides,
  );
  throw new AuthProviderError(code, {
    status: response.status,
    requestId,
    retryAfterSeconds: code === "RATE_LIMITED"
      ? readRetryAfterSeconds(response.headers)
      : null,
  });
}

const signInResponseSchema = z.looseObject({
  twoFactorRedirect: z.boolean().optional().describe(
    "Whether the sign-in requires a pending two-factor challenge before a session is issued.",
  ),
}).describe("Better Auth sign-in/email response body.");
const reauthenticateResponseSchema = z.looseObject({
  reauthenticated: z.literal(true).describe(
    "True once the current session's password re-proof was recorded.",
  ),
}).describe("Bakery bakery/reauthenticate response body.");
const enableResponseSchema = z.looseObject({
  totpURI: z.string().describe(
    "otpauth:// URI carrying the shared TOTP secret for authenticator enrollment.",
  ),
  backupCodes: z.array(
    z.string().describe("Single-use recovery backup code."),
  ).describe("Freshly generated single-use recovery backup codes."),
}).describe("Better Auth two-factor/enable response body.");
const backupCodesResponseSchema = z.looseObject({
  backupCodes: z.array(
    z.string().describe("Single-use recovery backup code."),
  ).describe("Freshly generated single-use recovery backup codes."),
}).describe("Better Auth two-factor/generate-backup-codes response body.");

const registrationOptionsSchema = z.looseObject({
  challenge: z.string().describe(
    "Base64url WebAuthn challenge the authenticator must sign.",
  ),
}).describe(
  "Better Auth passkey/generate-register-options response: WebAuthn creation options.",
);
const passkeyRecordSchema = z.looseObject({
  id: z.string().describe("Provider identifier of the passkey."),
  name: z.string().nullish().describe("Person-chosen label of the passkey."),
  credentialID: z.string().describe(
    "Base64url WebAuthn credential identifier of the passkey.",
  ),
  deviceType: z.string().describe(
    "Credential device type: singleDevice or multiDevice.",
  ),
  backedUp: z.boolean().describe(
    "Whether the credential is backed up to a passkey provider.",
  ),
  transports: z.string().nullish().describe(
    "Comma-separated authenticator transports the credential reported.",
  ),
  createdAt: z.union([
    z.string().describe("ISO timestamp the provider serialised."),
    z.number().describe("Epoch milliseconds the provider serialised."),
  ]).nullish().describe(
    "When the passkey was registered, as the provider serialised it.",
  ),
}).describe(
  "Better Auth passkey record; only public fields are read, the public key is ignored.",
);
const updatePasskeyResponseSchema = z.looseObject({
  passkey: passkeyRecordSchema,
}).describe("Better Auth passkey/update-passkey response body.");
const passkeyListSchema = z.array(passkeyRecordSchema).describe(
  "Better Auth passkey/list-user-passkeys response: the caller's passkeys.",
);

function toPasskeySummary(
  record: z.infer<typeof passkeyRecordSchema>,
): PasskeySummary {
  return {
    id: record.id,
    name: record.name ?? null,
    credentialId: record.credentialID,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    transports: record.transports
      ? record.transports.split(",").filter((entry) => entry !== "")
      : [],
    createdAt: record.createdAt === null || record.createdAt === undefined
      ? null
      : new Date(record.createdAt).toISOString(),
  };
}

export function createAuthProviderClient(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  createRequestId?: () => string;
}): AuthProviderClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const createRequestId = options.createRequestId ??
    (() => crypto.randomUUID());

  const post = async (
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    overrides?: Readonly<Record<string, AuthProviderFailureCode>>,
  ): Promise<{ response: Response; requestId: string }> => {
    const requestId = createRequestId();
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: "POST",
        credentials: "include",
        signal,
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "X-Request-Id": requestId,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AuthProviderError("NETWORK", {
        status: null,
        requestId,
        retryAfterSeconds: null,
        cause,
      });
    }
    if (!response.ok) {
      await throwProviderFailure(response, requestId, overrides);
    }
    return { response, requestId };
  };

  const get = async (
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; requestId: string }> => {
    const requestId = createRequestId();
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: "GET",
        credentials: "include",
        signal,
        headers: { "accept": "application/json", "X-Request-Id": requestId },
      });
    } catch (cause) {
      throw new AuthProviderError("NETWORK", {
        status: null,
        requestId,
        retryAfterSeconds: null,
        cause,
      });
    }
    if (!response.ok) await throwProviderFailure(response, requestId);
    return { response, requestId };
  };

  const parseOrThrow = async <T>(
    parse: (body: unknown) => { success: true; data: T } | { success: false },
    response: Response,
    requestId: string,
  ): Promise<T> => {
    const parsed = parse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new AuthProviderError("UNAVAILABLE", {
        status: response.status,
        requestId,
        retryAfterSeconds: null,
      });
    }
    return parsed.data;
  };

  return {
    async signInEmail(input, signal) {
      const { response, requestId } = await post(
        "/api/auth/sign-in/email",
        { email: input.email, password: input.password },
        signal,
      );
      const parsed = signInResponseSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new AuthProviderError("UNAVAILABLE", {
          status: response.status,
          requestId,
          retryAfterSeconds: null,
        });
      }
      return parsed.data.twoFactorRedirect === true
        ? { kind: "two-factor-required" }
        : { kind: "signed-in" };
    },

    async signUpEmail(input, signal) {
      await post(
        "/api/auth/sign-up/email",
        {
          name: input.name,
          email: input.email,
          password: input.password,
          rememberMe: false,
        },
        signal,
      );
      return { kind: "submitted" };
    },

    async signOut(signal) {
      await post("/api/auth/sign-out", {}, signal);
    },

    async reauthenticate(input, signal) {
      const { response, requestId } = await post(
        "/api/auth/bakery/reauthenticate",
        { password: input.password },
        signal,
        REAUTHENTICATE_CODE_MAP,
      );
      await parseOrThrow(
        (body) => reauthenticateResponseSchema.safeParse(body),
        response,
        requestId,
      );
    },

    twoFactor: {
      async verifyTotp(input, signal) {
        await post(
          "/api/auth/two-factor/verify-totp",
          { code: input.code },
          signal,
        );
      },

      async verifyBackupCode(input, signal) {
        await post(
          "/api/auth/two-factor/verify-backup-code",
          { code: input.code },
          signal,
        );
      },

      async enable(input, signal) {
        const { response, requestId } = await post(
          "/api/auth/two-factor/enable",
          { password: input.password },
          signal,
        );
        const parsed = enableResponseSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!parsed.success) {
          throw new AuthProviderError("UNAVAILABLE", {
            status: response.status,
            requestId,
            retryAfterSeconds: null,
          });
        }
        return {
          totpUri: parsed.data.totpURI,
          backupCodes: parsed.data.backupCodes,
        };
      },

      async generateBackupCodes(input, signal) {
        const { response, requestId } = await post(
          "/api/auth/two-factor/generate-backup-codes",
          { password: input.password },
          signal,
        );
        const parsed = backupCodesResponseSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (!parsed.success) {
          throw new AuthProviderError("UNAVAILABLE", {
            status: response.status,
            requestId,
            retryAfterSeconds: null,
          });
        }
        return { backupCodes: parsed.data.backupCodes };
      },

      async disable(input, signal) {
        await post(
          "/api/auth/two-factor/disable",
          { password: input.password },
          signal,
        );
      },
    },

    async changePassword(input, signal) {
      await post(
        "/api/auth/change-password",
        {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          revokeOtherSessions: input.revokeOtherSessions,
        },
        signal,
        CHANGE_PASSWORD_CODE_MAP,
      );
    },

    passkey: {
      async generateRegisterOptions(input, signal) {
        const query = input.name === undefined
          ? ""
          : `?name=${encodeURIComponent(input.name)}`;
        const { response, requestId } = await get(
          `/api/auth/passkey/generate-register-options${query}`,
          signal,
        );
        return await parseOrThrow(
          (body) => registrationOptionsSchema.safeParse(body),
          response,
          requestId,
        );
      },

      async verifyRegistration(input, signal) {
        const { response, requestId } = await post(
          "/api/auth/passkey/verify-registration",
          {
            response: input.response,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
          signal,
        );
        return toPasskeySummary(
          await parseOrThrow(
            (body) => passkeyRecordSchema.safeParse(body),
            response,
            requestId,
          ),
        );
      },

      async listUserPasskeys(signal) {
        const { response, requestId } = await get(
          "/api/auth/passkey/list-user-passkeys",
          signal,
        );
        const records = await parseOrThrow(
          (body) => passkeyListSchema.safeParse(body),
          response,
          requestId,
        );
        return records.map(toPasskeySummary);
      },

      async updatePasskey(input, signal) {
        const { response, requestId } = await post(
          "/api/auth/passkey/update-passkey",
          { id: input.id, name: input.name },
          signal,
        );
        const body = await parseOrThrow(
          (value) => updatePasskeyResponseSchema.safeParse(value),
          response,
          requestId,
        );
        return toPasskeySummary(body.passkey);
      },

      async deletePasskey(input, signal) {
        await post(
          "/api/auth/passkey/delete-passkey",
          { id: input.id },
          signal,
        );
      },
    },
  };
}
