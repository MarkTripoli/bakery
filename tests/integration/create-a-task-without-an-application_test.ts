import { assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

async function create(
  f: Awaited<ReturnType<typeof openInstallationFixture>>,
  body: Record<string, unknown>,
) {
  return await call(f, "POST", "/v1/tasks", f.adminCookie, {
    body,
    headers: {
      "Bakery-Organization-Id": f.organizationId,
      "Idempotency-Key": crypto.randomUUID(),
    },
  });
}

Deno.test("a task can be created with no application, and reads back with none", async () => {
  const f = await openInstallationFixture(false);
  try {
    const created = await create(f, {
      taskType: "feature",
      title: "Triage the provider-neutral ticket",
    });
    assertEquals(created.status, 201, await created.clone().text());
    const task = await created.json() as { id: string; applicationId: unknown };
    assertEquals(task.applicationId, null);
    const read = await call(f, "GET", `/v1/tasks/${task.id}`, f.adminCookie, {
      headers: { "Bakery-Organization-Id": f.organizationId },
    });
    assertEquals(read.status, 200);
    assertEquals(
      (await read.json() as { applicationId: unknown }).applicationId,
      null,
    );
  } finally {
    await f.pgDatabase.query(
      "delete from bakery.tasks where organization_id = $1 and application_id is null",
      [f.organizationId],
    );
    await f.pgDatabase.query(
      `delete from bakery.conversations
        where organization_id = $1 and application_id is null
          and title = 'Triage the provider-neutral ticket'`,
      [f.organizationId],
    );
    await f.finish();
  }
});

Deno.test("a repository without an application is refused before anything is written", async () => {
  const f = await openInstallationFixture(false);
  try {
    const refused = await create(f, {
      taskType: "feature",
      title: "Has a repository but no application",
      repositoryId: crypto.randomUUID(),
    });
    assertEquals(refused.status, 422, await refused.clone().text());
    const problem = await refused.json() as { issues?: { code: string }[] };
    assertEquals(problem.issues?.[0]?.code, "repository_requires_application");
    const stored = await f.pgDatabase.query(
      "select 1 from bakery.tasks where organization_id = $1 and application_id is null",
      [f.organizationId],
    );
    assertEquals(stored.rows.length, 0);
  } finally {
    await f.finish();
  }
});
