import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { SkillResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { organizationQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { slugFromName } from "./draft-state.ts";

export function NewSkillDialog(
  { onClose, onCreated }: {
    onClose: () => void;
    onCreated: (skill: SkillResponse) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [name, setName] = useState("");
  const [forOrganization, setForOrganization] = useState(true);
  const [refusal, setRefusal] = useState<"taken" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const organization = useQuery(organizationQueryOptions(api, scope));
  const organizationId = scope.organizationId;
  const slug = slugFromName(name);

  const create = async () => {
    if (organizationId === null || slug === "" || busy) return;
    setBusy(true);
    setRefusal(null);
    const result = await api.createSkill({
      organizationId,
      slug,
      name: name.trim(),
      scope: forOrganization ? "organization" : "personal",
      idempotencyKey: `skill-create-${organizationId}-${slug}`,
    });
    setBusy(false);
    if (!result.ok) {
      const status = result.error.kind === "problem"
        ? result.error.problem.status
        : 0;
      setRefusal(status === 409 || status === 422 ? "taken" : "failed");
      return;
    }
    onCreated(result.data);
  };

  return (
    <UI.Dialog
      open
      variant="form"
      state={busy ? "submitting" : "open"}
      title={t("library.skills.new.title")}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field label={t("library.skills.new.scope.label")}>
            <UI.Stack gap="tight">
              <UI.Radio
                name="new-skill-scope"
                value="organization"
                checked={forOrganization}
                onChange={() => setForOrganization(true)}
              >
                {t("library.skills.scope.organization")}
              </UI.Radio>
              <UI.Text variant="muted">
                {t("library.skills.new.scope.organization", {
                  organization: organization.data?.name ?? "",
                })}
              </UI.Text>
              <UI.Radio
                name="new-skill-scope"
                value="personal"
                checked={!forOrganization}
                onChange={() => setForOrganization(false)}
              >
                {t("library.skills.scope.personal")}
              </UI.Radio>
              <UI.Text variant="muted">
                {t("library.skills.new.scope.personal")}
              </UI.Text>
            </UI.Stack>
          </UI.Field>
          <UI.Field
            label={t("library.skills.new.name")}
            htmlFor="new-skill-name"
            error={refusal === "taken"
              ? t("library.skills.new.nameTaken")
              : refusal === "failed"
              ? t("library.skills.new.failed")
              : undefined}
          >
            <UI.TextInput
              id="new-skill-name"
              name="new-skill-name"
              type="text"
              autoComplete="off"
              value={name}
              invalid={refusal !== null}
              onChange={(value) => {
                setName(value);
                setRefusal(null);
              }}
            />
          </UI.Field>
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" disabled={busy} onClick={onClose}>
              {t("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              type="submit"
              variant="primary"
              disabled={busy || slug === ""}
            >
              {t("library.skills.new.submit")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
