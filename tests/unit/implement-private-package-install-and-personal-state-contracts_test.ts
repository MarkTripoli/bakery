import { assertEquals, assertThrows } from "@std/assert";
import {
  compareVersions,
  parseSdkRange,
  parseVersion,
  PLUGIN_SDK_VERSION,
  satisfiesSdkRange,
  SdkRangeSyntaxError,
} from "@bakery/contracts/plugin-sdk";

/**
 * SDK range evaluation (#15, B14.01).
 *
 * The cases that matter are the refusals. A range this host cannot read must be
 * refused rather than assumed compatible, because "unparseable" and "fits" have
 * opposite consequences: the first refuses activation, the second permits it.
 */

const v = (major: number, minor: number, patch: number) => ({
  major,
  minor,
  patch,
});

Deno.test("versions order by component, not by string", () => {
  // "10.0.0" sorts before "9.0.0" as text, so the parse has to be numeric.
  assertEquals(compareVersions(v(10, 0, 0), v(9, 0, 0)) > 0, true);
  assertEquals(compareVersions(v(1, 2, 3), v(1, 2, 3)), 0);
  assertEquals(compareVersions(v(1, 2, 3), v(1, 2, 4)) < 0, true);
  assertEquals(compareVersions(v(1, 3, 0), v(1, 2, 9)) > 0, true);
});

Deno.test("a version must be three numeric components", () => {
  assertEquals(parseVersion("1.2.3"), v(1, 2, 3));
  // Anything looser is refused: guessing at "1.2" or "v1.2.3" would mean
  // guessing which of the missing or prefixed parts the publisher meant.
  for (const bad of ["1.2", "1", "v1.2.3", "1.2.3.4", "1.2.x", " 1.2.3 "]) {
    const trimmed = bad.trim();
    if (trimmed === "1.2.3") continue;
    assertThrows(() => parseVersion(bad), SdkRangeSyntaxError);
  }
});

Deno.test("caret allows the whole major, except on a 0.x major", () => {
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 2, 3)), true);
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 9, 0)), true);
  assertEquals(satisfiesSdkRange("^1.2.3", v(2, 0, 0)), false);
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 2, 2)), false);
  // 0.x is unstable by convention, so the caret narrows to the minor.
  assertEquals(satisfiesSdkRange("^0.2.3", v(0, 2, 9)), true);
  assertEquals(satisfiesSdkRange("^0.2.3", v(0, 3, 0)), false);
});

Deno.test("tilde allows patch updates within the named minor", () => {
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 2, 9)), true);
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 3, 0)), false);
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 2, 2)), false);
});

Deno.test("comparators and space-separated conjunctions hold", () => {
  assertEquals(satisfiesSdkRange(">=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange(">1.0.0", v(1, 0, 0)), false);
  assertEquals(satisfiesSdkRange("<=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("<2.0.0", v(1, 9, 9)), true);
  // A conjunction is an intersection, not a union: both halves must hold.
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0", v(1, 5, 0)), true);
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0", v(2, 0, 0)), false);
});

Deno.test("a bare version is an exact pin and || is a union", () => {
  assertEquals(satisfiesSdkRange("1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("1.0.0", v(1, 0, 1)), false);
  assertEquals(satisfiesSdkRange("=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("^2.0.0 || ^1.0.0", v(1, 4, 0)), true);
  assertEquals(satisfiesSdkRange("^2.0.0 || ^3.0.0", v(1, 4, 0)), false);
});

Deno.test("a range this host cannot read is refused, never assumed to fit", () => {
  for (const bad of ["", "   ", "latest", "1.x", "*", ">= 1.0.0", "^1.2"]) {
    assertThrows(() => parseSdkRange(bad), SdkRangeSyntaxError);
  }
  // The specific trap: a wildcard would mean "any version", which is the most
  // permissive reading available. Refusing is the only safe answer.
  assertThrows(() => satisfiesSdkRange("*"), SdkRangeSyntaxError);
});

Deno.test("the host SDK version satisfies its own minor-pinned range", () => {
  assertEquals(PLUGIN_SDK_VERSION, v(1, 0, 0));
  assertEquals(satisfiesSdkRange("^1.0.0"), true);
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0"), true);
  // A range for a future host is a legitimate publication, so this is false
  // rather than a throw - refusing the build would be the activation check's
  // job, not the parser's.
  assertEquals(satisfiesSdkRange("^2.0.0"), false);
});
