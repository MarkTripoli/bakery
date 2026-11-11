import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import type { CatalogActionName } from "../../packages/contracts/src/contracts.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";

const input = z.object({
  revision: z.number().int().positive().describe("Published profile revision."),
}).strict().describe(
  "Minimal profile publication input for CAS transport proof.",
);
const output = z.object({
  revision: z.number().int().positive().describe("Committed profile revision."),
}).strict().describe(
  "Minimal committed profile output for CAS transport proof.",
);

Deno.test("repository profile publication carries strong If-Match into replay metadata", async () => {
  let expectedVersion: number | undefined;
  const registry = new ActionRegistry(undefined, {
    run: async ({ metadata, invokeAndEncode }) => {
      expectedVersion = metadata.expectedVersion;
      return await invokeAndEncode();
    },
  }).register({
    name: "repositoryProfiles.create" as CatalogActionName,
    method: HttpMethod.Post,
    path: "/v1/repositories/:id/profiles",
    input,
    output,
    policy: { type: ActionKind.Command, access: "Public" },
    handler: (_context, value) => value,
  });
  const app = createApiRouter({ registry });
  const request = (ifMatch: string) =>
    app.fetch(
      new Request(
        `http://local/v1/repositories/${crypto.randomUUID()}/profiles`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": ifMatch,
          },
          body: JSON.stringify({ revision: 7 }),
        },
      ),
    );

  assertEquals((await request('"7"')).status, 201);
  assertEquals(expectedVersion, 7);
  assertEquals((await request('W/"7"')).status, 428);
});
