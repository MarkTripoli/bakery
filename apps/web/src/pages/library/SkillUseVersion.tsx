import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { SkillResponse, SkillVersionResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { sayAboutSkill } from "./SkillActions.tsx";

function failureKey(error: unknown) {
  if (asyncKindForError(error) === "offline") {
    return "library.skill.failure.offline";
  }
  switch (failureStatus(error)) {
    case 403:
      return "library.skill.failure.forbidden";
    case 412:
      return "library.skill.failure.conflict";
    default:
      return "library.skill.failure.failed";
  }
}

export function SkillUseVersion(
  { skill, version }: {
    readonly skill: SkillResponse;
    readonly version: SkillVersionResponse;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const [open, setOpen] = useState(false);
  const intent = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const number = version.revision;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["protected"] });
  const use = useMutation({
    mutationKey: ["skills.setActiveVersion"],
    mutationFn: async () => {
      const result = await api.setSkillActiveVersion({
        organizationId: scope.organizationId as string,
        id: skill.id,
        versionId: version.id,
        version: skill.version,
        idempotencyKey: intent.current ??= crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: async () => {
      intent.current = null;
      sayAboutSkill(translate("library.skill.use.done", { number }));
      setOpen(false);
      await refresh();
      focusAfterPaint(() =>
        globalThis.document.querySelector<HTMLElement>(
          `[data-version="${version.id}"]`,
        )
      );
    },
    onError: (error) => {
      const status = failureStatus(error);
      if (status !== null && status < 500) intent.current = null;
      void refresh();
    },
  });
  const close = () => {
    setOpen(false);
    focusAfterPaint(() => opener.current);
  };
  return (
    <>
      <UI.Inline>
        <UI.Button
          aria-label={translate("library.skill.use.actionNamed", { number })}
          onClick={(event) => {
            opener.current = event.currentTarget;
            intent.current = null;
            use.reset();
            setOpen(true);
          }}
          variant="secondary"
        >
          {translate("library.skill.use.action")}
        </UI.Button>
      </UI.Inline>
      {open
        ? (
          <UI.AlertDialog
            cancelAction={
              <UI.Button onClick={close} variant="secondary">
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                disabled={use.isPending}
                loading={use.isPending}
                onClick={() => use.mutate()}
                variant="primary"
              >
                {translate("library.skill.use.actionNamed", { number })}
              </UI.Button>
            }
            onOpenChange={(next) => !next && !use.isPending && close()}
            open
            state={use.isPending ? "confirming" : "open"}
            title={translate("library.skill.use.actionNamed", { number })}
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("library.skill.use.body", { number })}
              </UI.Text>
              {use.isError
                ? (
                  <UI.InlineNotice role="alert" tone="error">
                    {translate(failureKey(use.error), { name: skill.name })}
                  </UI.InlineNotice>
                )
                : null}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
