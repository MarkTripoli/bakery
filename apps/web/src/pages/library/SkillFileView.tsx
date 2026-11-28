import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import { skillFileQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  isMarkdownFile,
  type ManifestFile,
  skillFileShown,
  skillFileWords,
  withoutFrontMatter,
} from "./skills-state.ts";

export function SkillFileView(
  { versionId, file }: {
    readonly versionId: string;
    readonly file: ManifestFile;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const shown = skillFileShown(file);
  const options = skillFileQueryOptions(api, scope, versionId, file.path);
  const bytes = useQuery({ ...options, enabled: shown && options.enabled });
  const cannot = (
    <UI.Text variant="muted">
      {translate("library.skill.files.cannotShow")}
    </UI.Text>
  );
  if (!shown) return cannot;
  if (bytes.isError) {
    return (
      <UI.InlineNotice
        tone="error"
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void bytes.refetch()}
          >
            {translate("library.retry")}
          </UI.Button>
        }
      >
        {translate("library.skill.files.fileError")}
      </UI.InlineNotice>
    );
  }
  if (bytes.data === undefined) return <UI.Skeleton shape="row" />;
  const words = skillFileWords(bytes.data.content);
  if (words === null) return cannot;
  return isMarkdownFile(file)
    ? (
      <UI.ArtifactViewer
        label={translate("library.skill.files.contents")}
        size="full"
        content={{ kind: "markdown", text: withoutFrontMatter(words) }}
      />
    )
    : <UI.CodeBlock aria-label={file.path} code={words} />;
}
