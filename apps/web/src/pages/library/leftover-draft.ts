import type {
  BakeryApiClient,
  WorkflowVersionResponse,
} from "../../api/client.ts";
import { authoredYaml } from "./authored-yaml.ts";
import { publishChanges } from "./publish-changes.ts";
import { sameStarts, savedStart, startsOfVersion } from "./start-list.ts";

export type DraftTarget = Readonly<{ id: string; version: number }>;

export function leftoverDraftOf(
  versions: readonly WorkflowVersionResponse[],
  wasInUse: WorkflowVersionResponse | undefined,
): WorkflowVersionResponse | undefined {
  if (wasInUse === undefined) return undefined;
  return versions.find((version) =>
    version.status === "draft" &&
    !publishChanges(
      wasInUse.normalizedSpec,
      version.normalizedSpec,
      (key) => key,
    ).differs &&
    sameStarts(
      startsOfVersion(version.starts),
      startsOfVersion(wasInUse.starts),
    )
  );
}

export async function rewriteDraft(
  api: Pick<BakeryApiClient, "updateWorkflowVersion">,
  organizationId: string,
  workflowId: string,
  target: DraftTarget,
  used: WorkflowVersionResponse,
): Promise<boolean> {
  const result = await api.updateWorkflowVersion({
    organizationId,
    workflowId,
    versionId: target.id,
    version: target.version,
    input: {
      definition: used.normalizedSpec,
      ...await authoredYaml(used.sourceYaml, used.normalizedSpec),
      starts: startsOfVersion(used.starts).map(savedStart),
    },
    idempotencyKey: crypto.randomUUID(),
  });
  return result.ok;
}
