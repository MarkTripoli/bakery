/**
 * Deterministic pseudo-locale generator. Fills only the rows a pseudo catalog
 * is missing, never rewrites an existing key:
 *
 * - `en-XA`: `⟦accented text …padding⟧`, at least ceil(1.35 x source length).
 * - `ar-XB`: `⟪source⟫`, the RTL-marked wrapper newest rows already use.
 *
 * Run `pnpm --dir packages/i18n pseudo` to write missing rows, or add
 * `--check` to fail when any row is missing without writing.
 */

/** Minimum en-XA length as a multiple of the English source length. */
export const PSEUDO_EXPANSION_RATIO = 1.35;

const ACCENTS: Readonly<Record<string, string>> = {
  a: "à",
  b: "ƀ",
  c: "ç",
  d: "ð",
  e: "ë",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "ï",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ô",
  p: "þ",
  q: "ǫ",
  r: "ŕ",
  s: "š",
  t: "ŧ",
  u: "û",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ÿ",
  z: "ž",
  A: "À",
  B: "Ɓ",
  C: "Ç",
  D: "Ð",
  E: "Ë",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Ï",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ô",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ŧ",
  U: "Û",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ÿ",
  Z: "Ž",
};

const FILLER = "ŧëšŧ çôþÿ ";

/** Required en-XA length for an English source of the given length. */
export function minimumPseudoLength(sourceLength: number): number {
  return Math.ceil(PSEUDO_EXPANSION_RATIO * sourceLength);
}

/**
 * Accents literal letters while leaving ICU syntax untouched: every
 * `{...}` argument or plural/select block is copied verbatim, so argument
 * names and keywords survive.
 */
function accent(message: string): string {
  let depth = 0;
  let output = "";
  for (const character of message) {
    if (character === "{") depth += 1;
    output += depth === 0 ? ACCENTS[character] ?? character : character;
    if (character === "}" && depth > 0) depth -= 1;
  }
  return output;
}

/** en-XA row for an English message, padded to the minimum expansion. */
export function pseudoAccented(message: string): string {
  const body = `⟦${accent(message)}⟧`;
  const missing = minimumPseudoLength(message.length) - body.length;
  if (missing <= 0) return body;
  const filler = Array.from(
    { length: missing - 1 },
    (_, index) => FILLER[index % FILLER.length],
  ).join("").replace(/ $/, "ŧ");
  const padding = missing === 1 ? "…" : ` ${filler}`;
  return `⟦${accent(message)}${padding}⟧`;
}

/** ar-XB row for an English message: the RTL-marked wrapper only. */
export function pseudoBidi(message: string): string {
  return `⟪${message}⟫`;
}

/**
 * Returns `existing` plus a generated row for every English key it lacks.
 * Existing rows keep their text and order; new rows follow in English order.
 */
export function fillMissingRows(
  english: Readonly<Record<string, string>>,
  existing: Readonly<Record<string, string>>,
  generate: (message: string) => string,
): Record<string, string> {
  const result: Record<string, string> = { ...existing };
  for (const [key, message] of Object.entries(english)) {
    if (!(key in result)) result[key] = generate(message);
  }
  return result;
}

if (import.meta.main) {
  const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
  const checkOnly = Deno.args.includes("--check");
  const read = async (locale: string) =>
    JSON.parse(
      await Deno.readTextFile(`${root}locales/${locale}.json`),
    ) as Record<string, string>;
  const english = await read("en");
  let missingTotal = 0;
  for (
    const [locale, generate] of [
      ["en-XA", pseudoAccented],
      ["ar-XB", pseudoBidi],
    ] as const
  ) {
    const existing = await read(locale);
    const filled = fillMissingRows(english, existing, generate);
    const missing = Object.keys(filled).length - Object.keys(existing).length;
    missingTotal += missing;
    if (missing > 0 && !checkOnly) {
      await Deno.writeTextFile(
        `${root}locales/${locale}.json`,
        `${JSON.stringify(filled, null, 2)}\n`,
      );
    }
    console.log(
      `${locale}: ${missing} missing row${missing === 1 ? "" : "s"}${
        missing > 0 && !checkOnly ? " written" : ""
      }.`,
    );
  }
  if (checkOnly && missingTotal > 0) Deno.exit(1);
}
