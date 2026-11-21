import type {
  PluginInstallListResponse,
  PluginPackageListResponse,
  PluginVersionListResponse,
} from "../api/client.ts";

/**
 * What the Plugins page shows, derived from three served lists: the plugins
 * published to the organization, the versions of each, and the installs this
 * person may see. Nothing here talks to the server.
 */

export type PluginPackage = PluginPackageListResponse["items"][number];
export type PluginVersion = PluginVersionListResponse["items"][number];
export type PluginInstall = PluginInstallListResponse["items"][number];

/** The install states the page words; an uninstalled install is not listed. */
export type PluginState = "on" | "off" | "ready" | "notWorking";

export type PluginScope = "organization" | "personal";

/** What an install can do, from the fixed list a manifest may ask for. */
export const PLUGIN_CAPABILITIES = [
  "state.read",
  "state.write",
  "ui.page",
  "ui.panel",
  "commands.run",
  "tools.invoke",
  "jobs.schedule",
] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

/** The last update the server refused to start, kept on the install. */
export type PluginUpdateFailure = Readonly<{
  versionId: string;
  versionName: string;
  reason: string;
  at: string;
}>;

/** Reads the recorded failure off an install, or null when there is none or it is malformed. */
export function updateFailureOf(
  install: Pick<PluginInstall, "lastUpdateFailure"> | undefined,
): PluginUpdateFailure | null {
  const raw = install?.lastUpdateFailure as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    raw === null || raw === undefined || typeof raw !== "object" ||
    typeof raw.versionId !== "string" || typeof raw.versionName !== "string" ||
    typeof raw.reason !== "string" || typeof raw.at !== "string"
  ) return null;
  return {
    versionId: raw.versionId,
    versionName: raw.versionName,
    reason: raw.reason,
    at: raw.at,
  };
}

export type InstalledPlugin = Readonly<{
  installId: string;
  /** The install's `version`, sent back as the precondition of a change. */
  installVersion: number;
  packageId: string;
  name: string;
  versionId: string;
  versionName: string;
  state: PluginState;
  scope: PluginScope;
  /** Set for a personal install, so an administrator can say whose it is. */
  ownerPrincipalId: string | null;
  /** The last update the server refused to start, until it succeeds or is dismissed. */
  updateFailure: PluginUpdateFailure | null;
  /** The newest published version, when it is not the one installed. */
  update: Readonly<{ versionId: string; versionName: string }> | null;
}>;

export type AvailablePlugin = Readonly<{
  packageId: string;
  name: string;
  versionId: string;
  versionName: string;
  publishedAt: string;
  /** The person already has it as a private install; the organization can still get it. */
  havePrivately: boolean;
}>;

const STATE_OF_STATUS: Record<string, PluginState | undefined> = {
  enabled: "on",
  disabled: "off",
  staged: "ready",
  failed: "notWorking",
};

/** The newest version that finished publishing, or null when none has. */
export function latestVersion(
  versions: readonly PluginVersion[],
): PluginVersion | null {
  let latest: PluginVersion | null = null;
  for (const version of versions) {
    if (version.publishedAt === null) continue;
    if (
      latest === null || latest.publishedAt === null ||
      version.publishedAt > latest.publishedAt ||
      (version.publishedAt === latest.publishedAt &&
        version.createdAt > latest.createdAt)
    ) latest = version;
  }
  return latest;
}

/** Versions that finished publishing, newest first. */
export function publishedVersions(
  versions: readonly PluginVersion[],
): PluginVersion[] {
  return versions
    .filter((version) => version.publishedAt !== null)
    .sort((a, b) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") ||
      b.createdAt.localeCompare(a.createdAt)
    );
}

/** The capabilities a version's manifest asks for, in the page's fixed order. */
export function capabilitiesOf(version: PluginVersion): PluginCapability[] {
  const manifest = version.manifest as { requestedCapabilities?: unknown };
  const asked = Array.isArray(manifest?.requestedCapabilities)
    ? manifest.requestedCapabilities
    : [];
  return PLUGIN_CAPABILITIES.filter((capability) => asked.includes(capability));
}

/** Installed plugins: every install that is not removed, newest change first. */
export function installedPlugins(
  installs: readonly PluginInstall[],
  packages: readonly PluginPackage[],
  versionsByPackage: ReadonlyMap<string, readonly PluginVersion[]>,
): InstalledPlugin[] {
  const names = new Map(packages.map((item) => [item.id, item.displayName]));
  const rows: InstalledPlugin[] = [];
  for (const install of installs) {
    const state = STATE_OF_STATUS[install.status];
    if (state === undefined) continue;
    const versions = versionsByPackage.get(install.pluginPackageId) ?? [];
    const current = versions.find((item) =>
      item.id === install.pluginVersionId
    );
    const latest = latestVersion(versions);
    rows.push({
      installId: install.id,
      installVersion: install.version,
      packageId: install.pluginPackageId,
      name: names.get(install.pluginPackageId) ?? install.pluginPackageId,
      versionId: install.pluginVersionId,
      versionName: current?.versionName ?? "",
      state,
      scope: install.scope,
      ownerPrincipalId: install.ownerPrincipalId,
      updateFailure: updateFailureOf(install),
      update: latest !== null && latest.id !== install.pluginVersionId &&
          // Only an upgrade is offered here; moving back is a separate choice.
          (current === undefined || current.publishedAt === null ||
            latest.publishedAt! > current.publishedAt)
        ? { versionId: latest.id, versionName: latest.versionName }
        : null,
    });
  }
  return rows.sort((a, b) =>
    a.name.localeCompare(b.name) || a.installId.localeCompare(b.installId)
  );
}

/**
 * Plugins published here that the organization does not have yet. A plugin
 * installed for the organization drops out; one installed only privately stays,
 * marked, because the organization can still get it.
 */
export function availablePlugins(
  installs: readonly PluginInstall[],
  packages: readonly PluginPackage[],
  versionsByPackage: ReadonlyMap<string, readonly PluginVersion[]>,
): AvailablePlugin[] {
  const live = installs.filter((install) =>
    STATE_OF_STATUS[install.status] !== undefined
  );
  const rows: AvailablePlugin[] = [];
  for (const item of packages) {
    const mine = live.filter((install) => install.pluginPackageId === item.id);
    if (mine.some((install) => install.scope === "organization")) continue;
    const latest = latestVersion(versionsByPackage.get(item.id) ?? []);
    if (latest === null || latest.publishedAt === null) continue;
    rows.push({
      packageId: item.id,
      name: item.displayName,
      versionId: latest.id,
      versionName: latest.versionName,
      publishedAt: latest.publishedAt,
      havePrivately: mine.length > 0,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** What moving from one version to another adds and takes away. */
export function capabilityDifference(
  from: readonly PluginCapability[],
  to: readonly PluginCapability[],
): { added: PluginCapability[]; removed: PluginCapability[] } {
  return {
    added: to.filter((capability) => !from.includes(capability)),
    removed: from.filter((capability) => !to.includes(capability)),
  };
}

export type PluginActor = Readonly<{
  role: "admin" | "developer" | "viewer" | "guest" | null;
  principalId: string | null;
}>;

/**
 * Whether this person may change an install: an organization install by an
 * administrator, a private one by the person it belongs to. The server decides
 * in the end; this only keeps the page from offering what it will refuse.
 */
export function mayChangeInstall(
  install: Pick<InstalledPlugin, "scope" | "ownerPrincipalId">,
  actor: PluginActor,
): boolean {
  return install.scope === "organization"
    ? actor.role === "admin"
    : actor.principalId !== null &&
      install.ownerPrincipalId === actor.principalId;
}

/** Whether this person may install for the given scope. */
export function mayInstall(scope: PluginScope, actor: PluginActor): boolean {
  return scope === "organization"
    ? actor.role === "admin"
    : actor.role === "admin" || actor.role === "developer";
}

/** The fingerprint as shown: its first 8 and last 4 characters, without the algorithm prefix. */
export function shortFingerprint(digest: string): string {
  const hex = digest.replace(/^[a-z0-9]+:/i, "");
  return hex.length <= 16 ? hex : `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

/** A byte count in words: bytes under 1 KB, then KB and MB with one decimal. */
export function formatBytes(bytes: number, locale: string): string {
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    }).format(value);
  if (bytes < 1024) return `${number(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, 1)} KB`;
  return `${number(bytes / (1024 * 1024), 1)} MB`;
}

/** Longest value shown in full before "Show all". */
export const EVIDENCE_VALUE_LIMIT = 200;

export type EvidenceRow = Readonly<{ name: string; value: string }>;

/** A value as compact text: strings as they are, lists joined, anything else as JSON. */
function evidenceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map(evidenceText).filter((part) => part !== "").join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The publisher's own details as rows: each top-level entry, in the publisher's
 * words. Nothing is judged; an entry that says a check passed is still only a
 * claim, so no row is ever marked as proven.
 */
export function evidenceRows(evidence: unknown): EvidenceRow[] {
  if (
    evidence === null || typeof evidence !== "object" || Array.isArray(evidence)
  ) return [];
  return Object.entries(evidence as Record<string, unknown>).map((
    [name, value],
  ) => ({ name, value: evidenceText(value) }));
}
