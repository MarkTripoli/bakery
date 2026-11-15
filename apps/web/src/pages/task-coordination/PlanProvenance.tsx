import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { CoordinationPlanResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { planOrigin, shortId } from "./model.ts";

/**
 * The text with a break opportunity every few characters of an unbroken run,
 * so a long name wraps inside its line instead of widening the page.
 */
function breakable(text: string): ReactNode[] {
  return text.split(/(\S{24})/).flatMap((part, index) =>
    index % 2 === 1 ? [part, <wbr key={index} />] : [part]
  );
}

/**
 * Where the plan came from: origin (ad hoc, saved workflow, or a ticket the
 * requester reported). Rendered as inline runs so the header keeps its height.
 * The plan digest is not here: it sits behind the page's fingerprint row.
 * Nothing renders for a plan without an origin. A ticket is a claim by the
 * requester, so `PlanTicketClaim` says it is not verified, and its link
 * renders only for https.
 */
export function PlanProvenance(
  {
    leadingSeparator = false,
    olderVersion = false,
    plan,
    workflowName,
    workflowVersion,
  }: {
    /** Header form: a dot leads this run; it binds to the next word so no line ends in a lone dot. */
    leadingSeparator?: boolean;
    plan: CoordinationPlanResponse;
    /** Name of the saved workflow when readable; the id stands in otherwise. */
    workflowName: string | undefined;
    /** The saved workflow's version number when readable; its short id stands in otherwise. */
    workflowVersion?: number | undefined;
    /** True when the workflow is readable and a newer version is the one in use. */
    olderVersion?: boolean;
  },
) {
  const { translate: t } = useI18n();
  const navigate = useNavigate();
  const origin = planOrigin(plan);
  if (origin === null) return null;
  const label = origin.kind === "ad_hoc"
    ? t("tasks.coordination.origin.adHoc")
    : origin.kind === "saved_workflow"
    // The version's number, once it is known; its identifier is internal and
    // is never shown in its place.
    ? workflowVersion === undefined
      ? t("tasks.coordination.origin.workflowNoVersion", {
        name: workflowName ?? shortId(origin.workflowId),
      })
      : t("tasks.coordination.origin.workflow", {
        name: workflowName ?? shortId(origin.workflowId),
        version: String(workflowVersion),
      })
    : t("tasks.coordination.origin.ticket", {
      provider: origin.provider,
      reference: origin.reference,
    });
  // A saved workflow's line leads to that version's page.
  const href = origin.kind === "saved_workflow" && origin.workflowVersionId
    ? `/library/workflows/${origin.workflowId}?version=${origin.workflowVersionId}`
    : null;
  return (
    <span data-ui-region="plan-provenance">
      {leadingSeparator && <span aria-hidden="true">·&nbsp;</span>}
      <span data-plan-origin={origin.kind}>
        {href === null ? label : (
          <UI.Link
            href={href}
            onClick={(event) => {
              event.preventDefault();
              void navigate({ to: href });
            }}
          >
            {breakable(label)}
          </UI.Link>
        )}
        {olderVersion && (
          <>
            {" "}
            <UI.Badge tone="neutral">
              {t("tasks.coordination.origin.older")}
            </UI.Badge>
            <UI.HelpTip
              closeLabel={t("core.actions.close")}
              label={t("tasks.coordination.origin.older")}
            >
              {t("tasks.coordination.origin.olderHelp")}
            </UI.HelpTip>
          </>
        )}
      </span>
    </span>
  );
}

/** A ticket origin is the requester's claim: never verified, https links only. */
export function PlanTicketClaim(
  { plan }: { plan: CoordinationPlanResponse },
) {
  const { translate: t } = useI18n();
  const origin = planOrigin(plan);
  if (origin?.kind !== "ticket") return null;
  return (
    <UI.Inline gap="compact" data-ui-region="plan-ticket-claim">
      <UI.Text variant="caption">
        {t("tasks.coordination.origin.ticketClaim")}
      </UI.Text>
      {origin.url !== null && (
        <UI.Link variant="external" href={origin.url}>
          {t("tasks.coordination.origin.ticketLink")}
        </UI.Link>
      )}
    </UI.Inline>
  );
}
