import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { Translator } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import {
  invalidateNotificationQueries,
  notificationTargetQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../../shell/shell-slots.tsx";
import type { LandingSearch } from "../../notifications/landing.ts";

export type SharedKind = "document" | "conversation";
export type SharedReason = "gone" | "no_longer_shared" | "unknown";

export function sharedKindOf(targetKind: string): SharedKind | null {
  if (targetKind === "conversation_message") return "conversation";
  return targetKind === "comment" || targetKind === "document_version"
    ? "document"
    : null;
}

export function sharedUnavailableCopy(
  translate: Translator,
  kind: SharedKind,
  reason: SharedReason,
  granter: string | null,
): { title: string; description: string } {
  const title = reason === "unknown"
    ? translate("shared.unavailable.unknown.title" as never)
    : translate(
      `shared.${kind}.${
        reason === "gone" ? "gone" : "noLongerShared"
      }.title` as never,
    );
  const description = reason === "gone"
    ? granter === null
      ? translate("shared.unavailable.gone.bodyAnon" as never)
      : translate("shared.unavailable.gone.body" as never, { name: granter })
    : reason === "no_longer_shared"
    ? granter === null
      ? translate("shared.unavailable.noLongerShared.bodyAnon" as never)
      : translate("shared.unavailable.noLongerShared.body" as never, {
        granter,
      })
    : translate("shared.unavailable.unknown.body" as never);
  return { title, description };
}

export function SharedUnavailable(
  { kind, landing }: { kind: SharedKind; landing: LandingSearch },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [marked, setMarked] = useState(false);
  const target = useQuery({
    ...notificationTargetQueryOptions(api, scope, landing.n ?? ""),
    enabled: landing.n !== undefined && scope.organizationId !== null,
  });
  if (landing.n !== undefined && target.isPending) {
    return (
      <UI.Stack
        aria-busy="true"
        aria-label={translate("notifications.loading")}
        gap="compact"
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <UI.Skeleton key={index} shape="text" />
        ))}
      </UI.Stack>
    );
  }
  const reason: SharedReason = target.data?.reason ?? "unknown";
  const copy = sharedUnavailableCopy(
    translate,
    kind,
    reason,
    target.data?.sharedByName ?? null,
  );
  const canMark = landing.n !== undefined && landing.r !== undefined &&
    scope.organizationId !== null;
  const markRead = async () => {
    if (landing.n === undefined || landing.r === undefined) return;
    if (scope.organizationId === null) return;
    const result = await api.setNotificationRead({
      organizationId: scope.organizationId,
      id: landing.n,
      read: true,
      expectedCasVersion: landing.r,
      idempotencyKey: `read-${landing.n}-${landing.r}-true`,
    });
    if (!result.ok) return;
    setMarked(true);
    await invalidateNotificationQueries(queryClient);
  };
  return (
    <>
      <ShellActiveNavigation id="work" />
      <UI.EmptyState
        title={copy.title}
        description={copy.description}
        variant="filtered"
        data-testid={`shared-unavailable-${reason}`}
        action={
          <UI.Inline>
            <UI.Button
              variant="primary"
              onClick={() =>
                void navigate({ to: "/notifications", search: {} })}
            >
              {translate("shared.backToInbox" as never)}
            </UI.Button>
            {canMark && !marked
              ? (
                <UI.Button variant="secondary" onClick={() => void markRead()}>
                  {translate("notifications.row.markRead" as never)}
                </UI.Button>
              )
              : null}
          </UI.Inline>
        }
      />
    </>
  );
}
