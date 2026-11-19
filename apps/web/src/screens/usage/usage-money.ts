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

/** Money as the page shows it: the server's figure with its unit. */
export function usd(amount: string): string {
  return `$${amount}`;
}
