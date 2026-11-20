import { useInfiniteQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { StorageFolderItem } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { storageFileVersionsQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { FilePreview } from "./FilePreview.tsx";

/**
 * A file opened full size, in the page column, with the details panel still
 * beside it. A work item's document does not come here: it opens on its
 * artifact page, where comments and publishing already live.
 */
export function FileOpened(
  { file, revision, onBack }: {
    readonly file: StorageFolderItem;
    /** The version being looked at; undefined for the current one. */
    readonly revision: number | undefined;
    readonly onBack: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const versions = useInfiniteQuery({
    ...storageFileVersionsQueryOptions(api, scope, file.id),
    enabled: scope.organizationId !== null,
  });
  const rows = versions.data?.pages.flatMap((page) => page.items) ?? [];
  const current = rows.find((version) => version.isCurrent) ?? null;
  // The same rule as the details panel: the current version is the plain file.
  const shown = revision === undefined || revision === current?.revision
    ? null
    : rows.find((version) => version.revision === revision) ?? null;
  return (
    <UI.Stack gap="standard" data-testid="file-opened">
      <UI.Inline variant="between" gap="compact">
        <UI.Heading level="section">{file.displayName ?? file.name}</UI.Heading>
        <UI.Button variant="secondary" onClick={onBack}>
          {translate("files.action.closeView")}
        </UI.Button>
      </UI.Inline>
      <FilePreview file={file} version={shown} full />
    </UI.Stack>
  );
}
