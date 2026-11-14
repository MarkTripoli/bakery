import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  ValidationReportResponse,
  WorkflowDefinitionResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { clip, NAME_LIMIT } from "./copy-workflow.ts";
import {
  type ImportProblem,
  type ImportRead,
  nameFromFile,
  problemsOf,
  readImport,
} from "./import-workflow.ts";
import { useCreateDraft } from "./use-create-draft.ts";

/** How long the text has to rest before it is checked. */
const SETTLE_MS = 500;

/** What the check of the current text found. */
type Check =
  | { readonly state: "empty" }
  | { readonly state: "checking" }
  | { readonly state: "unreadable" }
  | { readonly state: "offline" }
  | {
    readonly state: "invalid";
    readonly problems: readonly ImportProblem[];
  }
  | {
    readonly state: "valid";
    readonly read: Extract<ImportRead, { ok: true }>;
    readonly warnings: readonly ImportProblem[];
  };

/**
 * Import a workflow definition file as a new draft (design-ux, #66): the text
 * is read here, the server checks it, and only a definition the server
 * accepts can be imported. Importing creates a draft and runs nothing.
 */
export function ImportDialog(
  { onClose, onMade }: {
    readonly onClose: () => void;
    /** Called with the new workflow once it has its draft. */
    readonly onMade: (workflow: WorkflowDefinitionResponse) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const organizationId = scope.organizationId as string;
  const draft = useCreateDraft();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [check, setCheck] = useState<Check>({ state: "empty" });
  const [tried, setTried] = useState(false);
  const [fileName, setFileName] = useState("");
  const turn = useRef(0);

  const validate = useMutation({
    mutationKey: ["workflows.validate"],
    mutationFn: async (
      definition: Extract<ImportRead, { ok: true }>["definition"],
    ) => {
      const result = await api.validateWorkflow({
        organizationId,
        input: { definition },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data satisfies ValidationReportResponse;
    },
  });

  // Check the text once it has rested; a newer text overrides an older check.
  useEffect(() => {
    if (text.trim() === "") {
      setCheck({ state: "empty" });
      return;
    }
    const mine = ++turn.current;
    setCheck({ state: "checking" });
    const timer = setTimeout(async () => {
      const read = await readImport(text);
      if (mine !== turn.current) return;
      if (!read.ok) {
        setCheck({ state: "invalid", problems: read.problems });
        return;
      }
      try {
        const report = await validate.mutateAsync(read.definition);
        if (mine !== turn.current) return;
        if (report.errors.length > 0) {
          setCheck({ state: "invalid", problems: problemsOf(report.errors) });
        } else {
          setCheck({
            state: "valid",
            read,
            warnings: problemsOf(report.warnings ?? []),
          });
        }
      } catch (error) {
        if (mine !== turn.current) return;
        setCheck({
          state: asyncKindForError(error) === "offline"
            ? "offline"
            : "unreadable",
        });
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `validate` is a stable mutation handle; the text is the only input.
  }, [text]);

  // The name starts from what the file says it is, until the person types one.
  useEffect(() => {
    if (check.state === "valid" && !nameTouched && check.read.name !== null) {
      setName(check.read.name);
    }
  }, [check, nameTouched]);

  // The browser's own file picker, opened by the button (the page keeps no
  // file field of its own to style or to reach by keyboard).
  const choose = () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept =
      ".yaml,.yml,.json,application/yaml,application/json,text/yaml";
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (file === undefined) return;
      void file.text().then((content) => {
        setFileName(file.name);
        if (!nameTouched) setName(clip(nameFromFile(file.name), NAME_LIMIT));
        setText(content);
      });
    };
    picker.click();
  };

  const where = (problem: ImportProblem) =>
    problem.where.kind === "whole"
      ? translate("library.import.whole" as never)
      : problem.where.kind === "step"
      ? problem.where.field === null
        ? translate("library.import.step" as never, {
          number: problem.where.number,
        })
        : translate("library.import.stepField" as never, {
          number: problem.where.number,
          field: problem.where.field,
        })
      : problem.where.path;
  const lines = (problems: readonly ImportProblem[], label: string) => (
    <UI.Stack gap="compact" role="list" aria-label={label}>
      {problems.map((problem, index) => (
        <div key={index} role="listitem">
          <UI.Text variant="caption">
            <UI.DataText>{where(problem)}</UI.DataText>
            {": "}
            {problem.message}
          </UI.Text>
        </div>
      ))}
    </UI.Stack>
  );

  const valid = check.state === "valid";
  const emptyName = name.trim() === "";
  const submit = async () => {
    setTried(true);
    if (check.state !== "valid" || emptyName) return;
    const workflow = await draft.create({
      name: name.trim(),
      description: "",
      definition: check.read.definition,
      sourceYaml: text,
    });
    if (workflow !== null) onMade(workflow);
  };
  const { failure, made } = draft;

  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !draft.pending && onClose()}
      state={draft.pending ? "submitting" : "open"}
      title={translate("library.import.title" as never)}
      variant="form"
    >
      <form
        noValidate
        data-testid="import-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("library.import.file" as never)}
            htmlFor="workflow-import-file"
            hint={translate("library.import.fileHint" as never)}
          >
            <UI.Inline gap="compact">
              <UI.Button
                id="workflow-import-choose"
                variant="secondary"
                disabled={draft.pending || made !== null}
                onClick={choose}
              >
                {translate("library.import.choose" as never)}
              </UI.Button>
              {fileName === ""
                ? null
                : <UI.Text variant="caption">{fileName}</UI.Text>}
            </UI.Inline>
          </UI.Field>
          <UI.Field
            label={translate("library.import.paste" as never)}
            htmlFor="workflow-import-text"
            variant="textarea"
          >
            <textarea
              id="workflow-import-text"
              name="definition"
              rows={8}
              spellCheck={false}
              autoComplete="off"
              disabled={draft.pending || made !== null}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </UI.Field>
          <div role="status" aria-live="polite" data-import-state={check.state}>
            {check.state === "checking"
              ? (
                <UI.Text variant="muted">
                  {translate("library.import.checking" as never)}
                </UI.Text>
              )
              : check.state === "unreadable" || check.state === "offline"
              ? (
                <UI.InlineNotice tone="error">
                  {translate(
                    (check.state === "offline"
                      ? "library.import.offline"
                      : "library.import.unreadable") as never,
                  )}
                </UI.InlineNotice>
              )
              : check.state === "invalid"
              ? (
                <UI.InlineNotice tone="error">
                  <UI.Stack gap="compact">
                    <UI.Text>
                      {translate("library.import.invalid" as never, {
                        count: check.problems.length,
                      })}
                    </UI.Text>
                    {lines(
                      check.problems,
                      translate("library.import.problems" as never),
                    )}
                  </UI.Stack>
                </UI.InlineNotice>
              )
              : check.state === "valid"
              ? (
                <UI.InlineNotice tone="success">
                  <UI.Stack gap="compact">
                    <UI.Text>
                      {check.read.steps === null
                        ? translate("library.import.valid" as never)
                        : translate("library.import.validSteps" as never, {
                          count: check.read.steps,
                        })}
                    </UI.Text>
                    {check.warnings.length === 0 ? null : lines(
                      check.warnings,
                      translate("library.import.warnings" as never),
                    )}
                  </UI.Stack>
                </UI.InlineNotice>
              )
              : null}
          </div>
          {valid || made !== null
            ? (
              <UI.Field
                label={translate("library.import.name" as never)}
                htmlFor="workflow-import-name"
                hint={made !== null
                  ? translate("library.import.locked" as never)
                  : undefined}
                required
                error={tried && emptyName
                  ? translate("library.import.nameEmpty" as never)
                  : failure === "nameTaken" || failure === "nameRejected"
                  ? translate(`library.draft.${failure}` as never)
                  : undefined}
              >
                <UI.TextInput
                  id="workflow-import-name"
                  name="name"
                  type="text"
                  autoComplete="off"
                  value={name}
                  disabled={made !== null}
                  invalid={tried && emptyName || undefined}
                  onChange={(value) => {
                    setNameTouched(true);
                    setName(clip(value, NAME_LIMIT));
                    // A refused name is edited, not repeated.
                    if (failure === "nameTaken" || failure === "nameRejected") {
                      draft.clearFailure();
                    }
                  }}
                />
              </UI.Field>
            )
            : null}
          <UI.Text variant="muted">
            {translate("library.import.note" as never)}
          </UI.Text>
          {failure === null || failure === "nameTaken" ||
              failure === "nameRejected"
            ? null
            : (
              <UI.InlineNotice tone="error">
                {translate(
                  (failure === "stepsFailed"
                    ? "library.import.stepsFailed"
                    : failure === "offline"
                    ? "library.copy.offline"
                    : failure === "forbidden"
                    ? "library.import.forbidden"
                    : "library.import.failed") as never,
                  { name: made?.name ?? name.trim() },
                )}
              </UI.InlineNotice>
            )}
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              disabled={draft.pending}
              onClick={onClose}
            >
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              type="submit"
              variant="primary"
              disabled={draft.pending || (!valid && made === null)}
            >
              {translate(
                (made !== null
                  ? "library.copy.retry"
                  : "library.import.submit") as never,
              )}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
