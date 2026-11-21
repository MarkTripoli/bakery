import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { PluginPageEntry } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * The pages one plugin adds to Bakery (design-ux, #76 revision 5): each with
 * its title and a way to open it. While the plugin is off its pages are
 * hidden, and a version that adds none says so.
 */
export function PagesItAdds(
  { installId, on, pages }: {
    readonly installId: string;
    /** Whether the plugin is on; only then does the server list its pages. */
    readonly on: boolean;
    readonly pages: readonly PluginPageEntry[];
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  return (
    <UI.Stack data-testid="plugin-pages" gap="tight">
      <UI.Heading level="section">
        {translate("settings.plugins.pages.title")}
      </UI.Heading>
      {!on
        ? (
          <UI.Text variant="muted">
            {translate("settings.plugins.pages.hidden")}
          </UI.Text>
        )
        : pages.length === 0
        ? <UI.Text>{translate("settings.plugins.pages.none")}</UI.Text>
        : (
          <UI.Stack gap="none">
            {pages.map((page) => (
              <UI.Inline gap="compact" key={page.pageId}>
                <UI.Text>{page.title}</UI.Text>
                <UI.Button
                  aria-label={translate("settings.plugins.pages.openLabel", {
                    title: page.title,
                  })}
                  onClick={() =>
                    void navigate({
                      to: `/plugins/${installId}/${page.pageId}`,
                    })}
                  variant="secondary"
                >
                  {translate("settings.plugins.pages.open")}
                </UI.Button>
              </UI.Inline>
            ))}
          </UI.Stack>
        )}
    </UI.Stack>
  );
}
