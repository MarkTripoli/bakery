import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  invalidateNotificationQueries,
  notificationTargetQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { landingDestination } from "./landing.ts";

type Destination = NonNullable<ReturnType<typeof landingDestination>>;

/**
 * `/notifications?open={id}`: where a row goes. The target is resolved now,
 * against what the reader may open now, and the address is replaced by the
 * place itself so Back returns to the list. A target that is gone, or that the
 * reader can no longer reach, says so here and offers the way back.
 */
export function NotificationOpening(
  { id, revision, onLand, onBack }: {
    id: string;
    revision: number | null;
    onLand: (destination: Destination) => void;
    onBack: () => void;
  },
) {
  const { translate } = useI18n();
  const client = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [marking, setMarking] = useState<"idle" | "saving" | "done" | "failed">(
    "idle",
  );
  const markRead = async () => {
    if (revision === null || scope.organizationId === null) return;
    setMarking("saving");
    const result = await client.setNotificationRead({
      organizationId: scope.organizationId,
      id,
      read: true,
      expectedCasVersion: revision,
      idempotencyKey: `read-${id}-${revision}-true`,
    });
    if (!result.ok) {
      setMarking("failed");
      return;
    }
    setMarking("done");
    await invalidateNotificationQueries(queryClient);
  };
  const target = useQuery({
    ...notificationTargetQueryOptions(client, scope, id),
    enabled: scope.organizationId !== null,
  });
  const destination = target.data
    ? landingDestination(target.data, { id, revision })
    : null;
  const landed = useRef(false);

  useEffect(() => {
    if (destination === null || landed.current) return;
    landed.current = true;
    onLand(destination);
  }, [destination, onLand]);

  const gone = !target.isPending && !target.isError && destination === null;
  return (
    <UI.Stack gap="spacious">
      <UI.Heading level="page">{translate("notifications.title")}</UI.Heading>
      {target.isError
        ? (
          <UI.InlineNotice
            tone="error"
            action={
              <UI.Button onClick={() => void target.refetch()} variant="quiet">
                {translate("notifications.tryAgain")}
              </UI.Button>
            }
          >
            {translate("notifications.failed")}
          </UI.InlineNotice>
        )
        : gone
        ? (
          <UI.EmptyState
            title={translate("notifications.unavailable.title")}
            description={translate("notifications.unavailable.sentence")}
            variant="filtered"
            action={
              <UI.Inline gap="compact">
                <UI.Button onClick={onBack} variant="primary">
                  {translate("notifications.unavailable.back")}
                </UI.Button>
                {revision === null || marking === "done" ? null : (
                  <UI.Button
                    loading={marking === "saving"}
                    onClick={() => void markRead()}
                    variant="secondary"
                  >
                    {translate("notifications.row.markRead")}
                  </UI.Button>
                )}
              </UI.Inline>
            }
          />
        )
        : (
          <UI.Stack
            aria-busy="true"
            aria-label={translate("notifications.loading")}
            gap="compact"
          >
            {Array.from({ length: 3 }).map((_, index) => (
              <UI.Skeleton key={index} shape="text" />
            ))}
          </UI.Stack>
        )}
      {gone && marking === "done"
        ? (
          <UI.InlineNotice tone="information">
            {translate("notifications.unavailable.marked")}
          </UI.InlineNotice>
        )
        : null}
      {gone && marking === "failed"
        ? (
          <UI.InlineNotice tone="error">
            {translate("notifications.row.saveFailed")}
          </UI.InlineNotice>
        )
        : null}
    </UI.Stack>
  );
}
