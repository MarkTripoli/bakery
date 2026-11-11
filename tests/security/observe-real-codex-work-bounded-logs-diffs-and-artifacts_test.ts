import { JOB_ATTEMPTS_LIST_ACTION } from "../../apps/server/src/modules/execution/attempt-read.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { attemptBrowserClient } from "../helpers/attempt-read.ts";
import { setup } from "../helpers/output-ingestion.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { createWorkerScope } from "../helpers/worker-execution.ts";

Deno.test("attempt reads enforce task ownership, organization scope, active resources and current grants", () =>
  withWorkerFixture(async (fixture) => {
    const first = await setup(fixture);
    const second = await setup(fixture);
    assert(first.binding.taskId);
    const read = (
      options: {
        taskId?: string;
        jobId?: string;
        organizationId?: string;
        cookie?: string;
        cursor?: string;
      } = {},
    ) => {
      const url = new URL(
        `/v1/jobs/${options.jobId ?? first.assignment.jobId}/attempts`,
        fixture.config.publicBaseUrl,
      );
      url.searchParams.set(
        "taskId",
        options.taskId ?? first.binding.taskId ?? "",
      );
      url.searchParams.set("limit", "1");
      if (options.cursor) url.searchParams.set("cursor", options.cursor);
      return fixture.app.fetch(
        new Request(url, {
          headers: {
            "Bakery-Organization-Id": options.organizationId ??
              fixture.organizationId,
            cookie: options.cookie ?? fixture.adminCookie,
          },
        }),
      );
    };
    assertEquals((await read()).status, 200);
    await fixture.pgDatabase.query(
      `insert into bakery.job_attempts (
      organization_id,job_id,worker_host_id,worker_session_id,worker_session_generation,attempt_no,fence,lease_token_hash,lease_expires_at,status,created_at)
      select organization_id,job_id,worker_host_id,worker_session_id,worker_session_generation,attempt_no+1,fence+1,lease_token_hash,lease_expires_at,'lost',created_at+interval '1 second'
      from bakery.job_attempts where id=$1`,
      [first.assignment.attemptId],
    );
    const page = await attemptBrowserClient(fixture).actions
      ["jobAttempts.list"]({
        id: first.assignment.jobId,
        taskId: first.binding.taskId,
        limit: 1,
      });
    assert(page.nextCursor);
    assertEquals((await read({ cursor: page.nextCursor })).status, 200);
    assertEquals(
      (await read({
        jobId: second.assignment.jobId,
        taskId: second.binding.taskId ?? "",
        cursor: page.nextCursor,
      })).status,
      400,
    );

    assertEquals((await read({ cookie: "" })).status, 401);
    assertEquals(
      (await read({ taskId: second.binding.taskId ?? "" })).status,
      404,
    );
    assertEquals((await read({ jobId: crypto.randomUUID() })).status, 404);
    const other = await createWorkerScope(
      fixture,
      "attempt-reader-other",
      fixture,
    );
    try {
      assertEquals(
        (await read({ organizationId: other.organizationId })).status,
        404,
      );
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id=$1`,
        [other.organizationId],
      );
    }
    const badCursor = await read({ cursor: "tampered" });
    assertEquals(badCursor.status, 400);
    assertEquals((await badCursor.json()).code, "INVALID_CURSOR");
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='inactive' where organization_id=$1 and principal_id=$2`,
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals((await read({ cursor: page.nextCursor })).status, 404);
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='active' where organization_id=$1 and principal_id=$2`,
      [fixture.organizationId, fixture.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks set archived_at=now() where id=$1`,
      [first.binding.taskId],
    );
    assertEquals((await read()).status, 404);
    await fixture.pgDatabase.query(
      `update bakery.tasks set archived_at=null where id=$1`,
      [first.binding.taskId],
    );
    await fixture.pgDatabase.query(
      `update bakery.applications set archived_at=now() where id=$1`,
      [first.binding.applicationId],
    );
    assertEquals((await read()).status, 404);
  }));

Deno.test("jobAttempts.list authority rechecks exact service grants before every read", () =>
  withWorkerFixture(async (fixture) => {
    const serviceId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id,display_name,principal_type) values ($1,'Attempt reader service','service')`,
      [serviceId],
    );
    try {
      const runner = new PostgresAuthorityRunner(fixture.runtimePgDatabase);
      const context = {
        request: new Request(
          `${fixture.config.publicBaseUrl}/v1/jobs/${crypto.randomUUID()}/attempts`,
          { headers: { "Bakery-Organization-Id": fixture.organizationId } },
        ),
        params: {},
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        signal: new AbortController().signal,
        principal: {
          principalId: serviceId,
          principalType: "service",
          displayName: "Attempt reader service",
        },
      };
      const read = () =>
        runner.run(
          JOB_ATTEMPTS_LIST_ACTION,
          context,
          {},
          () => Promise.resolve("authorized"),
        );
      assertEquals(
        (await assertRejects(read, StandardError)).code,
        "RESOURCE_NOT_FOUND",
      );
      await fixture.pgDatabase.query(
        `insert into bakery.permission_grants (organization_id,principal_id,capability,granted_by_principal_id) values ($1,$2,'jobAttempts.list',$3)`,
        [fixture.organizationId, serviceId, fixture.principalId],
      );
      assertEquals(await read(), "authorized");
      await fixture.pgDatabase.query(
        `update bakery.permission_grants set revoked_at=now() where organization_id=$1 and principal_id=$2`,
        [fixture.organizationId, serviceId],
      );
      assertEquals(
        (await assertRejects(read, StandardError)).code,
        "RESOURCE_NOT_FOUND",
      );
      await fixture.pgDatabase.query(
        `update bakery.permission_grants set revoked_at=null,expires_at=now()-interval '1 second' where organization_id=$1 and principal_id=$2`,
        [fixture.organizationId, serviceId],
      );
      assertEquals(
        (await assertRejects(read, StandardError)).code,
        "RESOURCE_NOT_FOUND",
      );
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.permission_grants where principal_id=$1`,
        [serviceId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.principals where id=$1`,
        [serviceId],
      );
    }
  }));
