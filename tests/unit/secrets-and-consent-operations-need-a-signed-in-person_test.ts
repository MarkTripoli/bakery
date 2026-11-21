import { assertEquals } from "@std/assert";
import { createSecretsActionRegistry } from "../../apps/server/src/modules/secrets/actions.ts";
import { createMcpActionRegistry } from "../../apps/server/src/modules/mcp/routes.ts";

/**
 * #448 S9c (chapter 25, O51): secrets and consent stay with a person. Each
 * write needs a signed-in browser session, so a token, an MCP client or an
 * agent's session call is refused before any handler runs.
 */

const REQUIRE_A_PERSON = [
  "secrets.create",
  "secrets.rotate",
  "secrets.updatePolicy",
  "secrets.revoke",
  "mcpUseGrants.create",
  "mcpUseGrants.revoke",
];

Deno.test("every secret and consent write needs a signed-in session", () => {
  const definitions = [
    ...createSecretsActionRegistry({} as never, "secret").list(),
    ...createMcpActionRegistry({} as never, {
      cursorSecret: "secret",
      secretsKey: undefined,
    }).list(),
  ];
  const byName = new Map<string, (typeof definitions)[number]>(
    definitions.map((entry) => [entry.name, entry]),
  );
  const missing: string[] = [];
  for (const name of REQUIRE_A_PERSON) {
    const definition = byName.get(name);
    if (definition?.policy.sessionOnly !== true) missing.push(name);
  }
  assertEquals(missing, []);
});

Deno.test("reading a secret's metadata or a connection's grants does not need one", () => {
  const definitions = [
    ...createSecretsActionRegistry({} as never, "secret").list(),
    ...createMcpActionRegistry({} as never, {
      cursorSecret: "secret",
      secretsKey: undefined,
    }).list(),
  ];
  const byName = new Map<string, (typeof definitions)[number]>(
    definitions.map((entry) => [entry.name, entry]),
  );
  for (const name of ["secrets.list", "secrets.get", "mcpUseGrants.list"]) {
    assertEquals(byName.get(name)?.policy.sessionOnly, undefined, name);
  }
});
