import { expect, test } from "@playwright/test";
import type { Server } from "node:http";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const packageRoot = decodeURIComponent(new URL("..", import.meta.url).pathname);
const captureScript = join(packageRoot, "scripts/capture-stories.mjs");
const packageModules = join(packageRoot, "node_modules");

const context = {
  viewport: { width: 320, height: 240 },
  dpr: 1,
  theme: "light",
  storedPreference: "light",
  pointer: "fine",
  locale: "en-US",
  direction: "ltr",
  timezone: "UTC",
  reducedMotion: "no-preference",
  zoom: 1,
  interaction: "load",
};

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixtureRepository(failingCase?: string) {
  const root = await mkdtemp(join(tmpdir(), "bakery-ui-capture-"));
  const uiRoot = join(root, "packages/ui");
  const baselines = join(root, "docs/technical-design/ui-baselines");
  const storybook = join(uiRoot, "storybook-static");
  await Promise.all([
    mkdir(join(uiRoot, "scripts"), { recursive: true }),
    mkdir(join(uiRoot, "src/atoms"), { recursive: true }),
    mkdir(storybook, { recursive: true }),
    mkdir(join(root, "docs/technical-design/enterprise-mocks/fonts"), {
      recursive: true,
    }),
  ]);
  await cp(captureScript, join(uiRoot, "scripts/capture-stories.mjs"));
  for (
    const script of [
      "paper-browser-profile.mjs",
      "paper-k0-raster.mjs",
      "paper-whole-artboard.mjs",
      "image-score.mjs",
      "native-viewport-bundle.mjs",
      "native-viewport-bundle-v2.mjs",
      "qualification-visible-union.mjs",
      "render-paper-references.mjs",
      "worker-readiness-reference.mjs",
    ]
  ) {
    await cp(
      join(packageRoot, "scripts", script),
      join(uiRoot, "scripts", script),
    );
  }
  await symlink(packageModules, join(uiRoot, "node_modules"), "dir");
  await writeJson(join(uiRoot, "package.json"), {
    name: "capture-rail-fixture",
    private: true,
    type: "module",
    scripts: { "capture:stories": "node scripts/capture-stories.mjs" },
  });
  await writeJson(join(baselines, "tokens.json"), {
    source: { revision: "fixture", digest: "f".repeat(64) },
  });
  await writeJson(join(baselines, "paper-baselines.json"), {
    schemaVersion: 2,
    source: { fileId: "fixture-file" },
    cases: [],
  });
  await writeJson(join(baselines, "paper-specimens.json"), {
    schemaVersion: 1,
    specimens: [],
  });
  await writeJson(join(baselines, "components.json"), {
    entries: [
      { id: "ui.button", name: "Button", level: "atom" },
      { id: "ui.thing", name: "Thing", level: "atom" },
    ],
  });
  await writeJson(join(baselines, "runtime-cases.json"), {
    schemaVersion: 1,
    contexts: { fixture: context },
    cases: [
      {
        id: "ui.button.contract.fixture",
        catalogId: "ui.button",
        requiredCaseId: "contract",
        storyId: "fixture-button--contract",
        context: "fixture",
        assertions: [],
      },
      {
        id: "ui.thing.contract.fixture",
        catalogId: "ui.thing",
        requiredCaseId: "contract",
        storyId: "fixture-thing--contract",
        context: "fixture",
        assertions: [],
      },
    ],
  });
  await writeJson(join(storybook, "index.json"), {
    entries: {
      "fixture-button--contract": {
        id: "fixture-button--contract",
        type: "story",
        importPath: "./src/atoms/Button.stories.tsx",
      },
      "fixture-thing--contract": {
        id: "fixture-thing--contract",
        type: "story",
        importPath: "./src/atoms/Thing.stories.tsx",
      },
    },
  });
  await writeFile(
    join(storybook, "iframe.html"),
    `<!doctype html><html><body><script>
      const query = new URLSearchParams(location.search);
      const globals = Object.fromEntries(
        (query.get("globals") || "").split(";").map((part) => part.split(":"))
      );
      const wrapper = document.createElement("main");
      wrapper.dataset.theme = query.get("id") === ${
      JSON.stringify(failingCase ? "fixture-button--contract" : undefined)
    }
        ? "dark"
        : globals.theme;
      wrapper.lang = globals.locale;
      const story = document.createElement("section");
      story.className = "storybook-story";
      story.dir = globals.direction;
      story.dataset.pointer = globals.pointer;
      story.dataset.reducedMotion = String(globals.reducedMotion === "reduce");
      story.style.cssText = "--target-min: 28px; zoom: 1; inline-size: 100px; block-size: 40px";
      story.textContent = query.get("id") || "fixture";
      wrapper.append(story);
      document.body.append(wrapper);
    </script></body></html>`,
  );
  for (const name of ["Button", "Thing"]) {
    await writeFile(
      join(uiRoot, `src/atoms/${name}.tsx`),
      `export const ${name} = 1;\n`,
    );
    await writeFile(
      join(uiRoot, `src/atoms/${name}.stories.tsx`),
      `export default { title: "Fixture/${name}" };\n`,
    );
  }
  await writeFile(join(root, ".gitignore"), "node_modules\nartifacts\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@bakery.invalid");
  git(root, "config", "user.name", "Bakery Fixture");
  git(root, "add", ".");
  git(root, "commit", "-qm", "test: add capture fixture");
  git(
    root,
    "update-ref",
    "refs/remotes/origin/main",
    git(root, "rev-parse", "HEAD"),
  );
  return root;
}

function capture(root: string, ...args: string[]) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "BASE_URL"),
  );
  return spawnSync(
    "pnpm",
    ["--dir", join(root, "packages/ui"), "capture:stories", "--", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, GITHUB_BASE_REF: "main" },
    },
  );
}

async function manifest(root: string) {
  return JSON.parse(
    await readFile(
      join(root, "artifacts/ui-baseline/runtime/manifest.json"),
      "utf8",
    ),
  );
}

test.describe("capture CLI rails", () => {
  test.setTimeout(120_000);

  test("writes complete schema-2 evidence when one runtime assertion fails", async () => {
    const caseId = "ui.button.contract.fixture";
    const root = await fixtureRepository(caseId);
    try {
      const result = capture(root, "--case", caseId);
      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      const report = await manifest(root);
      expect(report.schemaVersion).toBe(2);
      expect(report.coverage).toEqual({
        expected: 2,
        selected: 1,
        observed: 1,
        passed: 0,
        failed: 1,
        blocked: 0,
        missing: [],
        routes: 0,
      });
      expect(report.cases[0]).toMatchObject({
        id: caseId,
        status: "failed",
        reason: "theme-mismatch",
      });
      await expect(readFile(join(
        root,
        `artifacts/ui-baseline/runtime/images/failed-${caseId}.png`,
      ))).resolves.not.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("partitioned capture requires its catalog state, not every other case or a weaker override", async () => {
    const root = await fixtureRepository();
    const caseId = "ui.button.contract.fixture";
    try {
      const baselines = join(root, "docs/technical-design/ui-baselines");
      await writeJson(join(baselines, "components.json"), {
        entries: [{
          id: "ui.button",
          name: "Button",
          level: "atom",
          variants: ["start", "connected"],
          states: ["start", "connected"],
          requiredCaseCoverage: "partitioned",
          requiredCases: [{
            id: "contract",
            variants: ["start"],
            states: ["start"],
          }],
        }],
      });
      const html = join(root, "packages/ui/storybook-static/iframe.html");
      const before = await readFile(html, "utf8");
      const withState = (state: string) =>
        before.replace(
          "story.textContent =",
          `story.dataset.uiComponent = "button"; story.dataset.variant = "${state}"; story.dataset.state = "${state}"; story.textContent =`,
        );
      await writeFile(html, withState("start"));
      let result = capture(root, "--case", caseId);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect((await manifest(root)).cases[0].status).toBe("passed");
      await writeFile(html, withState("connected"));
      const runtimePath = join(baselines, "runtime-cases.json");
      const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
      runtime.cases[0].semanticCoverage = { states: [], variants: [] };
      await writeJson(runtimePath, runtime);
      result = capture(root, "--case", caseId);
      expect(result.status).not.toBe(0);
      expect((await manifest(root)).cases[0]).toMatchObject({
        status: "failed",
        reason: "semantic-coverage",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects a lone story narrowly and shared source as the full matrix", async () => {
    const root = await fixtureRepository();
    try {
      const story = join(root, "packages/ui/src/atoms/Button.stories.tsx");
      await writeFile(
        story,
        'export default { title: "Fixture/Button changed" };\n',
      );
      git(root, "add", ".");
      git(root, "commit", "-qm", "test: change one story");
      let result = capture(root, "--changed");
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect((await manifest(root)).selection.caseIds).toEqual([
        "ui.button.contract.fixture",
      ]);

      const source = join(root, "packages/ui/src/atoms/Button.tsx");
      await writeFile(source, "export const Button = 2;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "test: change shared source");
      result = capture(root, "--changed");
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect((await manifest(root)).selection.caseIds).toEqual([
        "ui.button.contract.fixture",
        "ui.thing.contract.fixture",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.describe("static Storybook server", () => {
  test("answers 404 and keeps serving when an asset read fails", async () => {
    // Dynamic import: `capture-stories.mjs` is plain JavaScript and this
    // package sets `allowJs: false`, so the module is outside the TypeScript
    // program and a static import would not resolve.
    const { startStaticStorybook } = (await import(
      join(packageRoot, "scripts/capture-stories.mjs")
    )) as {
      startStaticStorybook: (
        directory: string,
      ) => Promise<{ server: Server; baseURL: string }>;
    };
    const root = await mkdtemp(join(tmpdir(), "bakery-ui-server-"));
    // `stat` resolves for the directory, so the handler picks a content type
    // and commits to a 200 before it learns the body is unreadable: this
    // directory holds no index.html.
    await mkdir(join(root, "empty"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html>ok\n");
    const { server, baseURL } = await startStaticStorybook(root);
    try {
      const missing = await fetch(`${baseURL}/empty/`);
      expect(missing.status).toBe(404);
      const served = await fetch(`${baseURL}/index.html`);
      expect(served.status).toBe(200);
      expect(await served.text()).toContain("ok");
    } finally {
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  });
});
