import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { notificationTargetQueryOptions } from "../api/query.ts";
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
              <UI.Button onClick={onBack} variant="secondary">
                {translate("notifications.unavailable.back")}
              </UI.Button>
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
    </UI.Stack>
  );
}
