import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { type ArtifactResponse, versionEtag } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { effectiveAccessQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function ArtifactPinControl({ artifact, onUpdated }: {
  readonly artifact: ArtifactResponse;
  readonly onUpdated: () => Promise<void>;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scope),
    enabled: scope.organizationId !== null,
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const update = async (pinned: boolean) => {
    if (
      !scope.organizationId || access.data?.role !== "admin" || busy || error
    ) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(false);
    const result = await api.updateArtifact({
      organizationId: scope.organizationId,
      id: artifact.id,
      input: { pinned },
      ifMatch: versionEtag(artifact.version),
      idempotencyKey: crypto.randomUUID(),
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    if (!result.ok) {
      setBusy(false);
      setError(true);
      return;
    }
    setConfirm(false);
    await onUpdated();
    if (!abort.signal.aborted) setBusy(false);
  };
  if (access.isError || access.data?.role !== "admin") return null;
  return (
    <ArtifactPinView
      label={t(artifact.pinnedAt ? "artifact.pin.unpin" : "artifact.pin.pin")}
      busy={busy}
      error={error}
      confirm={confirm}
      onOpenChange={setConfirm}
      onPress={() => artifact.pinnedAt ? setConfirm(true) : void update(true)}
      onConfirm={() => void update(false)}
      onReload={() => {
        setError(false);
        setConfirm(false);
        void onUpdated();
      }}
      labels={{
        unpin: t("artifact.pin.unpin"),
        error: t("artifact.pin.error"),
        reload: t("artifact.pin.reload"),
        close: t("artifact.agent.close"),
        warning: t("artifact.pin.warning"),
      }}
    />
  );
}

export function ArtifactPinView(
  {
    label,
    busy,
    error,
    confirm,
    onPress,
    onConfirm,
    onOpenChange,
    onReload,
    labels,
  }: {
    readonly label: string;
    readonly busy: boolean;
    readonly error: boolean;
    readonly confirm: boolean;
    readonly onPress: () => void;
    readonly onConfirm: () => void;
    readonly onOpenChange: (open: boolean) => void;
    readonly onReload: () => void;
    readonly labels: {
      readonly unpin: string;
      readonly error: string;
      readonly reload: string;
      readonly close: string;
      readonly warning: string;
    };
  },
) {
  return (
    <UI.Stack gap="compact">
      <UI.Inline gap="compact">
        <UI.Button
          variant="outline"
          disabled={busy || error}
          onClick={onPress}
        >
          {label}
        </UI.Button>
      </UI.Inline>
      {error && !confirm
        ? (
          <UI.InlineNotice tone="error">
            {labels.error}
          </UI.InlineNotice>
        )
        : null}
      {error && !confirm
        ? (
          <UI.Button
            variant="outline"
            onClick={onReload}
          >
            {labels.reload}
          </UI.Button>
        )
        : null}
      <UI.Dialog
        title={labels.unpin}
        open={confirm}
        onOpenChange={onOpenChange}
        dismissLabel={labels.close}
      >
        <UI.Text>{labels.warning}</UI.Text>
        <UI.Button disabled={busy || error} onClick={onConfirm}>
          {labels.unpin}
        </UI.Button>
        {error && confirm
          ? (
            <UI.InlineNotice tone="error">
              {labels.error}
            </UI.InlineNotice>
          )
          : null}
        {error && confirm
          ? (
            <UI.Button
              variant="outline"
              onClick={onReload}
            >
              {labels.reload}
            </UI.Button>
          )
          : null}
      </UI.Dialog>
    </UI.Stack>
  );
}
