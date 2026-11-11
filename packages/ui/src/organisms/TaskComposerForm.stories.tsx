import { type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Stack,
  TaskComposerForm,
  type TaskComposerSetupReason,
  type TaskComposerSubmitState,
  type TaskComposerValues,
  type TaskComposerView,
  Text,
} from "@bakery/ui";
import {
  composerLabels,
  setupReasons,
  storyTranslator,
} from "../fixtures/task-session.ts";

const meta = {
  title: "Bakery/Organisms/TaskComposerForm",
  parameters: {
    catalogId: "ui.taskComposerForm",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const repositories = [
  { id: "repo-1", label: "bakery/bakery" },
  { id: "repo-2", label: "example/web" },
];

const filled: TaskComposerValues = {
  repositoryId: "repo-1",
  presetId: "fixed-coding@1",
  title: "Add repository onboarding",
  taskType: "feature",
  description: "Choose a repository and check the worker toolchain.",
  budget: "5.00",
};

const worstCase: TaskComposerValues = {
  ...filled,
  title: "Add repository onboarding with an extremely long title that keeps " +
    "going so the field must hold it without growing the page sideways",
  description: "A".repeat(40) + " " + "unbroken".repeat(24) + "\n" +
    "Every line of this description is long on purpose. ".repeat(6),
};

export const Contract: StoryObj = {
  render: (_args, context) => {
    const t = storyTranslator(context.globals);
    const labels = composerLabels(t);
    const form = (
      key: string,
      options: {
        view?: TaskComposerView;
        submitState?: TaskComposerSubmitState;
        setupReasons?: readonly TaskComposerSetupReason[];
        values?: TaskComposerValues;
        planFirst?: boolean;
      } = {},
    ): ReactNode => (
      <div data-case={key} key={key}>
        <TaskComposerForm
          labels={{ ...labels, heading: `${labels.heading} (${key})` }}
          onChange={() => {}}
          onDiscard={() => {}}
          onRetry={() => {}}
          onSubmit={() => {}}
          planFirst={{
            label: t("tasks.composer.planFirst"),
            hint: t("tasks.composer.planFirstHint"),
            submit: t("tasks.composer.submitPlan"),
            checked: options.planFirst === true,
            onChange: () => {},
          }}
          presets={[{
            id: "fixed-coding@1",
            title: t("tasks.preset.fixedCoding.title"),
            description: t("tasks.preset.fixedCoding.description"),
          }]}
          repositories={repositories}
          setupReasons={options.setupReasons}
          submitState={options.submitState}
          values={options.values ?? filled}
          view={options.view}
        />
      </div>
    );
    return (
      <Stack>
        <Text data-testid="text-specimen-copy" variant="caption">
          {t("tasks.composer.unknown")}
        </Text>
        {form("idle")}
        {setupReasons.map((reason) =>
          form(`setup ${reason}`, { setupReasons: [reason] })
        )}
        {form("setup all reasons", { setupReasons })}
        {form("setup unknown reason", {
          setupReasons: ["future_reason" as TaskComposerSetupReason],
        })}
        {form("no repository chosen", {
          values: { ...filled, repositoryId: "" },
        })}
        {form("submitting", { submitState: "submitting" })}
        {form("unknown", { submitState: "unknown" })}
        {form("conflict", { submitState: "conflict" })}
        {form("forbidden", { submitState: "forbidden" })}
        {form("error", { submitState: "error" })}
        {form("loading", { view: "loading" })}
        {form("empty", { view: "empty" })}
        {form("offline", { view: "offline" })}
        {form("reconnecting", { view: "reconnecting" })}
        {form("plan first", { planFirst: true })}
        {form("plan first with unmet setup", {
          planFirst: true,
          setupReasons: ["no_active_profile"],
        })}
        {form("worst case", { values: worstCase })}
      </Stack>
    );
  },
};
