import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";

/**
 * Issues / Batches / the page: where the batch pages sit. On the list itself
 * the last crumb is Batches; elsewhere Batches links back to it.
 */
export function BatchBreadcrumbs({ current }: { current?: string }) {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb" as never)}
        items={[
          { label: translate("issues.title" as never), href: "/issues" },
          current === undefined
            ? { label: translate("batches.title" as never) }
            : {
              label: translate("batches.title" as never),
              href: "/issues/batches",
            },
          ...(current === undefined ? [] : [{ label: current }]),
        ]}
      />
    </ShellSlot>
  );
}
