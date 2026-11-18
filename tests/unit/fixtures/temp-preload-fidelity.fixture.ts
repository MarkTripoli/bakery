// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): reads what the preload's wrappers look like to a test, and
// removes its own temp dir in its own unload handler with no try/catch, as a
// test may (#253). The rail expects a clean run.

Deno.test("the wrapped temp calls keep their name and length", () => {
  const deno = Deno as unknown as Record<
    string,
    { name: string; length: number }
  >;
  for (
    const name of [
      "makeTempDir",
      "makeTempFile",
      "makeTempDirSync",
      "makeTempFileSync",
    ]
  ) {
    if (deno[name].name !== name) {
      throw new Error(`${name}.name is ${JSON.stringify(deno[name].name)}`);
    }
    if (deno[name].length !== 0) {
      throw new Error(`${name}.length is ${deno[name].length}`);
    }
  }
});

Deno.test("a test can remove its own temp dir in its own unload handler", () => {
  const dir = Deno.makeTempDirSync({ prefix: "bakery-fixture-own-unload-" });
  // No try/catch: it throws if the preload already removed the directory.
  globalThis.addEventListener("unload", () => {
    Deno.removeSync(dir, { recursive: true });
  });
});
