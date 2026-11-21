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

/**
 * A plugin's declared state namespace, validated as a name rather than a path.
 *
 * State lives in rows keyed by (install, owner, namespace, key), so a namespace
 * cannot escape anything by itself. The rules are nonetheless the archive
 * path's: no separators, no relative segments, no control characters, no case
 * folding surprises. Namespace and key from two different plugins must not be
 * able to alias each other, and a value that "looks like" a path invites a
 * future reader to treat it as one.
 */
export class PluginManifestError extends Error {
  constructor(
    readonly code: PluginManifestErrorCode,
    readonly detail: string,
  ) {
    super(`plugin manifest refused: ${code} (${detail})`);
    this.name = "PluginManifestError";
  }
}

export type PluginManifestErrorCode =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_KEY"
  | "CAPABILITIES_NOT_A_LIST"
  | "CAPABILITY_NOT_A_NAME"
  | "CAPABILITY_NOT_ALLOWED"
  | "LOCALE_NOT_A_NAME"
  | "LOCALE_REPLACES_CORE"
  | "NAMESPACE_INVALID"
  | "STATE_SCHEMA_VERSION_INVALID"
  | "PAGES_NOT_A_LIST"
  | "PAGES_TOO_MANY"
  | "PAGE_INVALID"
  | "PAGE_ID_DUPLICATE"
  | "PAGES_WITHOUT_UI_PAGE";

const NAMESPACE_MAX = 64;
const KEY_MAX = 128;

/**
 * The characters that let a name escape its namespace.
 *
 * Written as an explicit scan rather than a regex with a `\u0000` escape: the
 * lint rule that forbids control characters in a regular expression is right to
 * fire, and the scan states the intent more plainly than a character class.
 */
function escapesNamespace(value: string): boolean {
  for (const char of value) {
    if (char === "/" || char === "\\" || char === "\u0000") return true;
  }
  return value.includes("..");
}

/**
 * The capabilities an install may be granted.
 *
 * This is an allowlist, not a pattern. A manifest naming something outside it
 * is refused at install rather than dropped, because silently discarding a
 * requested capability would leave an install whose manifest and grants
 * disagree, and the plugin would fail later in a way nobody can attribute.
 */
export const PLUGIN_INSTALL_CAPABILITIES = Object.freeze(
  [
    "state.read",
    "state.write",
    "ui.page",
    "ui.panel",
    "commands.run",
    "tools.invoke",
    "jobs.schedule",
  ] as const,
);
export type PluginInstallCapability =
  typeof PLUGIN_INSTALL_CAPABILITIES[number];

const CORE_LOCALE_PREFIX = "bakery.";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function assertPluginNamespace(
  value: string,
  label = "namespace",
): void {
  if (value.length === 0) {
    throw new PluginManifestError("NAMESPACE_INVALID", `${label} empty`);
  }
  if (value.length > NAMESPACE_MAX) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      `${label} longer than ${NAMESPACE_MAX}`,
    );
  }
  if (escapesNamespace(value)) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      `${label} contains a path separator or traversal`,
    );
  }
  if (!NAME_PATTERN.test(value)) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      `${label} is not a lowercase name`,
    );
  }
}

/** A state key is a name too, with the archive path's bounds and refusals. */
export function assertPluginStateKey(value: string): void {
  if (value.length === 0) {
    throw new PluginManifestError("NAMESPACE_INVALID", "key empty");
  }
  if (value.length > KEY_MAX) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      `key longer than ${KEY_MAX}`,
    );
  }
  if (
    escapesNamespace(value) ||
    value.split(".").some((part) => part === "" || part === "..")
  ) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      "key contains a path separator or traversal",
    );
  }
}

/**
 * The validated shape of a version's manifest, as far as installing it cares.
 *
 * The manifest may carry anything the SDK adds later; what is read here is the
 * part that decides authority: the capabilities it asks for, the state it wants
 * to keep, and the locale catalog it ships. Unknown top-level keys are refused
 * rather than ignored, because a manifest whose author believed a key had an
 * effect it does not have is a security bug reported as a compatibility bug.
 */
export type PluginManifest = Readonly<{
  name: string;
  requestedCapabilities: readonly PluginInstallCapability[];
  locales: readonly string[];
  stateSchemaVersion: number;
  stateNamespaces: readonly string[];
  pages: readonly PluginPage[];
}>;

/**
 * One page a version adds (#76, FS24): a stable id, the title Bakery shows in
 * its own strip and sidebar, and the HTML file in the bundle that the page's
 * sealed frame loads.
 */
export type PluginPage = Readonly<{
  id: string;
  title: string;
  file: string;
}>;

/**
 * Bounds on a version's pages. The sidebar shows six and folds the rest under
 * More, so twenty is room to grow rather than a target; the file bound is the
 * one the document read enforces before it answers.
 */
export const PLUGIN_PAGE_LIMITS = Object.freeze({
  maxPages: 20,
  idMaxLength: 64,
  titleMaxLength: 80,
  fileMaxLength: 200,
  documentMaxBytes: 2 * 1024 * 1024,
});

const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PAGE_FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PAGE_KEYS = new Set(["id", "title", "file"]);

function pageRefusal(code: PluginManifestErrorCode, detail: string): never {
  throw new PluginManifestError(code, detail);
}

/**
 * True for a character a title must not carry: C0/C1 controls and the
 * bidirectional overrides, which would let a title reorder the text Bakery
 * draws around it ("Provided by the plugin ...").
 */
function unsafeTitleCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * The bundle path a page loads, validated as a path that cannot leave the
 * bundle: relative, forward slashes only, no empty, `.` or `..` segment, every
 * segment a plain file name, and an `.html` file. The archive reader applies
 * its own path rules again when the file is looked up, so this is the first of
 * two locks rather than the only one.
 */
export function assertPluginPageFile(file: string): void {
  if (file.length === 0 || file.length > PLUGIN_PAGE_LIMITS.fileMaxLength) {
    pageRefusal("PAGE_INVALID", "page file is empty or too long");
  }
  const segments = file.split("/");
  if (
    segments.some((segment) =>
      segment === "." || segment === ".." || !PAGE_FILE_SEGMENT.test(segment)
    )
  ) {
    pageRefusal("PAGE_INVALID", "page file is not a plain relative path");
  }
  if (!file.endsWith(".html") || file === "manifest.json") {
    pageRefusal("PAGE_INVALID", "page file must be an .html file");
  }
}

/**
 * A manifest's `pages`, validated strictly. Absent means none. A page list on a
 * version that does not ask for `ui.page` is refused, because its author
 * believed the pages would show and they never could.
 */
export function parsePluginPages(
  value: unknown,
  requestedCapabilities: readonly string[],
): readonly PluginPage[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    pageRefusal("PAGES_NOT_A_LIST", "pages must be a list");
  }
  if (value.length > PLUGIN_PAGE_LIMITS.maxPages) {
    pageRefusal(
      "PAGES_TOO_MANY",
      `at most ${PLUGIN_PAGE_LIMITS.maxPages} pages`,
    );
  }
  if (value.length > 0 && !requestedCapabilities.includes("ui.page")) {
    pageRefusal(
      "PAGES_WITHOUT_UI_PAGE",
      "pages are declared but ui.page is not requested",
    );
  }
  const seen = new Set<string>();
  const pages: PluginPage[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      pageRefusal("PAGE_INVALID", "a page is not an object");
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!PAGE_KEYS.has(key)) {
        pageRefusal("PAGE_INVALID", `unknown page key "${key}"`);
      }
    }
    const { id, title, file } = record;
    if (
      typeof id !== "string" || id.length > PLUGIN_PAGE_LIMITS.idMaxLength ||
      !PAGE_ID_PATTERN.test(id)
    ) {
      pageRefusal("PAGE_INVALID", "a page id is not a lowercase name");
    }
    if (seen.has(id)) {
      pageRefusal("PAGE_ID_DUPLICATE", `page id "${id}" repeats`);
    }
    seen.add(id);
    if (
      typeof title !== "string" || title.trim() !== title ||
      title.length === 0 || title.length > PLUGIN_PAGE_LIMITS.titleMaxLength ||
      [...title].some(unsafeTitleCharacter)
    ) {
      pageRefusal("PAGE_INVALID", `page "${id}" has an unusable title`);
    }
    if (typeof file !== "string") {
      pageRefusal("PAGE_INVALID", `page "${id}" names no file`);
    }
    assertPluginPageFile(file);
    pages.push(Object.freeze({ id, title, file }));
  }
  return Object.freeze(pages);
}

const MANIFEST_KEYS = new Set([
  "name",
  "requestedCapabilities",
  "locales",
  "stateSchemaVersion",
  "stateNamespaces",
  "pages",
]);

export function parsePluginManifest(manifest: unknown): PluginManifest {
  if (
    manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
  ) {
    throw new PluginManifestError(
      "NOT_AN_OBJECT",
      "manifest must be an object",
    );
  }
  const record = manifest as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!MANIFEST_KEYS.has(key)) {
      throw new PluginManifestError(
        "UNKNOWN_KEY",
        `unknown manifest key "${key}"`,
      );
    }
  }

  const name = record.name;
  if (
    typeof name !== "string" || !NAME_PATTERN.test(name) ||
    name.length > NAMESPACE_MAX
  ) {
    throw new PluginManifestError(
      "CAPABILITY_NOT_A_NAME",
      "manifest name is not a lowercase name",
    );
  }

  const capabilities = record.requestedCapabilities;
  if (!Array.isArray(capabilities)) {
    throw new PluginManifestError(
      "CAPABILITIES_NOT_A_LIST",
      "requestedCapabilities must be a list",
    );
  }
  const allowed = new Set<string>(PLUGIN_INSTALL_CAPABILITIES);
  const requested: PluginInstallCapability[] = [];
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !NAME_PATTERN.test(capability)) {
      throw new PluginManifestError(
        "CAPABILITY_NOT_A_NAME",
        "a requested capability is not a name",
      );
    }
    if (!allowed.has(capability)) {
      // The refusal, not a filter: an install whose grants disagree with its
      // manifest is the state nobody can debug later.
      throw new PluginManifestError(
        "CAPABILITY_NOT_ALLOWED",
        `capability "${capability}" is not grantable to a plugin`,
      );
    }
    // Deduplicated so the grant set and the manifest are the same set.
    if (!requested.includes(capability as PluginInstallCapability)) {
      requested.push(capability as PluginInstallCapability);
    }
  }

  const locales = record.locales ?? [];
  if (!Array.isArray(locales)) {
    throw new PluginManifestError(
      "LOCALE_NOT_A_NAME",
      "locales must be a list",
    );
  }
  const localesOut: string[] = [];
  for (const locale of locales) {
    if (typeof locale !== "string" || !NAME_PATTERN.test(locale)) {
      throw new PluginManifestError(
        "LOCALE_NOT_A_NAME",
        "a locale is not a name",
      );
    }
    // A plugin cannot replace core Bakery copy; it may only ship its own
    // namespace. This is the one reservation that is about content, not shape.
    if (locale.startsWith(CORE_LOCALE_PREFIX)) {
      throw new PluginManifestError(
        "LOCALE_REPLACES_CORE",
        `locale namespace "${locale}" belongs to the host`,
      );
    }
    localesOut.push(locale);
  }

  const stateSchemaVersion = record.stateSchemaVersion ?? 1;
  if (
    typeof stateSchemaVersion !== "number" ||
    !Number.isInteger(stateSchemaVersion) ||
    stateSchemaVersion < 1 ||
    stateSchemaVersion > 2147483647
  ) {
    throw new PluginManifestError(
      "STATE_SCHEMA_VERSION_INVALID",
      "stateSchemaVersion must be a positive integer",
    );
  }

  const namespaces = record.stateNamespaces ?? [];
  if (!Array.isArray(namespaces)) {
    throw new PluginManifestError(
      "NAMESPACE_INVALID",
      "stateNamespaces must be a list",
    );
  }
  const namespacesOut: string[] = [];
  for (const namespace of namespaces) {
    if (typeof namespace !== "string") {
      throw new PluginManifestError(
        "NAMESPACE_INVALID",
        "a state namespace is not a string",
      );
    }
    assertPluginNamespace(namespace, "state namespace");
    namespacesOut.push(namespace);
  }

  return Object.freeze({
    name,
    requestedCapabilities: Object.freeze(requested),
    locales: Object.freeze(localesOut),
    stateSchemaVersion,
    stateNamespaces: Object.freeze(namespacesOut),
    pages: parsePluginPages(record.pages, requested),
  });
}
