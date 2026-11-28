import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export function DraftKeptNotice(
  { version, pending, onRetry }: {
    readonly version: number;
    readonly pending: boolean;
    readonly onRetry: () => void;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice role="alert" tone="error">
      <UI.Stack gap="compact">
        <UI.Text>
          {translate("library.workflow.draftKept", { version })}
        </UI.Text>
        <UI.Inline gap="compact">
          <UI.Button
            disabled={pending}
            loading={pending}
            onClick={onRetry}
            variant="secondary"
          >
            {translate("library.workflow.draftKeptRetry")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.InlineNotice>
  );
}
