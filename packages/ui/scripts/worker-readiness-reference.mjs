// Execute only the admitted published JSX. No application controls or services.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const webRequire = createRequire(
  new URL("../../../apps/web/package.json", import.meta.url),
);
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function workerReadinessMarkup(directory, frameId) {
  const manifest = JSON.parse(
    await readFile(join(directory, "paper-manifest.json"), "utf8"),
  );
  const frame = manifest.screens.find((entry) => entry.nodeId === frameId);
  if (!frame) throw new Error(`Unknown K-0 frame ${frameId}`);
  // Validate all dependencies, not just the selected JSX. Missing inputs fail closed.
  for (const input of manifest.inputs) {
    if (sha256(await readFile(join(directory, input.path))) !== input.sha256) {
      throw new Error(`K-0 input hash mismatch: ${input.path}`);
    }
  }
  const theme = JSON.parse(
    await readFile(join(directory, "theme-values.json"), "utf8"),
  );
  const declarations = Object.entries(theme.tokens).map(([name, token]) => {
    const value = token["--color"] ??
      token.displayed.slice(name.length - 2).trim();
    // Paper displays dimension tokens as bare numbers; CSS lengths need units.
    const cssValue =
      /^(--text-|--leading-|--spacing-|--radius-|--container-)/.test(name)
        ? `${value}px`
        : value;
    return `${name}:${cssValue}`;
  }).join(";");
  const fonts = ["geist", "geist-mono"].flatMap((family) =>
    [400, 500, 600].map((weight) =>
      `@font-face{font-family:'${
        family === "geist" ? "Geist" : "Geist Mono"
      }';font-weight:${weight};src:url(fonts/${family}-${weight}.ttf)}`
    )
  ).join("\n");
  const source = await readFile(join(directory, frame.sourcePath), "utf8");
  const { transformWithOxc } = await import(webRequire.resolve("vite"));
  const { code } = await transformWithOxc(source, "paper.jsx", {
    jsx: { runtime: "classic" },
  });
  const Component = new Function(
    "React",
    code.replace("export default", "return"),
  )(React);
  let markup = renderToStaticMarkup(React.createElement(Component));
  for (const image of manifest.publicImages) {
    markup = markup.replaceAll(image.url, image.path);
  }
  return `<style>${fonts}\n:root{${declarations}}body{margin:0}</style>${markup}`;
}
