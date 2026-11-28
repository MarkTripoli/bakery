import { useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";

const DOCUMENTS_SHOWN = 5;

export type ListedDocument = Readonly<{
  versionId: string;
  name: string;
  revision: number;
  detail?: string;
}>;

export function DocumentList(
  { documents, unchecked, gone, hidden }: {
    readonly documents: readonly ListedDocument[];
    readonly unchecked: number;
    readonly gone: number;
    readonly hidden: number;
  },
) {
  const { translate: t } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? documents : documents.slice(0, DOCUMENTS_SHOWN);
  return (
    <UI.Stack gap="tight">
      {shown.map((document) => (
        <UI.Stack gap="none" key={document.versionId}>
          <UI.Link
            variant="sentence"
            href={`/files/versions/${document.versionId}`}
          >
            {t("tasks.run.handover.documentVersion", {
              name: document.name,
              version: document.revision,
            })}
          </UI.Link>
          {document.detail === undefined
            ? null
            : <UI.Text variant="caption">{document.detail}</UI.Text>}
        </UI.Stack>
      ))}
      {documents.length > DOCUMENTS_SHOWN && !all
        ? (
          <UI.Inline>
            <UI.Button variant="quiet" onClick={() => setAll(true)}>
              {t("tasks.run.handover.showAll", { count: documents.length })}
            </UI.Button>
          </UI.Inline>
        )
        : null}
      {unchecked === 0
        ? null
        : (
          <UI.Text variant="muted" data-testid="documents-unchecked">
            {t("tasks.run.handover.documentsUnchecked", { count: unchecked })}
          </UI.Text>
        )}
      {gone === 0
        ? null
        : (
          <UI.Text variant="muted" data-testid="documents-gone">
            {t("tasks.run.handover.documentsGone", { count: gone })}
          </UI.Text>
        )}
      {hidden === 0
        ? null
        : (
          <UI.Text variant="muted" data-testid="documents-hidden">
            {t("tasks.run.handover.documentsHidden", { count: hidden })}
          </UI.Text>
        )}
    </UI.Stack>
  );
}
