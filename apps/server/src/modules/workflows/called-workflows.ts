import { WORKFLOW_COMPILER_LIMITS } from "@bakery/contracts/workflow-compiler";
import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * The published workflow versions a definition may call (#418, one engine
 * O10). A `call` names a version by id, and the compiler inlines it from the
 * definition that version was published with. The compiler is pure, so this
 * loads what it will be offered: only versions that are published in the
 * caller's own organization. A version of another organization, an unpublished
 * draft and an id that does not exist are all simply absent, and the compiler
 * refuses the call without saying which.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every version id a definition's `call` nodes name, in no particular order. */
export function calledVersionIds(definition: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const call = Object.hasOwn(record, "call") ? record["call"] : undefined;
    if (call !== null && typeof call === "object" && !Array.isArray(call)) {
      const version = (call as Record<string, unknown>)["workflow"];
      if (typeof version === "string" && UUID.test(version)) {
        found.add(version.toLowerCase());
      }
    }
    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };
  visit(definition, 0);
  return [...found];
}

/**
 * Loads the called versions, and the versions those call, as far as the
 * compiler will follow them: a workflow, its child and that child's own child.
 */
export async function loadCalledWorkflows(
  transaction: PgTransactionClient,
  organizationId: string,
  definition: unknown,
): Promise<ReadonlyMap<string, unknown>> {
  const loaded = new Map<string, unknown>();
  let wanted = calledVersionIds(definition);
  for (let round = 0; round < WORKFLOW_COMPILER_LIMITS.callDepth; round++) {
    wanted = wanted.filter((id) => !loaded.has(id));
    if (wanted.length === 0) break;
    const found = await transaction.query<{ id: string; spec: unknown }>(
      `select id, normalized_spec as spec
         from bakery.workflow_versions
        where organization_id = $1 and status = 'published'
          and id = any($2::uuid[])`,
      [organizationId, wanted],
    );
    const next: string[] = [];
    for (const row of found.rows) {
      loaded.set(row.id.toLowerCase(), row.spec);
      next.push(...calledVersionIds(row.spec));
    }
    wanted = next;
  }
  return loaded;
}
