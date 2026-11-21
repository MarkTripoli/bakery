import { assertEquals } from "@std/assert";
import { pluginPageDocumentUrl } from "../../apps/web/src/pages/plugins/page-url.ts";

Deno.test("the frame's address carries the render inputs and the organization", () => {
  assertEquals(
    pluginPageDocumentUrl("inst-1", "release-checklist", "org-1", {
      theme: "dark",
      locale: "ar-EG",
      dir: "rtl",
    }),
    "/v1/plugin-installs/inst-1/pages/release-checklist/document?theme=dark&locale=ar-EG&dir=rtl&organizationId=org-1",
  );
});

Deno.test("an id cannot add a path segment or a query value of its own", () => {
  const url = pluginPageDocumentUrl("a/../b", "p?x=1", "o&theme=light", {
    theme: "light",
    locale: "en",
    dir: "ltr",
  });
  assertEquals(url.includes("/../"), false);
  assertEquals(
    url.startsWith("/v1/plugin-installs/a%2F..%2Fb/pages/p%3Fx%3D1/document?"),
    true,
  );
  assertEquals(
    new URL(url, "http://x").searchParams.get("organizationId"),
    "o&theme=light",
  );
  assertEquals(new URL(url, "http://x").searchParams.get("theme"), "light");
});
