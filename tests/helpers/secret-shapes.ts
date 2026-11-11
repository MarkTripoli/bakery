/** Shapes a credential takes when it leaks: tokens, digests, JWS, key material. */
export const SECRET_SHAPES: readonly [string, RegExp][] = [
  [
    "compact JWS or JWT",
    /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/,
  ],
  ["sha256 hex digest", /\b[0-9a-f]{64}\b/i],
  [
    "prefixed secret token",
    /\b(?:sk|pk|tok|bkt|bky|pat|ghp|gho)_[A-Za-z0-9]{16,}|\bbsc_[A-Za-z0-9_-]{16,}/,
  ],
  ["bearer credential", /\bBearer\s+\S{8,}/i],
  ["PEM key material", /-----BEGIN [A-Z ]*KEY-----/],
  ["long base64 blob", /[A-Za-z0-9+/_-]{80,}={0,2}/],
];
