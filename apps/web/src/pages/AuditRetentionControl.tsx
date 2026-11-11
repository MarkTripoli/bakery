import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useIdempotentIntent } from "../app/use-idempotent-intent.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

const RETENTION_CHOICES = ["forever", 30, 90, 180, 365, 730] as const;

/** Audit retention window selector for one organization. */
export function AuditRetentionControl({ organizationId }: {
  readonly organizationId: string;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const retentionKey = protectedQueryKey(
    { ...scope, organizationId },
    "auditRetention.get",
    {},
  );
  const retention = useQuery({
    queryKey: retentionKey,
    queryFn: async ({ signal }) => {
      const result = await api.auditRetention.get({ organizationId, signal });
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });
  const [choice, setChoice] = useState<string | null>(null);
  const [retentionNotice, setRetentionNotice] = useState<MessageKey | null>(
    null,
  );
  const intent = useIdempotentIntent();
  const current = retention.data?.retentionDays;
  const selected = choice ??
    (current === null || current === undefined ? "forever" : String(current));
  const [saving, saveRetention] = useSingleFlightSubmit(async () => {
    setRetentionNotice(null);
    const retentionDays = selected === "forever" ? null : Number(selected);
    const result = await api.auditRetention.update({
      organizationId,
      input: { retentionDays },
      idempotencyKey: intent.keyFor(String(retentionDays)),
    });
    if (!result.ok) {
      setRetentionNotice("settings.audit.retention.error");
      return;
    }
    queryClient.setQueryData(retentionKey, result.data);
    setChoice(null);
    intent.reset();
    setRetentionNotice("settings.audit.retention.saved");
  });

  return (
    <div>
      <UI.Text variant="muted">
        {translate("settings.audit.retention.description")}
      </UI.Text>
      <UI.Combobox
        label={translate("settings.audit.retention.label")}
        value={selected}
        onChange={(event) => setChoice(event.target.value)}
        options={RETENTION_CHOICES.map((value) => ({
          value: String(value),
          label: value === "forever"
            ? translate("settings.audit.retention.forever")
            : translate("settings.audit.retention.days", { count: value }),
        }))}
      />
      {retentionNotice
        ? (
          <UI.AlertBanner
            tone={retentionNotice === "settings.audit.retention.error"
              ? "error"
              : "information"}
          >
            {translate(retentionNotice)}
          </UI.AlertBanner>
        )
        : null}
      <UI.Button
        type="button"
        loading={saving}
        onClick={() => void saveRetention()}
      >
        {translate("settings.audit.retention.save")}
      </UI.Button>
    </div>
  );
}
