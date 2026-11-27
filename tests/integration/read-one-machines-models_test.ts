import { assertEquals } from "@std/assert";
import { openApprovalFixture } from "../helpers/scoped-approvals.ts";

type Fixture = Awaited<ReturnType<typeof openApprovalFixture>>;

async function seedMachine(
  fixture: Fixture,
  organizationId: string,
): Promise<{ hostId: string; bindingId: string }> {
  const db = fixture.fx.ownerPg;
  const ids = {
    principal: crypto.randomUUID(),
    host: crypto.randomUUID(),
    binding: crypto.randomUUID(),
  };
  await db.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Models machine', 'worker')`,
    [ids.principal],
  );
  await db.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id,
       principal_type, name, os, architecture, capabilities, slots,
       credential_hash, worker_session_id, worker_session_generation,
       adapter_capabilities)
     values ($1, $2, $3, 'worker', 'models-box', 'linux', 'x64', '[]', 1, $4,
       $5, 0, '[]'::jsonb)`,
    [
      ids.host,
      organizationId,
      ids.principal,
      `models-${ids.host}`,
      crypto.randomUUID(),
    ],
  );
  await db.query(
    `insert into bakery.worker_provider_bindings (id, organization_id,
       worker_host_id, component_key, provider, billing_route, auth_mode,
       credential_location)
     values ($1, $2, $3, 'pi', 'openai', 'api_metered', 'api_key',
       'harness_host')`,
    [ids.binding, organizationId, ids.host],
  );
  return { hostId: ids.host, bindingId: ids.binding };
}

const routeBody = {
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-5",
  harness: "pi",
  billingRoute: "api_metered",
  credentialLocation: "harness_host",
};

Deno.test("a member reads only the models routed to one machine, without operational detail", async () => {
  const fixture = await openApprovalFixture();
  try {
    const machine = await seedMachine(fixture, fixture.fx.organizationId);
    const admin = await fixture.as(fixture.fx.admin);
    const create = async (model: string) => {
      const response = await fixture.call(
        admin,
        "POST",
        "/v1/provider-routes",
        {
          body: { ...routeBody, model },
          key: crypto.randomUUID(),
        },
      );
      assertEquals(response.status, 201, await response.clone().text());
      return (await response.json() as { id: string }).id;
    };
    const bound = await create("gpt-5");
    await create("gpt-5-mini");
    await fixture.fx.ownerPg.query(
      `update bakery.provider_routes set worker_binding_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.fx.organizationId, bound, machine.bindingId],
    );
    const read = await fixture.call(
      await fixture.as(fixture.fx.developer),
      "GET",
      `/v1/workers/${machine.hostId}/models`,
    );
    assertEquals(read.status, 200, await read.clone().text());
    const page = await read.json() as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    assertEquals(page.items.map((item) => [item.id, item.model, item.status]), [
      [bound, "gpt-5", "active"],
    ]);
    assertEquals("endpoint" in page.items[0]!, false);
    assertEquals(page.nextCursor, null);
  } finally {
    await fixture.close();
  }
});

Deno.test("another organization's machine reads as not found", async () => {
  const fixture = await openApprovalFixture();
  try {
    const foreignOrganization = crypto.randomUUID();
    await fixture.fx.ownerPg.query(
      `insert into bakery.organizations (id, name, slug, metadata, created_at,
         updated_at)
       values ($1, 'Foreign organization', $2, '{}'::jsonb, now(), now())`,
      [foreignOrganization, `foreign-${foreignOrganization}`],
    );
    const foreign = await seedMachine(fixture, foreignOrganization);
    for (const principal of [fixture.fx.admin, fixture.fx.developer]) {
      const read = await fixture.call(
        await fixture.as(principal),
        "GET",
        `/v1/workers/${foreign.hostId}/models`,
      );
      assertEquals(read.status, 404, await read.clone().text());
      await read.body?.cancel();
    }
    await fixture.fx.ownerPg.query(
      "delete from bakery.organizations where id = $1",
      [foreignOrganization],
    );
  } finally {
    await fixture.close();
  }
});
