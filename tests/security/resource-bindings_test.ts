import { assertEquals, assertNotEquals } from "@std/assert";
import {
  authRequest,
  call,
  type InstallationFixture,
  openInstallationFixture,
  signIn,
} from "../helpers/installation-settings.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { orgHeader } from "../helpers/account-settings.ts";
import {
  adminJson,
  bearerCall,
  createServiceAccount,
  type Json,
  mintToken,
} from "../helpers/access-tokens.ts";

type World = {
  appA: string;
  appB: string;
  repoA1: string;
  repoA2: string;
  repoB1: string;
  taskA1: string;
  taskA2: string;
  taskANoRepo: string;
  taskB1: string;
};

async function createApplication(f: InstallationFixture, slug: string) {
  const response = await adminJson(f, "POST", "/v1/applications", {
    slug,
    name: slug,
    description: "d",
  });
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

async function insertRepository(
  f: InstallationFixture,
  applicationId: string,
  name: string,
) {
  const id = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.repositories (
      id, organization_id, application_id, integration_connection_id,
      provider_repo_id, owner, name, default_branch
    ) values ($1, $2, $3, $4, $5, 'bind-owner', $6, 'main')`,
    [
      id,
      f.organizationId,
      applicationId,
      crypto.randomUUID(),
      `bind-${id}`,
      name,
    ],
  );
  const profileId = crypto.randomUUID();
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  await f.pgDatabase.query(
    `insert into bakery.repository_profiles (
      id, organization_id, application_id, repository_id, revision, config,
      digest, created_by
    ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
    [
      profileId,
      f.organizationId,
      applicationId,
      id,
      JSON.stringify(config),
      await sha256Hex(canonicalJson(config)),
      f.adminId,
    ],
  );
  await f.pgDatabase.query(
    `update bakery.repositories set active_profile_id = $3
      where organization_id = $1 and id = $2`,
    [f.organizationId, id, profileId],
  );
  return id;
}

async function createTask(
  f: InstallationFixture,
  applicationId: string,
  repositoryId: string | null,
  title: string,
) {
  const response = await adminJson(f, "POST", "/v1/tasks", {
    applicationId,
    ...(repositoryId === null ? {} : { repositoryId }),
    taskType: "feature",
    title,
  });
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

async function buildWorld(f: InstallationFixture): Promise<World> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const appA = await createApplication(f, `bind-a-${suffix}`);
  const appB = await createApplication(f, `bind-b-${suffix}`);
  const repoA1 = await insertRepository(f, appA, `a1-${suffix}`);
  const repoA2 = await insertRepository(f, appA, `a2-${suffix}`);
  const repoB1 = await insertRepository(f, appB, `b1-${suffix}`);
  return {
    appA,
    appB,
    repoA1,
    repoA2,
    repoB1,
    taskA1: await createTask(f, appA, repoA1, "task a1"),
    taskA2: await createTask(f, appA, repoA2, "task a2"),
    taskANoRepo: await createTask(f, appA, null, "task a, no repo"),
    taskB1: await createTask(f, appB, repoB1, "task b1"),
  };
}

async function setMemberRole(
  f: InstallationFixture,
  principalId: string,
  role: string | null,
) {
  const memberships = await adminJson(
    f,
    "GET",
    `/v1/organizations/${f.organizationId}/memberships`,
  );
  const items = (await memberships.json()).items as {
    id: string;
    principalId: string;
  }[];
  const membership = items.find((item) => item.principalId === principalId)!;
  const response = await adminJson(
    f,
    "PATCH",
    `/v1/organizations/${f.organizationId}/memberships/${membership.id}`,
    { role },
  );
  assertEquals(response.status, 200, await response.clone().text());
}

async function bind(
  f: InstallationFixture,
  principalId: string,
  roleKey: "viewer" | "developer",
  scopeType: "application" | "repository",
  scopeId: string,
) {
  const response = await adminJson(f, "POST", "/v1/access-bindings", {
    principalId,
    roleKey,
    scopeType,
    scopeId,
  });
  assertEquals(response.status, 201, await response.clone().text());
  return await response.json() as Json & { id: string; version: number };
}

async function unbind(
  f: InstallationFixture,
  binding: { id: string; version: number },
) {
  const response = await adminJson(
    f,
    "DELETE",
    `/v1/access-bindings/${binding.id}`,
    undefined,
    { "If-Match": `"v${binding.version}"` },
  );
  assertEquals(response.status, 204, await response.clone().text());
}

function asDeveloper(
  f: InstallationFixture,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return call(f, method, path, f.developerCookie, {
    body,
    headers: {
      ...orgHeader(f.organizationId),
      ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      ...headers,
    },
  });
}

/** Task updates take the task's current version as a strong precondition. */
const IF_MATCH_V1 = { "If-Match": '"v1"' };

async function ids(response: Response) {
  assertEquals(response.status, 200, await response.clone().text());
  return ((await response.json()).items as { id: string }[]).map((item) =>
    item.id
  ).sort();
}

/** A hidden resource must look exactly like one that does not exist. */
async function assertNotFoundLikeForeign(
  hidden: Response,
  missing: Response,
) {
  assertEquals(hidden.status, 404);
  assertEquals(missing.status, 404);
  const a = await hidden.json() as Json;
  const b = await missing.json() as Json;
  assertEquals(a.code, b.code);
  assertEquals(a.status, b.status);
}

Deno.test("a guest bound on a repository acts on that repository's tasks only", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    await setMemberRole(f, f.developerId!, "guest");
    const absent = crypto.randomUUID();

    // Unbound guest: nothing is visible; the organization still looks absent.
    const before = await asDeveloper(f, "GET", `/v1/tasks/${w.taskA1}`);
    await assertNotFoundLikeForeign(
      before,
      await asDeveloper(f, "GET", `/v1/tasks/${absent}`),
    );

    const binding = await bind(
      f,
      f.developerId!,
      "viewer",
      "repository",
      w.repoA1,
    );

    // Reads inside the binding work.
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskA1}`)).status,
      200,
    );
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/repositories/${w.repoA1}`)).status,
      200,
    );
    assertEquals(await ids(await asDeveloper(f, "GET", "/v1/tasks")), [
      w.taskA1,
    ]);
    assertEquals(await ids(await asDeveloper(f, "GET", "/v1/repositories")), [
      w.repoA1,
    ]);
    // A repository binding does not reveal its parent application or siblings.
    assertEquals(
      await ids(await asDeveloper(f, "GET", "/v1/applications")),
      [],
    );

    // Everything else is 404 exactly like a task that does not exist.
    for (
      const hidden of [w.taskA2, w.taskANoRepo, w.taskB1]
    ) {
      await assertNotFoundLikeForeign(
        await asDeveloper(f, "GET", `/v1/tasks/${hidden}`),
        await asDeveloper(f, "GET", `/v1/tasks/${absent}`),
      );
    }
    for (const hidden of [w.repoA2, w.repoB1]) {
      await assertNotFoundLikeForeign(
        await asDeveloper(f, "GET", `/v1/repositories/${hidden}`),
        await asDeveloper(f, "GET", `/v1/repositories/${absent}`),
      );
    }
    await assertNotFoundLikeForeign(
      await asDeveloper(f, "GET", `/v1/applications/${w.appA}`),
      await asDeveloper(f, "GET", `/v1/applications/${absent}`),
    );

    // Viewer rights: readable but the verb is missing -> 403, not 404.
    const write = await asDeveloper(f, "PATCH", `/v1/tasks/${w.taskA1}`, {
      title: "renamed",
    });
    assertEquals(write.status, 403, await write.clone().text());
    // A write on a hidden task is 404, not 403.
    assertEquals(
      (await asDeveloper(f, "PATCH", `/v1/tasks/${w.taskA2}`, { title: "x" }))
        .status,
      404,
    );

    // Binding effect is immediate: removed -> next request is 404 again.
    await unbind(f, binding);
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskA1}`)).status,
      404,
    );
    // The guest holds no organization-wide read, so the list is refused too.
    assertEquals((await asDeveloper(f, "GET", "/v1/tasks")).status, 404);
  } finally {
    await f.finish();
  }
});

Deno.test("a developer binding on an application covers its repositories, tasks and runs, and nothing else", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    await setMemberRole(f, f.developerId!, "guest");
    await bind(f, f.developerId!, "developer", "application", w.appA);

    assertEquals(
      await ids(await asDeveloper(f, "GET", "/v1/tasks")),
      [w.taskA1, w.taskA2, w.taskANoRepo].sort(),
    );
    assertEquals(
      await ids(await asDeveloper(f, "GET", "/v1/repositories")),
      [w.repoA1, w.repoA2].sort(),
    );
    assertEquals(await ids(await asDeveloper(f, "GET", "/v1/applications")), [
      w.appA,
    ]);
    const update = await asDeveloper(
      f,
      "PATCH",
      `/v1/tasks/${w.taskA2}`,
      { title: "renamed by binding" },
      IF_MATCH_V1,
    );
    assertEquals(update.status, 200, await update.clone().text());
    const created = await asDeveloper(f, "POST", "/v1/tasks", {
      applicationId: w.appA,
      repositoryId: w.repoA1,
      taskType: "bug",
      title: "filed by a bound developer",
    });
    assertEquals(created.status, 201, await created.clone().text());
    // Creating under another application is hidden, not forbidden-with-detail.
    const foreign = await asDeveloper(f, "POST", "/v1/tasks", {
      applicationId: w.appB,
      taskType: "bug",
      title: "nope",
    });
    assertEquals(foreign.status, 404, await foreign.clone().text());
    // A repository of another application cannot be smuggled under this one.
    const smuggled = await asDeveloper(f, "POST", "/v1/tasks", {
      applicationId: w.appA,
      repositoryId: w.repoB1,
      taskType: "bug",
      title: "nope",
    });
    assertNotEquals(smuggled.status, 201, await smuggled.clone().text());
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskB1}`)).status,
      404,
    );

    // Bindings never reach organization administration or other resources.
    for (
      const path of [
        "/v1/access-bindings",
        "/v1/principals",
        "/v1/audit-events",
      ]
    ) {
      const denied = await asDeveloper(f, "GET", path);
      assertEquals(
        denied.status,
        404,
        `${path}: ${await denied.clone().text()}`,
      );
    }
    // Mutating bindings is a session-only admin action.
    const mutate = await asDeveloper(f, "POST", "/v1/access-bindings", {
      principalId: f.developerId,
      roleKey: "developer",
      scopeType: "application",
      scopeId: w.appB,
    });
    assertEquals(mutate.status, 404, await mutate.clone().text());
  } finally {
    await f.finish();
  }
});

Deno.test("a binding adds to an organization role and never lowers it", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    await setMemberRole(f, f.developerId!, "viewer");
    // A viewer already reads everything; a developer binding lets it write on A.
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskB1}`)).status,
      200,
    );
    const denied = await asDeveloper(f, "PATCH", `/v1/tasks/${w.taskA1}`, {
      title: "x",
    });
    assertEquals(denied.status, 403);
    await bind(f, f.developerId!, "developer", "application", w.appA);
    const allowed = await asDeveloper(
      f,
      "PATCH",
      `/v1/tasks/${w.taskA1}`,
      { title: "now allowed" },
      IF_MATCH_V1,
    );
    assertEquals(allowed.status, 200, await allowed.clone().text());
    // Still no write outside the binding, and reads elsewhere are unchanged.
    assertEquals(
      (await asDeveloper(f, "PATCH", `/v1/tasks/${w.taskB1}`, { title: "x" }))
        .status,
      403,
    );
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskB1}`)).status,
      200,
    );
    assertEquals((await asDeveloper(f, "GET", "/v1/tasks")).status, 200);
  } finally {
    await f.finish();
  }
});

Deno.test("a token of a bound service account sees only the bound resource", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    const account = await createServiceAccount(f, "Bound bot", "guest");
    const token = await mintToken(f, account.id, ["bakery:read"]);
    const get = (path: string) => bearerCall(f, "GET", path, token.secret);
    assertEquals((await get(`/v1/tasks/${w.taskA1}`)).status, 404);
    await bind(f, account.id, "viewer", "repository", w.repoA1);
    assertEquals((await get(`/v1/tasks/${w.taskA1}`)).status, 200);
    assertEquals((await get(`/v1/tasks/${w.taskA2}`)).status, 404);
    assertEquals(await ids(await get("/v1/tasks")), [w.taskA1]);
    // A read-only scope still caps a developer binding.
    await bind(f, account.id, "developer", "repository", w.repoA1);
    const write = await bearerCall(
      f,
      "PATCH",
      `/v1/tasks/${w.taskA1}`,
      token.secret,
      {
        body: { title: "x" },
      },
    );
    assertEquals(write.status, 403, await write.clone().text());
    assertEquals((await write.json()).code, "INSUFFICIENT_SCOPE");
  } finally {
    await f.finish();
  }
});

Deno.test("bindings are access-management mutations: bearer tokens get SESSION_REQUIRED", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    const admin = await createServiceAccount(f, "Admin bot", "admin");
    const token = await mintToken(f, admin.id, ["bakery:admin"]);
    const response = await bearerCall(
      f,
      "POST",
      "/v1/access-bindings",
      token.secret,
      {
        body: {
          principalId: admin.id,
          roleKey: "viewer",
          scopeType: "application",
          scopeId: w.appA,
        },
      },
    );
    assertEquals(response.status, 403, await response.clone().text());
    assertEquals((await response.json()).code, "SESSION_REQUIRED");
    // Reading them is allowed for an admin token.
    assertEquals(
      (await bearerCall(f, "GET", "/v1/access-bindings", token.secret)).status,
      200,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("creating a binding is validated and anti-escalation capped", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    const post = (body: Json) =>
      adminJson(f, "POST", "/v1/access-bindings", body);
    const base = {
      principalId: f.developerId,
      roleKey: "viewer",
      scopeType: "application",
      scopeId: w.appA,
    };
    // Admin is organization-wide only.
    assertEquals((await post({ ...base, roleKey: "admin" })).status, 400);
    // A resource that is not in the organization is not found.
    assertEquals(
      (await post({ ...base, scopeId: crypto.randomUUID() })).status,
      404,
    );
    assertEquals(
      (await post({ ...base, principalId: crypto.randomUUID() })).status,
      404,
    );
    const first = await post(base);
    assertEquals(first.status, 201, await first.clone().text());
    assertEquals((await post(base)).status, 409);
    // Non-admins cannot list (hidden like any admin read) or create (forbidden).
    assertEquals(
      (await asDeveloper(f, "GET", "/v1/access-bindings")).status,
      404,
    );
    assertEquals(
      (await asDeveloper(f, "POST", "/v1/access-bindings", base)).status,
      403,
    );
  } finally {
    await f.finish();
  }
});

Deno.test("removing a member removes their bindings", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    await bind(f, f.developerId!, "viewer", "application", w.appA);
    const memberships = await adminJson(
      f,
      "GET",
      `/v1/organizations/${f.organizationId}/memberships`,
    );
    const membership = ((await memberships.json()).items as {
      id: string;
      principalId: string;
    }[]).find((item) => item.principalId === f.developerId)!;
    const removed = await adminJson(
      f,
      "DELETE",
      `/v1/organizations/${f.organizationId}/memberships/${membership.id}`,
    );
    assertEquals(removed.status, 204, await removed.clone().text());
    const left = await f.pgDatabase.query(
      "select 1 from bakery.access_bindings where principal_id = $1",
      [f.developerId],
    );
    assertEquals(left.rowCount, 0);
  } finally {
    await f.finish();
  }
});

Deno.test("the last organization admin cannot be demoted, removed or deactivated, with or without bindings", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    const memberships = await adminJson(
      f,
      "GET",
      `/v1/organizations/${f.organizationId}/memberships`,
    );
    const adminMembership = ((await memberships.json()).items as {
      id: string;
      principalId: string;
      role: string;
    }[]).find((item) => item.principalId === f.adminId)!;
    const url =
      `/v1/organizations/${f.organizationId}/memberships/${adminMembership.id}`;
    // A binding held by the admin changes nothing about the invariant.
    await bind(f, f.adminId, "viewer", "application", w.appA);
    for (
      const body of [
        { role: "developer" },
        { role: "guest" },
        { status: "inactive" },
      ]
    ) {
      const response = await adminJson(f, "PATCH", url, body);
      assertEquals(
        response.status,
        409,
        `${JSON.stringify(body)} ${await response.clone().text()}`,
      );
    }
    assertEquals((await adminJson(f, "DELETE", url)).status, 409);
    // Promote the developer, then the first admin can step down; the new
    // sole admin is protected in turn.
    await setMemberRole(f, f.developerId!, "admin");
    assertEquals(
      (await adminJson(f, "PATCH", url, { role: "developer" })).status,
      200,
    );
    const asNewAdmin = (method: string, path: string, body?: unknown) =>
      call(f, method, path, f.developerCookie, {
        body,
        headers: {
          ...orgHeader(f.organizationId),
          "Idempotency-Key": crypto.randomUUID(),
        },
      });
    const list = await asNewAdmin(
      "GET",
      `/v1/organizations/${f.organizationId}/memberships`,
    );
    const mine = ((await list.json()).items as {
      id: string;
      principalId: string;
    }[]).find((item) => item.principalId === f.developerId)!;
    const demote = await asNewAdmin(
      "PATCH",
      `/v1/organizations/${f.organizationId}/memberships/${mine.id}`,
      { role: "viewer" },
    );
    assertEquals(demote.status, 409, await demote.clone().text());
  } finally {
    await f.finish();
  }
});

async function insertRun(f: InstallationFixture, taskId: string) {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, 'Binding workflow')`,
    [workflowId, f.organizationId, `bind-wf-${workflowId}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.workflow_versions (
      id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
      digest, status, created_by
    ) values ($1, $2, $3, 1, 'name: x', '{}'::jsonb, $4, 'published', $5)`,
    [versionId, f.organizationId, workflowId, "0".repeat(64), f.adminId],
  );
  await f.pgDatabase.query(
    `insert into bakery.workflow_runs (
      id, organization_id, task_id, workflow_version_id, requested_by, snapshot
    ) values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [runId, f.organizationId, taskId, versionId, f.adminId],
  );
  return runId;
}

Deno.test("a run is reached through its task's binding and no other", async () => {
  const f = await openInstallationFixture();
  try {
    const w = await buildWorld(f);
    const runA1 = await insertRun(f, w.taskA1);
    const runB1 = await insertRun(f, w.taskB1);
    const adminView = await adminJson(f, "GET", `/v1/runs/${runA1}`);
    assertEquals(adminView.status, 200, await adminView.clone().text());
    await setMemberRole(f, f.developerId!, "guest");
    const absent = crypto.randomUUID();
    await assertNotFoundLikeForeign(
      await asDeveloper(f, "GET", `/v1/runs/${runA1}`),
      await asDeveloper(f, "GET", `/v1/runs/${absent}`),
    );
    await bind(f, f.developerId!, "viewer", "repository", w.repoA1);
    const visible = await asDeveloper(f, "GET", `/v1/runs/${runA1}`);
    assertEquals(visible.status, 200, await visible.clone().text());
    assertEquals(
      (await asDeveloper(f, "GET", `/v1/tasks/${w.taskA1}/runs`)).status,
      200,
    );
    await assertNotFoundLikeForeign(
      await asDeveloper(f, "GET", `/v1/runs/${runB1}`),
      await asDeveloper(f, "GET", `/v1/runs/${absent}`),
    );
    await assertNotFoundLikeForeign(
      await asDeveloper(f, "GET", `/v1/tasks/${w.taskB1}/runs`),
      await asDeveloper(f, "GET", `/v1/tasks/${absent}/runs`),
    );
    // A viewer binding does not allow starting a run.
    const start = await asDeveloper(f, "POST", `/v1/tasks/${w.taskA1}/runs`, {
      executionMode: "repository",
      presetId: "fixed-coding",
    });
    assertEquals(start.status, 403, await start.clone().text());
  } finally {
    await f.finish();
  }
});

/** Invites a fresh person as `role`, registers and accepts through the real flow. */
async function joinAs(f: InstallationFixture, role: string) {
  const email = `bind-${role}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const invited = await adminJson(
    f,
    "POST",
    `/v1/organizations/${f.organizationId}/invitations`,
    { email, role },
  );
  assertEquals(invited.status, 201, await invited.clone().text());
  const invitation = await invited.json() as { id: string; role: string };
  assertEquals(invitation.role, role);
  const signUp = await f.app.fetch(
    authRequest("/api/auth/sign-up/email", {
      email,
      password: f.password,
      name: `Bound ${role}`,
    }),
  );
  assertEquals(signUp.status, 200, await signUp.clone().text());
  const cookie = await signIn(f, email, f.password);
  const accepted = await f.app.fetch(
    authRequest("/api/auth/organization/accept-invitation", {
      invitationId: invitation.id,
    }, { cookie }),
  );
  assertEquals(accepted.status, 200, await accepted.clone().text());
  const principal = await f.pgDatabase.query<{ id: string; role: string }>(
    `select principal.id, membership.role
     from bakery.principals as principal
     join public."user" as provider on provider.id = principal.provider_user_id
     join bakery.organization_memberships as membership
       on membership.principal_id = principal.id
       and membership.organization_id = $2
     where provider.email = $1`,
    [email, f.organizationId],
  );
  assertEquals(principal.rows[0]?.role, role);
  return { email, cookie, principalId: principal.rows[0].id };
}

Deno.test("an invited guest lands with no access, then reaches only what a binding gives them", async () => {
  const f = await openInstallationFixture();
  const extra: string[] = [];
  try {
    const w = await buildWorld(f);
    const guest = await joinAs(f, "guest");
    extra.push(guest.email);
    const viewer = await joinAs(f, "viewer");
    extra.push(viewer.email);
    const asGuest = (path: string) =>
      call(f, "GET", path, guest.cookie, {
        headers: orgHeader(f.organizationId),
      });
    // A guest holds nothing organization-wide; a viewer reads everything.
    assertEquals((await asGuest(`/v1/tasks/${w.taskA1}`)).status, 404);
    const asViewer = await call(
      f,
      "GET",
      `/v1/tasks/${w.taskA1}`,
      viewer.cookie,
      {
        headers: orgHeader(f.organizationId),
      },
    );
    assertEquals(asViewer.status, 200, await asViewer.clone().text());

    const binding = await bind(
      f,
      guest.principalId,
      "viewer",
      "repository",
      w.repoA1,
    );
    assertEquals((await asGuest(`/v1/tasks/${w.taskA1}`)).status, 200);
    assertEquals((await asGuest(`/v1/tasks/${w.taskA2}`)).status, 404);
    assertEquals(await ids(await asGuest("/v1/tasks")), [w.taskA1]);
    await unbind(f, binding);
    assertEquals((await asGuest(`/v1/tasks/${w.taskA1}`)).status, 404);
  } finally {
    await cleanupAuthFixture(f.pgDatabase, extra);
    await f.finish();
  }
});
