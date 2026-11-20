/**
 * #448 slice 1: an agent's file writes and the five layers that bound them
 * (chapter 25 section 17.6, O39, O44, O45, O50 to O52).
 *
 * Each layer has a test that calls it alone, and a test that drives the real
 * guard (assertAgentFileWrite) with every other layer satisfied and only that
 * one failing. The second kind is the mutant check: delete the layer's line in
 * the guard and its test stops refusing, so the write would pass.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  AGENT_FILE_REFUSALS,
  agentAreaRefusal,
  type AgentFileGrant,
  AgentFileRefusal,
  AgentPathRefusal,
  agentPathRefusal,
  FILES_WRITE_SCOPE,
  grantRefusal,
  pathSpellingRefusal,
  principalAuthorityRefusal,
  storageAuditActor,
  storageScopeRefusal,
} from "../../apps/server/src/modules/knowledge/agent-file-scope.ts";
import {
  type AgentFileTarget,
  assertAgentFileWrite,
  refuseAgentPath,
} from "../../apps/server/src/modules/knowledge/agent-file-guard.ts";
import { parseStoragePath } from "../../apps/server/src/modules/knowledge/storage-tree.ts";
import {
  assertSessionToolAllowed,
  sessionOperationScopes,
} from "../../apps/server/src/modules/execution/session-tools.ts";
import { readScopesForSession } from "../../apps/server/src/modules/execution/session-claim-credential.ts";
import { DRAFT_EDIT_REFUSAL_REASONS } from "../../packages/contracts/src/http.ts";

const ORG = "0195f000-0000-7000-8000-0000000000a1";
const OTHER_ORG = "0195f000-0000-7000-8000-0000000000a2";
const WORKFLOW = "0195f000-0000-7000-8000-0000000000b1";
const OTHER_WORKFLOW = "0195f000-0000-7000-8000-0000000000b2";
const PERSON = "0195f000-0000-7000-8000-0000000000c1";
const OTHER_MEMBER = "0195f000-0000-7000-8000-0000000000c2";
const ADMIN = "0195f000-0000-7000-8000-0000000000c3";
const SHARED = "0195f000-0000-7000-8000-0000000000d1";
const BRIEFS = "0195f000-0000-7000-8000-0000000000d2";
const SIBLING = "0195f000-0000-7000-8000-0000000000d3";
const ATTEMPT = "0195f000-0000-7000-8000-0000000000e1";
const SESSION = "0195f000-0000-7000-8000-0000000000e2";

const T0 = new Date("2026-11-19T12:00:00Z");
const T1 = new Date("2026-11-19T12:10:00Z");

function grant(overrides: Partial<AgentFileGrant> = {}): AgentFileGrant {
  return {
    id: "0195f000-0000-7000-8000-0000000000f1",
    organizationId: ORG,
    workflowId: WORKFLOW,
    folderId: SHARED,
    access: "write",
    grantedById: ADMIN,
    expiresAt: new Date("2026-11-19T12:05:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

const writeScope = {
  organizationId: ORG,
  workflowId: WORKFLOW,
  access: "write" as const,
  folderChain: [SHARED, BRIEFS],
  now: T0,
};

const working = { policy: "working" as const, ownerId: null, systemKey: null };

// ---------------------------------------------------------------- layer 1

Deno.test("layer 1: the contract bounds the path before any handler runs", () => {
  const body = (path: string) => ({
    path,
    mediaType: "text/plain",
    content: btoa("x"),
  });
  assert(
    contractSchemas.StorageFilePut.safeParse(body("/shared/a.md")).success,
  );
  // Too long and too short are refused by the schema alone: no guard, no tree.
  assert(
    !contractSchemas.StorageFilePut.safeParse(body("/" + "a".repeat(4096)))
      .success,
  );
  assert(!contractSchemas.StorageFilePut.safeParse(body("/")).success);
  assert(!contractSchemas.StorageFilePut.safeParse({ path: "/x" }).success);
  // The grant contract bounds access and needs an expiry: no grant without one.
  assert(
    !contractSchemas.AgentFileGrantCreate.safeParse({
      workflowId: WORKFLOW,
      folderId: SHARED,
      access: "admin",
      expiresAt: T1.toISOString(),
    }).success,
  );
  assert(
    !contractSchemas.AgentFileGrantCreate.safeParse({
      workflowId: WORKFLOW,
      folderId: SHARED,
      access: "write",
    }).success,
  );
});

// ---------------------------------------------------------------- layer 3

const PATH_CASES: [string, AgentPathRefusal][] = [
  ["shared/a.md", AgentPathRefusal.NotAbsolute],
  ["/shared/a\u0000.md", AgentPathRefusal.ControlCharacter],
  ["/shared\\..\\users/a.md", AgentPathRefusal.Backslash],
  ["/shared/%2e%2e/users/a.md", AgentPathRefusal.Encoded],
  ["/shared/%252e%252e/users/a.md", AgentPathRefusal.Encoded],
  ["/shared\u2215users/a.md", AgentPathRefusal.LookalikeSeparator],
  ["/\uff55sers/me/a.md", AgentPathRefusal.NotNormalized],
  ["/shared/cafe\u0301.md", AgentPathRefusal.NotNormalized],
  ["/shared/ briefs/a.md", AgentPathRefusal.NotNormalized],
  ["/shared/briefs/", AgentPathRefusal.TrailingSlash],
  ["/shared//a.md", AgentPathRefusal.EmptySegment],
  ["/shared/../users/a.md", AgentPathRefusal.Traversal],
  ["/shared/./a.md", AgentPathRefusal.Traversal],
  ["/shared/~admin/a.md", AgentPathRefusal.SymlinkLike],
  ["/shared/link->users/a.md", AgentPathRefusal.SymlinkLike],
  ["/shared/users.lnk/a.md", AgentPathRefusal.SymlinkLike],
];

Deno.test("layer 3: every path trick is a named refusal, and a plain path passes", () => {
  assertEquals(agentPathRefusal("/shared/briefs/plan.md"), undefined);
  for (const [path, reason] of PATH_CASES) {
    assertEquals(agentPathRefusal(path), reason, path);
  }
});

Deno.test("layer 3 is not the tree's parser: the parser quietly accepts what the agent path refuses", () => {
  // Without layer 3 these would reach resolution and land somewhere: the
  // parser trims, normalizes and treats escapes as plain names.
  for (
    const path of [
      "/shared/ briefs/a.md",
      "/shared/cafe\u0301.md",
      "/shared/%2e%2e/a.md",
      "/shared/~admin/a.md",
    ]
  ) {
    parseStoragePath(path);
    assert(agentPathRefusal(path) !== undefined, path);
  }
});

Deno.test("layer 3: a case variant resolves for a person and is refused for an agent", () => {
  assertEquals(
    pathSpellingRefusal(["shared", "briefs"], ["shared", "briefs"]),
    undefined,
  );
  assertEquals(
    pathSpellingRefusal(["Shared", "briefs"], ["shared", "briefs"]),
    AgentPathRefusal.SpellingMismatch,
  );
  assertEquals(
    pathSpellingRefusal(["TRASH"], ["trash"]),
    AgentPathRefusal.SpellingMismatch,
  );
  assertEquals(
    pathSpellingRefusal(["shared"], ["shared", "briefs"]),
    AgentPathRefusal.SpellingMismatch,
  );
});

Deno.test("layer 3 at the handler: a session call's path is refused before parsing, a person's is not", () => {
  const agent = { agentSession: { attemptId: ATTEMPT } };
  let refused: unknown;
  try {
    refuseAgentPath(agent, "/shared/../users/a.md");
  } catch (error) {
    refused = error;
  }
  assert(refused instanceof StandardError);
  assertEquals(refused.code, "UNPROCESSABLE");
  // A person's request is left to the tree's own parser.
  refuseAgentPath({}, "/shared/../users/a.md");
});

// ---------------------------------------------------------------- layer 2

Deno.test("layer 2: a live write grant on the folder or an ancestor covers the write", () => {
  assertEquals(grantRefusal([grant()], writeScope).grant?.id, grant().id);
  assertEquals(
    grantRefusal([grant({ folderId: BRIEFS })], writeScope).refusal,
    undefined,
  );
});

Deno.test("layer 2: missing, other workflow, other organization and sibling folder are not covered", () => {
  assertEquals(
    grantRefusal([], writeScope).refusal,
    AgentFileRefusal.GrantMissing,
  );
  for (
    const other of [
      grant({ workflowId: OTHER_WORKFLOW }),
      grant({ organizationId: OTHER_ORG }),
      grant({ folderId: SIBLING }),
    ]
  ) {
    assertEquals(
      grantRefusal([other], writeScope).refusal,
      AgentFileRefusal.GrantMissing,
    );
  }
});

Deno.test("layer 2: a read grant never permits a write or a destructive verb", () => {
  // put, mkdir, cp, mv and rm all ask for write access.
  assertEquals(
    grantRefusal([grant({ access: "read" })], writeScope).refusal,
    AgentFileRefusal.GrantReadOnly,
  );
  assertEquals(
    grantRefusal([grant({ access: "read" })], { ...writeScope, access: "read" })
      .refusal,
    undefined,
  );
});

Deno.test("layer 2: a grant that expires mid-operation stops the very next write", () => {
  const grants = [grant()];
  // Valid when the step was admitted and for its first write...
  assertEquals(grantRefusal(grants, writeScope).refusal, undefined);
  // ...and refused for the write after the expiry, with nothing held over.
  assertEquals(
    grantRefusal(grants, { ...writeScope, now: T1 }).refusal,
    AgentFileRefusal.GrantExpired,
  );
});

Deno.test("layer 2: a revoked grant says withdrawn, distinct from never allowed", () => {
  assertEquals(
    grantRefusal([grant({ revokedAt: T0 })], writeScope).refusal,
    AgentFileRefusal.GrantRevoked,
  );
  // Revoked write, live read: still "withdrawn", not "read only".
  assertEquals(
    grantRefusal([
      grant({ revokedAt: T0 }),
      grant({ id: "0195f000-0000-7000-8000-0000000000f2", access: "read" }),
    ], writeScope).refusal,
    AgentFileRefusal.GrantRevoked,
  );
});

Deno.test("layer 2, area axis: library, record, connections, trash and system are never reachable", () => {
  assertEquals(agentAreaRefusal(working, ADMIN), undefined);
  assertEquals(
    agentAreaRefusal(
      { policy: "library", ownerId: null, systemKey: "library" },
      ADMIN,
    ),
    AgentFileRefusal.LibraryArea,
  );
  assertEquals(
    agentAreaRefusal(
      { policy: "record", ownerId: null, systemKey: null },
      ADMIN,
    ),
    AgentFileRefusal.RecordArea,
  );
  assertEquals(
    agentAreaRefusal(
      { policy: "system", ownerId: null, systemKey: "trash" },
      ADMIN,
    ),
    AgentFileRefusal.TrashArea,
  );
  assertEquals(
    agentAreaRefusal(
      { policy: "system", ownerId: null, systemKey: "system" },
      ADMIN,
    ),
    AgentFileRefusal.SystemArea,
  );
  assertEquals(
    agentAreaRefusal({
      policy: "working",
      ownerId: null,
      systemKey: "connections",
    }, ADMIN),
    AgentFileRefusal.SystemArea,
  );
});

Deno.test("layer 2, area axis: /users/<member> is closed, the starter's own included, unless its owner granted it", () => {
  const own = { policy: "personal" as const, ownerId: PERSON, systemKey: null };
  const scratch = {
    policy: "scratch" as const,
    ownerId: PERSON,
    systemKey: null,
  };
  // The starter's own folder, granted by an Admin: closed.
  assertEquals(agentAreaRefusal(own, ADMIN), AgentFileRefusal.PersonalArea);
  assertEquals(agentAreaRefusal(scratch, ADMIN), AgentFileRefusal.PersonalArea);
  // Only the owner's own grant opens it.
  assertEquals(agentAreaRefusal(own, PERSON), undefined);
});

// ---------------------------------------------------------------- layer 4

Deno.test("layer 4: a grant adds scope, never authority", () => {
  assertEquals(principalAuthorityRefusal(working, PERSON), undefined);
  const theirs = {
    policy: "personal" as const,
    ownerId: OTHER_MEMBER,
    systemKey: null,
  };
  // The other member granted their own folder, so layer 2 passes...
  assertEquals(agentAreaRefusal(theirs, OTHER_MEMBER), undefined);
  // ...and the person the agent acts for still cannot read or write it.
  assertEquals(
    principalAuthorityRefusal(theirs, PERSON),
    AgentFileRefusal.PrincipalCannotRead,
  );
  assertEquals(
    principalAuthorityRefusal({
      policy: "library",
      ownerId: null,
      systemKey: "library",
    }, PERSON),
    AgentFileRefusal.PrincipalCannotWrite,
  );
});

// ---------------------------------------------------------------- layer 5

Deno.test("layer 5: a row from another organization means not found", () => {
  assertEquals(storageScopeRefusal(ORG, [{ organizationId: ORG }]), undefined);
  assertEquals(
    storageScopeRefusal(ORG, [{ organizationId: ORG }, {
      organizationId: OTHER_ORG,
    }]),
    "not_found",
  );
  assertEquals(storageScopeRefusal(ORG, []), "not_found");
});

// ------------------------------------------- the real guard, one layer at a time

type Chain = { id: string; name: string; organization_id: string }[];
type GrantRows = {
  id: string;
  organization_id: string;
  workflow_id: string;
  folder_id: string;
  access: "read" | "write";
  granted_by: string;
  expires_at: Date;
  revoked_at: Date | null;
}[];

const goodChain: Chain = [
  { id: SHARED, name: "shared", organization_id: ORG },
  { id: BRIEFS, name: "briefs", organization_id: ORG },
];

function grantRow(
  overrides: Partial<GrantRows[number]> = {},
): GrantRows[number] {
  return {
    id: "0195f000-0000-7000-8000-0000000000f1",
    organization_id: ORG,
    workflow_id: WORKFLOW,
    folder_id: SHARED,
    access: "write",
    granted_by: ADMIN,
    expires_at: new Date("2026-11-19T12:05:00Z"),
    revoked_at: null,
    ...overrides,
  };
}

/** A transaction that answers the guard's two reads from fixed rows. */
function fakeTx(chain: Chain, grants: GrantRows) {
  return {
    query: <R>(sql: string, _params?: unknown[]) =>
      Promise.resolve({
        rows: (sql.includes("with recursive up")
          ? chain
          : sql.includes("agent_file_grants")
          ? grants
          : []) as R[],
        rowCount: 0,
      }),
  } as unknown as Parameters<typeof assertAgentFileWrite>[0];
}

const briefsFolder: AgentFileTarget = {
  id: BRIEFS,
  policy: "working",
  owner_id: null,
  system_key: null,
};

function scope(
  overrides: Partial<Parameters<typeof assertAgentFileWrite>[1]> = {},
) {
  return {
    organizationId: ORG,
    principalId: PERSON,
    workflowId: WORKFLOW,
    attemptId: ATTEMPT,
    agentSessionId: SESSION,
    target: briefsFolder,
    rawPath: "/shared/briefs/plan.md",
    access: "write" as const,
    now: T0,
    ...overrides,
  };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise) as StandardError;
  assert(error instanceof StandardError);
  const params = error.params as
    | { reason?: string; issues?: { code: string }[] }
    | undefined;
  return params?.reason ?? params?.issues?.[0]?.code ?? error.code;
}

Deno.test("the guard allows a write when every layer holds, and names the grant and session for the audit", async () => {
  const allowed = await assertAgentFileWrite(
    fakeTx(goodChain, [grantRow()]),
    scope(),
  );
  assertEquals(allowed, {
    attemptId: ATTEMPT,
    agentSessionId: SESSION,
    fileGrantId: grantRow().id,
  });
});

Deno.test("the guard: each inner layer refuses on its own while the others hold", async () => {
  // Layer 3, lexical.
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow()]),
      scope({ rawPath: "/shared/briefs/../plan.md" }),
    )),
    AgentPathRefusal.Traversal,
  );
  // Layer 3, resolved: a case variant of a folder that exists.
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow()]),
      scope({ rawPath: "/Shared/briefs/plan.md" }),
    )),
    AgentPathRefusal.SpellingMismatch,
  );
  // Layer 5: a chain row from another organization is not found.
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(
        [goodChain[0], { ...goodChain[1], organization_id: OTHER_ORG }],
        [grantRow()],
      ),
      scope(),
    )),
    "RESOURCE_NOT_FOUND",
  );
  // Layer 2: expiry judged at the time of this write, not of admission.
  assertEquals(
    await reason(
      assertAgentFileWrite(fakeTx(goodChain, [grantRow()]), scope({ now: T1 })),
    ),
    AgentFileRefusal.GrantExpired,
  );
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow({ revoked_at: T0 })]),
      scope(),
    )),
    AgentFileRefusal.GrantRevoked,
  );
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow({ access: "read" })]),
      scope(),
    )),
    AgentFileRefusal.GrantReadOnly,
  );
  // Layer 2, area axis: the starter's own personal folder, granted by an Admin.
  const ownFolder: AgentFileTarget = {
    id: BRIEFS,
    policy: "personal",
    owner_id: PERSON,
    system_key: null,
  };
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow()]),
      scope({ target: ownFolder }),
    )),
    AgentFileRefusal.PersonalArea,
  );
  // Layer 4: another member granted their own folder; the person cannot write it.
  const theirFolder: AgentFileTarget = {
    id: BRIEFS,
    policy: "personal",
    owner_id: OTHER_MEMBER,
    system_key: null,
  };
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow({ granted_by: OTHER_MEMBER })]),
      scope({ target: theirFolder }),
    )),
    AgentFileRefusal.PrincipalCannotRead,
  );
});

Deno.test("the guard: an operation by entry id (mv source, rm) skips only the path checks", async () => {
  const { rawPath: _omit, ...byId } = scope();
  const allowed = await assertAgentFileWrite(
    fakeTx(goodChain, [grantRow()]),
    byId,
  );
  assertEquals(allowed.fileGrantId, grantRow().id);
  assertEquals(
    await reason(assertAgentFileWrite(
      fakeTx(goodChain, [grantRow({ access: "read" })]),
      byId,
    )),
    AgentFileRefusal.GrantReadOnly,
  );
});

// ---------------------------------------------------------------- audit

Deno.test("audit: a person's and an agent's write carry the same actor keys", () => {
  const person = storageAuditActor(
    { principalId: PERSON, actorKind: "person", accessTokenId: null },
    null,
  );
  const agent = storageAuditActor(
    { principalId: PERSON, actorKind: "agent", accessTokenId: null },
    { attemptId: ATTEMPT, agentSessionId: SESSION, fileGrantId: grantRow().id },
  );
  assertEquals(Object.keys(person).sort(), Object.keys(agent).sort());
  // The agent's names both identities: the person and the session.
  assertEquals([agent.kind, agent.principalId, agent.agentSessionId], [
    "agent",
    PERSON,
    SESSION,
  ]);
  assertEquals([person.kind, person.agentSessionId, person.fileGrantId], [
    "person",
    null,
    null,
  ]);
});

// ------------------------------------------------- the self-connection's offer

Deno.test("session: the storage writes are offered under files.write, which no session gets by default", () => {
  for (
    const name of [
      "storageFiles.put",
      "storageFolders.create",
      "storageEntries.copy",
      "storageEntries.move",
      "storageEntries.trash",
    ]
  ) {
    assertEquals(
      assertSessionToolAllowed([FILES_WRITE_SCOPE], name),
      FILES_WRITE_SCOPE,
    );
  }
  assert(!readScopesForSession().includes(FILES_WRITE_SCOPE));
});

Deno.test("session: secrets, consent, granting, restore and purge stay with people", () => {
  const offered = new Set(sessionOperationScopes());
  for (
    const name of [
      "secrets.list",
      "secrets.get",
      "secrets.create",
      "secrets.rotate",
      "secrets.revoke",
      "secrets.updatePolicy",
      "integrationAuthAttempts.create",
      "integrationAuth.authorizationCallback",
      "integrationAuth.setup",
      "agentFileGrants.create",
      "agentFileGrants.revoke",
      "agentPowerGrants.create",
      "storageEntries.restore",
      "storageEntries.purge",
      "storageSettings.put",
    ]
  ) assert(!offered.has(name), name);
});

Deno.test("every refusal an agent write can name reaches the client", () => {
  for (const refusal of AGENT_FILE_REFUSALS) {
    assert(DRAFT_EDIT_REFUSAL_REASONS.AUTH_FORBIDDEN.has(refusal), refusal);
  }
});
