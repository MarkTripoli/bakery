import { assertEquals } from "@std/assert";
import {
  folderAccess,
  type FolderGrant,
  type FolderNode,
  grantRefusal,
  mayEdit,
  mayManage,
  mayView,
} from "../../apps/server/src/modules/knowledge/folder-access.ts";

// #449 (chapter 25 section 17.3): grants inherit downward and a restricted
// folder stops inheritance; personal and record areas are not grantable.

const node = (
  id: string,
  extra: Partial<FolderNode> = {},
): FolderNode => ({
  id,
  policy: "working",
  systemKey: null,
  restricted: false,
  ...extra,
});
const grant = (
  folderId: string,
  principalId: string,
  level: FolderGrant["level"],
): FolderGrant => ({ folderId, principalId, level });

const alice = "alice";
const bob = "bob";

Deno.test("an unrestricted folder is open and no grant changes that", () => {
  const chain = [node("shared"), node("a")];
  const access = folderAccess(
    chain,
    [grant("shared", alice, "view")],
    bob,
    false,
  );
  assertEquals(access, { restricted: false, level: null });
  assertEquals(mayView(access), true);
  assertEquals(mayEdit(access), true);
});

Deno.test("a restricted folder hides from a principal with no grant inside it", () => {
  const chain = [
    node("shared"),
    node("secret", { restricted: true }),
    node("b"),
  ];
  const access = folderAccess(
    chain,
    [grant("shared", bob, "manage")],
    bob,
    false,
  );
  assertEquals(access, { restricted: true, level: null });
  assertEquals(mayView(access), false);
  assertEquals(mayEdit(access), false);
});

Deno.test("a grant on the restricted folder inherits down to its children", () => {
  const chain = [
    node("shared"),
    node("secret", { restricted: true }),
    node("b"),
  ];
  const access = folderAccess(
    chain,
    [grant("secret", alice, "view")],
    alice,
    false,
  );
  assertEquals(access.level, "view");
  assertEquals(mayView(access), true);
  assertEquals(mayEdit(access), false);
});

Deno.test("the highest level inside the restriction wins", () => {
  const chain = [node("secret", { restricted: true }), node("b")];
  const access = folderAccess(
    chain,
    [grant("secret", alice, "view"), grant("b", alice, "edit")],
    alice,
    false,
  );
  assertEquals(access.level, "edit");
  assertEquals(mayEdit(access), true);
  assertEquals(mayManage(access, true), false);
});

Deno.test("a grant above the nearest restriction does not reach below it", () => {
  const chain = [
    node("shared"),
    node("outer", { restricted: true }),
    node("inner", { restricted: true }),
    node("leaf"),
  ];
  const access = folderAccess(
    chain,
    [grant("outer", alice, "manage")],
    alice,
    false,
  );
  assertEquals(access, { restricted: true, level: null });
});

Deno.test("a grant on a sibling does not reach a restricted folder", () => {
  const chain = [node("shared"), node("secret", { restricted: true })];
  const access = folderAccess(
    chain,
    [grant("other", alice, "manage")],
    alice,
    false,
  );
  assertEquals(access.level, null);
});

Deno.test("an Admin holds manage on a restricted folder", () => {
  const chain = [node("secret", { restricted: true })];
  const access = folderAccess(chain, [], "root", true);
  assertEquals(access.level, "manage");
  assertEquals(mayManage(access, false), true);
});

Deno.test("managing a restricted folder needs a manage grant, an open one needs the area's write", () => {
  const open = folderAccess([node("a")], [], alice, false);
  assertEquals(mayManage(open, true), true);
  assertEquals(mayManage(open, false), false);
  const closed = [node("a", { restricted: true })];
  assertEquals(
    mayManage(
      folderAccess(closed, [grant("a", alice, "edit")], alice, false),
      true,
    ),
    false,
  );
  assertEquals(
    mayManage(
      folderAccess(closed, [grant("a", alice, "manage")], alice, false),
      false,
    ),
    true,
  );
});

Deno.test("only working areas are grantable, and not the artifacts or connections areas", () => {
  assertEquals(grantRefusal([node("shared")]), undefined);
  assertEquals(
    grantRefusal([node("p", { policy: "record" })]),
    "not_a_working_area",
  );
  assertEquals(
    grantRefusal([node("u", { policy: "personal" })]),
    "not_a_working_area",
  );
  assertEquals(
    grantRefusal([
      node("t", { policy: "record", systemKey: "task:1" }),
      node("attachments", { systemKey: "task:1:attachments" }),
    ]),
    "artifact_area",
  );
  assertEquals(
    grantRefusal([
      node("c", { systemKey: "connections" }),
      node("x"),
    ]),
    "connections_area",
  );
  assertEquals(
    grantRefusal([
      node("pr", { policy: "record", systemKey: "project:1" }),
      node("assets", { systemKey: "project:1:assets" }),
    ]),
    undefined,
  );
});
