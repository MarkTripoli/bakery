import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  listNotifications,
  markAllNotificationsRead,
  readNotification,
  readNotificationCount,
  setNotificationRead,
  toNotification,
} from "./notifications-postgres.ts";
import {
  resolveDestinationSummary,
  resolveNotificationTarget,
} from "./notifications-target.ts";

/**
 * Recipient-only notification handlers. Every one of these reads the acting
 * principal from the authorized transaction and scopes to it; none accepts a
 * recipient from the request, so one person cannot read or change another's
 * inbox by naming an id.
 */
export function createNotificationHandlers(secret: string) {
  const recipientOf = (context: ActionContext) => {
    const work = requireWorkTransaction(context);
    return {
      ...work,
      scope: {
        organizationId: work.organizationId,
        recipientId: work.principalId,
        ...(work.accessScope === undefined
          ? {}
          : { accessScope: work.accessScope }),
      },
    };
  };

  return {
    async list(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const query = input as z.output<
        typeof contractSchemas.NotificationCursorQuery
      >;
      return await listNotifications(transaction, {
        action: "notifications.list",
        scope,
        query,
        secret,
        destinationOf: (row) =>
          resolveDestinationSummary(transaction, scope, row),
      });
    },

    async count(context: ActionContext) {
      const { transaction, scope } = recipientOf(context);
      const count = await readNotificationCount(transaction, scope);
      // A missing count is unknown, not zero: null says "no authoritative
      // number yet" so the badge draws the unavailable state instead of lying.
      return {
        unread: count.unread,
        revision: count.revision,
      };
    },

    async get(context: ActionContext) {
      const { transaction, scope } = recipientOf(context);
      const id = context.params.id;
      if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const row = await readNotification(transaction, scope, id);
      return toNotification(
        row,
        await resolveDestinationSummary(transaction, scope, row),
      );
    },

    async resolveTarget(context: ActionContext) {
      const { transaction, scope } = recipientOf(context);
      const id = context.params.id;
      if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const row = await readNotification(transaction, scope, id);
      return await resolveNotificationTarget(transaction, scope, row);
    },

    async setRead(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const row = await setNotificationRead(
        transaction,
        scope,
        input as z.output<typeof contractSchemas.NotificationReadUpdate>,
      );
      return toNotification(
        row,
        await resolveDestinationSummary(transaction, scope, row),
      );
    },

    async markAllRead(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const { readBefore } = input as z.output<
        typeof contractSchemas.NotificationMarkAllRead
      >;
      return await markAllNotificationsRead(transaction, scope, readBefore);
    },
  };
}
