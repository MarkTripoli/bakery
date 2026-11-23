/** What a reference points at. */
export type ReferenceKind =
  | "commit"
  | "release"
  | "pullRequest"
  | "issue"
  | "task"
  | "run"
  | "machine"
  | "person";

/** Characters of the whole id that show in the text, per kind; the rest is in the card. */
const SHORT: Readonly<Partial<Record<ReferenceKind, number>>> = {
  commit: 7,
  release: 8,
  task: 8,
  run: 8,
};

/** The short form of an id: 7 characters for a commit, 8 for a release, task or run; anything else as it is. */
export function shortReference(kind: ReferenceKind, value: string): string {
  const length = SHORT[kind];
  return length === undefined ? value : value.slice(0, length);
}
