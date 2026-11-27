import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

Deno.test("a task with no application is unreachable from another organization", async () => {
  const f = await openInstallationFixture(false);
  const otherOrganization = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  try {
    await f.pgDatabase.query(
      `insert into bakery.organizations (id, name, slug, metadata, created_at,
         updated_at, version)
       values ($1, 'Other', $2, '{}'::jsonb, now(), now(), 1)`,
      [otherOrganization, `other-${otherOrganization}`],
    );
    await f.pgDatabase.query(
      `insert into bakery.conversations
         (id, organization_id, application_id, title, created_by)
       values ($1, $2, null, 'Elsewhere', $3)`,
      [conversationId, otherOrganization, f.adminId],
    );
    await f.pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, conversation_id, title,
         task_type, status, priority, created_by)
       values ($1, $2, null, $3, 'No application', 'feature', 'draft', 50, $4)`,
      [taskId, otherOrganization, conversationId, f.adminId],
    );
    const own = { "Bakery-Organization-Id": f.organizationId };
    const read = await call(f, "GET", `/v1/tasks/${taskId}`, f.adminCookie, {
      headers: own,
    });
    assertEquals(read.status, 404, await read.clone().text());
    await read.body?.cancel();
    const listed = await call(f, "GET", "/v1/tasks?limit=100", f.adminCookie, {
      headers: own,
    });
    assertEquals(listed.status, 200);
    assert(!(await listed.text()).includes(taskId));
    const asOther = await call(
      f,
      "GET",
      `/v1/tasks/${taskId}`,
      f.adminCookie,
      { headers: { "Bakery-Organization-Id": otherOrganization } },
    );
    assert(
      asOther.status === 403 || asOther.status === 404,
      String(asOther.status),
    );
    await asOther.body?.cancel();
  } finally {
    await f.pgDatabase.query(
      "delete from bakery.tasks where organization_id = $1",
      [otherOrganization],
    );
    await f.pgDatabase.query(
      "delete from bakery.conversations where organization_id = $1",
      [otherOrganization],
    );
    await f.pgDatabase.query("delete from bakery.organizations where id = $1", [
      otherOrganization,
    ]);
    await f.finish();
  }
});
