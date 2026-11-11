import * as UI from "@bakery/ui";
import type { RepositoryProfileObservationResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

export function RepositoryObservation(
  { observation }: Readonly<{
    observation: RepositoryProfileObservationResponse;
  }>,
) {
  const { translate } = useI18n();
  const eligible = observation.payload.readiness === "eligible";
  const outcomes = {
    passed: translate("projects.onboarding.observation.check.passed"),
    failed: translate("projects.onboarding.observation.check.failed"),
    missing: translate("projects.onboarding.observation.check.missing"),
    unsupported: translate("projects.onboarding.observation.check.unsupported"),
  };
  const templates = {
    "source.integrity.v1": translate(
      "projects.onboarding.observation.template.source",
    ),
    "tool.version.v1": translate(
      "projects.onboarding.observation.template.tool",
    ),
    "node.syntax.v1": translate(
      "projects.onboarding.observation.template.node",
    ),
    "deno.check.v1": translate("projects.onboarding.observation.template.deno"),
    "unsupported.v1": translate(
      "projects.onboarding.observation.template.unsupported",
    ),
  };
  const reasons = {
    verified: translate("projects.onboarding.observation.reason.verified"),
    exit_nonzero: translate(
      "projects.onboarding.observation.reason.exitNonzero",
    ),
    tool_missing: translate(
      "projects.onboarding.observation.reason.toolMissing",
    ),
    unsupported_command: translate(
      "projects.onboarding.observation.reason.unsupportedCommand",
    ),
    deadline: translate("projects.onboarding.observation.reason.deadline"),
    output_limit: translate(
      "projects.onboarding.observation.reason.outputLimit",
    ),
    platform_mismatch: translate(
      "projects.onboarding.observation.reason.platformMismatch",
    ),
    source_invalid: translate(
      "projects.onboarding.observation.reason.sourceInvalid",
    ),
  };
  return (
    <UI.Stack gap="standard" data-testid="projects-inspection-observation">
      <UI.Heading level="section">
        {translate("projects.onboarding.observation.heading")}
      </UI.Heading>
      <UI.Badge tone={eligible ? "success" : "neutral"}>
        {eligible
          ? translate("projects.onboarding.observation.eligible")
          : translate("projects.onboarding.observation.blocked")}
      </UI.Badge>
      <UI.InlineNotice
        tone={eligible ? "information" : "warning"}
        role="status"
      >
        {eligible
          ? translate("projects.onboarding.observation.eligibleDescription")
          : translate("projects.onboarding.observation.blockedDescription")}
      </UI.InlineNotice>
      <dl>
        <dt>{translate("projects.onboarding.observation.id")}</dt>
        <dd>
          <bdi>
            <code>{observation.id}</code>
          </bdi>
        </dd>
        <dt>{translate("projects.onboarding.observation.digest")}</dt>
        <dd>
          <bdi>
            <code>{observation.observationDigest}</code>
          </bdi>
        </dd>
        <dt>{translate("projects.onboarding.observation.profileId")}</dt>
        <dd>
          <bdi>
            <code>{observation.profileId}</code>
          </bdi>
        </dd>
        <dt>{translate("projects.onboarding.observation.profileRevision")}</dt>
        <dd>
          <bdi>{observation.profileRevision}</bdi>
        </dd>
        <dt>{translate("projects.onboarding.observation.profileDigest")}</dt>
        <dd>
          <bdi>
            <code>{observation.profileDigest}</code>
          </bdi>
        </dd>
        <dt>{translate("projects.onboarding.observation.baseSha")}</dt>
        <dd>
          <bdi>
            <code>{observation.baseSha}</code>
          </bdi>
        </dd>
      </dl>
      <UI.Heading level="subsection">
        {translate("projects.onboarding.observation.checks")}
      </UI.Heading>
      <p>{translate("projects.onboarding.observation.requiredDescription")}</p>
      <ul>
        {observation.payload.checks.map((check) => (
          <li key={check.id}>
            <UI.Stack gap="compact">
              <p>
                <bdi>
                  <code>{check.id}</code>
                </bdi>: {templates[check.template]}
              </p>
              <p>
                <UI.Badge tone="neutral">
                  {check.required
                    ? translate("projects.onboarding.observation.required")
                    : translate("projects.onboarding.observation.optional")}
                </UI.Badge>{" "}
                {outcomes[check.status]}
              </p>
              <p>{reasons[check.reason]}</p>
            </UI.Stack>
          </li>
        ))}
      </ul>
    </UI.Stack>
  );
}
