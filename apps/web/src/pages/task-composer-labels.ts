import { createElement } from "react";
import type { TaskComposerLabels, TaskComposerSetupReason } from "@bakery/ui";
import type { Translator } from "@bakery/i18n";
import { RouterLink } from "../app/router-link.tsx";
import { LINK_SLOT, withLink } from "./with-link.tsx";

/** The reasons whose fix is made in Projects, where the sentence links to it. */
const PROJECTS_REASONS: ReadonlySet<TaskComposerSetupReason> = new Set([
  "repository_archived",
  "application_archived",
  "no_active_profile",
]);

/** Every availability reason the contract defines, each with its own copy. */
export const SETUP_REASONS: readonly TaskComposerSetupReason[] = [
  "repository_archived",
  "application_archived",
  "no_active_profile",
  "coding_agent_unbound",
  "coding_agent_disabled",
  "coding_agent_unbilled",
  "coding_agent_capability_denied",
  "coding_agent_unpriced",
  "review_agent_unavailable",
  "repair_agent_unavailable",
  "profile_effect_denied",
  "required_check_missing",
  "budget_below_reservation",
  "budget_policy_unavailable",
];

/** Display copy for a code-owned preset id; an unknown id shows its id. */
export function presetCopy(t: Translator, id: string) {
  switch (id) {
    case "fixed-coding":
      return {
        title: t("tasks.preset.fixedCoding.title"),
        description: t("tasks.preset.fixedCoding.description"),
      };
    case "fixed-coding-reviewed":
      return {
        title: t("tasks.preset.fixedCodingReviewed.title"),
        description: t("tasks.preset.fixedCodingReviewed.description"),
      };
    case "deliver-oneshot":
      return {
        title: t("tasks.preset.deliverOneshot.title"),
        description: t("tasks.preset.deliverOneshot.description"),
      };
    case "deliver-lean":
      return {
        title: t("tasks.preset.deliverLean.title"),
        description: t("tasks.preset.deliverLean.description"),
      };
    case "deliver-full":
      return {
        title: t("tasks.preset.deliverFull.title"),
        description: t("tasks.preset.deliverFull.description"),
      };
    case "deliver-prd":
      return {
        title: t("tasks.preset.deliverPrd.title"),
        description: t("tasks.preset.deliverPrd.description"),
      };
    default:
      return { title: id, description: undefined };
  }
}

export function composerLabels(
  t: Translator,
  /** The smallest budget that works, already formatted, when the server says. */
  minimumBudget: string | null = null,
): TaskComposerLabels {
  return {
    heading: t("tasks.composer.heading"),
    repository: t("tasks.composer.repository"),
    repositoryPlaceholder: t("tasks.composer.repositoryPlaceholder"),
    preset: t("tasks.composer.preset"),
    presetNone: t("tasks.composer.presetNone"),
    presetNoneHint: t("tasks.composer.presetNoneHint"),
    title: t("tasks.composer.title"),
    taskType: t("tasks.composer.taskType"),
    taskTypes: {
      feature: t("tasks.composer.taskType.feature"),
      bug: t("tasks.composer.taskType.bug"),
      epic: t("tasks.composer.taskType.epic"),
      maintenance: t("tasks.composer.taskType.maintenance"),
    },
    description: t("tasks.composer.description"),
    budget: t("tasks.composer.budget"),
    budgetHint: t("tasks.composer.budgetHint"),
    submit: t("tasks.composer.submit"),
    submitTask: t("tasks.composer.submitTask"),
    submitting: t("tasks.composer.submitting"),
    retry: t("tasks.composer.retry"),
    discard: t("tasks.composer.discard"),
    loading: t("tasks.composer.loading"),
    empty: t("tasks.composer.empty"),
    offline: t("tasks.composer.offline"),
    reconnecting: t("tasks.composer.reconnecting"),
    unknown: t("tasks.composer.unknown"),
    conflict: t("tasks.composer.conflict"),
    forbidden: t("tasks.composer.forbidden"),
    error: t("tasks.composer.error"),
    setupHeading: t("tasks.composer.setupHeading"),
    setupNoWorkflow: t("tasks.composer.setupNoWorkflow"),
    setupUnknown: withLink(
      t("tasks.composer.setup.unknown", { projects: LINK_SLOT }),
      projectsLink(t),
    ),
    setupRequired: Object.fromEntries(
      SETUP_REASONS.map((reason) => [
        reason,
        PROJECTS_REASONS.has(reason)
          ? withLink(
            t(`tasks.composer.setup.${reason}`, { projects: LINK_SLOT }),
            projectsLink(t),
          )
          : reason === "required_check_missing"
          ? withLink(
            t("tasks.composer.setup.required_check_missing", {
              rules: LINK_SLOT,
            }),
            createElement(
              RouterLink,
              { to: "/settings/organization/repository-rules" },
              t("tasks.composer.setup.rulesPage"),
            ),
          )
          : reason === "budget_below_reservation" && minimumBudget !== null
          ? `${t(`tasks.composer.setup.${reason}`)} ${
            t("tasks.composer.budgetMinimum", { amount: minimumBudget })
          }`
          : t(`tasks.composer.setup.${reason}`),
      ]),
    ) as TaskComposerLabels["setupRequired"],
  };
}

/** The link to the Projects page that the setup reasons put where they name it. */
function projectsLink(t: Translator) {
  return createElement(
    RouterLink,
    { to: "/projects" },
    t("tasks.composer.setup.projectsPage"),
  );
}

/** The budget cap and shape the contract accepts (`RunCreate.budgetLimitUsd`). */
export function validBudget(value: string): boolean {
  const text = value.trim();
  return /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(text) &&
    Number(text) <= 200;
}

/** Micro-USD of a decimal string, by integer math so no float rounds money. */
function microUsd(value: string): bigint {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/**
 * The setup reasons that apply to the budget the user typed. The server
 * computes `budget_below_reservation` for the preset's default budget, so the
 * composer replaces it with the same comparison against the typed budget and
 * the server's minimum. Unknown reasons stay first so they still render as
 * unknown; known reasons keep the SETUP_REASONS order.
 */
export function composerSetupReasons(
  serverReasons: readonly TaskComposerSetupReason[],
  budget: string,
  minimumBudgetLimitUsd: string | null,
): readonly TaskComposerSetupReason[] {
  const rest = serverReasons.filter((reason) =>
    reason !== "budget_below_reservation"
  );
  const below = minimumBudgetLimitUsd !== null && validBudget(budget) &&
    microUsd(budget) < microUsd(minimumBudgetLimitUsd);
  const known = new Set<TaskComposerSetupReason>(rest);
  if (below) known.add("budget_below_reservation");
  return [
    ...rest.filter((reason) => !SETUP_REASONS.includes(reason)),
    ...SETUP_REASONS.filter((reason) => known.has(reason)),
  ];
}
