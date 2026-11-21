import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { ConversationAccessGrant } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { conversationAccessQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * The people a conversation was opened to by a mention, for someone who may
 * share it (design-ux #73, section 4). Each row can take that access back;
 * the person's messages stay.
 */
export function PeopleAddedDialog(
  { conversationId, open, onOpenChange }: {
    readonly conversationId: string;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  const grants = useQuery({
    ...conversationAccessQueryOptions(api, scope, conversationId),
    enabled: open && Boolean(scope.organizationId),
  });
  const [removing, setRemoving] = useState<ConversationAccessGrant | null>(
    null,
  );
  const [outcome, setOutcome] = useState<
    | { readonly kind: "removed" | "changed"; readonly name: string }
    | { readonly kind: "failed" }
    | null
  >(null);
  const revoke = useMutation({
    mutationKey: ["conversationAccess.revoke"],
    mutationFn: async (grant: ConversationAccessGrant) => {
      const result = await api.revokeConversationAccess({
        organizationId: scope.organizationId as string,
        conversationId,
        principalId: grant.principalId,
        version: grant.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );
  const confirm = (grant: ConversationAccessGrant) => {
    revoke.mutateAsync(grant).then(
      () => {
        setOutcome({ kind: "removed", name: grant.displayName });
        setRemoving(null);
      },
      (error) => {
        const status = failureStatus(error);
        if (status === 409 || status === 412) {
          setOutcome({ kind: "changed", name: grant.displayName });
          setRemoving(null);
        } else {
          setOutcome({ kind: "failed" });
        }
      },
    );
  };
  const show = (grant: ConversationAccessGrant) => {
    if (grant.sourceMessageId === null) return;
    const target = document.querySelector(
      `[data-message-id="${grant.sourceMessageId}"]`,
    );
    onOpenChange(false);
    requestAnimationFrame(() =>
      target?.scrollIntoView({ block: "center", behavior: "smooth" })
    );
  };

  return (
    <>
      <UI.Dialog
        dismissLabel={translate("mentions.added.close")}
        onOpenChange={(next) => {
          if (!next) setOutcome(null);
          onOpenChange(next);
        }}
        open={open}
        title={translate("mentions.added.title")}
        variant="information"
      >
        <UI.Stack gap="standard">
          <UI.Text variant="muted">
            {translate("mentions.added.description")}
          </UI.Text>
          {outcome !== null
            ? (
              <UI.InlineNotice
                role={outcome.kind === "failed" ? "alert" : "status"}
                tone={outcome.kind === "failed"
                  ? "error"
                  : outcome.kind === "changed"
                  ? "information"
                  : "success"}
              >
                {outcome.kind === "removed"
                  ? translate("mentions.added.removed", { name: outcome.name })
                  : outcome.kind === "changed"
                  ? translate("mentions.added.changed", { name: outcome.name })
                  : translate("mentions.added.failed")}
              </UI.InlineNotice>
            )
            : null}
          {grants.isPending
            ? (
              <UI.Stack aria-busy="true" gap="compact">
                <UI.Text role="status" variant="muted">
                  {translate("mentions.added.loading")}
                </UI.Text>
                <UI.Skeleton shape="row" />
                <UI.Skeleton shape="row" />
              </UI.Stack>
            )
            : grants.isError
            ? (
              <UI.InlineNotice
                action={
                  <UI.Button
                    onClick={() => void grants.refetch()}
                    variant="secondary"
                  >
                    {translate("core.actions.retry")}
                  </UI.Button>
                }
                tone="error"
              >
                {translate("mentions.failed")}
              </UI.InlineNotice>
            )
            : grants.data.length === 0
            ? (
              <UI.Text variant="muted">
                {translate("mentions.added.empty")}
              </UI.Text>
            )
            : (
              <UI.DescriptionList>
                {grants.data.map((grant) => (
                  <UI.DescriptionItem
                    actionPlacement="below"
                    action={
                      <UI.Inline gap="compact">
                        {grant.sourceMessageId !== null
                          ? (
                            <UI.Button
                              onClick={() => show(grant)}
                              variant="text"
                            >
                              {translate("mentions.added.show")}
                            </UI.Button>
                          )
                          : null}
                        <UI.Button
                          aria-label={translate("mentions.added.removeLabel", {
                            name: grant.displayName,
                          })}
                          onClick={() => {
                            setOutcome(null);
                            setRemoving(grant);
                          }}
                          variant="secondary"
                        >
                          {translate("mentions.added.remove")}
                        </UI.Button>
                      </UI.Inline>
                    }
                    description={translate("mentions.added.row", {
                      by: grant.grantedByName,
                      date: date(grant.grantedAt),
                    })}
                    key={grant.id}
                    title={grant.displayName}
                  />
                ))}
              </UI.DescriptionList>
            )}
        </UI.Stack>
      </UI.Dialog>
      {removing !== null
        ? (
          <UI.AlertDialog
            cancelAction={
              <UI.Button
                autoFocus
                disabled={revoke.isPending}
                onClick={() => setRemoving(null)}
                variant="secondary"
              >
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                disabled={revoke.isPending}
                loading={revoke.isPending}
                onClick={() => confirm(removing)}
                variant="destructive"
              >
                {translate("mentions.added.remove")}
              </UI.Button>
            }
            onOpenChange={(next) => {
              if (!next && !revoke.isPending) setRemoving(null);
            }}
            open
            state={revoke.isPending ? "confirming" : "open"}
            title={translate("mentions.added.confirmTitle", {
              name: removing.displayName,
            })}
            variant="destructive"
          >
            <UI.Text>
              {translate("mentions.added.confirmBody", {
                name: removing.displayName,
              })}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
