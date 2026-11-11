import * as UI from "@bakery/ui";
import type { RepositoryOnboardingResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** Exact onboarding identity and the outcome notices; the state pill is in the card header. */
export function InspectionStatus(
  { onboarding }: Readonly<{ onboarding: RepositoryOnboardingResponse }>,
) {
  const { translate } = useI18n();
  const inFlight = onboarding.status === "queued" ||
    onboarding.status === "running";
  const identity = (
    <dl>
      <dt>{translate("projects.onboarding.inspection.onboardingId")}</dt>
      <dd>
        <bdi>
          <code>{onboarding.id}</code>
        </bdi>
      </dd>
      <dt>{translate("projects.onboarding.inspection.jobId")}</dt>
      <dd>
        <bdi>
          <code>{onboarding.jobId}</code>
        </bdi>
      </dd>
    </dl>
  );
  if (inFlight) {
    return (
      <UI.VisuallyHidden as="div" data-testid="projects-inspection-status">
        {identity}
      </UI.VisuallyHidden>
    );
  }
  return (
    <UI.Stack gap="standard" data-testid="projects-inspection-status">
      <UI.Heading level="section">
        {translate("projects.onboarding.inspection.statusHeading")}
      </UI.Heading>
      {identity}
      {onboarding.status === "failed"
        ? (
          <UI.InlineNotice tone="error">
            {translate(
              "projects.onboarding.inspection.status.failedDescription",
            )}
          </UI.InlineNotice>
        )
        : onboarding.status === "canceled"
        ? (
          <UI.InlineNotice tone="warning">
            {translate(
              "projects.onboarding.inspection.status.canceledDescription",
            )}
          </UI.InlineNotice>
        )
        : null}
    </UI.Stack>
  );
}

export function inspectionTone(
  status: RepositoryOnboardingResponse["status"],
): "information" | "success" | "destructive" | "neutral" {
  return status === "completed"
    ? "success"
    : status === "failed"
    ? "destructive"
    : status === "canceled"
    ? "neutral"
    : "information";
}
