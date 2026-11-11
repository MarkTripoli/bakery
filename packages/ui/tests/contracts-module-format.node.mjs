// Guardrail: @bakery/contracts must resolve as an ES module.
//
// Playwright's browser-test loader imports the web app's source as ES modules.
// When `packages/contracts` lacked a `"type": "module"` field, Node resolved
// `contracts.ts` with an ambiguous (`null`) format and the loader coerced it to
// CommonJS, and its workspace imports then hit Node's require-of-ESM path,
// which fails to link ES-module re-exports.
//
// The package is ES-module source (it uses `import ... with { type: "json" }`
// and imports ES-module workspace packages), so this guard raises as soon as
// the entry stops resolving as an ES module.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("@bakery/contracts resolves as an ES module and exposes its schemas", async () => {
  const formats = new Map();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url?.includes("/packages/contracts/")) {
        formats.set(specifier, result.format);
      }
      return result;
    },
  });

  const mod = await import("@bakery/contracts/contracts");

  const format = formats.get("@bakery/contracts/contracts");
  assert.ok(
    format === "module" || format === "module-typescript",
    `package entry must resolve as an ES module so the browser-test loader ` +
      `does not coerce it to CommonJS, got ${format ?? "null"}`,
  );
  assert.equal(typeof mod.contractSchemas, "object");
});
