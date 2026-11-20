import { assert, assertEquals } from "@std/assert";

// Installing the desktop package must register the bakery:// scheme and hand its address to the app.
// The built package is checked in CI (apps/desktop/e2e/check_bundle.py); this holds its source to
// the same rule where every pull request runs.
const conf = JSON.parse(
  await Deno.readTextFile("apps/desktop/src-tauri/tauri.conf.json"),
);
const template = await Deno.readTextFile(
  "apps/desktop/src-tauri/bakery.desktop",
);

Deno.test("the desktop entry's Exec passes the address to the app", () => {
  const exec = template.split("\n").find((line) => line.startsWith("Exec="));
  assert(exec, "the template has an Exec line");
  assert(exec.trim().endsWith("%u"), `Exec must end with %u: ${exec}`);
});

Deno.test("the package uses that entry and registers the bakery scheme", () => {
  assertEquals(conf.bundle.linux.deb.desktopTemplate, "bakery.desktop");
  assertEquals(conf.plugins["deep-link"].desktop.schemes, ["bakery"]);
  assert(
    template.includes("{{#if mime_type}}MimeType={{mime_type}}"),
    "the entry carries the scheme the bundler adds",
  );
  assert(conf.bundle.targets.includes("deb"), "the Linux package is a deb");
});
