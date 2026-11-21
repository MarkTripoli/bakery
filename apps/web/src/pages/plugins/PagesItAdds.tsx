import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { PluginPageEntry } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * The pages one plugin adds to Bakery (design-ux, #76 revision 5): a ruled list
 * like the versions list below it, each page's title at the start of its row
 * and Open at the end. While the plugin is off its pages are hidden, and a
 * version that adds none says so.
 */
export function PagesItAdds(
  { installId, on, pages, phone }: {
    readonly installId: string;
    /** Whether the plugin is on; only then does the server list its pages. */
    readonly on: boolean;
    readonly pages: readonly PluginPageEntry[];
    /** The phone form of the list: a stacked row with Open on the title line. */
    readonly phone: boolean;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const open = (page: PluginPageEntry) => (
    <UI.Button
      aria-label={translate("settings.plugins.pages.openLabel", {
        title: page.title,
      })}
      onClick={() =>
        void navigate({ to: `/plugins/${installId}/${page.pageId}` })}
      variant="secondary"
    >
      {translate("settings.plugins.pages.open")}
    </UI.Button>
  );
  return (
    <UI.Stack data-testid="plugin-pages" gap="standard">
      <UI.Stack gap="tight">
        <UI.Heading level="section">
          {translate("settings.plugins.pages.title")}
        </UI.Heading>
        {on && pages.length > 0
          ? (
            <UI.Text variant="muted">
              {translate("settings.plugins.pages.help")}
            </UI.Text>
          )
          : null}
      </UI.Stack>
      {!on
        ? (
          <UI.Text variant="muted">
            {translate("settings.plugins.pages.hidden")}
          </UI.Text>
        )
        : pages.length === 0
        ? <UI.Text>{translate("settings.plugins.pages.none")}</UI.Text>
        : phone
        ? (
          <UI.Stack
            gap="none"
            role="list"
            aria-label={translate("settings.plugins.pages.title")}
          >
            {pages.map((page) => (
              <div key={page.pageId} role="listitem">
                <UI.StackedRow title={page.title} status={open(page)} />
              </div>
            ))}
          </UI.Stack>
        )
        : (
          <UI.DataTable<PluginPageEntry>
            caption={translate("settings.plugins.pages.title")}
            captionHidden
            headingsHidden
            variant="ruled"
            inset="edge"
            rowSize="double"
            rows={[...pages]}
            state="ready"
            getRowKey={(page) => page.pageId}
            columns={[
              {
                id: "page",
                width: "70%",
                header: translate("settings.plugins.pages.column"),
                cell: (page) => <UI.Text>{page.title}</UI.Text>,
              },
              {
                id: "action",
                align: "end",
                header: translate("settings.plugins.column.action"),
                cell: open,
              },
            ]}
          />
        )}
    </UI.Stack>
  );
}
