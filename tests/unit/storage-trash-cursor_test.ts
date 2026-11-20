import { assertEquals } from "@std/assert";
import {
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";

// The trash list pages by deletion time; a second page needs its ordering to
// be one the cursor binding accepts.
Deno.test("the trash list's cursor round-trips", async () => {
  const binding = {
    action: "storageTrash.list",
    principalId: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    ordering: "trashedAt:desc,id:desc",
    filters: "{}",
    schemaVersion: 1,
  };
  const position = {
    createdAt: "2026-11-19T19:00:00.000000Z",
    id: "00000000-0000-4000-8000-000000000003",
  };
  const cursor = await encodeCursor("secret", binding, position);
  const decoded = await decodeCursor("secret", cursor, binding);
  assertEquals([decoded?.createdAt, decoded?.id], [
    position.createdAt,
    position.id,
  ]);
});
