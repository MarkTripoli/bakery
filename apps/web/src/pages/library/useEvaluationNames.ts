import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import {
  evaluationCasesQueryOptions,
  evaluationDatasetsQueryOptions,
  libraryAgentsQueryOptions,
  libraryWorkflowsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import type { EvaluationDataset } from "../../api/client.ts";
import type { DefinitionNames } from "./evaluations-state.ts";

/** The names a run's rows need, read from the lists the organization already has. */
export type EvaluationNames = {
  readonly agents: DefinitionNames;
  readonly workflows: DefinitionNames;
  readonly datasets: ReadonlyMap<string, EvaluationDataset>;
  readonly cases: ReadonlyMap<string, string>;
};

/**
 * Names for the runs: agents and workflows (a pin's id), the test case sets
 * and, when asked, the test cases. The server gives pins and ids, not names
 * (design-ux #75, "For the server" 1), so a list that cannot be read leaves
 * its names out and the words fall back to the kind and the version.
 */
export function useEvaluationNames(
  { cases }: { readonly cases: boolean },
): EvaluationNames {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const agents = useQuery(libraryAgentsQueryOptions(api, scope));
  const workflows = useQuery(libraryWorkflowsQueryOptions(api, scope));
  const datasets = useQuery(evaluationDatasetsQueryOptions(api, scope));
  const caseList = useQuery({
    ...evaluationCasesQueryOptions(api, scope),
    enabled: cases && Boolean(scope.organizationId),
  });
  return useMemo(() => ({
    agents: new Map(
      (agents.data?.items ?? []).map((row) => [row.id, row.name]),
    ),
    workflows: new Map(
      (workflows.data?.items ?? []).map((row) => [row.id, row.name]),
    ),
    datasets: new Map((datasets.data ?? []).map((row) => [row.id, row])),
    cases: new Map((caseList.data ?? []).map((row) => [row.id, row.name])),
  }), [agents.data, workflows.data, datasets.data, caseList.data]);
}
