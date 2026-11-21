import { assertEquals } from "@std/assert";
import {
  DESKTOP_HANDOFF_PATH,
  handoffNavigationAllowed,
  safeReturnPath,
} from "../../apps/server/src/modules/auth/domain/desktop-handoff.ts";

Deno.test("a same-origin path is kept as the browser would resolve it", () => {
  assertEquals(safeReturnPath("/projects"), "/projects");
  assertEquals(safeReturnPath("/projects?tab=open#x"), "/projects?tab=open#x");
  assertEquals(safeReturnPath("/a/../b"), "/b");
});

Deno.test("anything that could leave the origin or loop is refused", () => {
  for (
    const value of [
      "",
      "projects",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "/x\u0000y",
      "/x\ny",
      "/" + "a".repeat(2048),
      DESKTOP_HANDOFF_PATH,
      `${DESKTOP_HANDOFF_PATH}?code=x`,
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/./\\evil.example",
    ]
  ) {
    assertEquals(safeReturnPath(value), null, JSON.stringify(value));
  }
});

Deno.test("only the app's own navigation may spend a code", () => {
  const site = (value: string | null) => {
    const headers = new Headers();
    if (value !== null) headers.set("sec-fetch-site", value);
    return handoffNavigationAllowed(headers);
  };
  assertEquals(site(null), true);
  assertEquals(site("none"), true);
  assertEquals(site("same-origin"), true);
  assertEquals(site("same-site"), false);
  assertEquals(site("cross-site"), false);
});
