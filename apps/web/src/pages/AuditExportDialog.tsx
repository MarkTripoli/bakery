import { useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

const RANGES = [7, 30, 90, 365] as const;
const RANGE_KEYS: Readonly<Record<(typeof RANGES)[number], MessageKey>> = {
  7: "settings.audit.since.7",
  30: "settings.audit.since.30",
  90: "settings.audit.since.90",
  365: "settings.audit.since.365",
};

/** Audit export trigger and dialog (JSON Lines download). */
export function AuditExportDialog({ organizationId }: {
  readonly organizationId: string;
}) {
  const api = useBakeryApi();
  const { translate } = useI18n();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [exportNotice, setExportNotice] = useState<MessageKey | null>(null);
  const [exporting, runExport] = useSingleFlightSubmit(async () => {
    setExportNotice(null);
    const now = Date.now();
    const result = await api.auditEvents.export({
      organizationId,
      query: {
        since: new Date(now - range * 86_400_000).toISOString(),
        until: new Date(now).toISOString(),
      },
    });
    if (!result.ok) {
      setExportNotice("settings.audit.export.error");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([result.data.content], { type: result.data.contentType }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = result.data.filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (result.data.truncated) {
      setExportNotice("settings.audit.export.truncated");
      return;
    }
    setOpen(false);
  });

  return (
    <div>
      <UI.Button type="button" onClick={() => setOpen(true)}>
        {translate("settings.audit.export.action")}
      </UI.Button>
      <UI.Dialog
        open={open}
        onOpenChange={setOpen}
        state={exporting ? "submitting" : exportNotice ? "error" : "open"}
        title={translate("settings.audit.export.title")}
        variant="form"
      >
        <UI.Text variant="muted">
          {translate("settings.audit.export.description")}
        </UI.Text>
        <UI.Combobox
          label={translate("settings.audit.export.range")}
          value={String(range)}
          onChange={(event) =>
            setRange(Number(event.target.value) as (typeof RANGES)[number])}
          options={RANGES.map((value) => ({
            value: String(value),
            label: translate(RANGE_KEYS[value]),
          }))}
        />
        <UI.Text>
          {translate("settings.audit.export.format")}
          {": "}
          {translate("settings.audit.export.format.value")}
        </UI.Text>
        {exportNotice
          ? (
            <UI.AlertBanner tone="error">
              {translate(exportNotice)}
            </UI.AlertBanner>
          )
          : null}
        <UI.Button type="button" onClick={() => setOpen(false)}>
          {translate("settings.audit.export.cancel")}
        </UI.Button>
        <UI.Button
          type="button"
          loading={exporting}
          onClick={() => void runExport()}
        >
          {translate("settings.audit.export.download")}
        </UI.Button>
      </UI.Dialog>
    </div>
  );
}
