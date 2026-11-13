import { useState } from "react";
import * as UI from "@bakery/ui";
import type { TaskCursorQuery } from "../api/client.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  WorkQueueFilters,
  type WorkQueueGroup,
  type WorkQueueInspectorDetail,
  WorkQueueView,
} from "../pages/TasksPage.tsx";
import { TaskSessionView } from "../pages/task-session-view.tsx";

/**
 * Paper E-0 synthetic Work queue data (paper-source/5J-0.jsx, E8-0.jsx).
 * Rendered through the production `WorkQueueView`; nothing here reaches the
 * API. Fields the product has no source for yet (task keys, harness,
 * participants, questions, model) exist only in this fixture.
 */
const groups: readonly WorkQueueGroup[] = [
  {
    id: "waiting_input",
    label: "Needs input",
    rows: [
      {
        id: "bkry-104",
        reference: "BKRY-104",
        title: "Add repository onboarding",
        application: "Bakery",
        stage: { label: "Needs input", tone: "warning" },
        harness: "Codex",
        age: "2m",
      },
      {
        id: "web-041",
        reference: "WEB-041",
        title: "Confirm error tracking provider",
        application: "Example web",
        stage: { label: "Needs input", tone: "warning" },
        harness: "Claude Code",
        age: "15m",
      },
    ],
  },
  {
    id: "active",
    label: "Active",
    rows: [
      {
        id: "web-038",
        reference: "WEB-038",
        title: "Refine activity filters",
        application: "Example web",
        stage: { label: "Reviewing", tone: "information" },
        harness: "Pi",
        age: "4m",
      },
      {
        id: "bkry-102",
        reference: "BKRY-102",
        title: "Preserve worker checkpoints",
        application: "Bakery",
        stage: { label: "Implementing", tone: "information" },
        harness: "Codex",
        age: "12m",
      },
      {
        id: "web-037",
        reference: "WEB-037",
        title: "Improve empty state copy",
        application: "Example web",
        stage: { label: "Implementing", tone: "information" },
        harness: "Pi",
        age: "19m",
      },
    ],
  },
  {
    id: "queued",
    label: "Queued",
    rows: [
      {
        id: "ios-027",
        reference: "IOS-027",
        title: "Add notification preferences",
        application: "Example mobile",
        stage: { label: "Waiting for Mac", tone: "neutral" },
        harness: "Claude Code",
        age: "8m",
      },
      {
        id: "bkry-101",
        reference: "BKRY-101",
        title: "Add webhook intake",
        application: "Bakery",
        stage: { label: "Queued", tone: "neutral" },
        harness: "Codex",
        age: "32m",
      },
      {
        id: "api-058",
        reference: "API-058",
        title: "Add rate limiting",
        application: "Example API",
        stage: { label: "Queued", tone: "neutral" },
        harness: "Pi",
        age: "41m",
      },
    ],
  },
];

const detail: WorkQueueInspectorDetail = {
  participants: ["Mark Tripoli", "Sam Lin"],
  question: {
    allowFreeText: false,
    defaultOptionId: "bakery",
    id: "question-bkry-104",
    options: [
      { id: "bakery", label: "Bakery only" },
      { id: "choose", label: "Choose repositories" },
    ],
    prompt: "Which repositories should we import?",
    status: "open",
  },
  activity: [
    {
      id: "research",
      title: "Research completed",
      time: "10:32",
      description: "Agent",
    },
    {
      id: "plan",
      title: "Plan, version 3 published",
      time: "10:29",
      description: "2 comments",
    },
    {
      id: "waiting",
      title: "Waiting for your answer",
      time: "10:27",
      description: "Repository selection",
    },
  ],
  model: "Workspace default",
};

export function WorkQueueFixture() {
  const { translate: t } = useI18n();
  const layout = useShellViewport() === "phone" ? "sheet" : "rail";
  const [selectedId, setSelectedId] = useState("bkry-104");
  const [view, setView] = useState("all");
  const [repository, setRepository] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskCursorQuery["status"]>();
  const counted = (label: string, count: number) =>
    t("tasks.queue.counted", { label, count: String(count) });
  return (
    <WorkQueueView
      layout={layout}
      state="ready"
      groups={groups}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onOpen={(event) => event.preventDefault()}
      detail={detail}
      summary={t("tasks.queue.summary", { count: 8 })}
      views={[
        {
          id: "all",
          label: layout === "sheet"
            ? counted(t("tasks.queue.view.all"), 8)
            : t("tasks.queue.view.all"),
        },
        { id: "waiting_input", label: counted("Needs input", 2) },
        { id: "active", label: counted("Active", 3) },
        { id: "queued", label: counted("Queued", 3) },
      ]}
      selectedView={view}
      onSelectView={setView}
      statusStrip={
        <UI.StatusStrip label="Worker readiness">
          <UI.StatusDot tone="success">1 worker ready</UI.StatusDot>
          <UI.Text variant="hint">MacBook offline</UI.Text>
        </UI.StatusStrip>
      }
      filters={
        <WorkQueueFilters
          layout={layout}
          repository={repository}
          onRepository={setRepository}
          repositoryValid
          search={search}
          onSearch={setSearch}
          status={status}
          onStatus={setStatus}
          statuses={["waiting_input", "active", "queued"] as const}
        />
      }
    />
  );
}

/**
 * Paper HU-0 task data through the production `TaskSessionView` composition:
 * the run timeline and artifact card in the main column, ArtifactPane in the
 * inspector. Only the user's brief is shown; planning conversation, revisions,
 * comments and approval are not shown yet.
 */
export function WorkSessionFixture() {
  const { translate: t } = useI18n();
  const [version, setVersion] = useState("");
  const brief =
    "Let’s make onboarding a repository feel straightforward. I want to choose the repository, check the worker toolchain, and see what still needs setup.";
  return (
    <TaskSessionView
      title="Repository onboarding"
      state="ready"
      layout={useShellViewport() === "phone" ? "sheet" : "rail"}
      breadcrumbs={[{ label: "Bakery" }, { label: "BKRY-104" }]}
      actions={<UI.StatusDot tone="information">Planning</UI.StatusDot>}
      messages={[{
        id: "brief",
        author: t("tasks.session.brief"),
        time: "10:21",
        body: brief,
      }]}
      aside={
        <UI.ArtifactPane
          label={t("tasks.artifactPane.label")}
          title="Repository onboarding · Task brief"
          labels={{
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
          }}
          versions={[]}
          version={version}
          onVersionChange={setVersion}
          previewText={brief}
        />
      }
    >
      <UI.Heading level="section">{t("tasks.run.heading")}</UI.Heading>
      <UI.RunTimeline
        label={t("tasks.run.timeline")}
        events={[
          {
            id: "s1",
            title: "Select the repository",
            description:
              "Choose a GitHub repository and confirm the default branch.",
            status: "complete",
          },
          {
            id: "s2",
            title: "Verify the environment",
            description:
              "Check the assigned worker, required tools, and repository profile before dispatch.",
            status: "complete",
          },
          {
            id: "s3",
            title: "Queue the first task",
            description:
              "Keep the task queued until every required readiness check passes.",
            status: "active",
          },
        ]}
      />
      <UI.ArtifactPreview
        href="#task-brief"
        title="Repository onboarding · Task brief"
        meta="Paper fixture · User task brief"
      />
    </TaskSessionView>
  );
}
