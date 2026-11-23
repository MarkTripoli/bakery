/**
 * Naming the document a step wrote (#429, deliver-as-workflow.md 4.3).
 *
 * A step declares an output slot, `outputs: [{name, kind}]`, and a later step
 * reads the document written under it as `$step.<id>.outputs.<name>`, an artifact
 * reference (artifactId, versionId, sha256) that a step's input slot then pins.
 *
 * Only an action that publishes exactly one document can bind a slot to it:
 * `agent.freeform` publishes its whole answer as one artifact, so its one
 * declared slot names that artifact. A slot on any other action, or a second
 * slot on this one, has nothing to bind and cannot be read. The compiler refuses
 * such a read and the engine binds the slot with the same rule, so a reference
 * that compiles is a reference that resolves.
 */

/** The actions that publish one document, so one declared slot can name it. */
export const DOCUMENT_OUTPUT_ACTIONS: readonly string[] = Object.freeze([
  "agent.freeform",
]);

/** The name of the slot a step's document is bound to, or undefined when none is. */
export function documentOutputSlot(
  action: string,
  declared: readonly Readonly<{ name: string }>[] | undefined,
): string | undefined {
  if (!DOCUMENT_OUTPUT_ACTIONS.includes(action)) return undefined;
  if (declared === undefined || declared.length !== 1) return undefined;
  return declared[0]!.name;
}
