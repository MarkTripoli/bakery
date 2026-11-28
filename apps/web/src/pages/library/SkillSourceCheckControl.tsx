import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { SkillResponse, SkillSourceCheck } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  skillSourceCheckQueryOptions,
  skillSourceQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { importFailureKind } from "./skill-source-state.ts";
import { shortRevision } from "./skill-update-state.ts";

export function useCheckedWhen() {
  const { locale, timeZone } = useI18n();
  return (iso: string | null) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(iso === null ? new Date() : new Date(iso));
}

export function useSourceProblemSentence() {
  const { translate } = useI18n();
  return (check: SkillSourceCheck, address: string, archive: boolean) => {
    const kind = importFailureKind(
      check.problem,
      "",
      check.requestedRevision,
      archive,
    );
    const host = URL.canParse(address) ? new URL(address).host : address;
    return translate(
      `library.skills.add.failure.${
        kind === "invalidAtTop" ? "invalid" : kind
      }`,
      {
        address,
        host,
        folder: address,
        revision: shortRevision(check.requestedRevision),
      },
    );
  };
}

export function SkillSourceCheckControl(
  { skill, address, archive }: {
    readonly skill: SkillResponse & { readonly activeVersionId: string };
    readonly address: string;
    readonly archive: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const when = useCheckedWhen();
  const problemSentence = useSourceProblemSentence();
  const check = useQuery({
    ...skillSourceCheckQueryOptions(
      api,
      scope,
      skill.id,
      skill.activeVersionId,
    ),
    enabled: false,
  });
  const queryClient = useQueryClient();
  const checkNow = async () => {
    await check.refetch();
    await queryClient.invalidateQueries({
      queryKey: skillSourceQueryOptions(api, scope, skill.sourceId ?? "")
        .queryKey,
    });
  };
  const checkButton = (label: string) => (
    <UI.Inline>
      <UI.Button
        loading={check.isFetching}
        onClick={() => void checkNow()}
        variant="secondary"
      >
        {label}
      </UI.Button>
    </UI.Inline>
  );
  const result = check.data;
  if (check.isError && !check.isFetching) {
    const error = check.error;
    const noSource = error.kind === "problem" &&
      error.problem.status === 409 &&
      error.problem.reason !== "skill_changed_during_source_check";
    return (
      <UI.Stack gap="compact">
        <UI.InlineNotice role="alert" tone="error">
          {translate(
            noSource
              ? "library.skills.update.noSource"
              : "library.skills.update.checkFailed",
          )}
        </UI.InlineNotice>
        {noSource
          ? null
          : checkButton(translate("library.skills.update.checkAgain"))}
      </UI.Stack>
    );
  }
  if (result === undefined) {
    return checkButton(translate("library.skills.update.check"));
  }
  if (result.status === "unreachable") {
    return (
      <UI.Stack gap="compact">
        <UI.InlineNotice role="status" tone="warning">
          {problemSentence(result, address, archive)}{" "}
          {translate("library.skills.update.stillWorks")}
        </UI.InlineNotice>
        {checkButton(translate("library.skills.update.checkAgain"))}
      </UI.Stack>
    );
  }
  if (result.status === "update_available") {
    return (
      <UI.Stack gap="compact">
        <UI.Text role="status">
          {translate("library.skills.update.available")}
        </UI.Text>
        <UI.Inline>
          <UI.Button
            onClick={() =>
              void navigate({
                to: "/library/skills/$skillId/update",
                params: { skillId: skill.id },
              })}
            variant="primary"
          >
            {translate("library.skills.update.review")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    );
  }
  return (
    <UI.Stack gap="compact">
      <UI.Text role="status">
        {translate("library.skills.update.current", {
          revision: shortRevision(result.requestedRevision),
          time: when(result.lastCheckedAt),
        })}
      </UI.Text>
      {checkButton(translate("library.skills.update.checkAgain"))}
    </UI.Stack>
  );
}
