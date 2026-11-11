import { createTranslator } from "@bakery/i18n";
import { storyTranslator } from "../fixtures/task-session.ts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/TaskDetail",
  parameters: { catalogId: "template.taskDetail", requiredCases: ["contract"] },
} satisfies Meta;
export default meta;

type Capability = "pause" | "cancel" | "resume" | "interrupt";
type Receipt = "pending" | "conflict" | "forbidden" | "terminal";

const BaseContract: StoryObj = {
  render: (_args, context) => {
    const translate = createTranslator({ locale: "en", surface: "ui-story" });
    const t = storyTranslator(context.globals);
    const labels = {
      artifactId: translate("tasks.artifact.id"),
      version: translate("tasks.artifact.version"),
      digest: translate("tasks.artifact.digest"),
      size: translate("tasks.artifact.size"),
      mediaType: translate("tasks.artifact.mediaType"),
      provenance: translate("tasks.artifact.provenance"),
      link: translate("tasks.artifact.open"),
    };
    const receiptText: Record<Receipt, string> = {
      pending: translate("tasks.controls.pending"),
      conflict: translate("tasks.controls.conflict"),
      forbidden: translate("tasks.controls.forbidden"),
      terminal: translate("tasks.controls.terminal"),
    };
    const detail = (
      variant: "sheet" | "pane" | "rail",
      state: "loading" | "ready" | "reconnecting" | "error" | "forbidden",
    ) => {
      const capabilities = new Set<Capability>(["pause", "cancel"]);
      const controls: ReadonlyArray<{
        capability: Capability;
        label: string;
        receipt: Receipt;
      }> = [
        {
          capability: "pause",
          label: translate("tasks.controls.pause"),
          receipt: "pending",
        },
        {
          capability: "resume",
          label: translate("tasks.controls.resume"),
          receipt: "forbidden",
        },
        {
          capability: "cancel",
          label: translate("tasks.controls.cancel"),
          receipt: "conflict",
        },
        {
          capability: "interrupt",
          label: translate("tasks.controls.interrupt"),
          receipt: "terminal",
        },
      ];
      return (
        <UI.TaskDetail
          actions={state === "ready"
            ? (
              <UI.Stack>
                {controls.map(({ capability, label, receipt }) => {
                  const authorized = capabilities.has(capability);
                  return (
                    <div key={capability} data-receipt={receipt}>
                      <UI.Button
                        disabled={!authorized}
                        type="button"
                        aria-describedby={`${capability}-receipt`}
                      >
                        {label}
                      </UI.Button>
                      <UI.Text id={`${capability}-receipt`}>
                        {receiptText[receipt]}
                      </UI.Text>
                    </div>
                  );
                })}
              </UI.Stack>
            )
            : null}
          state={state}
          title={translate("tasks.detail.title", { variant })}
          variant={variant}
          aside={<UI.Identity type="person" name="Alex" state="default" />}
        >
          <UI.Text>
            {state === "error"
              ? translate("tasks.detail.error")
              : state === "forbidden"
              ? translate("tasks.detail.forbidden")
              : translate("tasks.detail.content")}
          </UI.Text>
          {state === "ready"
            ? (
              <UI.ArtifactDescriptor
                artifactId="fixture-artifact"
                version="1"
                digest="sha256:0123456789abcdef0123456789abcdef"
                size="18 KB"
                mediaType="text/plain"
                provenance={translate("tasks.artifact.descriptor")}
                labels={labels}
                href="/artifact-fixture"
              />
            )
            : null}
        </UI.TaskDetail>
      );
    };
    return (
      <UI.Stack>
        {detail("rail", "ready")}
        {detail("sheet", "loading")}
        {detail("pane", "reconnecting")}
        {detail("rail", "error")}
        {detail("sheet", "forbidden")}
        <UI.TaskDetail
          composer={
            <UI.Button type="button" variant="secondary">
              {t("tasks.controls.cancel")}
            </UI.Button>
          }
          layout="session"
          meta={t("tasks.session.subtitle", {
            preset: t("tasks.preset.fixedCoding.title"),
            repository: "bakery/bakery",
            revision: 1,
          })}
          title={t("tasks.detail.title", { variant: "session" })}
          variant="rail"
        >
          <UI.RunTimeline
            connectivity="reconnecting"
            connectivityLabel={t("tasks.timeline.connectivity.reconnecting")}
            events={[
              {
                id: "queued",
                scope: "run",
                status: "complete",
                time: "10:21",
                title: t("tasks.timeline.queued"),
              },
              {
                id: "brief",
                status: "complete",
                time: "10:22",
                title: t("tasks.timeline.step.brief"),
              },
              {
                id: "implement",
                reason: t("tasks.timeline.stepFault"),
                status: "failed",
                title: t("tasks.timeline.step.implement"),
              },
              {
                id: "terminal",
                scope: "run",
                status: "failed",
                time: "10:30",
                title: t("tasks.timeline.terminal.failed"),
              },
            ]}
            label={t("tasks.timeline.label")}
          />
        </UI.TaskDetail>
      </UI.Stack>
    );
  },
};

const ConversationStory: StoryObj = {
  render: () => (
    <UI.TaskDetail
      layout="conversation"
      title="Shared checkout onboarding"
      subtitle="Northwind storefront · northwind/web · Fixed coding preset"
      stages={
        <UI.WorkflowStageStrip
          label="Workflow stages"
          stages={[
            { id: "discuss", title: "1 · Discuss", detail: "Automatic" },
            {
              id: "plan",
              title: "2 · Plan · Current stage",
              detail: "Waits for your approval",
              current: true,
            },
          ]}
        />
      }
      composer={
        <UI.MessageComposer
          aria-label="Message this task"
          field={<textarea aria-label="Message this task" rows={1} />}
          send={<UI.Button type="submit">Send</UI.Button>}
        />
      }
    >
      <UI.ConversationMessage author="You" timestamp="10:21 AM">
        Can we plan it across the two repositories?
      </UI.ConversationMessage>
    </UI.TaskDetail>
  ),
};

export const Contract: StoryObj = {
  render: (args, context) => (
    <>
      {BaseContract.render?.(args, context)}
      {ConversationStory.render?.(args, context)}
    </>
  ),
};
