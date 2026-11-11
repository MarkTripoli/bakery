import { StandardError } from "@bakery/contracts/http";

/** GitHub accepts App JWTs issued at most 60 s in the past and valid at most 10 min. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

const RSA_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
// AlgorithmIdentifier { rsaEncryption, NULL } for wrapping a PKCS#1 key.
const RSA_ENCRYPTION_IDENTIFIER = Uint8Array.of(
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
);

/**
 * The private key could not be read as an RSA PEM. The problem names only the
 * field; the value never reaches the response, a log or the error message.
 */
function malformedPrivateKey(): StandardError {
  return new StandardError({
    code: "MALFORMED_REQUEST",
    params: {
      issues: [{
        path: ["privateKey"],
        code: "invalid_private_key",
        message: "Private key must be an RSA private key in PEM format.",
      }],
    },
  });
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const header = derLength(length);
  const out = new Uint8Array(1 + header.length + length);
  out[0] = tag;
  out.set(header, 1);
  let offset = 1 + header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PrivateKeyInfo around an RSAPrivateKey, so WebCrypto can import GitHub's PKCS#1 download. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  return der(
    0x30,
    Uint8Array.of(0x02, 0x01, 0x00),
    RSA_ENCRYPTION_IDENTIFIER,
    der(0x04, pkcs1),
  );
}

const PEM =
  /^\s*-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END \1-----\s*$/;

/**
 * Imports a GitHub App private key: PKCS#1 (`RSA PRIVATE KEY`, GitHub's
 * download) or PKCS#8 (`PRIVATE KEY`). Anything else, including an
 * encrypted key or a non-RSA key, is MALFORMED_REQUEST.
 */
export async function importGitHubAppPrivateKey(
  pem: string,
): Promise<CryptoKey> {
  const match = PEM.exec(pem);
  if (!match) throw malformedPrivateKey();
  let body: Uint8Array;
  try {
    body = Uint8Array.from(
      atob(match[2].replace(/[\r\n]/g, "")),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw malformedPrivateKey();
  }
  const pkcs8 = match[1] === "RSA PRIVATE KEY" ? wrapPkcs1(body) : body;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8 as Uint8Array<ArrayBuffer>,
      RSA_ALGORITHM,
      false,
      ["sign"],
    );
  } catch {
    throw malformedPrivateKey();
  } finally {
    body.fill(0);
    pkcs8.fill(0);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Short-lived RS256 App JWT GitHub accepts on `GET /app`: issued 60 s in
 * the past for clock drift, valid nine minutes, issued by the App id.
 */
export async function signGitHubAppJwt(
  key: CryptoKey,
  appId: number,
  now: Date = new Date(),
): Promise<string> {
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${
    encode({
      iat: seconds - JWT_BACKDATE_SECONDS,
      exp: seconds + JWT_LIFETIME_SECONDS,
      iss: String(appId),
    })
  }`;
  const signature = await crypto.subtle.sign(
    RSA_ALGORITHM,
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}
