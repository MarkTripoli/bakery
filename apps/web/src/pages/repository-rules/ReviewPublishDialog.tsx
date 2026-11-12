import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  OrganizationRepositoryRuleEntries,
  OrganizationRepositoryRulePreviewResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { organizationRepositoryRulePreviewQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import type { ProtectedScope } from "../../app/query-scope.ts";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { focusAfterPaint } from "./focus.ts";
import type { RuleEntry } from "./presentation.ts";

type PreviewItem = OrganizationRepositoryRulePreviewResponse["items"][number];

/** A repository the change touches beyond inheriting it, the way the server classified it. */
function isAffected(item: PreviewItem): boolean {
  return item.status !== "inherited" || item.unsupported ||
    item.reactivatedRules.length > 0;
}

/**
 * The review step before publishing: what the draft would do to the
 * organization's repositories, asked of the server (nothing is computed
 * here), and the button that publishes it. Publishing stays off until the
 * preview has answered, because publishing without it is what this step
 * exists to prevent.
 */
export function ReviewPublishDialog(
  { baseRevision, entries, onOpenChange, onPublished, onStale, open, scope }: {
    /** The published revision the draft was made against. */
    baseRevision: number;
    /** The rules as they would be once published. */
    entries: readonly RuleEntry[];
    onOpenChange: (open: boolean) => void;
    onPublished: (revision: number) => void;
    /** A newer revision was published meanwhile (the server answered 412). */
    onStale: () => void;
    open: boolean;
    scope: ProtectedScope;
  },
) {
  const api = useBakeryApi();
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const queryClient = useQueryClient();
  const [publishing, setPublishing] = useState(false);
  const [publishFailed, setPublishFailed] = useState(false);
  // One key per attempt; kept for a retry only when the outcome is unknown.
  const idempotencyKey = useRef<string | null>(null);

  const draftEntries = entries as unknown as OrganizationRepositoryRuleEntries;
  const preview = useInfiniteQuery({
    ...organizationRepositoryRulePreviewQueryOptions(api, scope, {
      expectedRevision: baseRevision,
      entries: draftEntries,
    }),
    enabled: open && Boolean(scope.organizationId),
  });
  // A draft made on a revision that is no longer the newest cannot be previewed or published.
  const stale = (error: unknown) => failureStatus(error) === 412;
  const refreshRules = () =>
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[3] === "repositoryRules.get",
    });
  const previewStale = preview.isError && stale(preview.error);
  useEffect(() => {
    if (!previewStale) return;
    void refreshRules().then(onStale);
  }, [previewStale]);
  // A retry that works replaces the error with the answer: focus the way forward.
  const hadError = useRef(false);
  useEffect(() => {
    // Only a first read that failed: a failed Load more has its own way on.
    if (preview.isError && !preview.data) hadError.current = true;
    else if (preview.isSuccess && hadError.current) {
      hadError.current = false;
      focusAfterPaint(() =>
        document.querySelector<HTMLElement>('[data-testid="org-rules-publish"]')
      );
    }
  }, [preview.isError, preview.isSuccess, preview.data]);
  // The Load more button became a failure notice: its Try again is the way on.
  useEffect(() => {
    if (!preview.isFetchNextPageError) return;
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>(
        '[data-testid="org-rules-loadmore-retry"]',
      )
    );
  }, [preview.isFetchNextPageError]);
  /** Loads the next page; when that was the last, the button is gone, so focus the rows. */
  const loadMore = async () => {
    const result = await preview.fetchNextPage();
    if (result.isError || result.hasNextPage) return;
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>(
        '[role="dialog"] [data-ui-component="dataTable"], dialog[open] [data-ui-component="dataTable"]',
      )
    );
  };
  const first = preview.data?.pages[0];
  const items = preview.data?.pages.flatMap((page) => page.items) ?? [];
  const affected = items.filter(isAffected);
  const revision = first?.draftRevision ?? baseRevision + 1;

  const publish = async () => {
    if (!scope.organizationId || publishing) return;
    setPublishing(true);
    setPublishFailed(false);
    idempotencyKey.current ??= crypto.randomUUID();
    const result = await api.publishOrganizationRepositoryRules({
      organizationId: scope.organizationId,
      expectedRevision: baseRevision,
      entries: draftEntries,
      idempotencyKey: idempotencyKey.current,
    });
    setPublishing(false);
    if (!result.ok && stale(result.error)) {
      idempotencyKey.current = null;
      await refreshRules();
      onStale();
      return;
    }
    if (!result.ok) {
      // A definite answer ends the attempt; no answer may be retried as the same one.
      if (failureStatus(result.error) !== null) idempotencyKey.current = null;
      setPublishFailed(true);
      return;
    }
    idempotencyKey.current = null;
    await queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[3] === "repositoryRules.get" ||
        query.queryKey[3] === "repositoryRuleVersions.list",
    });
    onPublished(result.data.revision);
  };

  const effects = (item: PreviewItem): string[] => [
    ...(item.status === "overridden"
      ? [translate("settings.repositoryRules.publish.overridden")]
      : []),
    ...(item.status === "newly_locked"
      ? [translate("settings.repositoryRules.publish.newlyLocked")]
      : []),
    ...(item.unsupported
      ? [translate("settings.repositoryRules.publish.unsupported")]
      : []),
    ...(item.reactivatedRules.length > 0
      ? [translate("settings.repositoryRules.publish.reactivated")]
      : []),
  ];

  const count = (label: string, value: number) => (
    <UI.Stack gap="tight" key={label}>
      <UI.Text variant="strong">{value}</UI.Text>
      <UI.Text variant="muted">{label}</UI.Text>
    </UI.Stack>
  );

  const body = (
    <UI.Stack>
      {preview.isPending
        ? (
          <div
            aria-busy="true"
            aria-label={translate("settings.repositoryRules.publish.checking")}
            data-testid="org-rules-preview-loading"
            role="status"
          >
            <UI.Stack gap="compact">
              {[0, 1, 2].map((row) => <UI.Skeleton key={row} shape="row" />)}
            </UI.Stack>
          </div>
        )
        : null}
      {preview.isError && !preview.data && !previewStale
        ? (
          <UI.ErrorState
            action={
              <UI.Button
                loading={preview.isFetching}
                onClick={() => void preview.refetch()}
                type="button"
              >
                {translate("core.actions.retry")}
              </UI.Button>
            }
            title={translate("settings.repositoryRules.publish.loadError")}
          />
        )
        : null}
      {first
        ? (
          <>
            <UI.Text>
              {translate("settings.repositoryRules.publish.body", {
                count: first.counts.repositories,
              })}
            </UI.Text>
            <UI.Inline>
              {count(
                translate("settings.repositoryRules.publish.inherited"),
                first.counts.inherited,
              )}
              {count(
                translate("settings.repositoryRules.publish.overridden"),
                first.counts.overridden,
              )}
              {count(
                translate("settings.repositoryRules.publish.newlyLocked"),
                first.counts.newlyLocked,
              )}
              {count(
                translate("settings.repositoryRules.publish.unsupported"),
                first.counts.unsupported,
              )}
            </UI.Inline>
            {first.counts.unsupported > 0
              ? (
                <UI.InlineNotice tone="warning">
                  {translate("settings.repositoryRules.publish.blocked", {
                    count: first.counts.unsupported,
                  })}
                </UI.InlineNotice>
              )
              : null}
            {affected.length > 0
              ? (
                <UI.DataTable<PreviewItem>
                  caption={translate(
                    "settings.repositoryRules.publish.affected",
                  )}
                  captionHidden
                  columns={[
                    {
                      id: "repository",
                      header: translate(
                        "settings.repositoryRules.publish.column.repository",
                      ),
                      cell: (item) => item.repositoryName,
                    },
                    {
                      id: "effect",
                      header: translate(
                        "settings.repositoryRules.publish.column.effect",
                      ),
                      cell: (item) => (
                        <UI.Inline>
                          {effects(item).map((label) => (
                            <UI.Badge key={label}>{label}</UI.Badge>
                          ))}
                        </UI.Inline>
                      ),
                    },
                  ]}
                  getRowKey={(item) => item.repositoryId}
                  rows={affected}
                  state="ready"
                  variant="table"
                />
              )
              : !preview.hasNextPage
              ? (
                <UI.Text variant="muted">
                  {translate("settings.repositoryRules.publish.noneAffected")}
                </UI.Text>
              )
              : null}
            {preview.isFetchNextPageError
              ? (
                <UI.InlineNotice
                  action={
                    <UI.Button
                      data-testid="org-rules-loadmore-retry"
                      loading={preview.isFetchingNextPage}
                      onClick={() => void loadMore()}
                      type="button"
                      variant="secondary"
                    >
                      {translate("core.actions.retry")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("settings.repositoryRules.publish.loadMoreError")}
                </UI.InlineNotice>
              )
              : preview.hasNextPage
              ? (
                <UI.Button
                  loading={preview.isFetchingNextPage}
                  onClick={() => void loadMore()}
                  type="button"
                  variant="secondary"
                >
                  {translate("settings.repositoryRules.publish.loadMore")}
                </UI.Button>
              )
              : null}
          </>
        )
        : null}
      {publishFailed
        ? (
          <UI.AlertBanner tone="error">
            {translate("settings.repositoryRules.publish.publishError")}
          </UI.AlertBanner>
        )
        : null}
      <UI.Inline variant="end">
        <UI.Button
          onClick={() => onOpenChange(false)}
          type="button"
          variant="secondary"
        >
          {translate("settings.repositoryRules.publish.back")}
        </UI.Button>
        <UI.Button
          data-testid="org-rules-publish"
          disabled={!preview.isSuccess}
          loading={publishing}
          onClick={() => void publish()}
          type="button"
        >
          {translate("settings.repositoryRules.publish.confirm")}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );

  const title = translate("settings.repositoryRules.publish.title", {
    revision,
  });
  const state = publishing ? "submitting" : publishFailed ? "error" : "open";
  return phone
    ? (
      <UI.Sheet
        onOpenChange={onOpenChange}
        open={open}
        state={state}
        title={title}
        variant="bottom"
      >
        {body}
      </UI.Sheet>
    )
    : (
      <UI.Dialog
        onOpenChange={onOpenChange}
        open={open}
        state={state}
        title={title}
        variant="form"
      >
        {body}
      </UI.Dialog>
    );
}
