export const DOCUMENT_OUTPUT_ACTIONS: readonly string[] = Object.freeze([
  "agent.freeform",
]);

export function documentOutputSlot(
  action: string,
  declared: readonly Readonly<{ name: string }>[] | undefined,
): string | undefined {
  if (!DOCUMENT_OUTPUT_ACTIONS.includes(action)) return undefined;
  if (declared === undefined || declared.length !== 1) return undefined;
  return declared[0]!.name;
}
