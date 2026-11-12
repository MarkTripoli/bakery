import { type SecretsKeyConfig, SecretsKeyConfigSchema } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";

export const SecretCipherBindingSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Authenticated organization owning the credential.",
  ),
  applicationId: z.string().uuid().describe(
    "Application owning this encrypted credential.",
  ),
  secretId: z.string().uuid().describe("Immutable secret metadata identifier."),
  revision: z.number().int().positive().describe(
    "Immutable encrypted version revision.",
  ),
  keyId: SecretsKeyConfigSchema.shape.keyId.describe(
    "External key identity bound to this ciphertext.",
  ),
}).strict().describe(
  "Immutable project credential AES-GCM associated-data binding.",
);
export type SecretCipherBinding = z.infer<typeof SecretCipherBindingSchema>;
export const InstallationSecretCipherBindingSchema = z.object({
  secretId: z.string().uuid().describe(
    "Immutable installation-owned secret metadata identifier; the row has no organization or application.",
  ),
  revision: z.number().int().positive().describe(
    "Immutable encrypted version revision of the installation-owned secret.",
  ),
  keyId: SecretsKeyConfigSchema.shape.keyId.describe(
    "External key identity bound to this installation-owned ciphertext.",
  ),
}).strict().describe(
  "Installation-scoped AES-GCM associated-data binding; distinct from project bindings so neither ciphertext decrypts as the other.",
);
export type InstallationSecretCipherBinding = z.infer<
  typeof InstallationSecretCipherBindingSchema
>;
export const AuthAttemptVerifierCipherBindingSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization that owns the integration auth attempt.",
  ),
  attemptId: z.string().uuid().describe(
    "Integration auth attempt the PKCE verifier belongs to.",
  ),
  stateHash: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 hex of the state issued with this verifier; a rotated state needs a new ciphertext.",
  ),
  keyId: SecretsKeyConfigSchema.shape.keyId.describe(
    "External key identity bound to this verifier ciphertext.",
  ),
}).strict().describe(
  "Integration auth attempt PKCE verifier AES-GCM associated-data binding; distinct from project and installation bindings so no ciphertext decrypts as another kind.",
);
export type AuthAttemptVerifierCipherBinding = z.infer<
  typeof AuthAttemptVerifierCipherBindingSchema
>;
export const SlackIdentityNonceCipherBindingSchema = z.object({
  organizationId: z.string().uuid().describe(
    "Organization that owns the Slack identity attempt.",
  ),
  attemptId: z.string().uuid().describe(
    "Slack identity attempt the nonce belongs to.",
  ),
  stateHash: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 hex of the state issued with this nonce.",
  ),
  keyId: SecretsKeyConfigSchema.shape.keyId.describe(
    "External key identity bound to this nonce ciphertext.",
  ),
}).strict().describe(
  "Slack identity attempt nonce AES-GCM associated-data binding; distinct from the project, installation and PKCE verifier bindings so no ciphertext decrypts as another.",
);
export type SlackIdentityNonceCipherBinding = z.infer<
  typeof SlackIdentityNonceCipherBindingSchema
>;
export const SecretCipherSchema = z.object({
  ciphertext: z.instanceof(Uint8Array).describe(
    "Authenticated encrypted credential bytes including the GCM tag; storage only.",
  ),
  nonce: z.instanceof(Uint8Array).refine(
    (value) => value.length === 12,
    "Invalid cipher nonce.",
  ).describe("Fresh 96-bit AES-GCM nonce; immutable storage only."),
}).strict().describe(
  "Private encrypted credential version; never transported or audited.",
);
export type SecretCipher = z.infer<typeof SecretCipherSchema>;

export async function loadSecretKey(
  config?: SecretsKeyConfig,
): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const parsed = SecretsKeyConfigSchema.safeParse(config);
    if (!parsed.success) throw new Error("UNAVAILABLE");
    // Bounded read also rejects directories and malformed/oversized mounted keys.
    if (!(await Deno.stat(parsed.data.file)).isFile) {
      throw new Error("UNAVAILABLE");
    }
    const file = await Deno.open(parsed.data.file, { read: true });
    try {
      if (!(await file.stat()).isFile) throw new Error("UNAVAILABLE");
      bytes = new Uint8Array(33);
      let read = 0;
      while (read < bytes.length) {
        const size = await file.read(bytes.subarray(read));
        if (size === null) break;
        read += size;
      }
      if (read !== 32) throw new Error("UNAVAILABLE");
      return await crypto.subtle.importKey(
        "raw",
        bytes.subarray(0, 32),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    } finally {
      file.close();
    }
  } catch {
    throw new StandardError({ code: "STATE_CONFLICT" });
  } finally {
    bytes?.fill(0);
  }
}
function aad(binding: SecretCipherBinding): Uint8Array<ArrayBuffer> {
  const b = SecretCipherBindingSchema.parse(binding);
  return new TextEncoder().encode(
    JSON.stringify([
      1,
      b.organizationId,
      b.applicationId,
      b.secretId,
      b.revision,
      b.keyId,
    ]),
  );
}
function installationAad(
  binding: InstallationSecretCipherBinding,
): Uint8Array<ArrayBuffer> {
  const b = InstallationSecretCipherBindingSchema.parse(binding);
  return new TextEncoder().encode(
    JSON.stringify([2, "installation", b.secretId, b.revision, b.keyId]),
  );
}
function authAttemptVerifierAad(
  binding: AuthAttemptVerifierCipherBinding,
): Uint8Array<ArrayBuffer> {
  const b = AuthAttemptVerifierCipherBindingSchema.parse(binding);
  return new TextEncoder().encode(
    JSON.stringify([
      3,
      "integration_auth_attempt",
      b.organizationId,
      b.attemptId,
      b.stateHash,
      b.keyId,
    ]),
  );
}
function slackIdentityNonceAad(
  binding: SlackIdentityNonceCipherBinding,
): Uint8Array<ArrayBuffer> {
  const b = SlackIdentityNonceCipherBindingSchema.parse(binding);
  return new TextEncoder().encode(
    JSON.stringify([
      4,
      "slack_identity_attempt",
      b.organizationId,
      b.attemptId,
      b.stateHash,
      b.keyId,
    ]),
  );
}
async function encryptWith(
  key: CryptoKey,
  additionalData: () => Uint8Array<ArrayBuffer>,
  value: string,
): Promise<SecretCipher> {
  const plaintext = new TextEncoder().encode(value);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    return {
      nonce,
      ciphertext: new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: additionalData() },
          key,
          plaintext,
        ),
      ),
    };
  } finally {
    plaintext.fill(0);
  }
}
async function decryptWith(
  key: CryptoKey,
  additionalData: () => Uint8Array<ArrayBuffer>,
  cipher: SecretCipher,
): Promise<Uint8Array> {
  try {
    const parsed = SecretCipherSchema.parse(cipher);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: new Uint8Array(parsed.nonce),
          additionalData: additionalData(),
        },
        key,
        new Uint8Array(parsed.ciphertext),
      ),
    );
  } catch {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
}
export async function encryptSecret(
  key: CryptoKey,
  binding: SecretCipherBinding,
  value: string,
): Promise<SecretCipher> {
  return await encryptWith(key, () => aad(binding), value);
}
/** Private storage integrity oracle; metadata routes never call this. */
export async function decryptSecret(
  key: CryptoKey,
  binding: SecretCipherBinding,
  cipher: SecretCipher,
): Promise<Uint8Array> {
  return await decryptWith(key, () => aad(binding), cipher);
}
/** Encrypts an installation-owned credential, such as a GitHub App private key. */
export async function encryptInstallationSecret(
  key: CryptoKey,
  binding: InstallationSecretCipherBinding,
  value: string,
): Promise<SecretCipher> {
  return await encryptWith(key, () => installationAad(binding), value);
}
/** Private storage integrity oracle for installation-owned credentials; read routes never call this. */
export async function decryptInstallationSecret(
  key: CryptoKey,
  binding: InstallationSecretCipherBinding,
  cipher: SecretCipher,
): Promise<Uint8Array> {
  return await decryptWith(key, () => installationAad(binding), cipher);
}
/** Encrypts an integration auth attempt's PKCE verifier under its state. */
export async function encryptAuthAttemptVerifier(
  key: CryptoKey,
  binding: AuthAttemptVerifierCipherBinding,
  verifier: string,
): Promise<SecretCipher> {
  return await encryptWith(
    key,
    () => authAttemptVerifierAad(binding),
    verifier,
  );
}
/** Recovers a PKCE verifier for the code exchange; read routes never call this. */
export async function decryptAuthAttemptVerifier(
  key: CryptoKey,
  binding: AuthAttemptVerifierCipherBinding,
  cipher: SecretCipher,
): Promise<Uint8Array> {
  return await decryptWith(
    key,
    () => authAttemptVerifierAad(binding),
    cipher,
  );
}
/** Encrypts the nonce of a Slack identity attempt under its state. */
export async function encryptSlackIdentityNonce(
  key: CryptoKey,
  binding: SlackIdentityNonceCipherBinding,
  nonce: string,
): Promise<SecretCipher> {
  return await encryptWith(key, () => slackIdentityNonceAad(binding), nonce);
}
/** Recovers the nonce to check an identity token against; read routes never call this. */
export async function decryptSlackIdentityNonce(
  key: CryptoKey,
  binding: SlackIdentityNonceCipherBinding,
  cipher: SecretCipher,
): Promise<Uint8Array> {
  return await decryptWith(key, () => slackIdentityNonceAad(binding), cipher);
}
