import { assert, assertEquals } from "@std/assert";
import {
  acquirePreviewSlot,
  createOrganizationRulePreviewHandler,
  SCAN_SQL,
} from "../../apps/server/src/modules/repository-rules/previews.ts";

// Drives the real organization preview handler over a fake transaction, so
// admission wiring (which ids it passes, where it releases) is proven without
// a database.
const uuid = () => crypto.randomUUID();
const secret = "s".repeat(64);
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
const context = (organizationId: string, principalId: string, query: Query) =>
  ({
    authority: { organizationId, subject: { principalId } },
    transaction: { query },
    params: { id: organizationId },
  }) as never;
const input = (extra: Record<string, unknown> = {}) =>
  ({ expectedRevision: 0, entries: [], ...extra }) as never;
const run = async (
  organizationId: string,
  principalId: string,
  query: Query,
  value = input(),
) => {
  try {
    await createOrganizationRulePreviewHandler(secret)(
      context(organizationId, principalId, query),
      value,
    );
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
};
/** Two fresh slots fit and a third does not: nothing is leaked, the cap holds. */
function slotsAreFree(): boolean {
  const first = acquirePreviewSlot(uuid(), uuid());
  const second = acquirePreviewSlot(uuid(), uuid());
  let third = "fits";
  try {
    acquirePreviewSlot(uuid(), uuid())();
  } catch {
    third = "refused";
  }
  first();
  second();
  return third === "refused";
}
const empty: Query = () => Promise.resolve({ rows: [] });
const row = (summaries: unknown = []) => ({
  id: uuid(),
  application_id: uuid(),
  name: "r",
  summaries,
  command_ids: [],
});

Deno.test("the handler releases its slot on every exit path", async () => {
  const canceled = Object.assign(new Error("canceled"), { code: "57014" });
  const failures: Record<string, [Query, string, ReturnType<typeof input>?]> = {
    "set_config throws": [
      (sql) =>
        sql.includes("set_config")
          ? Promise.reject(new Error("aborted"))
          : Promise.resolve({ rows: [] }),
      "aborted",
    ],
    "statement timeout": [
      (sql) =>
        sql === SCAN_SQL
          ? Promise.reject(canceled)
          : Promise.resolve({ rows: [] }),
      "DEPENDENCY_TIMEOUT",
    ],
    "byte budget": [
      (sql) =>
        Promise.resolve({
          rows: sql === SCAN_SQL
            ? [row([{
              k: "code.magicNumbers",
              e: true,
              m: "require",
              b: "x".repeat(13 * 1024 * 1024),
            }])]
            : [],
        }),
      "UNPROCESSABLE",
    ],
    "stale revision": [
      (sql) =>
        Promise.resolve({
          rows: sql.includes("organization_repository_rule_versions")
            ? [{ revision: 3, config: { entries: [] }, digest: "d" }]
            : [],
        }),
      "PRECONDITION_FAILED",
    ],
    "invalid draft": [
      empty,
      "UNPROCESSABLE",
      input({ entries: [{ ruleKey: "nope" }] }),
    ],
    "bad cursor": [empty, "INVALID_CURSOR", input({ cursor: "garbage" })],
  };
  for (const [name, [query, expected, value]] of Object.entries(failures)) {
    assertEquals(await run(uuid(), uuid(), query, value), expected, name);
    assert(slotsAreFree(), `${name} left a slot held`);
  }
  assertEquals(await run(uuid(), uuid(), empty), "ok");
  assert(slotsAreFree(), "a successful scan left a slot held");
});

Deno.test("the handler admits by the caller's own organization and principal", async () => {
  const [orgA, orgB, orgC, orgD] = [1, 2, 3, 4].map(uuid);
  const [p1, p2, p3, p4] = [1, 2, 3, 4].map(uuid);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const hanging: Query = async (sql) => {
    if (sql === SCAN_SQL) await gate;
    return { rows: [] };
  };
  const held = run(orgA, p1, hanging);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Same organization, other person; same person, other organization.
  assertEquals(await run(orgA, p2, empty), "DEPENDENCY_UNAVAILABLE");
  assertEquals(await run(orgB, p1, empty), "DEPENDENCY_UNAVAILABLE");
  // Another organization and another person still scans.
  assertEquals(await run(orgB, p2, empty), "ok");
  let openSecond!: () => void;
  const gateSecond = new Promise<void>((resolve) => (openSecond = resolve));
  const heldSecond = run(orgC, p3, async (sql) => {
    if (sql === SCAN_SQL) await gateSecond;
    return { rows: [] };
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Two scans hold the process: a third, unrelated one is refused.
  assertEquals(await run(orgD, p4, empty), "DEPENDENCY_UNAVAILABLE");
  open();
  openSecond();
  assertEquals(await held, "ok");
  assertEquals(await heldSecond, "ok");
  assert(slotsAreFree());
  // Refused callers were not left counted.
  assertEquals(await run(orgB, p1, empty), "ok");
});
