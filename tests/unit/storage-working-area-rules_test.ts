import { assert, assertEquals } from "@std/assert";
import {
  admitsWrite,
  changeRefusal,
  DEFAULT_STORAGE_LIMITS,
  invalidLimit,
  isVisibleTo,
  quotaState,
  revisionsToPrune,
  scopeKeyFromAncestors,
  scratchExpired,
  trashExpired,
  writeRefusal,
} from "../../apps/server/src/modules/knowledge/storage-areas.ts";

// #447: the folder policy rules the working-area store applies.

const me = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const folder = (
  policy: Parameters<typeof writeRefusal>[0]["policy"],
  extra: { ownerId?: string | null; systemKey?: string | null } = {},
) => ({
  policy,
  ownerId: extra.ownerId ?? null,
  systemKey: extra.systemKey ?? null,
});

Deno.test("writes land only in working, own personal and own scratch folders", () => {
  assertEquals(writeRefusal(folder("working"), me), undefined);
  assertEquals(
    writeRefusal(folder("personal", { ownerId: me }), me),
    undefined,
  );
  assertEquals(writeRefusal(folder("scratch", { ownerId: me }), me), undefined);
  assertEquals(writeRefusal(folder("record"), me), "record_area");
  assertEquals(writeRefusal(folder("library"), me), "library_area");
  assertEquals(writeRefusal(folder("system"), me), "system_area");
  assertEquals(
    writeRefusal(folder("system", { systemKey: "trash" }), me),
    "trash_area",
  );
  assertEquals(
    writeRefusal(folder("personal", { ownerId: other }), me),
    "system_area",
  );
  // /users itself has no owner and takes no files.
  assertEquals(writeRefusal(folder("personal"), me), "system_area");
  assertEquals(
    writeRefusal(folder("working", { systemKey: "connections" }), me),
    "system_area",
  );
});

Deno.test("rm and mv are refused in record areas and on folders Bakery made", () => {
  assertEquals(changeRefusal(folder("record")), "record_area");
  assertEquals(changeRefusal(folder("library")), "library_area");
  assertEquals(changeRefusal(folder("system")), "system_area");
  assertEquals(
    changeRefusal(folder("working", { systemKey: "shared" })),
    "system_folder",
  );
  assertEquals(changeRefusal(folder("working")), undefined);
  assertEquals(changeRefusal(folder("scratch", { ownerId: me })), undefined);
});

Deno.test("a personal entry is visible to its owner only", () => {
  assert(isVisibleTo(folder("personal", { ownerId: me }), me));
  assert(!isVisibleTo(folder("personal", { ownerId: other }), me));
  assert(!isVisibleTo(folder("scratch", { ownerId: other }), me));
  assert(isVisibleTo(folder("working"), me));
});

Deno.test("working areas keep the newest N versions; scratch keeps the latest", () => {
  const revisions = [1, 2, 3, 4, 5];
  assertEquals(revisionsToPrune("working", revisions, 3), [1, 2]);
  assertEquals(revisionsToPrune("working", revisions, 20), []);
  assertEquals(revisionsToPrune("scratch", revisions, 20), [1, 2, 3, 4]);
});

Deno.test("trash and scratch expire after their retention, not before", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-11-19T00:00:00Z");
  const at = (days: number) => new Date(now.getTime() - days * day);
  assert(!trashExpired(at(29), now, DEFAULT_STORAGE_LIMITS));
  assert(trashExpired(at(30), now, DEFAULT_STORAGE_LIMITS));
  assert(!scratchExpired(at(29), now, DEFAULT_STORAGE_LIMITS));
  assert(scratchExpired(at(31), now, { scratchRetentionDays: 31 }));
});

Deno.test("quota warns at 75% and pauses new writes at 90%", () => {
  assertEquals(quotaState(74, 100), "ok");
  assertEquals(quotaState(75, 100), "warning");
  assertEquals(quotaState(90, 100), "paused");
  assert(admitsWrite(80, 9, 100));
  assert(!admitsWrite(80, 10, 100));
  // A write that adds nothing is always admitted, even when paused.
  assert(admitsWrite(95, 0, 100));
});

Deno.test("defaults are the O42 values and limits outside bounds are refused", () => {
  assertEquals(DEFAULT_STORAGE_LIMITS.workingVersionsKept, 20);
  assertEquals(DEFAULT_STORAGE_LIMITS.trashRetentionDays, 30);
  assertEquals(DEFAULT_STORAGE_LIMITS.scratchRetentionDays, 30);
  assertEquals(DEFAULT_STORAGE_LIMITS.maxFileBytes, 5 * 1024 ** 3);
  assertEquals(invalidLimit(DEFAULT_STORAGE_LIMITS), undefined);
  assertEquals(
    invalidLimit({ ...DEFAULT_STORAGE_LIMITS, workingVersionsKept: 0 }),
    "workingVersionsKept",
  );
  assertEquals(
    invalidLimit({ ...DEFAULT_STORAGE_LIMITS, maxFileBytes: 6 * 1024 ** 3 }),
    "maxFileBytes",
  );
});

Deno.test("a file counts against the nearest project or personal folder", () => {
  const project = "11111111-1111-4111-8111-111111111111";
  assertEquals(
    scopeKeyFromAncestors([null, "project:" + project + ":assets", "projects"]),
    "project:" + project,
  );
  assertEquals(
    scopeKeyFromAncestors(["user:" + me + ":scratch"]),
    "user:" + me,
  );
  assertEquals(scopeKeyFromAncestors(["shared"]), null);
});
