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
        // The compiler's findings are errors too (they name the node or field).
        const errors = [
          ...report.errors,
          ...(report.compilerDiagnostics ?? []).filter((found) =>
            !report.errors.some((known) =>
              known.path === found.path && known.message === found.message
            )
          ),
        ];
        if (errors.length > 0) {
          setCheck({
            state: "invalid",
            problems: problemsOf(errors, read.definition),
          });
        } else {
          setCheck({
            state: "valid",
            read,
            warnings: problemsOf(report.warnings ?? [], read.definition),
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
  // A problem says what to fix when the checker's code and the definition
  // let it; otherwise the place and the checker's own sentence.
  const way = (problem: ImportProblem) =>
    (problem.inside ?? []).map((part) =>
      part.kind === "name" ? part.name : translate(
        (part.kind === "step"
          ? "library.import.part.step"
          : "library.import.part.branch") as never,
        { number: part.number },
      )
    ).join(", ");
  const sentence = (problem: ImportProblem): string | null => {
    const nested = problem.inside !== undefined && problem.inside.length > 0;
    if (
      problem.code === "action_unknown" && problem.where.kind === "step" &&
      problem.detail !== undefined
    ) {
      return nested
        ? translate("library.import.problem.actionUnknownIn" as never, {
          number: problem.where.number,
          parts: way(problem),
          action: problem.detail,
        })
        : translate("library.import.problem.actionUnknown" as never, {
          number: problem.where.number,
          action: problem.detail,
        });
    }
    if (problem.code === "field_missing" && problem.where.kind === "step") {
      if (problem.field === undefined) {
        return translate("library.import.problem.stepFieldMissing" as never, {
          number: problem.where.number,
        });
      }
      return nested
        ? translate("library.import.problem.stepFieldMissingIn" as never, {
          number: problem.where.number,
          parts: way(problem),
          field: problem.field,
        })
        : translate("library.import.problem.stepFieldMissingNamed" as never, {
          number: problem.where.number,
          field: problem.field,
        });
    }
    if (problem.code === "field_missing" && problem.where.kind === "whole") {
      return translate("library.import.problem.fieldMissing" as never);
    }
    if (
      problem.code === "field_missing" && problem.field !== undefined &&
      problem.where.kind === "path" && !problem.where.path.includes(".")
    ) {
      return translate("library.import.problem.fieldMissingNamed" as never, {
        field: problem.field,
      });
    }
    return null;
  };
  const lines = (problems: readonly ImportProblem[], label: string) => (
    <UI.Stack gap="compact" role="list" aria-label={label}>
      {problems.map((problem, index) => (
        <div key={index} role="listitem">
          {sentence(problem) !== null
            ? <UI.Text variant="caption">{sentence(problem)}</UI.Text>
            : problem.where.kind === "path"
            ? (
              <UI.Inline gap="compact">
                <UI.DataText>{where(problem)}</UI.DataText>
                <UI.Text variant="caption">{problem.message}</UI.Text>
              </UI.Inline>
            )
            : (
              <UI.Text variant="caption">
                {where(problem)}
                {": "}
                {problem.message}
              </UI.Text>
            )}
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
              cols={80}
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
                  invalid={(tried && emptyName) || failure === "nameTaken" ||
                    failure === "nameRejected" || undefined}
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
          {check.state === "empty"
            ? (
              <UI.Text variant="muted" data-testid="import-reason">
                {translate("library.import.empty" as never)}
              </UI.Text>
            )
            : null}
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
