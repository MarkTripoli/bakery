import type { PluginInstallActionHandlers } from "./plugin-install-actions.ts";
import {
  createPluginInstall,
  getPluginInstall,
  listPluginInstalls,
  listPluginState,
  listPluginStateItems,
  putPluginState,
  updatePluginInstall,
} from "./plugin-install-postgres.ts";
import { getPluginPage, listPluginPages } from "./plugin-pages.ts";

/**
 * Binds the six install/state operations to their Postgres implementations.
 *
 * The install id comes from the route, so it is read from the action context
 * rather than repeated in the body: a body naming its own install could
 * disagree with the path it was sent to.
 */
export function createPluginInstallHandlers(
  cursorSecret: string,
): PluginInstallActionHandlers {
  return {
    listInstalls: (context, input) =>
      listPluginInstalls(context, input, cursorSecret),
    getInstall: (context) => getPluginInstall(context, installId(context)),
    createInstall: createPluginInstall,
    updateInstall: (context, input) =>
      updatePluginInstall(context, input, installId(context)),
    getState: (context, input) =>
      listPluginState(context, input, installId(context), cursorSecret),
    getStateItems: (context, input) =>
      listPluginStateItems(context, input, installId(context), cursorSecret),
    putState: (context, input) =>
      putPluginState(context, input, installId(context)),
    listPages: (context, input) =>
      listPluginPages(context, input, cursorSecret),
    getPage: getPluginPage,
  };
}

function installId(context: { params: Readonly<Record<string, string>> }) {
  return context.params.id ?? "";
}
