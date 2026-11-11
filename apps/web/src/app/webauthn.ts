/**
 * Native WebAuthn ceremony helpers: `navigator.credentials.create/get` with
 * local base64url conversion, so the web app needs no ceremony library.
 *
 * The auth provider speaks the WebAuthn JSON dialect (binary members are
 * unpadded base64url strings); the browser API takes `ArrayBuffer`s. These
 * helpers translate both ways and map the browser's failures onto the three
 * outcomes the screens render: `canceled`, `unsupported` and `failed`.
 *
 * Types are structural on purpose: the helpers run under Deno unit tests,
 * which carry no DOM `PublicKeyCredential` typings.
 */

/** Why a ceremony ended without a credential. */
export type WebAuthnFailureKind = "canceled" | "unsupported" | "failed";

export class WebAuthnCeremonyError extends Error {
  override readonly name = "WebAuthnCeremonyError";
  readonly kind: WebAuthnFailureKind;

  constructor(kind: WebAuthnFailureKind, cause?: unknown) {
    super(`WebAuthn ceremony ended: ${kind}`, { cause });
    this.kind = kind;
  }
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Decodes unpadded (or padded) base64url into bytes. */
export function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .replace(/=+$/, "");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** Encodes bytes as unpadded base64url. */
export function bufferToBase64url(
  buffer: ArrayBuffer | ArrayBufferView,
): string {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63] +
      BASE64URL_ALPHABET[(chunk >> 12) & 63];
    if (index + 1 < bytes.length) {
      output += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    }
    if (index + 2 < bytes.length) output += BASE64URL_ALPHABET[chunk & 63];
  }
  return output;
}

type DescriptorJson = {
  readonly id: string;
  readonly type?: string;
  readonly transports?: readonly string[];
};

type Descriptor = {
  readonly id: ArrayBuffer;
  readonly type: string;
  readonly transports?: readonly string[];
};

function decodeDescriptors(
  descriptors: readonly DescriptorJson[] | undefined,
): Descriptor[] | undefined {
  return descriptors?.map((descriptor) => ({
    ...descriptor,
    id: base64urlToBuffer(descriptor.id),
    type: descriptor.type ?? "public-key",
  }));
}

/** WebAuthn creation options as the provider sends them (JSON dialect). */
export type CreationOptionsJson = {
  readonly challenge: string;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly displayName?: string;
  };
  readonly excludeCredentials?: readonly DescriptorJson[];
} & Readonly<Record<string, unknown>>;

/** WebAuthn request options as the provider sends them (JSON dialect). */
export type RequestOptionsJson = {
  readonly challenge: string;
  readonly allowCredentials?: readonly DescriptorJson[];
} & Readonly<Record<string, unknown>>;

/** The decoded `publicKey` member handed to `navigator.credentials.create`. */
export type DecodedCreationOptions = Readonly<Record<string, unknown>> & {
  readonly challenge: ArrayBuffer;
  readonly user: Readonly<Record<string, unknown>> & {
    readonly id: ArrayBuffer;
  };
  readonly excludeCredentials?: readonly Descriptor[];
};

/** The decoded `publicKey` member handed to `navigator.credentials.get`. */
export type DecodedRequestOptions = Readonly<Record<string, unknown>> & {
  readonly challenge: ArrayBuffer;
  readonly allowCredentials?: readonly Descriptor[];
};

/** Decodes `challenge`, `user.id` and every `excludeCredentials[].id`. */
export function decodeCreationOptions(
  options: CreationOptionsJson,
): DecodedCreationOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: { ...options.user, id: base64urlToBuffer(options.user.id) },
    excludeCredentials: decodeDescriptors(options.excludeCredentials),
  };
}

/** Decodes `challenge` and every `allowCredentials[].id`. */
export function decodeRequestOptions(
  options: RequestOptionsJson,
): DecodedRequestOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: decodeDescriptors(options.allowCredentials),
  };
}

type CredentialLike = {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: Readonly<Record<string, unknown>>;
  readonly authenticatorAttachment?: string | null;
  getClientExtensionResults?: () => unknown;
};

function isCredentialLike(value: unknown): value is CredentialLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    candidate.rawId instanceof ArrayBuffer &&
    typeof candidate.type === "string" &&
    candidate.response !== null && typeof candidate.response === "object";
}

function encodeBuffer(value: unknown): string | undefined {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    ? bufferToBase64url(value)
    : undefined;
}

function transportsOf(response: Readonly<Record<string, unknown>>): string[] {
  const getTransports = response.getTransports;
  if (typeof getTransports !== "function") return [];
  const transports: unknown = getTransports.call(response);
  return Array.isArray(transports)
    ? transports.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function baseJson(credential: CredentialLike) {
  // `id` is the unpadded base64url of `rawId` by spec; deriving it from the
  // bytes keeps the pair equal even if a browser reports a padded `id`.
  const rawId = bufferToBase64url(credential.rawId);
  return {
    id: rawId,
    rawId,
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

/** `RegistrationResponseJSON` for `verify-registration`. */
export function encodeRegistrationCredential(
  credential: unknown,
): Record<string, unknown> {
  if (!isCredentialLike(credential)) {
    throw new WebAuthnCeremonyError("failed");
  }
  const response = credential.response;
  const callOptional = (name: string): unknown => {
    const method = response[name];
    return typeof method === "function" ? method.call(response) : undefined;
  };
  return {
    ...baseJson(credential),
    response: {
      clientDataJSON: encodeBuffer(response.clientDataJSON),
      attestationObject: encodeBuffer(response.attestationObject),
      transports: transportsOf(response),
      authenticatorData: encodeBuffer(callOptional("getAuthenticatorData")),
      publicKey: encodeBuffer(callOptional("getPublicKey")),
      publicKeyAlgorithm: callOptional("getPublicKeyAlgorithm"),
    },
  };
}

/** `AuthenticationResponseJSON` for an assertion. */
export function encodeAuthenticationCredential(
  credential: unknown,
): Record<string, unknown> {
  if (!isCredentialLike(credential)) {
    throw new WebAuthnCeremonyError("failed");
  }
  const response = credential.response;
  return {
    ...baseJson(credential),
    response: {
      clientDataJSON: encodeBuffer(response.clientDataJSON),
      authenticatorData: encodeBuffer(response.authenticatorData),
      signature: encodeBuffer(response.signature),
      userHandle: encodeBuffer(response.userHandle),
    },
  };
}

/** The slice of `navigator.credentials` the ceremony needs. */
export type CredentialsContainerLike = {
  create(
    options: { publicKey: DecodedCreationOptions; signal?: AbortSignal },
  ): Promise<unknown>;
  get(
    options: { publicKey: DecodedRequestOptions; signal?: AbortSignal },
  ): Promise<unknown>;
};

/** `navigator.credentials`, or `null` where the API does not exist. */
export function browserCredentials(): CredentialsContainerLike | null {
  const credentials = (globalThis as unknown as {
    navigator?: { credentials?: Partial<CredentialsContainerLike> };
  }).navigator?.credentials;
  return credentials !== undefined &&
      typeof credentials.create === "function" &&
      typeof credentials.get === "function"
    ? credentials as CredentialsContainerLike
    : null;
}

/**
 * Maps whatever a ceremony threw onto an outcome: the person dismissing the
 * prompt (`NotAllowedError`, `AbortError`) is `canceled`, a browser without
 * the API or authenticator support (`NotSupportedError`) is `unsupported`,
 * everything else is `failed`.
 */
export function classifyWebAuthnError(error: unknown): WebAuthnFailureKind {
  if (error instanceof WebAuthnCeremonyError) return error.kind;
  const name = error !== null && typeof error === "object" && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "NotAllowedError" || name === "AbortError") return "canceled";
  if (name === "NotSupportedError") return "unsupported";
  return "failed";
}

/**
 * Runs `navigator.credentials.create` for provider options and returns the
 * JSON body `verify-registration` expects. Aborting `signal` cancels the
 * browser prompt, which then reports `canceled`. Throws `WebAuthnCeremonyError`.
 */
export async function createPasskeyCredential(
  options: CreationOptionsJson,
  credentials: CredentialsContainerLike | null = browserCredentials(),
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (credentials === null) throw new WebAuthnCeremonyError("unsupported");
  try {
    const credential = await credentials.create({
      publicKey: decodeCreationOptions(options),
      signal,
    });
    if (credential === null || credential === undefined) {
      throw new WebAuthnCeremonyError("canceled");
    }
    return encodeRegistrationCredential(credential);
  } catch (error) {
    throw new WebAuthnCeremonyError(classifyWebAuthnError(error), error);
  }
}

/**
 * Runs `navigator.credentials.get` for provider options and returns the JSON
 * assertion. Throws `WebAuthnCeremonyError`.
 */
export async function getPasskeyAssertion(
  options: RequestOptionsJson,
  credentials: CredentialsContainerLike | null = browserCredentials(),
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (credentials === null) throw new WebAuthnCeremonyError("unsupported");
  try {
    const credential = await credentials.get({
      publicKey: decodeRequestOptions(options),
      signal,
    });
    if (credential === null || credential === undefined) {
      throw new WebAuthnCeremonyError("canceled");
    }
    return encodeAuthenticationCredential(credential);
  } catch (error) {
    throw new WebAuthnCeremonyError(classifyWebAuthnError(error), error);
  }
}
