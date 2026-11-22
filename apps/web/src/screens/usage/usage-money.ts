/**
 * Money arithmetic for the usage page.
 *
 * Every figure the server sends is a decimal string in dollars with up to six
 * places, and a micro-dollar is a whole number. Summing in whole micros means
 * no rounding step exists to be right or wrong at any magnitude; the float
 * route happens to agree at today's figures only because it rounds back to the
 * same micros, which is a fact about the magnitudes and not about the code.
 */

/** Adds two decimal strings exactly, in micro-dollars. */
export function addDecimalStrings(left: string, right: string): string {
  const scale = 1_000_000n;
  const micros = (value: string): bigint => {
    const trimmed = value.trim();
    const negative = trimmed.startsWith("-");
    const digits = negative ? trimmed.slice(1) : trimmed;
    const [whole, fraction = ""] = digits.split(".");
    const padded = fraction.padEnd(6, "0").slice(0, 6);
    const total = BigInt(whole || "0") * scale + BigInt(padded || "0");
    return negative ? -total : total;
  };
  const total = micros(left) + micros(right);
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(6, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Money as the page shows it: two places and grouped thousands.
 *
 * A cost table that mixes "$41.5" with "$500" makes a reader compare digits
 * that are not in the same place, and "$1000" is easy to misread by a factor
 * of ten. The server's figure is exact; this only puts it in the shape money
 * is read in. The six places are rounded half up to the cent, in whole
 * micro-dollars so no float is involved. A cost that is not zero but is under a
 * cent is not "$0.00": a cell that says so says the work was free, which is a
 * claim nobody measured. The caller words it ("Less than $0.01") from the
 * smallest amount, formatted as money, so the sentence lives in the catalogue.
 */
export function usd(
  amount: string,
  lessThan: (smallest: string) => string,
): string {
  const [whole = "0", fraction = ""] = amount.trim().split(".");
  const negative = whole.startsWith("-");
  const dollars = BigInt((negative ? whole.slice(1) : whole) || "0");
  const micros = dollars * 1_000_000n +
    BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
  const cents = (micros + 5_000n) / 10_000n;
  if (cents === 0n && micros > 0n) {
    const smallest = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(0.01);
    // "Less than $0.01" states the size, so it is as true of a tiny credit as of
    // a tiny cost; a minus sign would turn it into its opposite.
    return lessThan(smallest);
  }
  const grouped = (cents / 100n).toString().replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `${negative && cents > 0n ? "-" : ""}$${grouped}.${rest}`;
}

/** Compares two decimal strings exactly, in micro-dollars: negative, zero or positive. */
export function compareDecimalStrings(left: string, right: string): number {
  const difference = addDecimalStrings(left, negateDecimalString(right));
  if (difference.startsWith("-")) return -1;
  return difference === "0" ? 0 : 1;
}

/** Subtracts the second decimal string from the first, exactly. */
export function subtractDecimalStrings(left: string, right: string): string {
  return addDecimalStrings(left, negateDecimalString(right));
}

function negateDecimalString(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("-") ? trimmed.slice(1) : `-${trimmed}`;
}
