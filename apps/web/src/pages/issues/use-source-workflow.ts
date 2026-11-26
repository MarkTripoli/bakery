import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import type { TicketPresetId } from "../../api/client.ts";
import { workflowQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { workflowOfPolicy } from "../issue-sources.ts";
import { presetCopy } from "../task-composer-labels.ts";

export type SourceWorkflow =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "builtIn";
    preset: TicketPresetId;
    name: string;
    description: string;
  }>
  | Readonly<{
    kind: "written";
    workflowId: string;
    name: string;
    description: string;
  }>;

export const PENDING_NAME = "…";

export function useWorkflowName(workflowId: string | null): {
  name: string;
  description: string;
} {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const read = useQuery({
    ...workflowQueryOptions(api, scope, workflowId ?? ""),
    enabled: workflowId !== null && Boolean(scope.organizationId),
  });
  if (read.data !== undefined) {
    return { name: read.data.name, description: read.data.description ?? "" };
  }
  return {
    name: read.isError
      ? translate("issues.settings.workflow.unavailable" as never)
      : PENDING_NAME,
    description: "",
  };
}

export function useSourceWorkflow(policy: unknown): SourceWorkflow {
  const { translate } = useI18n();
  const ref = workflowOfPolicy(policy);
  const written = useWorkflowName(
    ref?.kind === "written" ? ref.workflowId : null,
  );
  if (ref === null) return { kind: "none" };
  if (ref.kind === "builtIn") {
    const copy = presetCopy(translate, ref.preset);
    return {
      kind: "builtIn",
      preset: ref.preset,
      name: copy.title,
      description: copy.description ?? "",
    };
  }
  return { kind: "written", workflowId: ref.workflowId, ...written };
}
