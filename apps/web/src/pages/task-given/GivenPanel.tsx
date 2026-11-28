import { useState } from "react";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { StepGivenResponse } from "../../api/client.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { fileSize } from "../library/skills-state.ts";
import { capitalized } from "../task-step-approval/model.ts";
import { DocumentList } from "./DocumentList.tsx";
import type { StepGivenOffer } from "./use-step-given.ts";

const FACTS_SHOWN = 5;

export function GivenPanel(
  { offer, stepName, onClose }: {
    readonly offer: StepGivenOffer;
    readonly stepName: string;
    readonly onClose: () => void;
  },
) {
  const { translate: t } = useI18n();
  const online = useConnectivity() === "online";
  const { data, isFetching, refetch } = offer.read;
  return (
    <UI.Sheet
      data-testid="step-given"
      dismissLabel={t("core.actions.close")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
      title={t("tasks.run.given.title", { step: stepName })}
      variant="side"
    >
      {data !== undefined
        ? <Given given={data} />
        : !online
        ? <UI.Text role="status">{t("tasks.run.given.offline")}</UI.Text>
        : isFetching
        ? <UI.Skeleton shape="surface" />
        : (
          <UI.Stack gap="compact">
            <UI.InlineNotice tone="warning" role="status">
              {t("tasks.run.given.failed")}
            </UI.InlineNotice>
            <UI.Inline>
              <UI.Button onClick={() => void refetch()}>
                {t("core.actions.retry")}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )}
    </UI.Sheet>
  );
}

function Given({ given }: { readonly given: StepGivenResponse }) {
  const { translate: t, locale, timeZone } = useI18n();
  const documents = given.documents.flatMap((document) =>
    document.name === null || document.version === null ? [] : [{
      versionId: document.artifactVersionId,
      name: document.name,
      revision: document.version,
      detail: [
        document.kind === null ? null : capitalized(document.kind),
        fileSize(document.sizeBytes, locale),
      ].filter((part) => part !== null).join(" · "),
    }]
  );
  const documentCount = documents.length + given.documentsHidden +
    given.documentsGone + given.documentsUnchecked;
  const nothing = documentCount === 0 && given.facts.length === 0 &&
    given.factsOmitted === 0;
  return (
    <UI.Stack gap="standard">
      {given.startedAt === null ? null : (
        <UI.Text variant="caption">
          {t("tasks.run.given.asOf", {
            when: formatDate(new Date(given.startedAt), locale, {
              timeZone,
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </UI.Text>
      )}
      {nothing
        ? <UI.Text variant="muted">{t("tasks.run.given.nothing")}</UI.Text>
        : (
          <UI.DescriptionList>
            {documentCount === 0 ? null : (
              <UI.DescriptionItem
                title={t("tasks.run.handover.documents", {
                  count: documentCount,
                })}
                description={
                  <DocumentList
                    documents={documents}
                    gone={given.documentsGone}
                    hidden={given.documentsHidden}
                    unchecked={given.documentsUnchecked}
                  />
                }
              />
            )}
            {given.facts.length === 0 && given.factsOmitted === 0
              ? null
              : <Facts facts={given.facts} omitted={given.factsOmitted} />}
          </UI.DescriptionList>
        )}
    </UI.Stack>
  );
}

function Facts(
  { facts, omitted }: {
    readonly facts: StepGivenResponse["facts"];
    readonly omitted: number;
  },
) {
  const { translate: t, locale, timeZone } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? facts : facts.slice(0, FACTS_SHOWN);
  return (
    <UI.DescriptionItem
      title={t("tasks.run.given.facts", { count: facts.length })}
      description={
        <UI.Stack gap="compact">
          {shown.map((fact) => (
            <UI.Stack gap="none" key={fact.memoryId}>
              <UI.Text>{fact.wording}</UI.Text>
              <UI.Text variant="caption">
                {t("tasks.run.given.wordingOf", {
                  date: formatDate(new Date(fact.recordedAt), locale, {
                    timeZone,
                    dateStyle: "medium",
                  }),
                })}
                {fact.state === "stopped_since"
                  ? ` · ${t("tasks.run.given.stopped")}`
                  : null}
                {fact.state === "corrected_since"
                  ? ` · ${t("tasks.run.given.corrected")}`
                  : null}
              </UI.Text>
              {fact.state === "corrected_since"
                ? (
                  <RouterLink
                    search={{ tab: "memory", fact: fact.memoryId }}
                    to="/library"
                    variant="sentence"
                  >
                    {t("tasks.run.given.seeFact")}
                  </RouterLink>
                )
                : null}
            </UI.Stack>
          ))}
          {facts.length > FACTS_SHOWN && !all
            ? (
              <UI.Inline>
                <UI.Button variant="quiet" onClick={() => setAll(true)}>
                  {t("tasks.run.handover.showAll", { count: facts.length })}
                </UI.Button>
              </UI.Inline>
            )
            : null}
          {omitted === 0
            ? null
            : (
              <UI.Text variant="muted" data-testid="given-omitted">
                {t("tasks.run.given.omitted", { count: omitted })}
              </UI.Text>
            )}
        </UI.Stack>
      }
    />
  );
}
