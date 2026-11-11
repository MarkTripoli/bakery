import * as UI from "@bakery/ui";
import { AuditExportDialog } from "./AuditExportDialog.tsx";
import { AuditRetentionControl } from "./AuditRetentionControl.tsx";

/** Audit export (JSON Lines download) and retention window for one organization. */
export function AuditExportRetention({ organizationId }: {
  readonly organizationId: string;
}) {
  return (
    <UI.Stack data-testid="audit-export-retention">
      <AuditExportDialog organizationId={organizationId} />
      <AuditRetentionControl organizationId={organizationId} />
    </UI.Stack>
  );
}
