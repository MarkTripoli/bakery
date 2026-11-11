import { assertEquals } from "@std/assert";
import {
  scopeCopy,
  wordableScopes,
} from "../../apps/web/src/app/connected-clients.ts";

Deno.test("the three Bakery scopes have consent copy and anything else has none", () => {
  assertEquals(
    scopeCopy("bakery:read")?.title,
    "auth.consent.scope.read.title",
  );
  assertEquals(
    scopeCopy("bakery:operate")?.title,
    "auth.consent.scope.operate.title",
  );
  assertEquals(
    scopeCopy("bakery:admin")?.title,
    "auth.consent.scope.admin.title",
  );
  assertEquals(scopeCopy("bakery:superuser"), null);
  // Inherited object keys must never read as a scope.
  assertEquals(scopeCopy("toString"), null);
  assertEquals(scopeCopy("__proto__"), null);
});

Deno.test("a grant lists its wordable scopes in grant order and drops the rest", () => {
  assertEquals(
    wordableScopes(["bakery:operate", "openid", "bakery:read"]),
    ["auth.consent.scope.operate.title", "auth.consent.scope.read.title"],
  );
  assertEquals(wordableScopes([]), []);
});
