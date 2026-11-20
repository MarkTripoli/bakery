import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { storageFileAtVersionQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";

/**
 * A link to one saved version (a memory's source, say): finds the file the
 * version belongs to and opens it in its folder at that version.
 */
export function FileVersionPage({ versionId }: { readonly versionId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const found = useQuery(
    storageFileAtVersionQueryOptions(api, scope, versionId),
  );
  const target = found.data;
  useEffect(() => {
    if (target === undefined) return;
    const parent = target.file.path.slice(0, target.file.path.lastIndexOf("/"));
    void navigate({
      to: "/files/$",
      params: { _splat: parent.slice(1) },
      search: target.isCurrent
        ? { file: target.file.id }
        : { file: target.file.id, tab: "versions", version: target.revision },
      replace: true,
    });
  }, [target, navigate]);
  return (
    <>
      <ShellActiveNavigation id="files" />
      <UI.Stack gap="spacious" data-testid="file-version-page">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("files.title")}
          subtitle={translate("files.description")}
        />
        {found.isError
          ? (
            <UI.EmptyState
              title={translate("files.version.notFound.title")}
              description={translate("files.version.notFound.description")}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void navigate({ to: "/files" })}
                >
                  {translate("files.notFound.action")}
                </UI.Button>
              }
            />
          )
          : (
            <UI.Text role="status">
              {translate("files.version.finding")}
            </UI.Text>
          )}
      </UI.Stack>
    </>
  );
}
