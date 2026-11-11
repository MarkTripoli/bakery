import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkUiExports } from "../scripts/check-exports.mjs";

function fixture(
  index,
  atoms = "export function PrimaryButton() { return null; }\n",
  molecules = "",
) {
  const root = mkdtempSync(join(tmpdir(), "bakery-ui-exports-"));
  const source = join(root, "packages/ui/src");
  mkdirSync(join(source, "atoms"), { recursive: true });
  mkdirSync(join(source, "molecules"), { recursive: true });
  writeFileSync(
    join(root, "catalog.json"),
    JSON.stringify({
      entries: [{ id: "ui.button", name: "PrimaryButton", level: "atom" }],
    }),
  );
  writeFileSync(
    join(root, "packages/ui/package.json"),
    JSON.stringify({
      exports: { ".": "./src/index.ts" },
    }),
  );
  writeFileSync(
    join(root, "packages/ui/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        target: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
      },
      include: ["src/**/*"],
    }),
  );
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(root, "packages/ui/node_modules"),
    "dir",
  );
  writeFileSync(join(source, "atoms/Button.ts"), atoms);
  writeFileSync(join(source, "molecules/Thing.ts"), molecules);
  writeFileSync(join(source, "index.ts"), index);
  return {
    root,
    catalog: join(root, "catalog.json"),
    uiPackage: join(root, "packages/ui"),
    cwd: join(root, "packages/ui"),
  };
}

function run(paths) {
  return checkUiExports({ ...paths, print: () => {}, validateSchema: false });
}

function close(paths) {
  rmSync(paths.root, { recursive: true, force: true });
}

test("accepts runtime wildcard exports", () => {
  const paths = fixture('export * from "./atoms/Button";');
  try {
    assert.deepEqual(run(paths).bindings, ["ui.button -> src/atoms/Button.ts"]);
  } finally {
    close(paths);
  }
});

test("rejects type-only exports with a source-located diagnostic", () => {
  const paths = fixture(
    'export type { PrimaryButton } from "./atoms/Button";',
  );
  try {
    assert.throws(
      () => run(paths),
      (error) => {
        assert(error instanceof Error);
        assert(
          error.message.startsWith(
            `${join(paths.uiPackage, "src/index.ts")}:1:`,
          ),
        );
        assert(
          error.message.includes("PrimaryButton for ui.button is type-only"),
        );
        return true;
      },
    );
  } finally {
    close(paths);
  }
});

test("rejects ambiguous wildcard exports", () => {
  const paths = fixture(
    'export * from "./atoms/Button";\nexport * from "./molecules/Thing";',
    "export function PrimaryButton() { return null; }\n",
    "export function PrimaryButton() { return null; }\n",
  );
  try {
    assert.throws(() => run(paths), /duplicate component PrimaryButton/);
  } finally {
    close(paths);
  }
});

test("rejects an exported component missing from the catalog", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton() { return null; }\nexport function ExtraButton() { return null; }\n",
  );
  writeFileSync(
    join(paths.root, "packages/ui/src/index.ts"),
    'export * from "./atoms/Button";\nexport { ExtraButton } from "./atoms/Button";\n',
  );
  try {
    assert.throws(
      () => run(paths),
      /source component ExtraButton is missing from the catalog/,
    );
  } finally {
    close(paths);
  }
});

test("rejects duplicate catalog ownership", () => {
  const paths = fixture('export * from "./atoms/Button";');
  writeFileSync(
    join(paths.root, "catalog.json"),
    JSON.stringify({
      entries: [
        { id: "ui.button", name: "PrimaryButton", level: "atom" },
        { id: "ui.button-copy", name: "PrimaryButton", level: "atom" },
      ],
    }),
  );
  try {
    assert.throws(
      () => run(paths),
      /duplicate public component catalog entry PrimaryButton/,
    );
  } finally {
    close(paths);
  }
});

test("resolves barrels before checking the Atomic Design path", () => {
  const paths = fixture(
    'export { PrimaryButton } from "./atoms/Barrel";',
    "",
    "export function PrimaryButton() { return null; }\n",
  );
  writeFileSync(
    join(paths.root, "packages/ui/src/atoms/Barrel.ts"),
    'export { PrimaryButton } from "../molecules/Thing";\n',
  );
  try {
    assert.throws(() => run(paths), /PrimaryButton is cataloged as atom/);
  } finally {
    close(paths);
  }
});

test("rejects an unexported source component", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton() { return null; }\nexport function UnexportedButton() { return null; }\n",
  );
  try {
    assert.throws(
      () => run(paths),
      /UnexportedButton is missing from the catalog/,
    );
  } finally {
    close(paths);
  }
});

test("rejects duplicate source declarations", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton() { return null; }\n",
    "export function PrimaryButton() { return null; }\n",
  );
  try {
    assert.throws(() => run(paths), /duplicate component PrimaryButton/);
  } finally {
    close(paths);
  }
});

test("rejects source/catalog level mismatch", () => {
  const paths = fixture(
    'export * from "./molecules/Thing";',
    "",
    "export function PrimaryButton() { return null; }\n",
  );
  try {
    assert.throws(() => run(paths), /cataloged as atom.*defined in molecules/);
  } finally {
    close(paths);
  }
});

test("rejects a catalog entry without source declaration", () => {
  const paths = fixture(
    'export { PrimaryButton } from "./atoms/Button";',
    "export const primaryButton = 'lowercase helper';\n",
  );
  try {
    assert.throws(() => run(paths), /has no capitalized source declaration/);
  } finally {
    close(paths);
  }
});

test("discovers source components without a filename allowlist", () => {
  const paths = fixture('export * from "./atoms/theme";');
  rmSync(join(paths.uiPackage, "src/atoms/Button.ts"));
  writeFileSync(
    join(paths.uiPackage, "src/atoms/theme.ts"),
    "export function PrimaryButton() { return null; }\n",
  );
  try {
    assert.deepEqual(
      run(paths).bindings,
      ["ui.button -> src/atoms/theme.ts"],
    );
  } finally {
    close(paths);
  }
});

test("excludes story, test, declaration, and test-directory sources", () => {
  const paths = fixture('export * from "./atoms/Button";');
  for (
    const relative of [
      "atoms/Extra.stories.ts",
      "atoms/Extra.story.mts",
      "atoms/Extra.spec.cts",
      "atoms/Extra.test.tsx",
      "atoms/Extra.d.ts",
      "atoms/stories/Extra.ts",
      "atoms/__tests__/Extra.tsx",
    ]
  ) {
    const file = join(paths.uiPackage, "src", relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export function ExtraButton() { return null; }\n");
  }
  try {
    assert.deepEqual([...run(paths).sourceComponents.keys()], [
      "PrimaryButton",
    ]);
  } finally {
    close(paths);
  }
});

test("rejects a public className prop with a source-located diagnostic", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    [
      "type PrimaryButtonProps = { className?: string; label: string };\n",
      "export function PrimaryButton({ className, label }: PrimaryButtonProps) {\n",
      "  return null;\n",
      "}\n",
    ].join(""),
  );
  try {
    assert.throws(
      () => run(paths),
      (error) => {
        assert(error instanceof Error);
        assert(
          error.message.startsWith(
            `${join(paths.uiPackage, "src/atoms/Button.ts")}:2:`,
          ),
        );
        assert(
          error.message.includes("PrimaryButton props type includes className"),
        );
        return true;
      },
    );
  } finally {
    close(paths);
  }
});

test("rejects a public style prop with a source-located diagnostic", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    [
      "type PrimaryButtonProps = { label: string; style?: string };\n",
      "export function PrimaryButton({ label, style }: PrimaryButtonProps) {\n",
      "  return null;\n",
      "}\n",
    ].join(""),
  );
  try {
    assert.throws(
      () => run(paths),
      (error) => {
        assert(error instanceof Error);
        assert(
          error.message.startsWith(
            `${join(paths.uiPackage, "src/atoms/Button.ts")}:2:`,
          ),
        );
        assert(
          error.message.includes("PrimaryButton props type includes style"),
        );
        return true;
      },
    );
  } finally {
    close(paths);
  }
});

test("rejects union public props that hide className or style", () => {
  const classNameFixture = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton(props: { id: string } | { className: string }) {\n  return null;\n}\n",
  );
  try {
    assert.throws(
      () => run(classNameFixture),
      (error) => {
        assert(error instanceof Error);
        assert(
          error.message.startsWith(
            `${join(classNameFixture.uiPackage, "src/atoms/Button.ts")}:1:`,
          ),
        );
        assert(
          error.message.includes(
            "PrimaryButton props type includes className",
          ),
        );
        return true;
      },
    );
  } finally {
    close(classNameFixture);
  }

  const styleFixture = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton(props: { id: string } | { style: string }) {\n  return null;\n}\n",
  );
  try {
    assert.throws(
      () => run(styleFixture),
      /PrimaryButton props type includes style/,
    );
  } finally {
    close(styleFixture);
  }
});

test("rejects extra public aliases for a cataloged component", () => {
  const paths = fixture(
    'export { PrimaryButton, PrimaryButton as ExtraButton } from "./atoms/Button";',
  );
  try {
    assert.throws(
      () => run(paths),
      /public export ExtraButton aliases cataloged component PrimaryButton/,
    );
  } finally {
    close(paths);
  }
});

test("accepts two callable const bindings declared in one statement", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    "export const PrimaryButton = () => null, ExtraButton = () => null;\n",
  );
  writeFileSync(
    join(paths.root, "catalog.json"),
    JSON.stringify({
      entries: [
        { id: "ui.button", name: "PrimaryButton", level: "atom" },
        { id: "ui.extra", name: "ExtraButton", level: "atom" },
      ],
    }),
  );
  try {
    assert.deepEqual(run(paths).bindings, [
      "ui.button -> src/atoms/Button.ts",
      "ui.extra -> src/atoms/Button.ts",
    ]);
  } finally {
    close(paths);
  }
});

test("reports the original source path for syntax errors", () => {
  const paths = fixture(
    'export * from "./atoms/Button";',
    "export function PrimaryButton( { return null; }\n",
  );
  try {
    assert.throws(
      () => run(paths),
      (error) => {
        assert(error instanceof Error);
        assert(
          error.message.startsWith(
            `${join(paths.uiPackage, "src/atoms/Button.ts")}:1:`,
          ),
        );
        assert(error.message.endsWith(": invalid TypeScript source"));
        return true;
      },
    );
  } finally {
    close(paths);
  }
});

test("rejects a catalog that violates the component catalog schema", () => {
  const paths = fixture('export * from "./atoms/Button";');
  try {
    assert.throws(
      () => checkUiExports({ ...paths, print: () => {} }),
      (error) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /violates packages\/ui\/catalog\/schema\.ts/,
        );
        assert.match(error.message, /entries\.0\.description/);
        return true;
      },
    );
  } finally {
    close(paths);
  }
});
