import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactAccessQueryOptions,
  conversationAccessQueryOptions,
} from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** What the people were added to: a task's conversation, or a document. */
export type PeopleSubject = {
  readonly kind: "conversation" | "document";
  readonly id: string;
};

/** One live grant, the same whether it opens a conversation or a document. */
type Grant = {
  readonly id: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly grantedByName: string;
  readonly grantedAt: string;
  readonly version: number;
  /** The message or comment that gave the access; null when it was given another way. */
  readonly sourceId: string | null;
};

/** The words that differ between a conversation and a document. */
const WORDS = {
  conversation: {
    title: "mentions.added.title",
    description: "mentions.added.description",
    show: "mentions.added.show",
    confirmTitle: "mentions.added.confirmTitle",
    confirmBody: "mentions.added.confirmBody",
  },
  document: {
    title: "mentions.added.documentTitle",
    description: "mentions.added.documentDescription",
    show: "mentions.added.documentShow",
    confirmTitle: "mentions.added.documentConfirmTitle",
    confirmBody: "mentions.added.documentConfirmBody",
  },
} as const;

/**
 * The people a conversation or a document was opened to by a mention, for
 * someone who may share it (design-ux #73, section 4). Each row can take that
 * access back; what the person wrote stays.
 */
export function PeopleAddedDialog(
  { subject, open, onOpenChange }: {
    readonly subject: PeopleSubject;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  const words = WORDS[subject.kind];
  const isConversation = subject.kind === "conversation";
  // Both reads exist so the hooks never change; only the subject's is on.
  const conversationGrants = useQuery({
    ...conversationAccessQueryOptions(
      api,
      scope,
      isConversation ? subject.id : "",
    ),
    enabled: open && isConversation && Boolean(scope.organizationId),
  });
  const documentGrants = useQuery({
    ...artifactAccessQueryOptions(api, scope, isConversation ? "" : subject.id),
    enabled: open && !isConversation && Boolean(scope.organizationId),
  });
  const grants = isConversation ? conversationGrants : documentGrants;
  const rows: readonly Grant[] | undefined = isConversation
    ? conversationGrants.data?.map((grant) => ({
      ...grant,
      sourceId: grant.sourceMessageId,
    }))
    : documentGrants.data?.map((grant) => ({
      ...grant,
      sourceId: grant.sourceCommentId,
    }));
  const [removing, setRemoving] = useState<Grant | null>(null);
  const [outcome, setOutcome] = useState<
    | { readonly kind: "removed" | "changed"; readonly name: string }
    | { readonly kind: "failed" | "notShown" }
    | null
  >(null);
  const revoke = useMutation({
    mutationKey: [
      isConversation ? "conversationAccess.revoke" : "artifactAccess.revoke",
    ],
    mutationFn: async (grant: Grant) => {
      const common = {
        organizationId: scope.organizationId as string,
        principalId: grant.principalId,
        version: grant.version,
        idempotencyKey: crypto.randomUUID(),
      };
      const result = isConversation
        ? await api.revokeConversationAccess({
          ...common,
          conversationId: subject.id,
        })
        : await api.revokeArtifactAccess({ ...common, artifactId: subject.id });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );
  const confirm = (grant: Grant) => {
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
  const show = (grant: Grant) => {
    if (grant.sourceId === null) return;
    const target = isConversation
      ? document.querySelector(`[data-message-id="${grant.sourceId}"]`)
      : document.getElementById(`comment-${grant.sourceId}`);
    // A reply inside a thread that is closed is not on the page to scroll to.
    if (target === null) {
      setOutcome({ kind: "notShown" });
      return;
    }
    onOpenChange(false);
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      if (!isConversation && target instanceof HTMLElement) target.focus();
    });
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
        title={translate(words.title)}
        variant="information"
      >
        <UI.Stack gap="standard">
          <UI.Text variant="muted">
            {translate(words.description)}
          </UI.Text>
          {outcome !== null
            ? (
              <UI.InlineNotice
                role={outcome.kind === "failed" ? "alert" : "status"}
                tone={outcome.kind === "failed"
                  ? "error"
                  : outcome.kind === "changed" || outcome.kind === "notShown"
                  ? "information"
                  : "success"}
              >
                {outcome.kind === "removed"
                  ? translate("mentions.added.removed", { name: outcome.name })
                  : outcome.kind === "changed"
                  ? translate("mentions.added.changed", { name: outcome.name })
                  : outcome.kind === "notShown"
                  ? translate("mentions.added.documentNotShown")
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
            : grants.isError || rows === undefined
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
            : rows.length === 0
            ? (
              <UI.Text variant="muted">
                {translate("mentions.added.empty")}
              </UI.Text>
            )
            : (
              <UI.DescriptionList>
                {rows.map((grant) => (
                  <UI.DescriptionItem
                    actionPlacement="below"
                    action={
                      <UI.Inline gap="compact">
                        {grant.sourceId !== null
                          ? (
                            <UI.Button
                              onClick={() => show(grant)}
                              variant="text"
                            >
                              {translate(words.show)}
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
            title={translate(words.confirmTitle, {
              name: removing.displayName,
            })}
            variant="destructive"
          >
            <UI.Text>
              {translate(words.confirmBody, { name: removing.displayName })}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
