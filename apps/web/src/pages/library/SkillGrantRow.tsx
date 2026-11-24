import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  SkillResponse,
  SkillUseGrant,
  WorkflowVersionResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { workflowVersionsQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { sayAboutSkill } from "./SkillActions.tsx";
import { ACTION_TITLES, stepsOf } from "./workflow-state.ts";

export function stepLabelOf(
  stepPath: string,
  steps: readonly { readonly uses: string }[] | null,
  translate: (key: never, values?: Record<string, string>) => string,
): string {
  const match = /^\/steps\/(\d+)(?:\/|$)/.exec(stepPath);
  const index = match === null ? null : Number(match[1]);
  const direct = /^\/steps\/\d+$/.test(stepPath);
  const found = direct && index !== null ? steps?.[index] : undefined;
  if (found !== undefined) {
    const key = ACTION_TITLES[found.uses];
    return key === undefined ? found.uses : translate(key as never);
  }
  return translate(
    "library.skill.access.stepFallback" as never,
    { number: String((index ?? 0) + 1) },
  );
}

export function SkillGrantRow(
  { grant, skill, revision, since }: {
    readonly grant: SkillUseGrant;
    readonly skill: SkillResponse;
    readonly revision: number | null;
    readonly since: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const offline = useConnectivity() === "offline";
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, grant.workflowId),
  );
  const newest = versions.data?.items.reduce<
    WorkflowVersionResponse | undefined
  >(
    (best, item) =>
      best === undefined || item.revision > best.revision ? item : best,
    undefined,
  );
  const stepLabel = stepLabelOf(
    grant.stepPath,
    newest === undefined ? null : stepsOf(newest),
    translate,
  );
  const caption = revision === null
    ? translate("library.skill.access.lineNoVersion", {
      step: stepLabel,
      date: since,
    })
    : translate("library.skill.access.line", {
      step: stepLabel,
      number: revision,
      date: since,
    });
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const intent = useRef<string | null>(null);

  const stop = useMutation({
    mutationKey: ["skills.useGrants.delete", grant.id],
    mutationFn: async () => {
      const result = await api.deleteSkillUseGrant({
        organizationId: scope.organizationId as string,
        skillId: skill.id,
        id: grant.id,
        version: grant.version,
        idempotencyKey: intent.current ??= crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
    },
  });

  const finish = () => {
    intent.current = null;
    setOpen(false);
    sayAboutSkill(
      translate("library.skill.access.stopped", {
        workflow: grant.workflowName,
        skill: skill.name,
      }),
    );
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  };
  const confirm = async () => {
    setFailed(false);
    try {
      await stop.mutateAsync();
      finish();
    } catch (error) {
      const status = failureStatus(error);
      if (status === 404 || status === 412) return finish();
      if (status !== null && status < 500) intent.current = null;
      setFailed(true);
    }
  };
  const close = () => {
    setOpen(false);
    setFailed(false);
    intent.current = null;
    focusAfterPaint(() => opener.current);
  };

  return (
    <div data-grant={grant.id} role="listitem">
      <UI.Stack gap="compact">
        <UI.Stack gap="none">
          <RouterLink
            to="/library/workflows/$workflowId"
            params={{ workflowId: grant.workflowId }}
          >
            {grant.workflowName}
          </RouterLink>
          <UI.Text variant="caption">{caption}</UI.Text>
        </UI.Stack>
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={offline || stop.isPending}
            aria-label={translate("library.skill.access.stopNamed", {
              workflow: grant.workflowName,
            })}
            onClick={() => {
              opener.current = document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
              intent.current = null;
              setFailed(false);
              setOpen(true);
            }}
          >
            {translate("library.skill.access.stop")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
      {open
        ? (
          <UI.AlertDialog
            open
            data-actions-layout="stack"
            onOpenChange={(next) => !next && !stop.isPending && close()}
            state={stop.isPending ? "confirming" : failed ? "error" : "open"}
            title={translate("library.skill.access.stopTitle", {
              workflow: grant.workflowName,
              skill: skill.name,
            })}
            cancelAction={
              <UI.Button
                variant="secondary"
                disabled={stop.isPending}
                onClick={close}
              >
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="destructive"
                loading={stop.isPending}
                disabled={stop.isPending}
                onClick={() => void confirm()}
              >
                {translate("library.skill.access.stop")}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("library.skill.access.stopBody", {
                  workflow: grant.workflowName,
                  step: stepLabel,
                })}
              </UI.Text>
              <UI.Text>{translate("library.skill.access.stopRunning")}</UI.Text>
              <UI.Text>{translate("library.skill.access.stopFiles")}</UI.Text>
              <UI.Text variant="muted">
                {translate("library.skill.access.stopAgain")}
              </UI.Text>
              {failed
                ? (
                  <UI.InlineNotice tone="error" role="alert">
                    {translate("library.skill.access.stopFailed", {
                      workflow: grant.workflowName,
                      skill: skill.name,
                    })}
                  </UI.InlineNotice>
                )
                : null}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
    </div>
  );
}
