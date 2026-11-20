import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { SavedDataItem, SavedDataPage } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  pluginSavedDataQueryOptions,
  SAVED_DATA_PAGE,
} from "../../api/query.ts";
import { isForbiddenFailure } from "../../app/async-state.ts";
import { useCursorPages } from "../../app/cursor-pages/useCursorPages.ts";
import { formatBytes } from "../../app/plugins.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * "Saved data": what a plugin has kept for itself, as a read-only list. Where it
 * is kept, how big it is and when it was last saved; never what is inside, and
 * nothing here can be changed. The read carries no value, so there is none to hide.
 */
export function SavedData(
  { installId, name, phone }: {
    readonly installId: string;
    /** The plugin's name, for the caption. */
    readonly name: string;
    readonly phone: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { locale, timeZone, translate } = useI18n();
  const first = useQuery(pluginSavedDataQueryOptions(api, scope, installId));
  const pages = useCursorPages<SavedDataItem>(
    first,
    installId,
    async (cursor): Promise<SavedDataPage> => {
      const result = await api.plugins.savedData({
        organizationId: scope.organizationId as string,
        installId,
        cursor,
        limit: SAVED_DATA_PAGE,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
  );
  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  const size = (item: SavedDataItem) => formatBytes(item.sizeBytes, locale);

  const heading = (
    <UI.Inline gap="compact">
      <UI.Heading level="section">
        {translate("settings.plugins.saved.heading")}
      </UI.Heading>
      <UI.HelpTip label={translate("settings.plugins.saved.heading")}>
        {translate("settings.plugins.saved.help")}
      </UI.HelpTip>
    </UI.Inline>
  );

  if (first.isPending) {
    return (
      <UI.Stack gap="standard" data-testid="plugin-saved">
        {heading}
        <UI.Stack
          gap="standard"
          role="list"
          aria-busy="true"
          aria-label={translate("settings.plugins.saved.loading")}
        >
          {[0, 1, 2].map((index) => (
            <div key={index} role="listitem">
              <UI.Skeleton shape="row" />
            </div>
          ))}
        </UI.Stack>
      </UI.Stack>
    );
  }
  if (first.isError) {
    return (
      <UI.Stack gap="standard" data-testid="plugin-saved">
        {heading}
        {isForbiddenFailure(first.error)
          ? (
            <UI.Text variant="muted">
              {translate("settings.plugins.saved.forbidden")}
            </UI.Text>
          )
          : (
            <UI.InlineNotice tone="error" role="alert">
              <UI.Text>{translate("settings.plugins.saved.failed")}</UI.Text>
              <UI.Inline gap="compact">
                <UI.Button
                  variant="secondary"
                  onClick={() => void first.refetch()}
                >
                  {translate("settings.plugins.saved.retry")}
                </UI.Button>
              </UI.Inline>
            </UI.InlineNotice>
          )}
      </UI.Stack>
    );
  }

  const items = pages.items;
  const total = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  return (
    <UI.Stack gap="standard" data-testid="plugin-saved">
      {heading}
      {items.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("settings.plugins.saved.none")}
          </UI.Text>
        )
        : (
          <>
            {phone
              ? (
                <UI.Stack
                  gap="none"
                  role="list"
                  aria-label={translate("settings.plugins.saved.heading")}
                >
                  {items.map((item) => (
                    <div key={item.id} role="listitem">
                      <UI.StackedRow
                        title={<UI.DataText>{item.key}</UI.DataText>}
                      >
                        <UI.Text variant="caption">
                          {translate("settings.plugins.saved.rowLine", {
                            group: item.namespace,
                            size: size(item),
                            when: when(item.updatedAt),
                          })}
                        </UI.Text>
                      </UI.StackedRow>
                    </div>
                  ))}
                </UI.Stack>
              )
              : (
                <UI.DataTable<SavedDataItem>
                  caption={translate("settings.plugins.saved.heading")}
                  captionHidden
                  variant="ruled"
                  inset="edge"
                  rowSize="single"
                  rows={[...items]}
                  state="ready"
                  getRowKey={(item) => item.id}
                  columns={[
                    {
                      id: "group",
                      width: "20%",
                      header: translate("settings.plugins.saved.group"),
                      cell: (item) => <UI.Text>{item.namespace}</UI.Text>,
                    },
                    {
                      id: "name",
                      width: "40%",
                      header: translate("settings.plugins.saved.name"),
                      cell: (item) => <UI.DataText>{item.key}</UI.DataText>,
                    },
                    {
                      id: "size",
                      width: "15%",
                      header: translate("settings.plugins.saved.size"),
                      cell: (item) => <UI.Text>{size(item)}</UI.Text>,
                    },
                    {
                      id: "saved",
                      align: "end",
                      header: translate("settings.plugins.saved.lastSaved"),
                      cell: (item) => <UI.Text>{when(item.updatedAt)}</UI.Text>,
                    },
                  ]}
                />
              )}
            <UI.Text variant="hint">
              {pages.hasNext
                ? translate("settings.plugins.saved.captionMore", {
                  count: items.length,
                  total: formatBytes(total, locale),
                  name,
                })
                : items.length === 1
                ? translate("settings.plugins.saved.caption.one", {
                  total: formatBytes(total, locale),
                  name,
                })
                : translate("settings.plugins.saved.caption", {
                  count: items.length,
                  total: formatBytes(total, locale),
                  name,
                })}
            </UI.Text>
            {pages.moreError
              ? (
                <UI.InlineNotice tone="error" role="alert">
                  {translate("settings.plugins.saved.moreFailed")}
                </UI.InlineNotice>
              )
              : null}
            {pages.hasNext
              ? (
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={pages.loadingMore}
                    onClick={pages.moreError ? pages.retryMore : pages.loadMore}
                  >
                    {translate("settings.plugins.saved.showMore")}
                  </UI.Button>
                </UI.Inline>
              )
              : null}
          </>
        )}
    </UI.Stack>
  );
}
