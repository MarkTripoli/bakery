/**
 * The four software-delivery work types this picker offers.
 *
 * Work type is an organization label since O23: a task may carry one of these
 * four or any other lowercase kebab-case label its organization uses. The
 * picker offers these four and shows any other label as itself, so a form
 * seeded from an existing task never misrepresents the row it came from.
 */
export type TaskComposerTaskType = "feature" | "bug" | "epic" | "maintenance";

export const TASK_COMPOSER_TASK_TYPES: readonly TaskComposerTaskType[] = Object
  .freeze(
    [
      "feature",
      "bug",
      "epic",
      "maintenance",
    ] as const,
  );

/** True when the label is one of the four this picker offers. */
export function isTaskComposerTaskType(
  value: string,
): value is TaskComposerTaskType {
  return (TASK_COMPOSER_TASK_TYPES as readonly string[]).includes(value);
}
