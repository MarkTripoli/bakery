import { assertEquals } from "@std/assert";
import { createBakeryApiClient } from "../../apps/web/src/api/client.ts";

const ORG = "00000000-0000-4000-8000-0000000000a1";

Deno.test("metrics reads carry the organization they were asked for", async () => {
  const seen: (string | null)[] = [];
  const fetchImpl = ((input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request.headers.get("bakery-organization-id"));
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  const client = createBakeryApiClient({
    baseUrl: "http://localhost",
    fetchImpl,
  });
  await client.metrics.get({
    organizationId: ORG,
    query: { metric: "tasks.leadTimeHours" } as never,
  });
  await client.metrics.sources({
    organizationId: ORG,
    query: { metric: "tasks.leadTimeHours" } as never,
  });
  assertEquals(seen, [ORG, ORG]);
});
