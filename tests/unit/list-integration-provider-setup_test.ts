import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { listProviderSetup } from "../../apps/server/src/modules/integrations/provider-setup.ts";

/**
 * integrationProviderSetup.list (#410): the one fact an organization needs, whether
 * a deployed provider's application has been registered, with no credential in it.
 */

function stand(registered: string[]) {
  const recorded: string[] = [];
  const transaction = {
    query: (sql: string) => {
      recorded.push(sql);
      return Promise.resolve({
        rows: registered.map((provider) => ({ provider })),
        rowCount: registered.length,
      });
    },
  };
  return {
    recorded,
    context: {
      transaction,
      principal: { principalId: "p" },
      authority: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        subject: { principalId: "p", principalType: "human" },
      },
    } as unknown as ActionContext,
  };
}

Deno.test("a provider that needs registration is needs_setup until one exists", async () => {
  const { context } = stand([]);
  assertEquals(await listProviderSetup(context), {
    providers: [
      { provider: "github", setupState: "needs_setup" },
      { provider: "linear", setupState: "needs_setup" },
    ],
  });
});

Deno.test("each provider turns ready on its own registration only", async () => {
  assertEquals(
    (await listProviderSetup(stand(["linear"]).context)).providers,
    [
      { provider: "github", setupState: "needs_setup" },
      { provider: "linear", setupState: "ready" },
    ],
  );
  assertEquals(
    (await listProviderSetup(stand(["github"]).context)).providers,
    [
      { provider: "github", setupState: "ready" },
      { provider: "linear", setupState: "needs_setup" },
    ],
  );
});

Deno.test("only the provider column is read, so nothing about a registration can leak", async () => {
  const { context, recorded } = stand(["linear"]);
  const result = await listProviderSetup(context);
  assertEquals(recorded.length, 1);
  assertEquals(/select provider from/i.test(recorded[0]), true);
  assertEquals(
    result.providers.every((row) =>
      Object.keys(row).sort().join() === "provider,setupState"
    ),
    true,
  );
});
