type FlatStep = {
  id: string;
  uses: string;
  repeatId?: string;
  repeatMax?: number;
};

export function presetRead<Item extends { id: string; steps: FlatStep[] }>(
  item: Item,
) {
  const nodes: unknown[] = [];
  let open: { id: string; steps: unknown[] } | undefined;
  for (const step of item.steps) {
    const node = { id: step.id, uses: step.uses };
    if (step.repeatId === undefined || step.repeatMax === undefined) {
      open = undefined;
      nodes.push(node);
      continue;
    }
    if (open === undefined || open.id !== step.repeatId) {
      open = { id: step.repeatId, steps: [] };
      nodes.push({
        id: step.repeatId,
        repeat: { max: step.repeatMax, steps: open.steps },
      });
    }
    open.steps.push(node);
  }
  return {
    ...item,
    definition: {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: item.id,
      steps: nodes,
    },
    startableFromComposer: true,
  };
}
