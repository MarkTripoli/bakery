/**
 * Plugin SDK version ranges (#15, B14.01).
 *
 * A package version declares the range of plugin SDK versions it accepts. The
 * host refuses to activate a version whose range does not contain the SDK it is
 * running, so this module decides compatibility and nothing else.
 *
 * The grammar is deliberately a strict subset of npm's. A range the host cannot
 * interpret is refused at version create rather than assumed compatible: a
 * plugin that cannot be proven to fit the host must not be activated, and
 * "unparseable" is not the same answer as "fits". Supporting more of npm's
 * syntax later is additive; guessing at it now is not, because a wrong guess
 * activates code the publisher never claimed would run.
 */

export type ParsedVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
}>;

export type ComparatorOperator = "=" | ">" | ">=" | "<" | "<=";

export type SdkComparator = Readonly<{
  operator: ComparatorOperator;
  version: ParsedVersion;
}>;

/**
 * One parseable alternative: a conjunction of comparators that must all hold.
 * A range is a list of these, any one of which being satisfied satisfies the
 * range (the `||` spelling).
 */
export type SdkRangeAlternative = readonly SdkComparator[];

export type SdkRangeSyntaxErrorCode =
  | "EMPTY"
  | "UNSUPPORTED_SYNTAX"
  | "MALFORMED_VERSION";

export class SdkRangeSyntaxError extends Error {
  readonly code: SdkRangeSyntaxErrorCode;

  constructor(code: SdkRangeSyntaxErrorCode, message: string) {
    super(message);
    this.name = "SdkRangeSyntaxError";
    this.code = code;
  }
}

/**
 * The plugin SDK the host implements. A version's `sdkRange` must accept this
 * value or the version cannot be activated.
 *
 * It lives here rather than in a `packages/plugin-sdk` package because that
 * package does not exist yet; moving one constant into a package of its own
 * would suggest an SDK surface that is not there. It moves when the SDK lands
 * with real content.
 */
export const PLUGIN_SDK_VERSION: ParsedVersion = Object.freeze({
  major: 1,
  minor: 0,
  patch: 0,
});

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse a bare `MAJOR.MINOR.PATCH` version, refusing anything looser. */
export function parseVersion(text: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) {
    throw new SdkRangeSyntaxError(
      "MALFORMED_VERSION",
      `"${text}" is not a MAJOR.MINOR.PATCH version.`,
    );
  }
  const [, major, minor, patch] = match;
  return {
    // Number() on a digits-only capture cannot produce NaN, and the pattern
    // already refused signs, decimals and exponents.
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/** Total order on versions: negative when `a` precedes `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Parse a range into alternatives of comparators.
 *
 * Accepted: `1.2.3`, `=1.2.3`, `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3`,
 * `^1.2.3`, `~1.2.3`, the same joined by spaces as a conjunction, and
 * alternatives separated by `||`.
 */
export function parseSdkRange(range: string): readonly SdkRangeAlternative[] {
  const text = range.trim();
  if (text === "") {
    throw new SdkRangeSyntaxError("EMPTY", "The SDK range is empty.");
  }
  return text.split("||").map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      throw new SdkRangeSyntaxError(
        "EMPTY",
        `"${range}" has an empty alternative.`,
      );
    }
    return tokens.flatMap((token) => comparatorsFor(token));
  });
}

function comparatorsFor(token: string): readonly SdkComparator[] {
  if (token.startsWith("^")) {
    const version = parseVersion(token.slice(1));
    // Caret means "same left-most non-zero component": ^1.2.3 allows <2.0.0,
    // while ^0.2.3 allows only <0.3.0 because a 0.x major is unstable by
    // convention and the publisher's intent there is a narrower promise.
    const ceiling = version.major > 0
      ? { major: version.major + 1, minor: 0, patch: 0 }
      : version.minor > 0
      ? { major: 0, minor: version.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: version.patch + 1 };
    return [
      { operator: ">=", version },
      { operator: "<", version: ceiling },
    ];
  }
  if (token.startsWith("~")) {
    const version = parseVersion(token.slice(1));
    // Tilde means patch-level updates within the named minor.
    return [
      { operator: ">=", version },
      {
        operator: "<",
        version: { major: version.major, minor: version.minor + 1, patch: 0 },
      },
    ];
  }
  for (const operator of [">=", "<=", ">", "<"] as const) {
    if (token.startsWith(operator)) {
      return [{
        operator,
        version: parseVersion(token.slice(operator.length)),
      }];
    }
  }
  if (token.startsWith("=")) {
    return [{ operator: "=", version: parseVersion(token.slice(1)) }];
  }
  // A bare version is an exact pin, matching the "=" spelling.
  return [{ operator: "=", version: parseVersion(token) }];
}

function holds(comparator: SdkComparator, candidate: ParsedVersion): boolean {
  const order = compareVersions(candidate, comparator.version);
  switch (comparator.operator) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
  }
}

/**
 * Whether `candidate` satisfies `range`.
 *
 * Throws `SdkRangeSyntaxError` for a range this host cannot read. Callers that
 * are validating publisher input catch it and refuse the version; callers that
 * are deciding activation have already validated, so a throw there means the
 * stored range was not validated when it was written.
 */
export function satisfiesSdkRange(
  range: string,
  candidate: ParsedVersion = PLUGIN_SDK_VERSION,
): boolean {
  const alternatives = parseSdkRange(range);
  return alternatives.some((alternative) =>
    alternative.every((comparator) => holds(comparator, candidate))
  );
}
