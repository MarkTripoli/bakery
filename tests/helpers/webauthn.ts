/**
 * A software WebAuthn authenticator for the Deno lanes: it produces the same
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` shapes a browser
 * would, signed by a real P-256 key, so `@simplewebauthn/server` verifies
 * them for real. No npm dependency: the encoder below is the small subset of
 * CBOR a WebAuthn ceremony needs.
 *
 * Every byte a test needs to corrupt is an override: the origin and RP ID
 * that go into the signed material, the user-verification flag, the
 * signature counter, and the assertion signature itself.
 */

export type CeremonyOverrides = {
  /** Origin written into `clientDataJSON`; defaults to the authenticator's. */
  readonly origin?: string;
  /** RP ID hashed into `authenticatorData`; defaults to the authenticator's. */
  readonly rpId?: string;
  /** `false` clears the UV flag; defaults to a verified user. */
  readonly userVerified?: boolean;
  /**
   * Signature counter. Registration defaults to 0 and an assertion to one
   * more than the highest counter emitted so far; an explicit value that is
   * higher advances that high-water mark, a lower one leaves it alone.
   */
  readonly counter?: number;
  /**
   * `"invalid"` corrupts the last bytes of an otherwise well-formed
   * assertion signature, so the credential resolves and only the
   * signature check can refuse it. Assertions only.
   */
  readonly signature?: "invalid";
};

export type SoftwareAuthenticator = {
  /** base64url credential id, also the plugin's `credentialID`. */
  readonly credentialId: string;
  register(
    options: { challenge: string },
    overrides?: CeremonyOverrides,
  ): Promise<Record<string, unknown>>;
  authenticate(
    options: { challenge: string },
    overrides?: CeremonyOverrides,
  ): Promise<Record<string, unknown>>;
};

/**
 * `Uint8Array<ArrayBuffer>`, the only form WebCrypto's `BufferSource`
 * parameters accept; the bare `Uint8Array` alias widens to
 * `ArrayBufferLike`, which includes `SharedArrayBuffer`.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** Cookie the plugin signs the challenge identifier into (`advanced.webAuthnChallengeCookie`). */
const CHALLENGE_COOKIE_NAME = "better-auth.better-auth-passkey";

/** https://www.w3.org/TR/webauthn-2/#flags */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

const textEncoder = new TextEncoder();

function concatBytes(parts: readonly Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function base64url(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

async function sha256(input: Bytes | string): Promise<Bytes> {
  const data = typeof input === "string" ? textEncoder.encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** CBOR initial byte plus its length/value argument, minimally encoded. */
function cborHead(major: number, value: number): Bytes {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  if (value < 0x10000) {
    return Uint8Array.of((major << 5) | 25, value >>> 8, value & 0xff);
  }
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

/** Major type 0 for non-negative, major type 1 for negative (`-1 - n`). */
function cborInt(value: number): Bytes {
  return value < 0 ? cborHead(1, -1 - value) : cborHead(0, value);
}

function cborBytes(value: Bytes): Bytes {
  return concatBytes([cborHead(2, value.length), value]);
}

function cborText(value: string): Bytes {
  const bytes = textEncoder.encode(value);
  return concatBytes([cborHead(3, bytes.length), bytes]);
}

function cborMap(entries: readonly (readonly [Bytes, Bytes])[]): Bytes {
  return concatBytes([
    cborHead(5, entries.length),
    ...entries.flatMap(([key, value]) => [key, value]),
  ]);
}

/** COSE_Key for ES256 from WebCrypto's raw `0x04 || x || y` export. */
function coseEc2Key(rawPublicKey: Bytes): Bytes {
  return cborMap([
    [cborInt(1), cborInt(2)], // kty: EC2
    [cborInt(3), cborInt(-7)], // alg: ES256
    [cborInt(-1), cborInt(1)], // crv: P-256
    [cborInt(-2), cborBytes(rawPublicKey.subarray(1, 33))],
    [cborInt(-3), cborBytes(rawPublicKey.subarray(33, 65))],
  ]);
}

/** DER INTEGER: minimal big-endian, prefixed with `0x00` when the high bit is set. */
function derInteger(bytes: Bytes): Bytes {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  const value = (trimmed[0] & 0x80) === 0x80
    ? concatBytes([Uint8Array.of(0), trimmed])
    : trimmed;
  return concatBytes([Uint8Array.of(0x02, value.length), value]);
}

/**
 * WebCrypto signs ECDSA as raw `r || s`; WebAuthn carries the DER
 * `SEQUENCE { INTEGER r, INTEGER s }` that `unwrapEC2Signature` parses.
 */
function derSignature(raw: Bytes): Bytes {
  const body = concatBytes([
    derInteger(raw.subarray(0, 32)),
    derInteger(raw.subarray(32)),
  ]);
  return concatBytes([Uint8Array.of(0x30, body.length), body]);
}

async function authenticatorData(options: {
  rpId: string;
  flags: number;
  counter: number;
  attestedCredential?: Bytes;
}): Promise<Bytes> {
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, options.counter, false);
  const head = [
    await sha256(options.rpId),
    Uint8Array.of(options.flags),
    counterBytes,
  ];
  return concatBytes(
    options.attestedCredential ? [...head, options.attestedCredential] : head,
  );
}

export async function createSoftwareAuthenticator(
  defaults: { origin: string; rpId: string },
): Promise<SoftwareAuthenticator> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const rawPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = base64url(credentialIdBytes);
  let signCount = 0;

  return {
    credentialId,
    async register(options, overrides) {
      const clientData = textEncoder.encode(JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: overrides?.origin ?? defaults.origin,
        crossOrigin: false,
      }));
      const attestedCredential = concatBytes([
        // All-zero AAGUID: `attestation: "none"` identifies no model.
        new Uint8Array(16),
        Uint8Array.of(
          credentialIdBytes.length >>> 8,
          credentialIdBytes.length & 0xff,
        ),
        credentialIdBytes,
        coseEc2Key(rawPublicKey),
      ]);
      signCount = overrides?.counter ?? 0;
      const authData = await authenticatorData({
        rpId: overrides?.rpId ?? defaults.rpId,
        flags: FLAG_USER_PRESENT | FLAG_ATTESTED_CREDENTIAL_DATA |
          (overrides?.userVerified === false ? 0 : FLAG_USER_VERIFIED),
        counter: signCount,
        attestedCredential,
      });
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(clientData),
          attestationObject: base64url(cborMap([
            [cborText("fmt"), cborText("none")],
            [cborText("attStmt"), cborMap([])],
            [cborText("authData"), cborBytes(authData)],
          ])),
          transports: ["internal"],
        },
      };
    },
    async authenticate(options, overrides) {
      const clientData = textEncoder.encode(JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin: overrides?.origin ?? defaults.origin,
        crossOrigin: false,
      }));
      const counter = overrides?.counter ?? signCount + 1;
      signCount = Math.max(signCount, counter);
      const authData = await authenticatorData({
        rpId: overrides?.rpId ?? defaults.rpId,
        flags: FLAG_USER_PRESENT |
          (overrides?.userVerified === false ? 0 : FLAG_USER_VERIFIED),
        counter,
      });
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keyPair.privateKey,
          concatBytes([authData, await sha256(clientData)]),
        ),
      );
      if (overrides?.signature === "invalid") {
        // Flip the low bit of the last `s` byte: still a valid DER
        // INTEGER, so the parser accepts it and only the curve math fails.
        signature[signature.length - 1] ^= 0x01;
      }
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(clientData),
          authenticatorData: base64url(authData),
          signature: base64url(derSignature(signature)),
        },
      };
    },
  };
}

/** The `better-auth.better-auth-passkey=<token>.<sig>` pair a ceremony must echo back. */
export function challengeCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.startsWith(`${CHALLENGE_COOKIE_NAME}=`)
  );
  if (!cookie) throw new Error("PASSKEY_CHALLENGE_COOKIE_REQUIRED");
  return cookie.split(";", 1)[0];
}

/** The `verification.identifier` the plugin stored: the signed cookie value before its first `.`. */
export function challengeIdentifier(response: Response): string {
  const value = challengeCookie(response).slice(
    CHALLENGE_COOKIE_NAME.length + 1,
  );
  return decodeURIComponent(value).split(".", 1)[0];
}
