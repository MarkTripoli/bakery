import { useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type DraftFile,
  isScript,
  pathProblem,
  SKILL_FILE_NAME_LIMIT,
} from "./skill-draft-state.ts";

type Common = {
  readonly files: readonly DraftFile[];
  readonly busy: boolean;
  readonly onClose: () => void;
};

function problemText(
  translate: ReturnType<typeof useI18n>["translate"],
  problem: ReturnType<typeof pathProblem>,
): string | undefined {
  return problem === null
    ? undefined
    : translate(`library.skills.editor.path.${problem}` as never);
}

export function AddFileDialog(
  { files, busy, onClose, onAdd, onUpload, suggestion }: Common & {
    readonly suggestion: string;
    readonly onAdd: (path: string, runnable: boolean) => void;
    readonly onUpload: () => void;
  },
) {
  const { translate } = useI18n();
  const [path, setPath] = useState(suggestion);
  const [runnable, setRunnable] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = pathProblem(files, path);
  const error = tried ? problemText(translate, problem) : undefined;
  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !busy && onClose()}
      state={busy ? "submitting" : "open"}
      title={translate("library.skills.editor.addFile.title")}
      variant="form"
    >
      <form
        noValidate
        data-testid="skill-add-file-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (problem === null) onAdd(path.trim(), runnable);
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("library.skills.editor.addFile.name")}
            htmlFor="skill-add-file-name"
            hint={translate("library.skills.editor.addFile.hint")}
            required
            error={error}
          >
            <UI.TextInput
              id="skill-add-file-name"
              name="path"
              type="text"
              autoComplete="off"
              value={path}
              invalid={error !== undefined || undefined}
              onChange={(value) =>
                setPath(value.slice(0, SKILL_FILE_NAME_LIMIT + 1))}
            />
          </UI.Field>
          {isScript(path)
            ? (
              <UI.Checkbox
                checked={runnable}
                onChange={(event) => setRunnable(event.currentTarget.checked)}
              >
                {translate("library.skills.editor.file.runnable")}
              </UI.Checkbox>
            )
            : null}
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" disabled={busy} onClick={onClose}>
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button variant="secondary" disabled={busy} onClick={onUpload}>
              {translate("library.skills.editor.addFile.upload")}
            </UI.Button>
            <UI.Button type="submit" variant="primary" disabled={busy}>
              {translate("library.skills.editor.addFile.submit")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}

export function RenameFileDialog(
  { files, file, busy, onClose, onRename }: Common & {
    readonly file: DraftFile;
    readonly onRename: (newPath: string) => void;
  },
) {
  const { translate } = useI18n();
  const [path, setPath] = useState(file.path);
  const [tried, setTried] = useState(false);
  const problem = path.trim() === file.path
    ? null
    : pathProblem(files, path, file.path);
  const error = tried ? problemText(translate, problem) : undefined;
  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !busy && onClose()}
      state={busy ? "submitting" : "open"}
      title={translate("library.skills.editor.rename.title", {
        file: file.path,
      })}
      variant="form"
    >
      <form
        noValidate
        data-testid="skill-rename-file-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (problem === null && path.trim() !== file.path) {
            onRename(path.trim());
          }
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("library.skills.editor.addFile.name")}
            htmlFor="skill-rename-file-name"
            required
            error={error}
          >
            <UI.TextInput
              id="skill-rename-file-name"
              name="path"
              type="text"
              autoComplete="off"
              value={path}
              invalid={error !== undefined || undefined}
              onChange={(value) =>
                setPath(value.slice(0, SKILL_FILE_NAME_LIMIT + 1))}
            />
          </UI.Field>
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" disabled={busy} onClick={onClose}>
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button type="submit" variant="primary" disabled={busy}>
              {translate("library.skills.editor.file.rename")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
