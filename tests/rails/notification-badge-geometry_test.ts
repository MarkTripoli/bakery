import { assert, assertEquals } from "@std/assert";

/**
 * The badge's placement is a design number, not a taste: it sits on the bell
 * icon's own corner, overlaps at most 8x8px of it, and is one rule for both the
 * desktop bar and the phone. Stills prove what the pixels did on the day; they
 * do not run in CI, so they cannot stop the next seat from re-breaking it.
 *
 * This rail reads the stylesheet and the component and re-derives the numbers
 * from the tokens, so it fails for the reasons the design would fail:
 *
 *   - the pill's height stops being the 16px line it is drawn from;
 *   - the overlap stops being 8px, or stops being measured from the glyph;
 *   - a width-scoped override creeps back in, which is what made the desktop
 *     and the phone disagree in the first place;
 *   - the anchor stops being a logical inset, which is what mirrors it in a
 *     right-to-left page;
 *   - the cap loses its left-to-right isolation and a right-to-left page draws
 *     "+99".
 */
const SPACE_PREFIX = "--space-";

/** Reads a `--token: <n>px` value out of the generated token stylesheet. */
function spaceValue(tokensCss: string, name: string): number {
  const match = tokensCss.match(
    new RegExp(`${SPACE_PREFIX}${name}:\\s*(\\d+(?:\\.\\d+)?)px`),
  );
  assert(match, `tokens.css has no --space-${name} in px`);
  return Number(match[1]);
}

/**
 * The declarations of one rule, without its selector or inner braces. A missing
 * rule is null rather than a thrown error: the rail exists to say what is
 * wrong, and "there is no such rule" is one of the things that can be wrong.
 */
function ruleBody(css: string, selector: string): string | null {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`${selector} is not closed`);
}

/**
 * A `calc(var(--space-N) * -M)`, or `calc(100% - var(--space-N) * M)`, in px.
 * Returns null when the declaration is absent or shaped differently, so a
 * rewrite that quietly changes the form is reported rather than ignored.
 */
function offsetFromEdge(
  body: string,
  property: string,
  tokensCss: string,
): number | null {
  const declaration = body.match(
    new RegExp(`${property}:\\s*calc\\(([^;]+)\\)`),
  );
  if (!declaration) return null;
  const expression = declaration[1];
  const againstSpace = expression.match(
    new RegExp(`${SPACE_PREFIX}(\\d+)\\)\\s*\\*\\s*(-?\\d+(?:\\.\\d+)?)`),
  );
  if (!againstSpace) return null;
  const gap = spaceValue(tokensCss, againstSpace[1]);
  return Math.abs(Number(againstSpace[2])) * gap;
}

/**
 * Resolves a length to px the way the token sheet would: a bare number, or a
 * `var(--token)` this rail can look up. Null is "cannot re-derive", which the
 * caller reports rather than guessing.
 */
function resolveLength(value: string, tokensCss: string): number | null {
  const literal = value.match(/^(\d+(?:\.\d+)?)(?:px)?$/);
  if (literal) return Number(literal[1]);
  const byToken = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (byToken) {
    const declared = tokensCss.match(
      new RegExp(`${byToken[1]}:\\s*(\\d+(?:\\.\\d+)?)px`),
    );
    return declared ? Number(declared[1]) : null;
  }
  return null;
}

/**
 * Every `@media` block that re-*places* the badge. A block that only changes
 * how the badge fades is welcome; a block that moves it by width is the thing
 * that made the desktop and the phone disagree.
 */
function widthScopedBadgeRules(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/@media\s+([^{]+)\{/g)) {
    const start = match.index ?? 0;
    let depth = 0;
    let end = start;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    const block = css.slice(start, end);
    const anchors = block.includes(".ui-notification-bell__badge") ||
      block.includes(".ui-notification-bell__glyph");
    if (!anchors) continue;
    const repositions =
      /(?:^|[\s{;])(?:inset(?:-[a-z]+)*|top|right|bottom|left|position|margin(?:-[a-z]+)*|padding(?:-[a-z]+)*|translate)\s*:/
        .test(block);
    if (repositions) found.push(`@media ${match[1].trim()}`);
  }
  return found;
}

/**
 * The value of the LAST declaration of `property` in a rule body. CSS lets a
 * later declaration of the same property win, so reading the first one would
 * check a value the browser never uses.
 */
function lastDeclaration(body: string, property: string): string | null {
  const all = [
    ...body.matchAll(
      new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`, "g"),
    ),
  ];
  return all.length === 0 ? null : all[all.length - 1][1].trim();
}

/**
 * The block-axis space a rule adds around its content, in px: padding at both
 * ends plus the border at both ends. Each is read from the last declaration
 * that sets it (longhand or shorthand, whichever comes last in the rule).
 * Null means a value this rail cannot re-derive.
 */
function blockExtras(body: string, tokensCss: string): number | null {
  let padding = 0;
  let border = 0;
  const declarations = [
    ...body.matchAll(/(?:^|\n)\s*([a-z-]+):\s*([^;]+);/g),
  ];
  for (const [, property, raw] of declarations) {
    const parts = raw.trim().split(/\s+(?![^(]*\))/);
    if (property === "padding-block") {
      const lengths = parts.map((part) => resolveLength(part, tokensCss));
      if (lengths.includes(null)) return null;
      padding = (lengths[0] as number) + ((lengths[1] ?? lengths[0]) as number);
    } else if (property === "padding") {
      const lengths = parts.map((part) => resolveLength(part, tokensCss));
      if (lengths.includes(null)) return null;
      const top = lengths[0] as number;
      const bottom = (lengths[2] ?? lengths[0]) as number;
      padding = top + bottom;
    } else if (
      property === "border" || property === "border-block" ||
      property === "border-width" || property === "border-block-width"
    ) {
      // A shorthand's width is its first length (or token); `none` is no border.
      if (/^(?:none|0)$/.test(raw.trim())) {
        border = 0;
        continue;
      }
      const width = parts.map((part) => resolveLength(part, tokensCss)).find((
        value,
      ) => value !== null);
      if (width === undefined) {
        if (property.endsWith("width")) return null;
        continue;
      }
      border = (width as number) * 2;
    }
  }
  return padding + border;
}

/** Renders an offset for a message: an absent declaration is not "nullpx". */
function describeOffset(value: number | null): string {
  return value === null ? "no usable offset" : `${value}px`;
}

export function badgeGeometryViolations(
  css: string,
  tokensCss: string,
  component: string,
): string[] {
  const violations: string[] = [];
  const badge = ruleBody(css, ".ui-notification-bell__badge");
  const glyph = ruleBody(css, ".ui-notification-bell__glyph");
  const ring = ruleBody(css, ".ui-notification-bell__badge--unknown");
  if (badge === null) {
    violations.push("data.css has no .ui-notification-bell__badge rule");
  }
  const glyphMissing = glyph === null;
  if (glyphMissing) {
    violations.push("data.css has no .ui-notification-bell__glyph rule");
  }
  if (ring === null) {
    violations.push("data.css has no rule for the unknown ring");
  }
  const badgeBody = badge ?? "";
  const glyphBody = glyph ?? "";
  const ringBody = ring ?? "";

  // 1. The pill is 16px tall because it is drawn on --type-badge's line.
  if (!/(?:^|\n)\s*font:\s*var\(--type-badge\)/.test(badgeBody)) {
    violations.push("badge does not take its type from --type-badge");
  }
  const typeBadge = tokensCss.match(/--type-badge:\s*[^;]*?\/\s*(\d+)px/);
  if (typeBadge === null) {
    violations.push("tokens.css does not declare --type-badge with a px line");
  } else if (Number(typeBadge[1]) !== 16) {
    violations.push(
      `--type-badge carries a ${typeBadge[1]}px line; the design pins 16px`,
    );
  }

  // 2. The pill is drawn 16px tall by the declaration that WINS.
  //
  // The token above is the line the text is drawn on, not the height the pill
  // takes: `min-block-size` sets a floor, so it beats the line box, and any
  // other rule that sets a block size beats both. Checking only the token let a
  // 20px pill ship green, which is the defect this closes. So the winning
  // height is re-derived from whatever the rule actually declares.
  const declaredHeights: number[] = [];
  for (const property of ["min-block-size", "block-size", "height"] as const) {
    const value = lastDeclaration(badgeBody, property);
    if (value === null) continue;
    // `auto` and `0` defer to the line box rather than pinning a height, so
    // only a real length participates in the floor.
    if (/^(?:auto|0)$/.test(value)) continue;
    const resolved = resolveLength(value, tokensCss);
    if (resolved === null) {
      violations.push(
        `badge ${property} is ${value}, which this rail cannot re-derive`,
      );
      continue;
    }
    declaredHeights.push(resolved);
  }
  // The painted height also carries the block padding and border: a
  // content-box height gets them on top of it, a border-box height has them
  // inside it, but in both the pill can be taller than the number declared.
  const extras = blockExtras(badgeBody, tokensCss);
  const borderBox = lastDeclaration(badgeBody, "box-sizing") === "border-box";
  const linePx = typeBadge === null ? 0 : Number(typeBadge[1]);
  if (declaredHeights.length === 0) {
    violations.push(
      "badge declares no block size, so its height is the line box; the design pins a 16px pill",
    );
  } else if (extras === null) {
    violations.push(
      "badge padding or border is a value this rail cannot re-derive",
    );
  } else {
    const floor = Math.max(...declaredHeights);
    const painted = borderBox
      ? Math.max(floor, linePx + extras)
      : Math.max(floor, linePx) + extras;
    if (painted !== 16) {
      violations.push(
        `badge is ${painted}px tall${
          extras > 0 ? ` including ${extras}px of padding and border` : ""
        }; the design pins 16px`,
      );
    }
  }

  // 3. The offset is measured from the glyph's own box.
  if (!glyphMissing && !/position:\s*relative/.test(glyphBody)) {
    violations.push("the glyph is not the badge's positioning cell");
  }
  if (!/position:\s*absolute/.test(badgeBody)) {
    violations.push("the badge is not positioned against the glyph");
  }

  // 4. The overlap is 8x8, derived from the tokens rather than trusted.
  const overlapBlock = offsetFromEdge(
    badgeBody,
    "inset-block-start",
    tokensCss,
  );
  const overlapInline = offsetFromEdge(
    badgeBody,
    "inset-inline-start",
    tokensCss,
  );
  if (overlapBlock !== 8) {
    violations.push(
      `badge overhangs the icon vertically by ${
        describeOffset(overlapBlock)
      }; the design pins 8px`,
    );
  }
  if (overlapInline !== 8) {
    violations.push(
      `badge overhangs the icon inline by ${
        describeOffset(overlapInline)
      }; the design pins 8px`,
    );
  }

  // 5. One rule for both surfaces: nothing may re-place the badge by width.
  for (const query of widthScopedBadgeRules(css)) {
    violations.push(
      `${query} re-places the badge; the design pins one offset for both surfaces`,
    );
  }

  // 6. Logical insets are what mirror the pill in a right-to-left page.
  for (const physical of ["left", "right", "top", "bottom"]) {
    if (new RegExp(`(?:^|\\n)\\s*${physical}:`).test(badgeBody)) {
      violations.push(
        `badge uses the physical ${physical}; a logical inset mirrors it in a right-to-left page`,
      );
    }
  }

  // 7. The ring is 12px with a 6px overhang, per the same geometry.
  const ringSize = ringBody.match(/block-size:\s*var\(--space-(\d+)\)/);
  if (ringSize === null || spaceValue(tokensCss, ringSize[1]) !== 12) {
    violations.push("the unknown ring is not 12px");
  }
  for (
    const property of ["inset-block-start", "inset-inline-start"] as const
  ) {
    const overhang = offsetFromEdge(ringBody, property, tokensCss);
    if (overhang !== 6) {
      violations.push(
        `the unknown ring's ${property} is ${
          describeOffset(overhang)
        }; the design pins 6px`,
      );
    }
  }

  // 8. A count reads left to right in every locale. Without the isolate a
  // right-to-left page draws "99+" as "+99", which reads as another number.
  if (!/unicode-bidi:\s*isolate/.test(badgeBody)) {
    violations.push("the badge does not isolate its count's direction");
  }
  if (!/dir="ltr"/.test(component)) {
    violations.push(
      "the drawn cap is not marked left-to-right in the component",
    );
  }

  return violations;
}

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const css = await Deno.readTextFile(`${root}packages/ui/src/data.css`);
const tokensCss = await Deno.readTextFile(
  `${root}packages/ui/src/foundations/tokens.css`,
);
const component = await Deno.readTextFile(
  `${root}packages/ui/src/molecules/NotificationBell.tsx`,
);

Deno.test("the badge's geometry is the design's, derived from the tokens", () => {
  assertEquals(badgeGeometryViolations(css, tokensCss, component), []);
});

Deno.test("a width-scoped offset is reported, because it broke both surfaces", () => {
  const broken = `${css}
@media (min-width: 744px) {
  .ui-notification-bell__badge {
    inset-block-start: calc((var(--space-3) + var(--space-1)) * -1);
  }
}`;
  assert(
    badgeGeometryViolations(broken, tokensCss, component).some((violation) =>
      violation.includes("one offset for both surfaces")
    ),
  );
});

Deno.test("a pill that stops being 16px tall is reported", () => {
  const taller = tokensCss.replace(
    "--type-badge: 400 11px/16px",
    "--type-badge: 400 11px/20px",
  );
  assert(taller !== tokensCss, "the fixture did not change a token");
  assert(
    badgeGeometryViolations(css, taller, component).some((violation) =>
      violation.includes("the design pins 16px")
    ),
  );
});

Deno.test("an overlap that drifts off 8px is reported", () => {
  const drifted = css.replace(
    "inset-block-start: calc(var(--space-1) * -2);",
    "inset-block-start: calc(var(--space-1) * -3);",
  );
  assert(
    badgeGeometryViolations(drifted, tokensCss, component).some((violation) =>
      violation.includes("the design pins 8px")
    ),
  );
});

Deno.test("a physical inset is reported, because it kills the mirror", () => {
  const physical = css.replace(
    "inset-inline-start: calc(100% - var(--space-1) * 2);",
    "right: calc(var(--space-1) * -2);",
  );
  assert(
    badgeGeometryViolations(physical, tokensCss, component).some((violation) =>
      violation.includes("a logical inset mirrors it")
    ),
  );
});

Deno.test("a cap without its left-to-right isolate is reported", () => {
  const unisolated = css.replace("unicode-bidi: isolate;", "");
  assert(
    badgeGeometryViolations(unisolated, tokensCss, component).some((
      violation,
    ) => violation.includes("isolate its count's direction")),
  );
});

Deno.test("a pill taller than the design's 16px is reported even when the token still says 16px", () => {
  // The exact hole this check closes: `min-block-size` sets a floor and so beats
  // the line box, meaning a taller declaration wins while --type-badge stays
  // correct. Checking only the token reported nothing here.
  const taller = css.replace(
    "min-block-size: var(--space-4);",
    "min-block-size: 20px;",
  );
  assert(taller !== css, "the fixture did not change the rule it targets");
  assert(
    badgeGeometryViolations(taller, tokensCss, component).some((violation) =>
      violation.includes("the design pins 16px")
    ),
    "a 20px pill must be reported where a 16px token is also present",
  );
});

Deno.test("a pill sized only by its line box is reported as not pinned", () => {
  // Dropping the floor entirely leaves the height to the line box: 16px today,
  // but nothing in the rule states it, which is a different defect from tall.
  const unpinned = css.replace("min-block-size: var(--space-4);", "");
  assert(unpinned !== css, "the fixture did not change the rule it targets");
  assert(
    badgeGeometryViolations(unpinned, tokensCss, component).some((violation) =>
      violation.includes("the design pins a 16px pill")
    ),
    "a pill with no declared block size must be reported",
  );
});

Deno.test("the last declaration of a property is the one that is checked", () => {
  // CSS lets the later declaration win. The first one is 16px, the one the
  // browser draws is 20px: reading the first would report nothing.
  const doubled = css.replace(
    "min-block-size: var(--space-4);",
    "min-block-size: var(--space-4);\n  min-block-size: 20px;",
  );
  assert(doubled !== css, "the fixture did not change the rule it targets");
  assert(
    badgeGeometryViolations(doubled, tokensCss, component).some((violation) =>
      violation.includes("the design pins 16px")
    ),
    "a later 20px declaration must be reported over an earlier 16px one",
  );
});

Deno.test("block padding and border count toward the painted height", () => {
  const padded = css.replace(
    "padding-block: 0;",
    "padding-block: var(--space-1);",
  );
  assert(padded !== css, "the fixture did not change the rule it targets");
  assert(
    badgeGeometryViolations(padded, tokensCss, component).some((violation) =>
      violation.includes("of padding and border")
    ),
    "a 16px floor with 4px of padding at each end paints 24px",
  );
  const bordered = css.replace(
    "padding-block: 0;",
    "padding-block: 0;\n  border-block: 1px solid var(--color-border);",
  );
  assert(
    badgeGeometryViolations(bordered, tokensCss, component).some((violation) =>
      violation.includes("of padding and border")
    ),
    "a 1px border at each end paints 18px",
  );
});
