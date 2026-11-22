import { assert, assertEquals, assertThrows } from "@std/assert";
import { authorize } from "../../apps/server/src/modules/auth/application/authorize.ts";
import {
  OrganizationRole,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";

/**
 * A document grant lets a person whose role holds none of it read and comment on
 * one document, and at level edit work its draft; it never reaches the task,
 * agents or resharing. The grant is set by the caller for one document only.
 */
const member = {
  subject: { principalType: PrincipalType.Human },
  // A guest with a custom role that holds nothing on documents.
  role: OrganizationRole.Guest,
  customRole: { id: "chat-only", key: "chat-only", permissions: [] },
  capabilities: [],
} as const;

Deno.test("a document grant permits exactly what its level names", () => {
  const readComment = {
    ...member,
    artifactGrant: { artifactId: crypto.randomUUID(), level: "read_comment" },
  } as const;
  const editor = {
    ...member,
    artifactGrant: { artifactId: crypto.randomUUID(), level: "edit" },
  } as const;
  for (
    const permission of [
      "artifactComment:write",
      "artifactVersion:read",
    ] as const
  ) {
    authorize(readComment, permission);
    authorize(editor, permission);
  }
  for (
    const permission of [
      "draft:read",
      "draft:write",
      "artifactVersion:write",
    ] as const
  ) {
    assertThrows(() => authorize(readComment, permission));
    authorize(editor, permission);
  }
  for (
    const permission of [
      "task:write",
      "conversation:share",
      "artifact:share",
    ] as const
  ) {
    assertThrows(() => authorize(editor, permission));
  }
});

Deno.test("a document grant never helps someone with no role", () => {
  const grant = { artifactId: crypto.randomUUID(), level: "edit" } as const;
  const noRole = {
    subject: { principalType: PrincipalType.Human },
    capabilities: [],
    artifactGrant: grant,
  } as const;
  assertThrows(() => authorize(noRole, "draft:read"));
  const viewerWithoutGrant = { ...member };
  assertEquals(
    (() => {
      try {
        authorize(viewerWithoutGrant, "draft:write");
        return "allowed";
      } catch {
        return "refused";
      }
    })(),
    "refused",
  );
  assert(true);
});
