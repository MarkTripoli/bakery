export async function authoredYaml(
  source: string | undefined,
  definition: unknown,
): Promise<{ sourceYaml?: string }> {
  if (!source) return {};
  const { rewriteWorkflowYaml } = await import(
    "@bakery/contracts/workflow-compiler"
  );
  const sourceYaml = rewriteWorkflowYaml(source, definition);
  return sourceYaml === null ? {} : { sourceYaml };
}
