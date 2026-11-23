import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The desktop update feed (#77): which signed build the server offers each
 * desktop target. An operator writes it as a JSON file and names it in
 * `BAKERY_DESKTOP_UPDATE_FEED_FILE`; the server reads it once at start-up.
 * Absent means this server offers no app updates.
 */
export const DESKTOP_UPDATE_FEED_FILE = "BAKERY_DESKTOP_UPDATE_FEED_FILE";

export const DESKTOP_UPDATE_TARGETS = ["linux", "darwin", "windows"] as const;
export const DESKTOP_UPDATE_ARCHES = ["x86_64", "aarch64"] as const;
export type DesktopUpdateTarget = (typeof DESKTOP_UPDATE_TARGETS)[number];
export type DesktopUpdateArch = (typeof DESKTOP_UPDATE_ARCHES)[number];

/** Semantic Versioning 2.0.0, without a leading "v". */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const FEED_KEY_PATTERN = new RegExp(
  `^(${DESKTOP_UPDATE_TARGETS.join("|")})-(${
    DESKTOP_UPDATE_ARCHES.join("|")
  })$`,
);

export const DesktopUpdateReleaseSchema = z.strictObject({
  version: z.string().max(128).regex(SEMVER_PATTERN).describe(
    "Semantic version of the signed build offered for this target, compared against the version the app reports.",
  ),
  pub_date: z.iso.datetime({ offset: true }).describe(
    "RFC 3339 time the build was published, passed through to the app unchanged.",
  ),
  url: z.url({ protocol: /^https$/ }).max(2048).describe(
    "HTTPS address of the signed build; plain HTTP is refused when the feed is read.",
  ),
  signature: z.string().min(1).max(4096).describe(
    "Minisign signature text the app checks against the release key built into it before installing.",
  ),
  notes: z.string().max(10_000).optional().describe(
    "Optional release notes passed through to the app.",
  ),
}).describe(
  "One signed desktop build the server offers for one target and architecture.",
);
export type DesktopUpdateRelease = z.infer<typeof DesktopUpdateReleaseSchema>;

export const DesktopUpdateFeedSchema = z.record(
  z.string().regex(FEED_KEY_PATTERN).describe(
    'Target and architecture the build runs on, written "<target>-<arch>", for example "linux-x86_64".',
  ),
  DesktopUpdateReleaseSchema,
).describe(
  "Operator-written map from desktop target and architecture to the signed build offered for it; a missing pair means no build for it.",
);
export type DesktopUpdateFeed = z.infer<typeof DesktopUpdateFeedSchema>;

/**
 * Reads and validates the feed file named by `BAKERY_DESKTOP_UPDATE_FEED_FILE`.
 * Unset or empty returns undefined; an unreadable or invalid file throws, so a
 * bad feed fails start-up instead of offering nothing silently.
 */
export function readDesktopUpdateFeed(
  path: string | undefined,
  readText: (path: string) => string = (file) => readFileSync(file, "utf8"),
): DesktopUpdateFeed | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readText(trimmed));
  } catch {
    throw new Error("DESKTOP_UPDATE_FEED_INVALID");
  }
  const parsed = DesktopUpdateFeedSchema.safeParse(raw);
  if (!parsed.success) throw new Error("DESKTOP_UPDATE_FEED_INVALID");
  return Object.freeze(parsed.data);
}

type ParsedVersion = {
  core: [number, number, number];
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Math.sign(Number(left) - Number(right));
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semantic Versioning 2.0.0 precedence: -1, 0 or 1. Build metadata is
 * ignored; a prerelease sorts before its release. Throws on a non-semver.
 */
export function compareSemver(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("SEMVER_INVALID");
  for (let index = 0; index < 3; index += 1) {
    const difference = Math.sign(a.core[index] - b.core[index]);
    if (difference !== 0) return difference;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const difference = compareIdentifiers(left, right);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The build to offer an app on `target`/`arch` running `currentVersion`, or
 * null when the feed has none newer (same, older or no build for the pair).
 */
export function selectDesktopUpdate(
  feed: DesktopUpdateFeed,
  query: {
    target: DesktopUpdateTarget;
    arch: DesktopUpdateArch;
    currentVersion: string;
  },
): DesktopUpdateRelease | null {
  const release = feed[`${query.target}-${query.arch}`];
  if (!release) return null;
  return compareSemver(release.version, query.currentVersion) > 0
    ? release
    : null;
}
