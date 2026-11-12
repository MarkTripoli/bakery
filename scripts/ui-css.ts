export type CssPolicy = "shared" | "consumer";

export type CssDefect = {
  path: string;
  line: number;
  column: number;
  message: string;
};

export type DiscoveredStylesheet = { path: string; policy: CssPolicy };

const localVariables = new Set(["--gutter", "--target-min"]);
const structuralLines = [
  /^block-size: 1px$/,
  /^inline-size: 1px$/,
  /^min-block-size: 100dvh$/,
  /^max-block-size: 28rem$/,
  /^max-block-size: calc\(100dvb - var\(--space-8\)\)$/,
  /^block-size: 100dvb$/,
  // Conversation column: the viewport below the 64px shell header.
  /^block-size: calc\(100dvb - var\(--layout-header\)\)$/,
  /^max-inline-size: 24rem$/,
  /^min-inline-size: 16rem$/,
  /^min-inline-size: 200px$/,
  /^max-inline-size: 65ch$/,
  /^max-inline-size: 32ch$/,
  // HelpTip's phone panel: at most half the screen, longer text scrolls inside it.
  /^max-block-size: 50dvb$/,
  /^max-inline-size: min\(360px, calc\(100vw - var\(--space-8\)\)\)$/,
  /^max-inline-size: min\(var\(--layout-dialog\), calc\(100dvi - var\(--space-8\)\)\)$/,
  // HelpTip's tooltip: the inspector width, bounded by the logical viewport.
  /^max-inline-size: min\(var\(--layout-inspector\), calc\(100dvi - var\(--space-8\)\)\)$/,
  /^inline-size: min\(100%, 32ch\)$/,
  /^inline-size: min\(var\(--layout-content\), 100dvi\)$/,
  // Tokenized E05 dialog width, bounded by the logical viewport with a token gutter.
  /^inline-size: min\(calc\(var\(--layout-dialog\) - var\(--space-10\)\), calc\(100dvi -\s+var\(--space-8\)\)\)$/,
  /^block-size: 20px$/,
  /^inline-size: 120px$/,
  /^block-size: 160px$/,
  /^grid-template-columns: minmax\(10rem, 2fr\) minmax\(6rem, 1fr\) minmax\(8rem, 1fr\)\s+auto$/,
  /^grid-template-columns: minmax\(0, 1fr\) minmax\(12rem, 20rem\)$/,
  /^grid-template-columns: minmax\(12rem, 20rem\)$/,
  /^grid-template-columns: minmax\(7rem, 0.35fr\) minmax\(0, 1fr\)$/,
  /^grid-template-columns: minmax\(0, 0.35fr\) minmax\(0, 1fr\)$/,
  // Paper E-0 Work queue columns incl. leading 12px gap (paper-source/5J-0.jsx).
  /^inline-size: 140px$/, // Application 128
  /^inline-size: 146px$/, // Stage 134
  /^inline-size: 100px$/, // Harness 88
  /^inline-size: 72px$/, // Age 48 + 12px row inset
  // Paper V-0 authentication artboards (docs/technical-design/auth-mocks/auth.css).
  /^gap: 36px$/, // auth.css:9 .brand-content
  /^max-inline-size: 340px$/, // auth.css:9 .brand-content
  /^max-inline-size: 320px$/, // auth.css:9 .full-logo
  /^max-inline-size: 330px$/, // auth.css:9 .brand-content h2
  /^max-inline-size: 296px$/, // auth.css:9 .brand-steps
  /^gap: 18px$/, // auth.css:9 .brand-steps .item
  /^gap: 28px$/, // auth.css:9 .form-content; also .brand-content tablet (auth.css:12)
  /^padding: 56px 48px$/, // auth.css:9 .form-pane
  /^max-inline-size: 380px$/, // auth.css:9 .form-content
  /^padding-inline: 28px$/, // auth.css:12 .brand-pane tablet
  /^max-inline-size: 260px$/, // auth.css:12 .full-logo tablet
  /^grid-template-columns: 260px minmax\(0, 1fr\)$/, // auth.css:12 .context-box tablet
  /^inline-size: 180px$/, // auth.css:13 .form-pane>.mobile-logo phone
  /^max-inline-size: 420px$/, // auth.css:13 .form-content, .form-bottom phone
  /^padding: 56px 40px$/, // auth.css:10 .context-layout
  /^grid-template-columns: 300px 440px$/, // auth.css:10 .context-box
  /^inline-size: 740px$/, // auth.css:10 .context-box
  /^padding: 40px 28px$/, // auth.css:10 .context-summary
  /^block-size: 28px$/, // auth.css:10 .small-brand img
  /^inline-size: 28px$/, // auth.css:10 .small-brand img
  /^block-size: 52px$/, // auth.css:21 .otp-input
  /^max-inline-size: 280px$/, // auth.css:21 .otp-input
  /^padding-inline: 14px$/, // auth.css:8 .notice
  /^block-size: 36px$/, // auth.css:8 .avatar
  /^inline-size: 36px$/, // auth.css:8 .item>.avatar, .item>.icon
  /^padding: 2px 7px$/, // auth.css:8 .badge
  /^max-inline-size: 760px$/, // auth.css:10 .settings-content max-width:840px less its 40px padding (the app shell's <main> gutter)
  /^max-inline-size: 520px$/, // auth.css:10 .settings-content>.form-content
  /^gap: 3px$/, // auth.css:8 .item h3 margin:0 0 3px
  /^block-size: 176px$/, // auth.css:22 .totp-qr
  /^inline-size: 176px$/, // auth.css:22 .totp-qr
  /^min-inline-size: 190px$/, // auth.css:22 .qr-setup>.stack
  // Installation settings template: 45rem form measure, 12.5rem label column, 18px radio glyph.
  /^max-inline-size: 45rem$/,
  /^grid-template-columns: 12.5rem minmax\(0, 1fr\)$/,
  /^inline-size: 1.125rem$/,
  /^block-size: 1.125rem$/,
  // AccessSettings template: Paper 820px column and fixed value/skeleton/fade measures.
  /^max-inline-size: 820px$/,
  /^inline-size: 160px$/, // access row cell
  /^inline-size: 340px$/, // access detail cell
  /^inline-size: 56px$/, // access row fade
  /^inline-size: 260px$/, // access skeleton line
  /^inline-size: 200px$/, // access skeleton line, phone
  /^block-size: 56px$/, // access skeleton row, phone
];

const allowedMediaQueries = new Set([
  "@media (min-width: 744px)",
  "@media (min-width: 1280px)",
  "@media (max-width: 1279px)",
  "@media (max-width: 743px)",
  "@media (max-width: 640px)",
  "@media (max-width: 420px)", // auth.css:24 small-phone band
  "@media (pointer: fine)",
  "@media (pointer: coarse)",
  "@media (prefers-reduced-motion: reduce)",
  // Tablet band for the Paper auth-mocks brand pane (auth.css:12).
  "@media (min-width: 744px) and (max-width: 1100px)",
]);

const visualProperties = new Set([
  "border",
  "border-block-end",
  "border-block-start",
  "border-inline-end",
  "border-inline-start",
  "border-radius",
  "box-shadow",
  "z-index",
  "outline",
  "outline-offset",
  "stroke-width",
  "animation-duration",
  "transition-duration",
]);

const colorProperties = new Set([
  "accent-color",
  "background",
  "background-color",
  "border-block-end-color",
  "border-block-start-color",
  "border-color",
  "border-inline-end-color",
  "border-inline-start-color",
  "color",
  "fill",
  "outline-color",
  "stroke",
  "text-decoration-color",
]);

const allowedColorKeywords = new Set([
  "currentcolor",
  "inherit",
  "initial",
  "none",
  "revert",
  "revert-layer",
  "transparent",
  "unset",
]);

const generatedUiExclusions = new Set([
  "src/foundations/tokens.css",
  "src/foundations/theme.css",
  "src/foundations/index.css",
]);

const evidenceSurfacePattern = /(?:^|\/)(?:\.storybook|storybook-static)\//;

function locate(
  source: string,
  index: number,
): { line: number; column: number } {
  const line = source.slice(0, index).split("\n").length;
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return { line, column: index - lineStart + 1 };
}

export function validateCss(
  path: string,
  source: string,
  generatedVariables: ReadonlySet<string>,
  policy: CssPolicy = "shared",
): CssDefect[] {
  const defects: CssDefect[] = [];
  const add = (index: number, message: string) => {
    const { line, column } = locate(source, index);
    defects.push({ path, line, column, message });
  };
  for (
    const match of source.matchAll(
      /(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/gi,
    )
  ) {
    add(match.index ?? 0, "raw color");
  }
  for (
    const match of source.matchAll(
      /\b(font(?:-size|-weight)?|line-height|letter-spacing)\s*:\s*([^;{}]+)/g,
    )
  ) {
    const value = match[2].trim();
    if (!/^(?:inherit\b|var\()/.test(value)) {
      add(match.index ?? 0, `raw typography ${match[0].trim()}`);
    }
  }
  for (const match of source.matchAll(/\b([a-z-]+):\s*([^;{}]+)/g)) {
    const property = match[1];
    const value = match[2].trim();
    const declaration = `${property}: ${value}`;
    if (
      colorProperties.has(property) &&
      !value.startsWith("var(") &&
      !allowedColorKeywords.has(value.toLowerCase())
    ) {
      add(match.index ?? 0, `raw color ${declaration}`);
    }
    if (visualProperties.has(property) && !value.startsWith("var(")) {
      add(match.index ?? 0, `raw visual value ${declaration}`);
    }
    if (
      /^(?:gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|(?:min|max-)?(?:block|inline)-size|grid-template-columns)$/
        .test(property) &&
      /\b\d+(?:\.\d+)?(?:px|rem|ch|dvb|dvi|vw|vh)\b/.test(value) &&
      (policy !== "shared" ||
        !structuralLines.some((allowed) => allowed.test(declaration)))
    ) {
      add(match.index ?? 0, `raw structural value ${declaration}`);
    }
  }
  for (const match of source.matchAll(/@media\s+([^\{]+)\{/g)) {
    const query = `@media ${match[1].trim()}`;
    if (!allowedMediaQueries.has(query)) {
      add(match.index ?? 0, `raw media query ${query}`);
    }
  }
  for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    const name = match[1];
    const allowed = generatedVariables.has(name) ||
      (policy === "shared" && localVariables.has(name));
    if (!allowed) {
      add(match.index ?? 0, `unknown variable ${name}`);
    }
  }
  for (
    const match of source.matchAll(
      /(?:^|[;{}])\s*(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gm,
    )
  ) {
    const name = match[1];
    const value = match[2].trim();
    const generated = generatedVariables.has(name);
    const local = policy === "shared" && localVariables.has(name);
    if (generated && policy === "consumer") {
      add(
        (match.index ?? 0) + match[0].indexOf(name),
        `consumer CSS may not redefine generated variable ${name}`,
      );
    } else if (!generated && !local) {
      add(
        (match.index ?? 0) + match[0].indexOf(name),
        `unknown custom property ${name}`,
      );
    } else if (local && !value.startsWith("var(")) {
      add(
        (match.index ?? 0) + match[0].indexOf(name),
        `raw responsive value ${name}: ${value}`,
      );
    }
  }
  return defects.sort((a, b) =>
    a.line - b.line || a.column - b.column ||
    a.message.localeCompare(b.message)
  );
}

export function formatCssDefect(defect: CssDefect): string {
  return `${defect.path}:${defect.line}:${defect.column}: ${defect.message}`;
}

async function collectStylesheets(dir: string, files: string[]) {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectStylesheets(full, files);
    } else if (entry.isFile && entry.name.endsWith(".css")) {
      files.push(full);
    }
  }
}

export async function discoverStylesheets(
  root: string,
): Promise<DiscoveredStylesheet[]> {
  const manifest = JSON.parse(await Deno.readTextFile(`${root}/package.json`));
  const discovered: DiscoveredStylesheet[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    const [base, leaf] = pattern.split("/");
    const baseDir = `${root}/${base}`;
    let baseStat;
    try {
      baseStat = await Deno.stat(baseDir);
    } catch {
      continue;
    }
    if (!baseStat.isDirectory) continue;
    for await (const entry of Deno.readDir(baseDir)) {
      if (!entry.isDirectory) continue;
      if (leaf && leaf !== "*" && leaf !== entry.name) continue;
      const dir = `${baseDir}/${entry.name}`;
      let packageStat;
      try {
        packageStat = await Deno.stat(`${dir}/package.json`);
      } catch {
        continue;
      }
      if (!packageStat.isFile) continue;
      const srcDir = `${dir}/src`;
      let srcStat;
      try {
        srcStat = await Deno.stat(srcDir);
      } catch {
        continue;
      }
      if (!srcStat.isDirectory) continue;
      const name = JSON.parse(
        await Deno.readTextFile(`${dir}/package.json`),
      ).name as string | undefined;
      const shared = name === "@bakery/ui";
      const files: string[] = [];
      await collectStylesheets(srcDir, files);
      for (const file of files.sort()) {
        const packagePath = file.slice(dir.length + 1);
        if (shared && generatedUiExclusions.has(packagePath)) continue;
        const workspacePath = file.slice(root.length + 1);
        if (evidenceSurfacePattern.test(`/${workspacePath}`)) continue;
        discovered.push({
          path: workspacePath,
          policy: shared ? "shared" : "consumer",
        });
      }
    }
  }
  return discovered.sort((a, b) => a.path.localeCompare(b.path));
}
