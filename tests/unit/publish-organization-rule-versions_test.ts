import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { repositoryRuleVersionDigest } from "../../apps/server/src/modules/repository-rules/postgres.ts";
import { OrganizationRepositoryRulesSchema } from "../../packages/contracts/src/repository-rules.ts";
import {
  allRuleEntries,
  commitsEntry,
} from "../helpers/repository-rule-entries.ts";

Deno.test("rule version digest matches the pinned vectors", async () => {
  // sha256('{"entries":[],"revision":0}'), computed outside the code under test.
  assertEquals(
    await repositoryRuleVersionDigest(0, []),
    "5b31205c26480a4aa906dbaf7e1b2790651383422e2e5c1324d26e25f9d0c5c4",
  );
  assertEquals(
    await repositoryRuleVersionDigest(1, [{
      ruleKey: "commits.semantic",
      enabled: true,
    }]),
    "d712534d57ceab4d61b5d41c901ce028590ecd85ead3df7d5c06253a8f26f0d1",
  );
});

Deno.test("rule version digest ignores key order and tracks every change", async () => {
  const entry = commitsEntry();
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  assertEquals(
    await repositoryRuleVersionDigest(3, [entry]),
    await repositoryRuleVersionDigest(3, [reordered]),
  );
  const base = await repositoryRuleVersionDigest(3, [entry]);
  assertNotEquals(base, await repositoryRuleVersionDigest(4, [entry]));
  for (
    const changed of [
      { ...entry, enabled: false },
      { ...entry, mode: "warn" },
      { ...entry, locked: false },
      { ...entry, explanation: "x" },
      { ...entry, options: { ...entry.options, maxSubjectLength: 73 } },
    ]
  ) {
    assertNotEquals(base, await repositoryRuleVersionDigest(3, [changed]));
  }
  const all = allRuleEntries();
  assertNotEquals(
    await repositoryRuleVersionDigest(1, all),
    await repositoryRuleVersionDigest(1, [...all].reverse()),
  );
});

Deno.test("prototype-style keys and control text never reach the digest", () => {
  const parse = (entry: unknown) =>
    OrganizationRepositoryRulesSchema.safeParse({
      revision: 1,
      entries: [entry],
    }).success;
  assert(parse(commitsEntry()));
  assert(
    !parse(
      JSON.parse(
        JSON.stringify(commitsEntry()).replace("{", '{"__proto__":{"x":1},'),
      ),
    ),
  );
  assert(!parse({ ...commitsEntry(), constructor: {} }));
  assert(!parse({ ...commitsEntry(), explanation: "bad\u0000text" }));
  assert(!parse({ ...commitsEntry(), explanation: "lone\ud800surrogate" }));
  assert(parse({ ...commitsEntry(), explanation: "emoji 😀 pair" }));
});
