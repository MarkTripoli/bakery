import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  RevisionSummary,
  RunIdentity,
  type RunOutputPageProps,
  RunOutputPanel,
  RunOutputView,
} from "@bakery/ui";

const meta = {
  title: "Bakery/Templates/RunOutputView",
  parameters: {
    catalogId: "template.runOutputView",
    requiredCases: ["contract"],
  },
} satisfies Meta;
export default meta;

const props: RunOutputPageProps = {
  brand: "Bakery",
  workspace: "Platform team",
  navigationLabel: "Primary navigation",
  navigation: [{ label: "Work", selected: true }],
  footer: "Platform team · Developer",
  menuLabel: "Menu",
  breadcrumbs: ["Work / Durable artifacts", "/ Run 42"],
  reference: "TASK 130 · RUN 42",
  status: "Running",
  title: "Make artifact delivery durable",
  description: "Platform / bakery · started 2 minutes ago",
  identity: (
    <RunIdentity
      title="Execution identity"
      worker="atlas-01"
      attempt="Try 2"
      lease="Lease active"
      detail="Codex · trusted worker record"
      unknownLabel="Unknown"
    />
  ),
  output: (
    <RunOutputPanel
      title="Run output"
      entries={[{
        id: "1",
        message: "14:32:01  worker atlas-01 acquired attempt 2",
      }]}
      state="live"
      statusLabel="Live"
      captureLabel="stdout + stderr · cursor 128"
      latestLabel="Jump to latest"
    />
  ),
  revision: (
    <RevisionSummary
      title="Changes"
      baseRevision="8ac02e1"
      candidateRevision="5d138ac"
      summary="3 files · +84 −12"
      disclaimer="Observed repository state. No review or merge decision recorded."
      unknownLabel="Unknown"
    />
  ),
};

export const Contract: StoryObj = {
  render: () => (
    <>
      <RunOutputView {...props} />
      <RunOutputView variant="section" title="Current run" state="notice">
        <div className="ui-run-card">
          <h2>Output interrupted</h2>
          <p className="ui-run-card__description" role="status">
            The stream ended before a terminal record. Execution outcome is
            unknown.
          </p>
          <div className="ui-run-card__actions">
            <Button variant="outline">Reload run</Button>
          </div>
        </div>
      </RunOutputView>
    </>
  ),
};
