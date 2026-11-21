/**
 * Proves the size sentences render with the real translator, so a "NaN bytes"
 * regression cannot hide behind a stub (#759).
 *
 * Every call site passes an already formatted size ("310.3 KB"), so these keys
 * must take `{size}` as text; `{size, number}` turns that string into NaN.
 */
import { createTranslator } from "../../packages/i18n/src/index.ts";

const t = createTranslator({ locale: "en" });
const cases: readonly (readonly [string, Record<string, string>])[] = [
  ["artifact.retrieval.sizeValue", { size: "310.3 KB" }],
  ["artifact.retrieval.versionSummary", {
    mediaType: "video/mp4",
    size: "310.3 KB",
  }],
  ["artifact.view.description", {
    author: "ana",
    step: "step-1",
    size: "310.3 KB",
  }],
  ["tasks.artifactPane.preview", {}],
];
let bad = 0;
for (const [key, args] of cases) {
  const out = t(key as never, args as never);
  const wrong = /NaN|undefined|\{size/.test(out);
  if (wrong) bad++;
  console.log(`${wrong ? "BAD " : "ok  "} ${key} => ${out}`);
}
console.log(bad === 0 ? "no NaN, no placeholder left" : `${bad} bad`);
Deno.exit(bad === 0 ? 0 : 1);
