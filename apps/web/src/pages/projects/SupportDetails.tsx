import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  RepositoryProfileResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  repositoryCheckQueryOptions,
  repositoryProfileObservationQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * Details for support (design-ux, #65): the identifiers and fingerprints a
 * person on the support side asks for, collapsed because nobody else needs
 * them. A value the page does not know says so rather than showing a blank.
 */
export function SupportDetails(
  { repository, active, checkId }: Readonly<{
    repository: RepositoryResponse;
    active: RepositoryProfileResponse | null;
    checkId: string | null;
  }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  // The same reads as the readiness step: one request each, shared by key.
  const check = useQuery({
    ...repositoryCheckQueryOptions(api, scope, repository.id, checkId ?? ""),
    enabled: scope.organizationId !== null && checkId !== null,
  });
  const finished = check.data?.status === "completed" ? check.data : null;
  const observation = useQuery({
    ...repositoryProfileObservationQueryOptions(
      api,
      scope,
      repository.applicationId,
      finished,
    ),
    enabled: scope.organizationId !== null && finished?.observationId != null &&
      finished.profileId !== null,
  });

  const rows: readonly [string, string | null][] = [
    ["repositoryId", repository.id],
    ["applicationId", repository.applicationId],
    ["profileId", active?.id ?? null],
    ["profileDigest", active?.digest ?? null],
    ["checkId", check.data?.id ?? null],
    ["jobId", check.data?.jobId ?? null],
    ["observationId", observation.data?.id ?? null],
    ["observationDigest", observation.data?.observationDigest ?? null],
    ["baseSha", observation.data?.baseSha ?? null],
  ];

  return (
    <UI.Stack gap="compact" data-testid="support-details">
      <UI.Button
        variant="text"
        aria-expanded={open}
        aria-controls={`${id}-details`}
        onClick={() => setOpen(!open)}
      >
        {translate("projects.repository.support.title" as never)}
      </UI.Button>
      <div id={`${id}-details`} hidden={!open}>
        <UI.DescriptionList>
          {rows.map(([key, value]) => (
            <UI.DescriptionItem
              key={key}
              title={translate(`projects.repository.support.${key}` as never)}
              description={
                <UI.DataText>
                  {value ??
                    translate("projects.repository.support.none" as never)}
                </UI.DataText>
              }
            />
          ))}
        </UI.DescriptionList>
      </div>
    </UI.Stack>
  );
}
