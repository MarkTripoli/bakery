/**
 * Copies the web app's design tokens and typeface into the desktop window's page, so the app uses
 * the very files the web does and no number is typed twice. Run before the app is built; its
 * output (`web/foundations/` and `web/fonts/`) is generated and not committed.
 *
 * The font faces in the web's `index.css` point at files outside this package, so the five token
 * and theme files are copied and `panel.css` declares the same faces against the copied fonts.
 */
const FILES = [
  "tokens.css",
  "theme.css",
  "responsive.css",
  "focus.css",
  "motion.css",
];

// Geist, the web's typeface, with its licence: the files the web's own font faces use.
const FONTS = [
  "geist-400.ttf",
  "geist-500.ttf",
  "geist-600.ttf",
  "geist-OFL.txt",
];

const source = new URL(
  "../../../packages/ui/src/foundations/",
  import.meta.url,
);
const target = new URL("../web/foundations/", import.meta.url);
const fontSource = new URL(
  "../../../docs/technical-design/enterprise-mocks/fonts/",
  import.meta.url,
);
const fontTarget = new URL("../web/fonts/", import.meta.url);

await Deno.mkdir(target, { recursive: true });
for (const name of FILES) {
  await Deno.copyFile(new URL(name, source), new URL(name, target));
}
await Deno.mkdir(fontTarget, { recursive: true });
for (const name of FONTS) {
  await Deno.copyFile(new URL(name, fontSource), new URL(name, fontTarget));
}
console.log(
  `copied ${FILES.length} foundation files and ${FONTS.length} font files to apps/desktop/web`,
);
