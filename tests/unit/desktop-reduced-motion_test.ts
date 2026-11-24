import { assert, assertEquals } from "@std/assert";

const css = Deno.readTextFileSync(
  new URL("../../apps/desktop/web/panel.css", import.meta.url),
).replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

function rulesOf(source: string): Rule[] {
  const rules: Rule[] = [];
  for (const match of source.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

function reducedMotionBlocks(): string[] {
  const blocks: string[] = [];
  const start = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (const match of css.matchAll(start)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const from = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(from, i - 1));
  }
  return blocks;
}

Deno.test("every animation and transition on the desktop page stops under reduced motion", () => {
  const outside = css.replace(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\}\s*\}/g,
    "",
  );
  const moving = rulesOf(outside).filter((rule) =>
    /\b(animation|transition)(-[a-z]+)?\s*:/.test(rule.body) &&
    !/@keyframes/.test(rule.selector)
  );
  assert(moving.length >= 1, "the page's moving rules were not found");
  const stopped = reducedMotionBlocks().flatMap(rulesOf);
  const unguarded = moving.filter((rule) =>
    !stopped.some((guard) =>
      guard.selector === rule.selector &&
      /(animation(-duration)?|transition(-duration)?)\s*:\s*(none|0s|0ms)/.test(
        guard.body,
      )
    )
  ).map((rule) => rule.selector);
  assertEquals(
    unguarded,
    [],
    "these rules move and have no reduced-motion rule",
  );
});
