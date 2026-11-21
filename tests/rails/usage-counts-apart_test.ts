/**
 * The usage page shows three figures, and two of them are counts of records:
 * "Reported, not confirmed" and "Cost unknown". They are different
 * populations - a record that reported a cost the provider has not confirmed,
 * and a record that reported nothing at all.
 *
 * The screen printed "2 records" under "Reported, not confirmed" for one
 * report beside one silence, because the server counted every record without a
 * receipt, which includes the silent ones. A count of neither population is a
 * worse answer than no count, so this rail holds the server's two filters
 * apart: the unknown count asks for `measurement = 'unknown'`, and the
 * unconfirmed count must exclude those same records.
 */
import { assert, assertStringIncludes } from "@std/assert";

const SOURCE = new URL(
  "../../apps/server/src/modules/work/usage.ts",
  import.meta.url,
);

Deno.test("the two usage counts never count the same record twice", async () => {
  const source = await Deno.readTextFile(SOURCE);

  // The unknown count and the unconfirmed count, as the query writes them.
  const unknownAt = source.indexOf(
    `count(*) filter (where usage.measurement = 'unknown')`,
  );
  assert(unknownAt >= 0, "the unknown count no longer filters on measurement");

  const unverifiedAt = source.indexOf(`as "unverifiedCount"`);
  assert(unverifiedAt >= 0, "the unconfirmed count is gone");

  const unverifiedFilter = source.slice(
    source.lastIndexOf("count(*) filter", unverifiedAt),
    unverifiedAt,
  );
  assertStringIncludes(
    unverifiedFilter,
    "usage.measurement <> 'unknown'",
    "the unconfirmed count must exclude records with no cost at all, or it " +
      "counts the same silence twice",
  );
  assert(
    unverifiedFilter.indexOf("usage.measurement <> 'unknown'") <
      unverifiedFilter.indexOf("provider-authoritative"),
    "the measurement filter must stay part of the same filter clause as the " +
      "receipt check",
  );
});
