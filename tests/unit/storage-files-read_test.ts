import { assertEquals, assertThrows } from "@std/assert";
import {
  attachmentDisposition,
  folderOrderRank,
  parseRevision,
  versionMaker,
  visibleRootKeys,
} from "../../apps/server/src/modules/knowledge/storage-reads.ts";
import {
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";

const me = "00000000-0000-4000-8000-000000000001";

Deno.test("the top of the tree: own folder instead of /users, connections and system only when due", () => {
  assertEquals(
    visibleRootKeys({ principalId: me, isAdmin: false, hasConnections: false }),
    ["projects", "shared", "user:" + me, "library", "trash"],
  );
  assertEquals(
    visibleRootKeys({ principalId: me, isAdmin: true, hasConnections: true }),
    [
      "projects",
      "shared",
      "user:" + me,
      "library",
      "connections",
      "trash",
      "system",
    ],
  );
  for (const isAdmin of [true, false]) {
    for (const hasConnections of [true, false]) {
      const keys = visibleRootKeys({
        principalId: me,
        isAdmin,
        hasConnections,
      });
      assertEquals(keys.includes("users"), false, "never /users itself");
    }
  }
});

Deno.test("folders sort before files", () => {
  assertEquals(folderOrderRank("folder") < folderOrderRank("file"), true);
});

Deno.test("a download names the file and never breaks the header", () => {
  assertEquals(
    attachmentDisposition("plan.md"),
    "attachment; filename=\"plan.md\"; filename*=UTF-8''plan.md",
  );
  const odd = attachmentDisposition('a"b;c%d é.mp4');
  assertEquals(
    odd,
    "attachment; filename=\"a_b_c_d _.mp4\"; filename*=UTF-8''" +
      encodeURIComponent('a"b;c%d é.mp4'),
  );
  // Constructing the header proves no forbidden character got through.
  new Headers({ "Content-Disposition": odd });
});

Deno.test("revision is a positive integer or absent", () => {
  assertEquals(parseRevision(undefined), null);
  assertEquals(parseRevision(""), null);
  assertEquals(parseRevision("3"), 3);
  for (const bad of ["0", "-1", "1.5", "01", "x", "9999999999"]) {
    assertThrows(() => parseRevision(bad));
  }
});

Deno.test("a version made by a step names the step, run, work item and the session and attempt it recorded", () => {
  const base = {
    id: "v",
    revision: 1,
    created_at: new Date(),
    size_bytes: "1",
    media_type: "text/plain",
    sha256: "a".repeat(64),
    removed_at: null,
    content_removed: false,
    author_id: me,
    author_name: "Ada",
  };
  const byStep = versionMaker({
    ...base,
    run_step_id: "s",
    step_key: "draft",
    run_id: "r",
    task_id: "t",
    task_title: "Write the plan",
    session_id: "x",
    attempt_id: "a",
    agent_name: "Planner",
    acting_for_id: "p",
    acting_for_name: "Grace",
    agent_write: false,
  });
  assertEquals(byStep, {
    makerKind: "step",
    makerPrincipalId: me,
    makerName: "Ada",
    stepId: "s",
    stepName: "draft",
    runId: "r",
    workItemId: "t",
    workItemTitle: "Write the plan",
    sessionId: "x",
    attemptId: "a",
    agentName: "Planner",
    actingForPrincipalId: "p",
    actingForName: "Grace",
  });
  const byPerson = versionMaker({
    ...base,
    run_step_id: null,
    step_key: null,
    run_id: null,
    task_id: null,
    task_title: null,
    session_id: null,
    attempt_id: null,
    agent_name: null,
    acting_for_id: null,
    acting_for_name: null,
    agent_write: false,
  });
  assertEquals(byPerson.makerKind, "person");
  assertEquals(byPerson.stepId, null);
  assertEquals(byPerson.attemptId, null);
  assertEquals(byPerson.actingForPrincipalId, null);
});

Deno.test("a version an agent wrote with a person's access reads as the agent's, naming that person and its step", () => {
  const byAgent = versionMaker({
    id: "v",
    revision: 3,
    created_at: new Date(),
    size_bytes: "1",
    media_type: "text/plain",
    sha256: "a".repeat(64),
    removed_at: null,
    content_removed: false,
    author_id: me,
    author_name: "Ada",
    // An agent's write now records its step too; it still reads as the
    // agent's, never the step's or the person's.
    run_step_id: "s",
    step_key: "review",
    run_id: "r",
    task_id: "t",
    task_title: "Write the plan",
    session_id: "session",
    attempt_id: "attempt",
    agent_name: "Reviewer",
    acting_for_id: me,
    acting_for_name: "Ada",
    agent_write: true,
  });
  assertEquals(byAgent, {
    makerKind: "agent",
    makerPrincipalId: me,
    makerName: "Ada",
    stepId: "s",
    stepName: "review",
    runId: "r",
    workItemId: "t",
    workItemTitle: "Write the plan",
    sessionId: "session",
    attemptId: "attempt",
    agentName: "Reviewer",
    actingForPrincipalId: me,
    actingForName: "Ada",
  });
});

Deno.test("every storage list ordering is one the cursor accepts", async () => {
  const id = "00000000-0000-4000-8000-0000000000aa";
  const cases = [
    ["storageFolderEntries.list", "kind:asc,nameKey:asc,id:asc", {
      position: 1,
      iteration: 0,
      id,
    }],
    ["storageFileVersions.list", "revision:desc,id:desc", {
      position: 3,
      iteration: 0,
      id,
    }],
    ["storageFileUses.list", "createdAt:desc,id:desc", {
      createdAt: "2026-11-19T10:00:00.000000Z",
      id,
    }],
    ["storageTrash.list", "trashedAt:desc,id:desc", {
      createdAt: "2026-11-19T10:00:00.000000Z",
      id,
    }],
  ] as const;
  for (const [action, ordering, position] of cases) {
    const binding = {
      action,
      principalId: me,
      organizationId: me,
      ordering,
      filters: "{}",
      schemaVersion: 1,
    };
    assertEquals(await decodeCursor("secret", undefined, binding), null);
    const cursor = await encodeCursor("secret", binding, position);
    assertEquals(
      (await decodeCursor("secret", cursor, binding))?.id,
      id,
      action,
    );
  }
});
