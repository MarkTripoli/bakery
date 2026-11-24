/**
 * A built-in workflow's steps as the definition the diagram draws (#62).
 *
 * The preset read lists the steps flat, in order. A step that sits in a bounded
 * repeat carries that repeat's id and its most iterations, so the steps of one
 * repeat, which are consecutive, are drawn as one repeat block. That is what
 * lets the built-in page name its repair loop "Fix until it passes" like the
 * workflow page does, instead of listing the loop's steps as if they ran once.
 */

/** One step as the preset read returns it. */
export type PresetStepRead = Readonly<{
  id: string;
  uses: string;
  repeatId?: string;
  repeatMax?: number;
}>;

/**
 * The definition `treeOf` draws for a preset: a plain action per step, and one
 * repeat node around each run of steps that share a repeat id. A repeat with no
 * readable limit is not grouped: its steps stay in the line, so nothing is
 * dropped and no limit is invented.
 */
export function presetDefinition(
  steps: readonly PresetStepRead[],
): { readonly steps: readonly unknown[] } {
  const out: unknown[] = [];
  let open: { id: string; body: unknown[] } | undefined;
  for (const step of steps) {
    const action = { kind: "action", id: step.id, uses: step.uses };
    const grouped = step.repeatId !== undefined &&
      step.repeatMax !== undefined;
    if (!grouped) {
      open = undefined;
      out.push(action);
      continue;
    }
    if (open === undefined || open.id !== step.repeatId) {
      open = { id: step.repeatId as string, body: [] };
      out.push({ kind: "repeat", max: step.repeatMax, steps: open.body });
    }
    open.body.push(action);
  }
  return { steps: out };
}
