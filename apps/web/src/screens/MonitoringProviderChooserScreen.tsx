import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { ProviderInfo } from "./monitoring/monitoring-display.ts";

export type MonitoringProviderChooserScreenProps = {
  readonly state: "loading" | "error" | "ready";
  readonly providers: readonly ProviderInfo[];
  /** A row was chosen: open the form for this provider. */
  readonly onChoose: (key: string) => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
};

/**
 * `/installation/monitoring/new`: where Bakery should send its measurements.
 * One row per provider the server lists, with its mark, its name and one
 * sentence; a row opens the form for that provider. The marks are shown only
 * beside the provider's name, and the page says whose they are.
 */
export function MonitoringProviderChooserScreen(
  props: MonitoringProviderChooserScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-page="installation-monitoring-chooser">
      <UI.PageHeader
        description={translate("installation.monitoring.chooser.line")}
        flush
        title={translate("installation.monitoring.add")}
        variant="list"
      />
      {props.state === "loading"
        ? (
          <UI.Stack aria-busy="true" gap="compact">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : null}
      {props.state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetry} type="button">
                {translate("installation.monitoring.retry")}
              </UI.Button>
            }
            title={translate("installation.monitoring.error")}
          />
        )
        : null}
      {props.state === "ready"
        ? (
          <UI.Stack
            aria-label={translate("installation.monitoring.add")}
            gap="none"
            role="list"
          >
            {props.providers.map((provider) => (
              <div
                data-provider={provider.key}
                key={provider.key}
                role="listitem"
              >
                <UI.ObjectRow
                  actions={
                    <UI.Button
                      aria-label={translate("installation.monitoring.addKind", {
                        kind: provider.name,
                      })}
                      onClick={() => props.onChoose(provider.key)}
                      type="button"
                      variant="secondary"
                    >
                      {translate("installation.monitoring.chooser.choose")}
                    </UI.Button>
                  }
                  identity={
                    <UI.Inline gap="standard">
                      <UI.ProviderMark
                        name={provider.name}
                        provider={provider.key}
                        size="header"
                      />
                      <UI.Stack gap="none">
                        <UI.Text>{provider.name}</UI.Text>
                        <UI.Text variant="muted">
                          {provider.description}
                        </UI.Text>
                      </UI.Stack>
                    </UI.Inline>
                  }
                  variant="comfortable"
                />
              </div>
            ))}
          </UI.Stack>
        )
        : null}
      <UI.Text variant="muted">
        {translate("installation.monitoring.chooser.note")}
      </UI.Text>
      <UI.Inline gap="standard" variant="end">
        <UI.Button onClick={props.onCancel} type="button" variant="secondary">
          {translate("installation.monitoring.form.cancel")}
        </UI.Button>
      </UI.Inline>
    </UI.SettingsContent>
  );
}
