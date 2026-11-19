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
