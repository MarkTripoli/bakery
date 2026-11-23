import { assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  createFolderGrant,
  revokeFolderGrant,
  setFolderRestriction,
} from "../../apps/server/src/modules/knowledge/folder-grants.ts";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

const unusedTransaction = new Proxy({}, {
  get() {
    throw new Error("the database was used");
  },
});

const context = (over: Record<string, unknown> = {}) =>
  ({
    transaction: unusedTransaction,
    authority: {
      organizationId: ORGANIZATION,
      subject: { principalId: PERSON },
    },
    principal: { principalType: "human" },
    params: { id: crypto.randomUUID() },
    ...over,
  }) as never;

const handlers: [string, (context: never) => Promise<unknown>][] = [
  [
    "create a grant",
    (c) => createFolderGrant(c, { principalId: PERSON, level: "view" }),
  ],
  ["revoke a grant", (c) => revokeFolderGrant(c)],
  ["restrict a folder", (c) => setFolderRestriction(c, { restricted: true })],
];

const agents: [string, Record<string, unknown>][] = [
  ["an agent session", { agentSession: { id: "session" } }],
  ["an access token", { accessToken: { id: "token" } }],
  ["a service principal", { principal: { principalType: "service" } }],
];

for (const [action, handler] of handlers) {
  for (const [who, over] of agents) {
    Deno.test(`${who} cannot ${action}, and the database is never touched`, async () => {
      const error = await assertRejects(
        () => handler(context(over)),
        StandardError,
      );
      assertEquals(error.code, "AUTH_FORBIDDEN");
    });
  }

  Deno.test(`a person reaches the database to ${action}`, async () => {
    await assertRejects(
      () => handler(context()),
      Error,
      "the database was used",
    );
  });
}
