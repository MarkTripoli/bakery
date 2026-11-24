import type { z } from "zod";
import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import { ActionAccess, contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type DesktopUpdateFeed,
  type DesktopUpdateRelease,
  selectDesktopUpdate,
} from "@bakery/config/desktop-update-feed";

/**
 * The desktop app's update manifest (#77). No feed configured: 404, this
 * server offers no app updates. Otherwise the newer signed build for the
 * caller's target and architecture, or null (204) when none is newer.
 */
export function desktopUpdatesGet(
  _context: ActionContext,
  input: z.output<typeof contractSchemas.DesktopUpdateQuery>,
  feed: DesktopUpdateFeed | undefined,
): DesktopUpdateRelease | null {
  if (!feed) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return selectDesktopUpdate(feed, {
    target: input.target,
    arch: input.arch,
    currentVersion: input.current_version,
  });
}

export function desktopUpdatesGetAction(
  feed: DesktopUpdateFeed | undefined,
): ActionDefinition<typeof contractSchemas.DesktopUpdateQuery> {
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
      access: ActionAccess.Public,
    },
    handler: (context, input) => desktopUpdatesGet(context, input, feed),
  };
}
