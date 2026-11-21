import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { EvaluationBatch } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { evaluationBatchesQueryOptions } from "../../api/query.ts";
import {
  asyncKindForError,
  isForbiddenFailure,
} from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { gateLine, pinTitle, runBadge } from "./evaluations-state.ts";

/**
 * The Evaluations tab of the Library (design-ux #75, revision 4): one row per
 * run, newest first, with its state and its quality gate in words. Starting a
 * run and comparing two runs are later slices, so the tab has no button for
 * them.
 */
export function EvaluationsTab() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const runs = useInfiniteQuery(evaluationBatchesQueryOptions(api, scope));

  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(iso),
    );
  const rows: EvaluationBatch[] =
    runs.data?.pages.flatMap((page) => page.items) ?? [];
  const title = (run: EvaluationBatch) => {
    const words = pinTitle(run.candidate, run.candidateDefinition);
    return translate(words.key, words.values);
  };
  const line = (run: EvaluationBatch) =>
    translate("library.evaluations.rowLine", {
      set: run.datasetName,
      started: when(run.createdAt),
    });
  const open = (run: EvaluationBatch) =>
    void navigate({
      to: "/library/evaluations/$batchId",
      params: { batchId: run.id },
    });

  if (runs.isError) {
    const forbidden = isForbiddenFailure(runs.error);
    const offline = !forbidden && asyncKindForError(runs.error) === "offline";
    return forbidden
      ? (
        <UI.EmptyState
          title={translate("library.forbidden.title")}
          description={translate("library.forbidden.description")}
          variant="firstUse"
        />
      )
      : (
        <UI.ErrorState
          title={translate(
            offline ? "library.offlineTitle" : "library.error.title",
          )}
          description={translate(
            offline
              ? "library.offlineDescription"
              : "library.error.description",
          )}
          action={
            <UI.Button
              variant="secondary"
              onClick={() => void runs.refetch()}
            >
              {translate("library.retry")}
            </UI.Button>
          }
        />
      );
  }
  if (runs.isPending) {
    return (
      <UI.Stack gap="standard" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {translate("library.loading")}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (rows.length === 0) {
    return (
      <UI.ListSection
        data-testid="library-evaluations"
        flush
        title={translate("library.evaluations.title")}
        variant={phone ? "list" : "table"}
      >
        <UI.EmptyState
          title={translate("library.evaluations.emptyTitle")}
          description={translate("library.evaluations.emptyDescription")}
          variant="firstUse"
        />
      </UI.ListSection>
    );
  }

  const columns: UI.DataTableColumn<EvaluationBatch>[] = [
    {
      id: "run",
      header: translate("library.evaluations.column.run"),
      cell: (run) => (
        <UI.Stack gap="none">
          <UI.Text>{title(run)}</UI.Text>
          <UI.Text variant="caption">{line(run)}</UI.Text>
        </UI.Stack>
      ),
    },
    {
      id: "state",
      header: translate("library.evaluations.column.state"),
      width: "320px",
      cell: (run) => {
        const badge = runBadge(run);
        return (
          <UI.Badge tone={badge.tone}>
            {translate(badge.words.key, badge.words.values)}
          </UI.Badge>
        );
      },
    },
    {
      id: "gate",
      header: translate("library.evaluations.column.gate"),
      width: "260px",
      cell: (run) => {
        const words = gateLine(run);
        return translate(words.key, words.values);
      },
    },
    {
      id: "action",
      header: (
        <UI.VisuallyHidden>
          {translate("library.evaluations.column.action")}
        </UI.VisuallyHidden>
      ),
      width: "96px",
      cell: (run) => (
        <UI.Button
          aria-label={translate("library.evaluations.openLabel", {
            title: title(run),
          })}
          onClick={() => open(run)}
          type="button"
          variant="secondary"
        >
          {translate("library.evaluations.open")}
        </UI.Button>
      ),
    },
  ];

  return (
    <UI.Stack gap="spacious" data-testid="library-evaluations">
      <UI.Text variant="muted">
        {translate("library.evaluations.intro")}
      </UI.Text>
      {phone
        ? (
          <UI.Stack
            aria-label={translate("library.evaluations.listLabel")}
            gap="none"
            role="list"
          >
            {rows.map((run) => {
              const badge = runBadge(run);
              const gate = gateLine(run);
              return (
                <div data-run={run.id} key={run.id} role="listitem">
                  <UI.StackedRow
                    title={title(run)}
                  >
                    <UI.Stack gap="compact">
                      <UI.Inline gap="compact">
                        <UI.Badge tone={badge.tone}>
                          {translate(badge.words.key, badge.words.values)}
                        </UI.Badge>
                      </UI.Inline>
                      <UI.Text variant="caption">{line(run)}</UI.Text>
                      <UI.Text variant="caption">
                        {translate(gate.key, gate.values)}
                      </UI.Text>
                      <UI.Button
                        aria-label={translate("library.evaluations.openLabel", {
                          title: title(run),
                        })}
                        onClick={() => open(run)}
                        type="button"
                        variant="secondary"
                      >
                        {translate("library.evaluations.open")}
                      </UI.Button>
                    </UI.Stack>
                  </UI.StackedRow>
                </div>
              );
            })}
          </UI.Stack>
        )
        : (
          <UI.DataTable
            caption={translate("library.evaluations.listLabel")}
            captionHidden
            columns={columns}
            getRowAttributes={(run) => ({ "data-run": run.id })}
            getRowKey={(run) => run.id}
            rows={rows}
            variant="ruled"
          />
        )}
      {runs.hasNextPage
        ? (
          <UI.Button
            loading={runs.isFetchingNextPage}
            onClick={() => void runs.fetchNextPage()}
            type="button"
            variant="secondary"
          >
            {translate("library.evaluations.showMore")}
          </UI.Button>
        )
        : null}
    </UI.Stack>
  );
}
