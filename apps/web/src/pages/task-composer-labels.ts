import type { TaskComposerLabels, TaskComposerSetupReason } from "@bakery/ui";
import type { Translator } from "@bakery/i18n";

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
    setupBadge: t("tasks.composer.setupBadge"),
    setupUnknown: t("tasks.composer.setup.unknown"),
    setupRequired: Object.fromEntries(
      SETUP_REASONS.map((reason) => [
        reason,
        reason === "budget_below_reservation" && minimumBudget !== null
          ? `${t(`tasks.composer.setup.${reason}`)} ${
            t("tasks.composer.budgetMinimum", { amount: minimumBudget })
          }`
          : t(`tasks.composer.setup.${reason}`),
      ]),
    ) as TaskComposerLabels["setupRequired"],
  };
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
