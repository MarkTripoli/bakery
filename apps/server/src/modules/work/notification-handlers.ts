import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "./work-transaction.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { readApprovalOutcomes } from "./notification-approval-outcome.ts";
import {
  listNotifications,
  markAllNotificationsRead,
  type NotificationRow,
  readNotification,
  readNotificationCount,
  setNotificationRead,
  toNotification,
  undoMarkAllNotificationsRead,
} from "./notifications-postgres.ts";
import { signalInboxChanged } from "./notification-signal.ts";
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
async function notificationOf(
  transaction: PgTransactionClient,
  scope: Parameters<typeof resolveDestinationSummary>[1],
  row: NotificationRow,
) {
  const outcomes = await readApprovalOutcomes(
    transaction,
    scope.organizationId,
    [row],
  );
  return toNotification(
    row,
    await resolveDestinationSummary(transaction, scope, row),
    outcomes.get(row.targetId) ?? null,
  );
}

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
      return await notificationOf(transaction, scope, row);
    },

    async resolveTarget(context: ActionContext) {
      const { transaction, scope } = recipientOf(context);
      const id = context.params.id;
      if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const row = await readNotification(transaction, scope, id);
      // How the target was reached is the server's business; the contract
      // carries only where to go.
      const { viaDocumentGrant: _viaGrant, ...target } =
        await resolveNotificationTarget(transaction, scope, row) as
          & Awaited<ReturnType<typeof resolveNotificationTarget>>
          & { viaDocumentGrant?: true };
      return target;
    },

    async setRead(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const change = input as z.output<
        typeof contractSchemas.NotificationReadUpdate
      >;
      const row = await setNotificationRead(transaction, scope, change);
      // Only a real change is a signal; a repeated same-state write is not.
      if (row.revision !== change.expectedCasVersion) {
        await signalInboxChanged(transaction, {
          organizationId: scope.organizationId,
          recipientId: scope.recipientId,
          traceId: context.traceId,
        });
      }
      return await notificationOf(transaction, scope, row);
    },

    async markAllRead(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const { readBefore } = input as z.output<
        typeof contractSchemas.NotificationMarkAllRead
      >;
      const result = await markAllNotificationsRead(
        transaction,
        scope,
        readBefore,
      );
      if (result.marked > 0) {
        await signalInboxChanged(transaction, {
          organizationId: scope.organizationId,
          recipientId: scope.recipientId,
          traceId: context.traceId,
        });
      }
      return result;
    },

    async undoMarkAllRead(context: ActionContext, input: unknown) {
      const { transaction, scope } = recipientOf(context);
      const { batchId } = input as z.output<
        typeof contractSchemas.NotificationUndoMarkAllRead
      >;
      const result = await undoMarkAllNotificationsRead(
        transaction,
        scope,
        batchId,
      );
      if (result.restored > 0) {
        await signalInboxChanged(transaction, {
          organizationId: scope.organizationId,
          recipientId: scope.recipientId,
          traceId: context.traceId,
        });
      }
      return result;
    },
  };
}
