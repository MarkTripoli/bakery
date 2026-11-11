import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactStorageQueryOptions,
  effectiveAccessQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function ArtifactStorageStatus() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scope),
    enabled: scope.organizationId !== null,
  });
  const admin = !access.isError && access.data?.role === "admin";
  const storage = useQuery({
    ...artifactStorageQueryOptions(api, scope),
    enabled: scope.organizationId !== null && admin,
  });
  if (!admin) return null;
  if (storage.isError) {
    return (
      <UI.InlineNotice tone="error">
        {t("artifact.storage.error")}
        <UI.Button variant="secondary" onClick={() => void storage.refetch()}>
          {t("artifact.storage.retry")}
        </UI.Button>
      </UI.InlineNotice>
    );
  }
  if (!storage.data) return null;
  const state = storage.data.state;
  switch (state) {
    case "normal":
    case "unmonitored":
      return null;
    case "warning":
    case "paused":
    case "unavailable":
      return (
        <ArtifactStorageView
          state={state === "warning" ? "warning" : "paused"}
          title={t(`artifact.storage.${state}.title`)}
          description={t(`artifact.storage.${state}.description`)}
          usage={t("artifact.storage.usage", {
            retained: storage.data.retainedBytes,
            pinned: storage.data.pinnedBytes,
          })}
          action={{
            label: t("artifact.storage.retry"),
            onClick: () => void storage.refetch(),
          }}
        />
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function ArtifactStorageView(
  { state, title, description, usage, action }: {
    readonly state: "warning" | "paused";
    readonly title: string;
    readonly description: string;
    readonly usage?: string;
    readonly action: { readonly label: string; readonly onClick: () => void };
  },
) {
  const button = (
    <UI.Button variant="outline" onClick={action.onClick}>
      {action.label}
    </UI.Button>
  );
  return (
    <UI.CapacityBanner
      state={state}
      title={title}
      description={description}
      actions={usage
        ? (
          <UI.Stack gap="compact">
            <UI.Text variant="caption">{usage}</UI.Text>
            {button}
          </UI.Stack>
        )
        : button}
    />
  );
}
