import {
  type AuthProviderClient,
  AuthProviderError,
} from "@bakery/contracts/auth-provider-client";
import { type SecurityFailure, securityFailure } from "./security-failures.ts";
import {
  createPasskeyCredential,
  type CreationOptionsJson,
} from "./webauthn.ts";

/**
 * The provider calls the passkey pages make, narrowed so a unit test can
 * stand in for the server without a browser or a router.
 */
export type PasskeyFlowAuth = {
  readonly reauthenticate: AuthProviderClient["reauthenticate"];
  readonly passkey: Pick<
    AuthProviderClient["passkey"],
    "generateRegisterOptions" | "verifyRegistration" | "deletePasskey"
  >;
  readonly twoFactor: Pick<
    AuthProviderClient["twoFactor"],
    "verifyTotp" | "verifyBackupCode"
  >;
};

/** Which kind of code proves the second factor in place. */
export type FactorCodeKind = "totp" | "backup";

/**
 * Re-proves the password on the current session. An account with no password
 * (`PASSWORD_NOT_SET`) has nothing to prove, so it is not an error here: the
 * passkey action runs directly and the server's own freshness check decides.
 * Skipped outright once the account is known to be passwordless.
 */
export async function proveSession(
  auth: Pick<PasskeyFlowAuth, "reauthenticate">,
  password: string,
  knownPasswordless: boolean,
): Promise<{ readonly passwordless: boolean }> {
  if (knownPasswordless) return { passwordless: true };
  try {
    await auth.reauthenticate({ password });
    return { passwordless: false };
  } catch (error) {
    if (
      error instanceof AuthProviderError && error.code === "PASSWORD_NOT_SET"
    ) {
      return { passwordless: true };
    }
    throw error;
  }
}

/**
 * Classifies a passkey-action failure. A stale session on an account with no
 * password cannot be refreshed in place, so it becomes the one
 * sign-out-then-sign-in offer; everyone else is routed to re-authentication.
 */
export function passkeyActionFailure(
  error: unknown,
  passwordless: boolean,
): SecurityFailure {
  const failure = securityFailure(error);
  return passwordless && failure.kind === "reauthRequired"
    ? { kind: "passwordNotSet" }
    : failure;
}

export type RegisterPasskeyInput = {
  readonly name: string;
  readonly password: string;
  readonly passwordless: boolean;
  readonly signal: AbortSignal;
  /** Called once the native prompt is about to open. */
  readonly onPrompt: () => void;
  /** Called as soon as the server says the account has no password. */
  readonly onPasswordless: () => void;
};

export type RegisterPasskeyDeps = {
  readonly auth: PasskeyFlowAuth;
  readonly createCredential?: typeof createPasskeyCredential;
};

/**
 * Adds a passkey: proves the session (or skips that for a passwordless
 * account), asks for creation options, runs the ceremony and verifies it.
 * A Cancel pressed while the credential was still resolving ends the flow
 * as `aborted` without calling verify-registration.
 */
export async function registerPasskey(
  deps: RegisterPasskeyDeps,
  input: RegisterPasskeyInput,
): Promise<"registered" | "aborted"> {
  const { auth } = deps;
  const create = deps.createCredential ?? createPasskeyCredential;
  const proof = await proveSession(auth, input.password, input.passwordless);
  if (proof.passwordless) input.onPasswordless();
  const options = await auth.passkey.generateRegisterOptions({
    name: input.name,
  });
  input.onPrompt();
  const credential = await create(
    options as CreationOptionsJson,
    undefined,
    input.signal,
  );
  if (input.signal.aborted) return "aborted";
  await auth.passkey.verifyRegistration({
    response: credential,
    name: input.name,
  });
  return "registered";
}

export type RemovePasskeyInput = {
  readonly passkeyId: string;
  readonly password: string;
  readonly passwordless: boolean;
  /** The server already asked for a second-factor code on this page. */
  readonly factorRequired: boolean;
  readonly code: string;
  readonly codeKind: FactorCodeKind;
  readonly onPasswordless: () => void;
};

/**
 * Removes a passkey. When the server has asked for a factor proof, the code
 * (authenticator or backup) is verified in place on this same session first;
 * otherwise the session is proved like `registerPasskey`.
 */
export async function removePasskey(
  auth: PasskeyFlowAuth,
  input: RemovePasskeyInput,
): Promise<void> {
  if (input.factorRequired) {
    if (input.codeKind === "backup") {
      await auth.twoFactor.verifyBackupCode({ code: input.code });
    } else await auth.twoFactor.verifyTotp({ code: input.code });
  } else {
    const proof = await proveSession(auth, input.password, input.passwordless);
    if (proof.passwordless) input.onPasswordless();
  }
  await auth.passkey.deletePasskey({ id: input.passkeyId });
}
