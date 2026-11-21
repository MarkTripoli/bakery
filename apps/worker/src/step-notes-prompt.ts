/** The most notes, and characters per note, a prompt takes from a job's input. */
const MAX_STEP_NOTES = 20;
const MAX_STEP_NOTE_LENGTH = 4_000;

/**
 * Adds the notes a person left for this step before it started (#412) to the
 * step's prompt.
 *
 * Notes come from the admitted job input (`stepNotes`), which the server fills
 * once. They are text for the agent to read: they carry no argv, environment,
 * tool, grant or skill, and a malformed or oversized entry is skipped rather
 * than trusted.
 */
export function withStepNotes(prompt: string, input: unknown): string {
  const raw = typeof input === "object" && input !== null
    ? (input as Record<string, unknown>).stepNotes
    : undefined;
  if (!Array.isArray(raw)) return prompt;
  const notes = raw
    .filter((note): note is string =>
      typeof note === "string" && note.length > 0 &&
      note.length <= MAX_STEP_NOTE_LENGTH
    )
    .slice(0, MAX_STEP_NOTES);
  if (notes.length === 0) return prompt;
  return `${prompt}\n\nNotes left for this step before it started:\n${
    notes.map((note) => `- ${note}`).join("\n")
  }`;
}
