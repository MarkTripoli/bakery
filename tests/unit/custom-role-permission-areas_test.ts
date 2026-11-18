import { assert, assertEquals } from "@std/assert";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import {
  isResource,
  isVerb,
  PERMISSION_AREAS,
  RESOURCE_AREAS,
} from "../../apps/web/src/pages/permission-areas.ts";

/** Every permission key the custom-role form offers. */
const keys = [
  ...new Set(
    catalogActions.flatMap((action) =>
      action.permission === null ? [] : [String(action.permission)]
    ),
  ),
];

Deno.test("every permission resource is placed in a named area", () => {
  const unplaced = [...new Set(keys.map((key) => key.split(":")[0]))].filter(
    (resource) => !isResource(resource),
  );
  assertEquals(
    unplaced,
    [],
    "a permission resource the form cannot word would show as a raw key under Other",
  );
});

Deno.test("every permission verb has a sentence", () => {
  const unworded = [...new Set(keys.map((key) => key.split(":")[1]))].filter(
    (verb) => !isVerb(verb),
  );
  assertEquals(unworded, []);
});

Deno.test("no area is empty and no resource names a missing area", () => {
  for (const area of PERMISSION_AREAS) {
    assert(
      Object.values(RESOURCE_AREAS).includes(area),
      `area ${area} holds no resource`,
    );
  }
  for (const resource of Object.keys(RESOURCE_AREAS)) {
    assert(
      keys.some((key) => key.startsWith(`${resource}:`)),
      `resource ${resource} matches no permission in the catalog`,
    );
  }
});
