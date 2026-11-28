import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  skillDraftQueryOptions,
} from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { clip } from "./copy-workflow.ts";
import { draftFailure, SKILL_NAME_LIMIT, slugOf } from "./skill-draft-state.ts";
import { useOrganizationName } from "./useOrganizationName.ts";

type Choice = "organization" | "personal";
export function SkillNewDialog({ onClose }: { readonly onClose: () => void }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const organizationId = scope.organizationId as string;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const admin = access.data?.role === "admin";
  const organizationName = useOrganizationName() ?? "";
  const [who, setWho] = useState<Choice | null>(null);
  const chosen: Choice = who ?? (admin ? "organization" : "personal");
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<
    ReturnType<typeof draftFailure> | null
  >(null);
  const key = useRef<string | null>(null);

  const create = useMutation({
    mutationKey: ["skills.create"],
    mutationFn: async (input: { name: string; scope: Choice }) => {
      key.current ??= crypto.randomUUID();
      const made = await api.createSkill({
        organizationId,
        input: {
          slug: slugOf(input.name),
          name: input.name,
          scope: input.scope,
        },
        idempotencyKey: key.current,
      });
      if (!made.ok) throw made.error;
      const draft = await api.openSkillDraft({
        organizationId,
        id: made.data.id,
      });
      if (draft.ok) {
        queryClient.setQueryData(
          skillDraftQueryOptions(
            api,
            scope,
            made.data.id,
          ).queryKey,
          draft.data,
        );
      }
      return made.data;
    },
  });
  const pending = create.isPending;
  const empty = name.trim() === "";
  const submit = async () => {
    setTried(true);
    if (empty) return;
    setFailure(null);
    try {
      const made = await create.mutateAsync({
        name: name.trim(),
        scope: chosen,
      });
      key.current = null;
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      void navigate({
        to: "/library/skills/$skillId/edit",
        params: { skillId: made.id },
      });
    } catch (error) {
      const status = failureStatus(error);
      if (status !== null && status < 500) key.current = null;
      setFailure(draftFailure(error));
    }
  };
  const nameError = tried && empty
    ? translate("library.skill.nameEmpty")
    : failure === "nameTaken"
    ? translate("library.skills.new.nameTaken")
    : failure === "rejected"
    ? translate("library.skill.nameRejected")
    : undefined;
  const failureLine = failure === null || failure === "nameTaken" ||
      failure === "rejected"
    ? null
    : (
      <UI.InlineNotice tone="error" role="alert">
        {translate(`library.skills.editor.failure.${failure}` as never)}
      </UI.InlineNotice>
    );

  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !pending && onClose()}
      state={pending ? "submitting" : "open"}
      title={translate("library.skills.new.title")}
      variant="form"
    >
      <form
        noValidate
        data-testid="skill-new-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Stack
            gap="tight"
            role="radiogroup"
            aria-label={translate("library.skills.new.who")}
          >
            <UI.Text variant="strong">
              {translate("library.skills.new.who")}
            </UI.Text>
            <UI.Stack gap="none">
              <UI.Radio
                checked={chosen === "organization"}
                disabled={!admin || pending}
                name="skill-new-scope"
                onChange={() => setWho("organization")}
                value="organization"
              >
                {translate("library.skill.scope.organization")}
              </UI.Radio>
              <UI.Text variant="hint">
                {admin
                  ? translate("library.skill.copy.organizationHint", {
                    organization: organizationName,
                  })
                  : translate("library.skill.copy.organizationOnlyAdmins")}
              </UI.Text>
            </UI.Stack>
            <UI.Stack gap="none">
              <UI.Radio
                checked={chosen === "personal"}
                disabled={pending}
                name="skill-new-scope"
                onChange={() => setWho("personal")}
                value="personal"
              >
                {translate("library.skill.scope.personal")}
              </UI.Radio>
              <UI.Text variant="hint">
                {translate("library.skill.copy.personalHint")}
              </UI.Text>
            </UI.Stack>
          </UI.Stack>
          <UI.Field
            label={translate("library.skill.name")}
            htmlFor="skill-new-name"
            required
            error={nameError}
          >
            <UI.TextInput
              id="skill-new-name"
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              invalid={nameError !== undefined || undefined}
              onChange={(value) => {
                setName(clip(value, SKILL_NAME_LIMIT));
                if (failure === "nameTaken" || failure === "rejected") {
                  setFailure(null);
                }
              }}
            />
          </UI.Field>
          <UI.Text variant="hint">
            {translate("library.skills.new.hint")}
          </UI.Text>
          {failureLine}
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              disabled={pending}
              onClick={onClose}
            >
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button type="submit" variant="primary" disabled={pending}>
              {translate("library.skills.new.create")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
