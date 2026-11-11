type Values = { light?: string; dark?: string; value?: string };
type PaperBinding = { light: string; dark: string } | { value: string };
export type TokenRole = {
  id: string;
  cssVariable: string;
  category: string;
  values: Values;
  paper?: PaperBinding | null;
  rationale?: string;
};
export type TokenManifest = {
  schemaVersion: number;
  source: { fileId: string; revision: string; digest: string };
  roles: TokenRole[];
};
export type PaperToken = { name: string; type: string; value: string };
export type PaperManifest = {
  contentHash: { tokens: string };
  tokens: PaperToken[];
};

const root = new URL("../", import.meta.url);
const manifestPath = new URL(
  "docs/technical-design/ui-baselines/tokens.json",
  root,
);
const paperManifestPath = new URL(
  "docs/technical-design/ui-baselines/paper-tokens.json",
  root,
);
const outputPaths = {
  ts: new URL("packages/ui/src/foundations/tokens.ts", root),
  css: new URL("packages/ui/src/foundations/tokens.css", root),
  theme: new URL("packages/ui/src/foundations/theme.css", root),
};
const supportedCategories = new Set([
  "borderWidth",
  "breakpoint",
  "color",
  "duration",
  "easing",
  "fontFamily",
  "fontWeight",
  "layer",
  "layout",
  "outline",
  "radius",
  "shadow",
  "size",
  "spacing",
  "stroke",
  "target",
  "tracking",
  "typography",
]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [k, v],
      ) => `${JSON.stringify(k)}:${stable(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stable(value)),
  );
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function validateManifest(manifest: TokenManifest): Promise<void> {
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported token schema version");
  }
  if (
    !manifest.source.fileId || !manifest.source.revision ||
    !/^[a-f0-9]{64}$/.test(manifest.source.digest)
  ) throw new Error("Incomplete token source metadata");
  const ids = new Set<string>();
  const variables = new Set<string>();
  for (const role of manifest.roles) {
    if (!/^[-a-z0-9.]+$/.test(role.id) || ids.has(role.id)) {
      throw new Error(`Invalid or duplicate role: ${role.id}`);
    }
    if (!supportedCategories.has(role.category)) {
      throw new Error(`Unsupported token category: ${role.category}`);
    }
    if (
      !/^--[a-z0-9-]+$/.test(role.cssVariable) ||
      variables.has(role.cssVariable)
    ) throw new Error(`Invalid or duplicate CSS variable: ${role.cssVariable}`);
    ids.add(role.id);
    variables.add(role.cssVariable);
    const values = role.values;
    if (values.value && (values.light || values.dark)) {
      throw new Error(`Mixed invariant/theme values: ${role.id}`);
    }
    if (!values.value && (!values.light || !values.dark)) {
      throw new Error(`Missing theme pair: ${role.id}`);
    }
    const valueKeys = Object.keys(values).sort();
    const expectedKeys = values.value ? ["value"] : ["dark", "light"];
    if (valueKeys.join(",") !== expectedKeys.join(",")) {
      throw new Error(`Unknown or incomplete token value keys: ${role.id}`);
    }
    for (const value of Object.values(values)) {
      if (!value?.trim() || /[{};]|\/\*|\*\//.test(value)) {
        throw new Error(`Unsafe or blank token value: ${role.id}`);
      }
    }
  }
  if (await digest(manifest.roles) !== manifest.source.digest) {
    throw new Error("Token source digest mismatch");
  }
}

function resolvePaperToken(
  name: string,
  tokens: ReadonlyMap<string, PaperToken>,
  seen: Set<string> = new Set(),
): string {
  const token = tokens.get(name);
  if (!token) throw new Error(`Unknown Paper token: ${name}`);
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(token.value);
  if (!reference) return token.value;
  if (seen.has(name)) {
    throw new Error(`Circular Paper token reference: ${name}`);
  }
  seen.add(name);
  return resolvePaperToken(reference[1], tokens, seen);
}

export function validatePaperAlignment(
  manifest: TokenManifest,
  paper: PaperManifest,
): void {
  const tokens = new Map(paper.tokens.map((token) => [token.name, token]));
  for (const role of manifest.roles) {
    const hasPaper = Object.hasOwn(role, "paper");
    if (role.category === "color" && !hasPaper) {
      throw new Error(`Color role missing Paper mapping: ${role.id}`);
    }
    if (!hasPaper || role.paper == null) {
      if (role.category === "color" && !role.rationale?.trim()) {
        throw new Error(
          `Color role with no Paper mapping needs a rationale: ${role.id}`,
        );
      }
      continue;
    }
    const valueKeys = Object.keys(role.values).sort().join(",");
    const paperKeys = Object.keys(role.paper).sort().join(",");
    if (valueKeys !== paperKeys) {
      throw new Error(`Paper mapping keys do not match values: ${role.id}`);
    }
    for (const key of Object.keys(role.values) as (keyof Values)[]) {
      const paperName = (role.paper as Record<string, string>)[key];
      const resolved = resolvePaperToken(paperName, tokens);
      const expected = role.values[key];
      if (resolved !== expected) {
        throw new Error(
          `Token ${role.id} (${key}) = ${expected} does not match Paper ${paperName} = ${resolved}`,
        );
      }
    }
  }
}

function render(manifest: TokenManifest) {
  const roles = [...manifest.roles].sort((a, b) =>
    a.cssVariable.localeCompare(b.cssVariable)
  );
  const header =
    `/* Generated from Paper ${manifest.source.fileId} revision ${manifest.source.revision}; digest ${manifest.source.digest}. */\n`;
  const invariant = roles.filter((r) => r.values.value);
  const light = roles.filter((r) => r.values.light);
  const dark = roles.filter((r) => r.values.dark);
  const declarations = (list: TokenRole[], key: keyof Values) =>
    list.map((r) => `  ${r.cssVariable}: ${r.values[key]};`).join("\n");
  const css = `${header}:root {\n${declarations(invariant, "value")}\n${
    declarations(light, "light")
  }\n}\n`;
  const theme =
    `${header}:root,\n[data-theme="light"] {\n  color-scheme: light;\n${
      declarations(light, "light")
    }\n}\n\n[data-theme="dark"] {\n  color-scheme: dark;\n${
      declarations(dark, "dark")
    }\n}\n`;
  const entries = roles.map((r) =>
    `  ${JSON.stringify(r.id)}: ${JSON.stringify(r.cssVariable)},`
  ).join("\n");
  const ts =
    `${header}export const semanticTokens = {\n${entries}\n} as const;\nexport type SemanticToken = keyof typeof semanticTokens;\n`;
  return { ts, css, theme };
}

export async function generate(check = false): Promise<void> {
  const manifest = JSON.parse(
    await Deno.readTextFile(manifestPath),
  ) as TokenManifest;
  const paper = JSON.parse(
    await Deno.readTextFile(paperManifestPath),
  ) as PaperManifest;
  await validateManifest(manifest);
  validatePaperAlignment(manifest, paper);
  const files = render(manifest);
  for (const [key, content] of Object.entries(files)) {
    const path = outputPaths[key as keyof typeof outputPaths];
    if (check) {
      if (await Deno.readTextFile(path) !== content) {
        throw new Error(`Generated output drift: ${path.pathname}`);
      }
    } else await Deno.writeTextFile(path, content);
  }
}

if (import.meta.main) await generate(Deno.args.includes("--check"));
