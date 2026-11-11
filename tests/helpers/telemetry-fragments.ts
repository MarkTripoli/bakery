/**
 * Seeded generators of credential-shaped material, for measuring how much of a
 * secret can reach a telemetry field. Nothing here is a real credential, and
 * none is written as a literal: each value is drawn from an alphabet at run
 * time, so no secret scanner has anything to find in the source.
 */

/** Seeded xorshift32, so a run draws the same numbers every time. */
export function seeded(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

export type Random = () => number;

const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const lower = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";

/** Character sets credentials are drawn from. */
export const alphabets = {
  base62: upper + lower + digits,
  base64: `${upper}${lower}${digits}+/`,
  base64url: `${upper}${lower}${digits}-_`,
  hex: "0123456789abcdef",
  base36lower: digits + lower,
  base32lower: lower + "234567",
} as const;

export type AlphabetName = keyof typeof alphabets;

/** `length` characters drawn uniformly from `alphabet`. */
export function draw(random: Random, alphabet: string, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[random() % alphabet.length];
  }
  return out;
}

/** Credential formats, each built from pieces so no literal resembles one. */
export const credentialShapes: Record<string, (random: Random) => string> = {
  githubClassic: (r) => ["gh", "p_", draw(r, alphabets.base62, 36)].join(""),
  githubFineGrained: (r) =>
    [
      "github",
      "_pat_",
      draw(r, alphabets.base62, 22),
      "_",
      draw(r, alphabets.base62, 59),
    ].join(""),
  awsSecretKey: (r) => draw(r, alphabets.base64, 40),
  jwtLike: (r) =>
    [
      draw(r, alphabets.base64url, 36),
      draw(r, alphabets.base64url, 80),
      draw(r, alphabets.base64url, 43),
    ].join("."),
  slackLike: (r) =>
    [
      "xo",
      "xb-",
      draw(r, digits, 12),
      "-",
      draw(r, digits, 13),
      "-",
      draw(r, alphabets.base62, 24),
    ].join(""),
  hex40: (r) => draw(r, alphabets.hex, 40),
  hex64: (r) => draw(r, alphabets.hex, 64),
  base36lower32: (r) => draw(r, alphabets.base36lower, 32),
  base32lower32: (r) => draw(r, alphabets.base32lower, 32),
};

/** Cuts `secret` into three consecutive pieces of at least `minimum` characters. */
export function splitInThree(
  random: Random,
  secret: string,
  minimum = 4,
): [string, string, string] {
  const room = secret.length - 3 * minimum;
  if (room < 0) throw new RangeError("secret too short to split");
  const first = minimum + (random() % (room + 1));
  const second = minimum +
    (random() % (secret.length - first - 2 * minimum + 1));
  return [
    secret.slice(0, first),
    secret.slice(first, first + second),
    secret.slice(first + second),
  ];
}
