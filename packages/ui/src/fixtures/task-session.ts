import type { SupportedLocale, Translator } from "@bakery/i18n";
import { createTranslator } from "@bakery/i18n";
import type { ArtifactPaneLabels } from "../organisms/ArtifactPane.tsx";
import type {
  TaskComposerLabels,
  TaskComposerSetupReason,
} from "../organisms/TaskComposerForm.tsx";

/** Synthetic presentation fixtures. No real repository, task or artifact. */
export type StoryGlobals = {
  locale?: unknown;
  direction?: unknown;
};

/** Story locale: the pseudo globals select the shipped pseudo catalogs. */
export function storyTranslator(globals: StoryGlobals = {}): Translator {
  const locale: SupportedLocale = globals.locale === "pseudo"
    ? "en-XA"
    : globals.direction === "rtl"
    ? "ar-XB"
    : "en";
  return createTranslator({ locale, surface: "task-session-fixture" });
}

/** Every availability reason the contract defines, in server order. */
export const setupReasons: readonly TaskComposerSetupReason[] = [
  "repository_archived",
  "application_archived",
  "no_active_profile",
  "coding_agent_unbound",
  "coding_agent_disabled",
  "coding_agent_unbilled",
  "coding_agent_capability_denied",
  "coding_agent_unpriced",
  "profile_effect_denied",
  "budget_below_reservation",
  "budget_policy_unavailable",
];

export function composerLabels(t: Translator): TaskComposerLabels {
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
      setupReasons.map((reason) => [
        reason,
        t(`tasks.composer.setup.${reason}`),
      ]),
    ) as TaskComposerLabels["setupRequired"],
  };
}

export function artifactPaneLabels(t: Translator): ArtifactPaneLabels {
  return {
    paneTitle: t("tasks.artifactPane.label"),
    versionSelect: t("tasks.artifactPane.versionSelect"),
    preview: t("tasks.artifactPane.preview"),
    truncated: t("tasks.artifactPane.truncated"),
    unavailable: t("tasks.artifactPane.unavailable"),
    loading: t("tasks.artifactPane.loading"),
    empty: t("tasks.artifactPane.empty"),
    error: t("tasks.artifactPane.error"),
    forbidden: t("tasks.artifactPane.forbidden"),
    offline: t("tasks.artifactPane.offline"),
    reconnecting: t("tasks.artifactPane.reconnecting"),
    download: t("tasks.artifactPane.download"),
    open: t("tasks.artifactPane.open"),
  };
}

export function artifactDescriptor(t: Translator, mediaType = "text/markdown") {
  return {
    artifactId: "artifact-42",
    version: "2",
    digest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    size: "1.2 KB",
    mediaType,
    provenance: "task.brief · attempt 1",
    labels: {
      artifactId: t("tasks.artifact.id"),
      version: t("tasks.artifact.version"),
      digest: t("tasks.artifact.digest"),
      size: t("tasks.artifact.size"),
      mediaType: t("tasks.artifact.mediaType"),
      provenance: t("tasks.artifact.provenance"),
      link: t("tasks.artifact.open"),
    },
  };
}

export const briefText = [
  "# Task brief",
  "",
  "Title: Add repository onboarding",
  "Type: feature",
  "",
  "Description:",
  "Choose a repository, check the worker toolchain and queue the first task.",
].join("\n");
