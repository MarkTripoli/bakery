import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { TaskSessionView } from "../pages/task-session-view.tsx";
import { TaskRunSectionView } from "../pages/task-run-section-view.tsx";
import { TaskRunStreamView } from "../pages/task-run-stream-view.tsx";
import { runOutputFixtureData } from "./run-output-fixture-data.ts";

export { runOutputFixtureStates } from "./run-output-fixture-data.ts";

export function RunOutputFixture() {
  const state = useRouterState({
    select: (router) => router.location.pathname.split("/").at(-1) ?? "default",
  });
  const viewport = useShellViewport();
  const fixture = runOutputFixtureData(state);
  const [version, setVersion] = useState(fixture.inspector.version);
  return (
    <>
      <ShellActiveNavigation id="work" />
      <TaskSessionView
        layout={viewport === "phone" ? "sheet" : "rail"}
        title={fixture.title}
        runHeading={{
          description: fixture.description,
          reference: fixture.reference,
          status: fixture.status,
        }}
        state="ready"
        messages={[]}
        aside={
          <UI.ArtifactPane
            {...fixture.inspector}
            version={version}
            onVersionChange={setVersion}
          />
        }
      >
        <TaskRunSectionView
          title="Current run"
          execution={
            <TaskRunStreamView
              identity={{
                ...fixture.identity,
                notice: fixture.notice && {
                  title: fixture.notice.title,
                  description: fixture.notice.description,
                  action: (
                    <UI.Button variant="outline">
                      {fixture.notice.actionLabel}
                    </UI.Button>
                  ),
                },
              }}
              output={fixture.output}
            />
          }
          revision={<UI.RevisionSummary {...fixture.revision} />}
          artifacts={
            <UI.RunArtifactSummary
              {...fixture.artifact}
              actions={
                <>
                  <UI.Link
                    variant="button"
                    href="/__fixtures__/artifacts/artifact/default"
                  >
                    Open artifact
                  </UI.Link>
                  <UI.Link variant="button" href="#artifact">Download</UI.Link>
                </>
              }
            />
          }
        />
      </TaskSessionView>
    </>
  );
}
