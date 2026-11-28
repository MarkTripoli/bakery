import type { MessageKey } from "@bakery/i18n";
import type {
  SkillResponse,
  SkillScope,
  SkillSource,
  SkillUsage,
  SkillVersionResponse,
} from "../../api/client.ts";
import { isTextMedia, mediaTypeOf } from "./skill-draft-state.ts";

/** Words for the translator: a key and the values it needs. */
export type Words = {
  readonly key: MessageKey;
  readonly values?: Readonly<Record<string, string | number>>;
};

/** The longest name search the server takes. */
export const SKILL_SEARCH_MAX = 200;

/** The scopes the Skills tab filters by, in the order the control shows them; "all" sends no scope. */
export const SKILL_FILTERS = [
  "all",
  "global",
  "organization",
  "personal",
] as const;
export type SkillFilter = (typeof SKILL_FILTERS)[number];

/** The filter a `?scope=` value names; anything else is All. */
export function skillFilter(value: unknown): SkillFilter {
  return value === "global" || value === "organization" ||
      value === "personal"
    ? value
    : "all";
}

/** The scope the server is asked for: none for All. */
export function serverScope(filter: SkillFilter): SkillScope | undefined {
  return filter === "all" ? undefined : filter;
}

/**
 * The name search the server is asked for: the text without spaces at its
 * ends, cut to what the server takes; nothing when it is empty.
 */
export function skillSearch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, SKILL_SEARCH_MAX);
  return text === "" ? undefined : text;
}

/** The filter's words on the control: "Shared by Bakery", "Organization", "Private". */
export function filterWords(filter: SkillFilter): Words {
  return { key: `library.skills.filter.${filter}` as const };
}

/** Who a skill belongs to, as a row says it: "Shared by Bakery", "Organization" or "Yours". */
export function belongsToWords(scope: SkillScope): Words {
  return { key: `library.skills.belongsTo.${scope}` as const };
}

/** The scope badge on a skill's page: "Shared by Bakery", "Organization" or "Private". */
export function scopeWords(scope: SkillScope): Words {
  return { key: `library.skills.scope.${scope}` as const };
}

/** The one badge beside a skill's name in the list. */
export type SkillBadge = "turnedOff";

/**
 * Turned off, when it is. Nothing else is badged in the list: the Belongs to
 * column says Private ("Yours"), and No version yet says a draft, so a badge
 * would say either twice. A skill's own page says its scope in its header.
 */
export function skillBadges(
  skill: Pick<SkillResponse, "enabled">,
): SkillBadge[] {
  return skill.enabled ? [] : ["turnedOff"];
}

/** What the page knows of the source the skill came from, for the licence. */
export type SourceLicense =
  | "none"
  | "loading"
  | "failed"
  | Readonly<{ license: string | null }>;

/**
 * Whether the Files card says the skill's own licence. Where it came from says
 * the source's licence, so Files says one only when it has something that card
 * does not: the skill has no source, the source cannot be read, or the two
 * licences differ. While the source loads it waits, so nothing flashes and goes.
 */
export function licenseShownInFiles(
  own: string | null,
  source: SourceLicense,
): boolean {
  if (own === null) return false;
  if (source === "none" || source === "failed") return true;
  if (source === "loading") return false;
  return source.license !== own;
}

/** "Version {n}" for the version in use, else "No version yet". */
export function versionInUseWords(
  skill: Pick<SkillResponse, "activeVersionId" | "activeRevision">,
): { readonly words: Words; readonly muted: boolean } {
  return skill.activeVersionId !== null && skill.activeRevision !== null
    ? {
      words: {
        key: "library.skills.version",
        values: { number: skill.activeRevision },
      },
      muted: false,
    }
    : { words: { key: "library.skills.noVersion" }, muted: true };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When a skill changed: relative within a week ("3 days ago", "yesterday"),
 * then a date in the reader's time zone.
 */
export function changedWhen(
  iso: string,
  now: Date,
  locale: string,
  timeZone: string | undefined,
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const ago = now.getTime() - then;
  if (ago >= 0 && ago < 7 * DAY) {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (ago < HOUR) return format.format(-Math.floor(ago / MINUTE), "minute");
    if (ago < DAY) return format.format(-Math.floor(ago / HOUR), "hour");
    return format.format(-Math.floor(ago / DAY), "day");
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
    .format(new Date(then));
}

/** What an empty list says: a search that found nothing, or a filter with no skills. */
export function emptyWords(
  filter: SkillFilter,
  q: string | undefined,
): { readonly title: Words; readonly description: Words | null } {
  if (q !== undefined) {
    return {
      title: { key: "library.skills.empty.search", values: { text: q } },
      description: null,
    };
  }
  return {
    title: { key: `library.skills.empty.${filter}.title` as const },
    description: {
      key: `library.skills.empty.${filter}.description` as const,
    },
  };
}

/** One file of a version's manifest, as the Files card lists it. */
export type ManifestFile = {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
};

/** The files of a version: the instructions file, the others in path order, and the licence. */
export type ManifestFiles = {
  readonly entry: ManifestFile | null;
  readonly others: readonly ManifestFile[];
  readonly license: string | null;
};

function manifestFile(value: unknown): ManifestFile | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string" || entry.path === "") return null;
  return {
    path: entry.path,
    mediaType: typeof entry.mediaType === "string" ? entry.mediaType : "",
    sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : 0,
  };
}

/**
 * Reads a version's manifest (typed only as JSON by the contract): the entry
 * file first, then every other file by path. A manifest that is not the
 * expected shape lists no files rather than failing the page.
 */
export function manifestFiles(
  version: Pick<SkillVersionResponse, "entryPath" | "manifest">,
): ManifestFiles {
  const manifest = typeof version.manifest === "object" &&
      version.manifest !== null && !Array.isArray(version.manifest)
    ? version.manifest as Record<string, unknown>
    : {};
  const files = Array.isArray(manifest.files)
    ? manifest.files.map(manifestFile).filter((file): file is ManifestFile =>
      file !== null
    )
    : [];
  const entryPath = typeof manifest.entryPath === "string"
    ? manifest.entryPath
    : version.entryPath;
  const entry = files.find((file) => file.path === entryPath) ?? null;
  const others = files
    .filter((file) => file !== entry)
    .sort((a, b) => a.path.localeCompare(b.path));
  const license = typeof manifest.license === "string" &&
      manifest.license.trim() !== ""
    ? manifest.license
    : null;
  return { entry, others, license };
}

/** A file size in the reader's locale: bytes, kB or MB. */
export function fileSize(bytes: number, locale: string): string {
  const [value, unit] = bytes < 1000
    ? [bytes, "byte"]
    : bytes < 1_000_000
    ? [bytes / 1000, "kilobyte"]
    : [bytes / 1_000_000, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    // A short byte reads "120 byte"; spelled out it reads "120 bytes".
    unitDisplay: unit === "byte" ? "long" : "short",
    maximumFractionDigits: unit === "byte" ? 0 : 1,
  }).format(value);
}

/** A short fingerprint of a version's digest: its first twelve characters, without the algorithm. */
export function fingerprint(digest: string): string {
  const colon = digest.indexOf(":");
  return (colon === -1 ? digest : digest.slice(colon + 1)).slice(0, 12);
}

/** A version's status in words. */
export function versionStatusWords(
  status: SkillVersionResponse["status"],
): Words {
  return { key: `library.skill.versions.status.${status}` as const };
}

/** The agents and the workflows that use a skill, each in name order. */
export function usedByGroups(items: readonly SkillUsage[]): {
  readonly agents: SkillUsage[];
  readonly workflows: SkillUsage[];
} {
  const order = (a: SkillUsage, b: SkillUsage) =>
    a.definitionName.localeCompare(b.definitionName) ||
    a.revision - b.revision;
  return {
    agents: items.filter((item) => item.kind === "agent").sort(order),
    workflows: items.filter((item) => item.kind === "workflow").sort(order),
  };
}

/**
 * The revisions of this skill that a usage row pins, once each and in order.
 * One the page cannot name is left out, so the line never shows a guess.
 */
export function pinnedRevisions(
  usage: Pick<SkillUsage, "skillVersionIds">,
  versions: readonly Pick<SkillVersionResponse, "id" | "revision">[],
): number[] {
  const found = usage.skillVersionIds.flatMap((id) => {
    const version = versions.find((item) => item.id === id);
    return version === undefined ? [] : [version.revision];
  });
  return [...new Set(found)].sort((a, b) => a - b);
}

/** Where a skill came from, as the card reads it. */
export type SkillOrigin =
  | { readonly kind: "written" }
  | {
    readonly kind: "copied";
    readonly skillId: string;
    readonly versionId: string | null;
  }
  | { readonly kind: "source"; readonly sourceId: string };

/** A copy names the skill it came from; otherwise a skill from a source names it; otherwise it was written here. */
export function skillOrigin(
  skill: Pick<
    SkillResponse,
    "copiedFromSkillId" | "copiedFromVersionId" | "sourceId"
  >,
): SkillOrigin {
  if (skill.copiedFromSkillId !== null) {
    return {
      kind: "copied",
      skillId: skill.copiedFromSkillId,
      versionId: skill.copiedFromVersionId,
    };
  }
  if (skill.sourceId !== null) {
    return { kind: "source", sourceId: skill.sourceId };
  }
  return { kind: "written" };
}

/** The line for a copy: with its name and version, with its name only, or neither when the original cannot be read. */
export function copiedWords(
  name: string | null,
  revision: number | null,
): Words {
  if (name === null) return { key: "library.skill.origin.copiedUnknown" };
  return revision === null
    ? { key: "library.skill.origin.copiedNamed", values: { name } }
    : {
      key: "library.skill.origin.copied",
      values: { name, number: revision },
    };
}

/** A source's kind in words. */
export function sourceKindWords(type: SkillSource["sourceType"]): Words {
  return { key: `library.skill.origin.kind.${type}` as const };
}

const SHOWN_FILE_BYTES = 1_000_000;

export function skillFileShown(
  file: { path: string; mediaType: string; sizeBytes: number },
): boolean {
  return file.sizeBytes <= SHOWN_FILE_BYTES &&
    isTextMedia(file.mediaType || mediaTypeOf(file.path));
}

export function skillFileWords(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function middleTruncated(path: string, longest = 34): string {
  if (path.length <= longest) return path;
  const keep = longest - 1;
  const head = Math.ceil(keep / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

export function withoutFrontMatter(words: string): string {
  return words.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/, "");
}

export function isMarkdownFile(
  file: { path: string; mediaType: string },
): boolean {
  return file.mediaType.startsWith("text/markdown") ||
    mediaTypeOf(file.path) === "text/markdown";
}
