import { StandardError } from "@bakery/contracts/http";

/**
 * Which ways of paying each coding agent accepts (#68), as the billing routes a
 * provider binding may name. The v1 rule, from 05-runtime-and-protocols.md
 * ("Models and harnesses"): Claude Code and Codex run on a subscription or on
 * metered API keys; Pi runs on metered API keys (OpenRouter) or a local model.
 *
 * The keys are the component keys a worker reports for each coding agent,
 * named after its harness (apps/worker/src/claude-harness.ts, codex-harness.ts,
 * pi-harness.ts). Any other key supports no route (fails closed, #68 ruling).
 */
export const CODING_AGENT_PAYMENT_METHODS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "harness.claude": Object.freeze(["subscription", "api_metered"]),
  "harness.codex": Object.freeze(["subscription", "api_metered"]),
  "harness.pi": Object.freeze(["api_metered", "local"]),
});

/** The billing routes a component accepts; empty when it is not a coding agent. */
export function paymentMethodsOf(componentKey: string): readonly string[] {
  return CODING_AGENT_PAYMENT_METHODS[componentKey] ?? [];
}

/**
 * Whether a binding's billing route is one its component accepts. A component
 * that is not a known coding agent accepts no route.
 */
export function paymentMethodSupported(
  componentKey: string,
  billingRoute: string,
): boolean {
  return paymentMethodsOf(componentKey).includes(billingRoute);
}

/**
 * Refuses a new or changed binding whose route its coding agent does not accept,
 * as a VALIDATION_FAILED issue on billingRoute coded payment_method_unsupported.
 * Existing bindings are never refused on read; they show as unsupported instead.
 */
export function requirePaymentMethodSupported(
  componentKey: string,
  billingRoute: string,
): void {
  if (!paymentMethodSupported(componentKey, billingRoute)) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: {
        issues: [{
          path: ["billingRoute"],
          code: "payment_method_unsupported",
          message: "This coding agent does not accept this way of paying.",
        }],
      },
    });
  }
}
