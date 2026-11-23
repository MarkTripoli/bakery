import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import { ActionAccess, contractSchemas } from "@bakery/contracts/contracts";
import { requirePrincipal } from "./handlers.ts";
import { StandardError } from "@bakery/contracts/http";
import {
  type DesktopUpdateArch,
  type DesktopUpdateFeed,
  type DesktopUpdateRelease,
  type DesktopUpdateTarget,
  selectDesktopUpdate,
} from "@bakery/config/desktop-update-feed";

export type DesktopUpdateQuery = {
  target: DesktopUpdateTarget;
  arch: DesktopUpdateArch;
  current_version: string;
};

/**
 * The desktop app's update manifest (#77). No feed configured: 404, this
 * server offers no app updates. Otherwise the newer signed build for the
 * caller's target and architecture, or null (204) when none is newer.
 */
export function desktopUpdatesGet(
  _context: ActionContext,
  input: DesktopUpdateQuery,
  feed: DesktopUpdateFeed | undefined,
): DesktopUpdateRelease | null {
  if (!feed) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return selectDesktopUpdate(feed, {
    target: input.target,
    arch: input.arch,
    currentVersion: input.current_version,
  });
}

/**
 * GET /v1/desktop/update. Any signed-in principal may ask: the desktop app
 * sends its own bearer token, and the manifest names no organization data.
 */
export function desktopUpdatesGetAction(
  feed: DesktopUpdateFeed | undefined,
): ActionDefinition {
  return {
    name: AuthImplementedAction.DesktopUpdatesGet,
    method: HttpMethod.Get,
    path: "/v1/desktop/update",
    input: contractSchemas.DesktopUpdateQuery,
    output: contractSchemas.DesktopUpdate,
    // 204 when no newer build is offered for the caller's target.
    noContentWhenNull: true,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Authenticated,
      authorize: (context) => {
        requirePrincipal(context.principal);
      },
    },
    handler: (context, input) =>
      desktopUpdatesGet(context, input as DesktopUpdateQuery, feed),
  };
}
