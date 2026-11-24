import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { EvaluationBatch } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { evaluationBatchesQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { olderFirst } from "./evaluations-compare.ts";
import { pinTitle } from "./evaluations-state.ts";

type Current = Pick<EvaluationBatch, "id" | "datasetId" | "createdAt">;

export function EvaluationComparePicker(
  { current, onClose }: {
    readonly current: Current;
    readonly onClose: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  const read = useInfiniteQuery(evaluationBatchesQueryOptions(api, scope, 50));
  const runs = (read.data?.pages.flatMap((page) => page.items) ?? [])
    .filter((run) => run.id !== current.id);
  const same = runs.filter((run) => run.datasetId === current.datasetId);
  const other = runs.filter((run) => run.datasetId !== current.datasetId);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone,
    }).format(new Date(iso));
  const choose = (run: EvaluationBatch) => {
    const [left, right] = olderFirst(current, run);
    onClose();
    void navigate({
      to: "/library/evaluations/$batchId/compare/$otherId",
      params: { batchId: left.id, otherId: right.id },
    });
  };
  const section = (
    labelKey: "same" | "other",
    items: readonly EvaluationBatch[],
  ) =>
    items.length === 0 ? null : (
      <UI.Stack gap="tight" key={labelKey}>
        <UI.Text variant="strong">
          {translate(`library.evaluations.compare.picker.${labelKey}` as const)}
        </UI.Text>
        <UI.Stack
          aria-label={translate(
            `library.evaluations.compare.picker.${labelKey}` as const,
          )}
          data-section={labelKey}
          gap="none"
          role="list"
        >
          {items.map((run) => {
            const title = pinTitle(run.candidate, run.candidateDefinition);
            return (
              <div data-run={run.id} key={run.id} role="listitem">
                <UI.ListRow
                  detail={translate(
                    "library.evaluations.compare.picker.detail",
                    {
                      set: run.datasetName,
                      date: date(run.createdAt),
                    },
                  )}
                  onSelect={() => choose(run)}
                  title={translate(title.key, title.values)}
                />
              </div>
            );
          })}
        </UI.Stack>
      </UI.Stack>
    );
  return (
    <UI.Dialog
      data-testid="evaluation-compare-picker"
      dismissLabel={translate("library.evaluations.compare.picker.dismiss")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      title={translate("library.evaluations.compare.picker.title")}
    >
      {read.isPending
        ? (
          <UI.Text role="status" variant="muted">
            {translate("library.evaluations.compare.picker.loading")}
          </UI.Text>
        )
        : read.isError
        ? (
          <UI.Stack gap="tight">
            <UI.InlineNotice tone="error">
              {translate("library.evaluations.compare.picker.error")}
            </UI.InlineNotice>
            <UI.Button onClick={() => void read.refetch()} variant="secondary">
              {translate("library.evaluations.compare.picker.retry")}
            </UI.Button>
          </UI.Stack>
        )
        : runs.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("library.evaluations.compare.picker.empty")}
          </UI.Text>
        )
        : (
          <UI.Stack gap="standard">
            {section("same", same)}
            {section("other", other)}
            {read.hasNextPage
              ? (
                <UI.Button
                  loading={read.isFetchingNextPage}
                  onClick={() => void read.fetchNextPage()}
                  variant="secondary"
                >
                  {translate("library.evaluations.compare.more", {
                    count: 50,
                  })}
                </UI.Button>
              )
              : null}
          </UI.Stack>
        )}
    </UI.Dialog>
  );
}
