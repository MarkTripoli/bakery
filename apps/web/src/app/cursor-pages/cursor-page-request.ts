export type CursorRequestGeneration = {
  generation: number;
  inFlight: boolean;
};

/** A reset invalidates results, errors and completion, not just appended items. */
export async function runCursorPageRequest<Page>(
  guard: CursorRequestGeneration,
  fetchPage: () => Promise<Page>,
  onPage: (page: Page) => void,
  onError: () => void,
  onComplete: () => void,
): Promise<void> {
  if (guard.inFlight) return;
  const generation = guard.generation;
  guard.inFlight = true;
  try {
    const page = await fetchPage();
    if (guard.generation === generation) onPage(page);
  } catch {
    if (guard.generation === generation) onError();
  } finally {
    if (guard.generation === generation) {
      guard.inFlight = false;
      onComplete();
    }
  }
}
