import { useCallback, useRef, useState } from "react";
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
import { SharedLoading } from "./SharedFrame.tsx";
import { SharedUnavailable } from "./SharedUnavailable.tsx";

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
  const [rootCount, setRootCount] = useState<number | null>(null);
  const [commentSettled, setCommentSettled] = useState(false);
  const settleComment = useCallback(() => setCommentSettled(true), []);
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
  const ready = artifact.data !== undefined && selected !== null &&
    (comment === undefined || landing.gone === true || commentSettled);
  const arrival = useLandingArrival({
    search: landing,
    ready,
    strip: stripLanding,
  });
  if (failed) {
    return <SharedUnavailable kind="document" landing={landing} />;
  }
  if (artifact.data === undefined) return <SharedLoading />;
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
          <UI.InlineNotice tone="information">
            {landing.gone === true
              ? `${t("notifications.landing.partGone")} ${
                t("shared.document.notice" as never)
              }`
              : t("shared.document.notice" as never)}
          </UI.InlineNotice>
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
              commentId={landing.gone === true ? undefined : comment}
              landed={comment !== undefined && landing.gone !== true}
              agentRequest={false}
              onRootCount={setRootCount}
              onLandingSettled={settleComment}
            />
          )
          : null}
        comments={{
          title: t("artifact.comments.title"),
          openLabel: rootCount === null
            ? t("shared.document.showCommentsUnknown" as never)
            : t("shared.document.showComments", {
              count: String(rootCount),
            }),
          linkedCommentId: landing.gone === true ? null : comment ?? null,
        }}
      />
    </>
  );
}
