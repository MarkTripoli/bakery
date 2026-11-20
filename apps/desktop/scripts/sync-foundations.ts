/**
 * Copies the web app's design tokens into the desktop window's page, so the app uses the very
 * files the web does and no number is typed twice. Run before the app is built; its output
 * (`web/foundations/`) is generated and not committed.
 *
 * The font faces in the web's `index.css` point at mock files outside this package, so only the
 * five token and theme files are copied; text uses the web's font stack and falls back to the
 * system face, as design-ux's mocks do.
 */
const FILES = [
  "tokens.css",
  "theme.css",
  "responsive.css",
  "focus.css",
  "motion.css",
];

const source = new URL(
  "../../../packages/ui/src/foundations/",
  import.meta.url,
);
const target = new URL("../web/foundations/", import.meta.url);

await Deno.mkdir(target, { recursive: true });
for (const name of FILES) {
  await Deno.copyFile(new URL(name, source), new URL(name, target));
}
console.log(
  `copied ${FILES.length} foundation files to apps/desktop/web/foundations`,
);
