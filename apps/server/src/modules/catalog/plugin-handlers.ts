import type { PluginPackageActionHandlers } from "./plugin-actions.ts";
import {
  createPluginPackage,
  createPluginVersion,
  getPluginPackage,
  listPluginPackages,
  listPluginVersions,
  type PluginVersionDependencies,
} from "./plugin-postgres.ts";

/**
 * Binds the five package/version operations to their Postgres implementations.
 *
 * The package id comes from the route, so it is read from the action context
 * rather than repeated in the body: a body naming its own package could
 * disagree with the path it was sent to.
 */
export function createPluginPackageHandlers(
  dependencies: PluginVersionDependencies,
): PluginPackageActionHandlers {
  return {
    listPackages: listPluginPackages,
    getPackage: (context) => getPluginPackage(context, packageId(context)),
    createPackage: createPluginPackage,
    listVersions: (context, input) =>
      listPluginVersions(context, input, packageId(context)),
    createVersion: (context, input) =>
      createPluginVersion(context, input, packageId(context), dependencies),
  };
}

function packageId(context: { params: Readonly<Record<string, string>> }) {
  return context.params.id ?? "";
}
