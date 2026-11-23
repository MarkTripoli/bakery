import { assert, assertEquals } from "@std/assert";

// The desktop window's page asks the app to do things by command name. A name the app does not register
// is rejected without a word, so a button draws and does nothing (#77: `press` against `press_button`
// left every drawn button dead on a real click, and nothing noticed). This ties the two lists together.

const read = (path: string) =>
  Deno.readTextFileSync(new URL(`../../${path}`, import.meta.url));

function pageCommands(): string[] {
  const names = [
    ...read("apps/desktop/web/panel.js").matchAll(
      /\binvoke\(\s*["']([a-z_]+)["']/g,
    ),
  ].map((match) => match[1]);
  return [...new Set(names)].sort();
}

function registeredCommands(): string[] {
  const source = read("apps/desktop/src-tauri/src/main.rs");
  const list = source.match(/generate_handler!\[([^\]]*)\]/s)?.[1] ?? "";
  return list.split(",").map((name) => name.trim()).filter(Boolean).sort();
}

Deno.test("every command the desktop page invokes is one the app registers", () => {
  const page = pageCommands();
  const registered = registeredCommands();
  assert(page.length >= 3, `the page's commands were not found: ${page}`);
  assert(registered.length >= 3, `the registered commands were not found`);
  const missing = page.filter((name) => !registered.includes(name));
  assertEquals(missing, [], "the page calls a command the app does not have");
});

Deno.test("the buttons' command is the one that presses a button", () => {
  assert(pageCommands().includes("press_button"));
  assertEquals(pageCommands().includes("press"), false);
});
