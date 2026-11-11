import { assertEquals } from "@std/assert";
import { isExcluded } from "../../scripts/ci/precommit-guard.ts";

Deno.test("directory entry excludes nested files", () => {
  const excludes = ["docs/x/"];
  assertEquals(isExcluded("docs/x/file.ts", excludes), true);
  assertEquals(isExcluded("docs/x/deep/er/file.jsx", excludes), true);
  assertEquals(isExcluded("./docs/x/file.ts", excludes), true);
});

Deno.test("exact entry excludes that file only", () => {
  const excludes = ["apps/web/public/theme-bootstrap.js"];
  assertEquals(
    isExcluded("apps/web/public/theme-bootstrap.js", excludes),
    true,
  );
  assertEquals(isExcluded("apps/web/public/other.js", excludes), false);
  assertEquals(
    isExcluded("apps/web/public/theme-bootstrap.js.bak", excludes),
    false,
  );
});

Deno.test("entry without slash also matches as a directory prefix", () => {
  assertEquals(isExcluded("docs/x/file.ts", ["docs/x"]), true);
  assertEquals(isExcluded("docs/xy/file.ts", ["docs/x"]), false);
});

Deno.test("directory entry does not match a sibling sharing the prefix", () => {
  assertEquals(isExcluded("docs/xy/file.ts", ["docs/x/"]), false);
});

Deno.test("non-excluded paths are kept", () => {
  assertEquals(isExcluded("scripts/a.ts", ["docs/x/", "b.js"]), false);
  assertEquals(isExcluded("scripts/a.ts", []), false);
});

Deno.test("root deno.json excludes paper-source files and keeps the guard", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as { fmt: { exclude: string[] } };
  const excludes = config.fmt.exclude;
  assertEquals(
    isExcluded(
      "docs/technical-design/enterprise-mocks/paper-source/a.jsx",
      excludes,
    ),
    true,
  );
  assertEquals(isExcluded("scripts/ci/precommit-guard.ts", excludes), false);
});
