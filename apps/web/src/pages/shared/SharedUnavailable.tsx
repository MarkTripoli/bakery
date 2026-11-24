import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import { notificationTargetQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../../shell/shell-slots.tsx";
import type { LandingSearch } from "../../notifications/landing.ts";

export type SharedKind = "document" | "conversation";
export type SharedReason = "gone" | "no_longer_shared" | "unknown";

export function sharedReasonOf(error: unknown): SharedReason {
  const status = typeof error === "object" && error !== null &&
      "kind" in error && error.kind === "problem" && "problem" in error &&
      typeof error.problem === "object" && error.problem !== null &&
      "status" in error.problem
    ? error.problem.status
    : null;
  return status === 403 ? "no_longer_shared" : "unknown";
}

export function SharedUnavailable(
  { kind, reason: fromRead, landing }: {
    kind: SharedKind;
    reason: SharedReason;
    landing: LandingSearch;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [marked, setMarked] = useState(false);
  const target = useQuery({
    ...notificationTargetQueryOptions(api, scope, landing.n ?? ""),
    enabled: landing.n !== undefined && scope.organizationId !== null,
  });
  const reason: SharedReason = target.data?.reason ?? fromRead;
  const granter = target.data?.sharedByName ?? null;
  const canMark = reason !== "gone" && landing.n !== undefined &&
    landing.r !== undefined && scope.organizationId !== null;
  const markRead = async () => {
    if (!canMark || landing.n === undefined || landing.r === undefined) return;
    const organizationId = scope.organizationId as string;
    await api.setNotificationRead({
      organizationId,
      id: landing.n,
      read: true,
      expectedCasVersion: landing.r,
      idempotencyKey: `read-${landing.n}-${landing.r}-true`,
    });
    setMarked(true);
  };
  const title = reason === "unknown"
    ? translate("shared.unavailable.unknown.title" as never)
    : translate(
      `shared.${kind}.${
        reason === "gone" ? "gone" : "noLongerShared"
      }.title` as never,
    );
  const description = reason === "gone"
    ? translate("shared.unavailable.gone.body" as never)
    : reason === "no_longer_shared"
    ? granter === null
      ? translate("shared.unavailable.noLongerShared.bodyAnon" as never)
      : translate("shared.unavailable.noLongerShared.body" as never, {
        granter,
      })
    : translate("shared.unavailable.unknown.body" as never);
  return (
    <>
      <ShellActiveNavigation id="work" />
      <UI.EmptyState
        title={title}
        description={description}
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
