import type { MemoryActionHandlers } from "./memory-actions.ts";
import {
  addMemoryRevision,
  createMemory,
  getMemory,
  listMemory,
  listMemoryRevisions,
  updateMemory,
} from "./memory-postgres.ts";

/**
 * Binds the six memory operations to their Postgres implementations.
 *
 * The id an operation acts on comes from the route, so the handlers read it
 * from the action context rather than asking the body to repeat it - a body
 * that named its own id could disagree with the path it was sent to.
 */
export function createMemoryHandlers(): MemoryActionHandlers {
  return {
    listMemories: listMemory,
    getMemory: (context) => getMemory(context, memoryId(context)),
    createMemory,
    updateMemory: (context, input) =>
      updateMemory(context, input, memoryId(context)),
    createRevision: (context, input) =>
      addMemoryRevision(context, input, memoryId(context)),
    listRevisions: (context, input) =>
      listMemoryRevisions(context, input, memoryId(context)),
  };
}

function memoryId(context: { params: Readonly<Record<string, string>> }) {
  return context.params.id ?? "";
}
