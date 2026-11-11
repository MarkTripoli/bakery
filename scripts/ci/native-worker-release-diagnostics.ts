// Native smoke owns the attempt ID. Never serialize registration values or errors.
export async function readReleasePresence(path: string, attemptId: string) {
  try {
    const state: unknown = JSON.parse(await Deno.readTextFile(path));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { state: "unreadable" as const };
    }
    const fields = state as Record<string, unknown>;
    const presence = (name: string): boolean => {
      const value = fields[name];
      if (value === undefined) return false;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("INVALID_PRESENCE_MAP");
      }
      return Object.hasOwn(value, attemptId);
    };
    return {
      state: "readable" as const,
      activeAssignments: presence("activeAssignments"),
      terminationEvidence: presence("terminationEvidence"),
      releaseMarkers: presence("releaseMarkers"),
    };
  } catch {
    return { state: "unreadable" as const };
  }
}
