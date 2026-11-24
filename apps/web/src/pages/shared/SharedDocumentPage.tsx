import { useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../../api/context.tsx";
import {
  artifactQueryOptions,
  artifactVersionsQueryOptions,
  notificationTargetQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { LandingSearch } from "../../notifications/landing.ts";
import { useLandingArrival } from "../../notifications/useLandingArrival.ts";
import { ArtifactComments } from "../ArtifactComments.tsx";
import { ArtifactPreviewBody } from "../ArtifactContentPreview.tsx";
import { ArtifactRetrievalView } from "../ArtifactRetrievalView.tsx";
import { sharedReasonOf, SharedUnavailable } from "./SharedUnavailable.tsx";

export function SharedDocumentPage(
  { artifactId, version, comment, landing: current, stripLanding }: {
    artifactId: string;
    version: string | undefined;
    comment: string | undefined;
    landing: LandingSearch;
    stripLanding: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t, locale } = useI18n();
  const navigate = useNavigate();
  const landing = useRef(current).current;
  const scoped = scope.organizationId !== null;
  const target = useQuery({
    ...notificationTargetQueryOptions(api, scope, landing.n ?? ""),
    enabled: landing.n !== undefined && scoped,
  });
  const artifact = useQuery({
    ...artifactQueryOptions(api, scope, artifactId),
    enabled: scoped,
  });
  const versions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, artifactId, { limit: 100 }),
    enabled: scoped && artifact.data !== undefined &&
      artifact.data.currentVersionId !== null,
  });
  const items = versions.data?.items ?? [];
  const selected = items.find((candidate) => candidate.id === version) ??
    items.find((candidate) =>
      candidate.id === artifact.data?.currentVersionId
    ) ??
    items[0] ?? null;
  const failed = artifact.isError || versions.isError;
  const ready = artifact.data !== undefined && selected !== null;
  const arrival = useLandingArrival({
    search: landing,
    ready: ready || failed,
    strip: stripLanding,
  });
  if (failed) {
    return (
      <SharedUnavailable
        kind="document"
        reason={sharedReasonOf(artifact.error ?? versions.error)}
        landing={landing}
      />
    );
  }
  if (artifact.data === undefined) {
    return (
      <UI.Stack
        aria-busy="true"
        aria-label={t("notifications.loading")}
        gap="compact"
      >
        {Array.from({ length: 3 }).map((_, index) => (
          <UI.Skeleton key={index} shape="text" />
        ))}
      </UI.Stack>
    );
  }
  const shown = artifact.data;
  const sharedBy = target.data?.sharedByName !== undefined &&
      target.data.sharedAt !== undefined
    ? t("shared.document.sharedBy" as never, {
      name: target.data.sharedByName,
      date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(target.data.sharedAt),
      ),
    })
    : "";
  return (
    <>
      <UI.VisuallyHidden aria-live="polite" as="div" role="status">
        {arrival}
      </UI.VisuallyHidden>
      <ArtifactRetrievalView
        testId="shared-document-page"
        title={shown.name}
        artifactLabel={t("artifact.view.eyebrow")}
        kind={selected?.mediaType ?? shown.artifactType}
        revision={selected
          ? t("artifact.version.label", { revision: selected.revision })
          : t("artifact.retrieval.noCurrentVersion")}
        description={sharedBy}
        versionLabel={t("artifact.retrieval.versionsTitle")}
        versionId={selected?.id ?? ""}
        versions={items.map((candidate) => ({
          id: candidate.id,
          label: t("artifact.version.label", { revision: candidate.revision }),
        }))}
        onVersionChange={(next) =>
          void navigate({
            to: "/shared/documents/$artifactId",
            params: { artifactId },
            search: { version: next },
          })}
        banner={
          <>
            <UI.InlineNotice tone="information">
              {t("shared.document.notice" as never)}
            </UI.InlineNotice>
            {landing.gone === true
              ? (
                <UI.InlineNotice tone="information">
                  {t("notifications.landing.partGone")}
                </UI.InlineNotice>
              )
              : null}
          </>
        }
        preview={selected
          ? (
            <ArtifactPreviewBody
              key={selected.id}
              version={selected}
              label={t("artifact.preview.title")}
            />
          )
          : (
            <UI.InlineNotice tone="information">
              {t("artifact.retrieval.emptyNotice")}
            </UI.InlineNotice>
          )}
        discussion={selected
          ? (
            <ArtifactComments
              key={`comments:${selected.id}`}
              artifact={shown}
              version={selected}
              commentId={comment}
              landed={comment !== undefined && landing.gone !== true}
            />
          )
          : null}
        comments={{
          title: t("artifact.comments.title"),
          openLabel: t("artifact.comments.title"),
          linkedCommentId: comment ?? null,
        }}
      />
    </>
  );
}
