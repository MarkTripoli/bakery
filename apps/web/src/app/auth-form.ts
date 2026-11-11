import { useCallback, useRef, useState } from "react";

/**
 * Guards a form submission handler so at most one submission is in flight at
 * a time. A second call while the first is still running is a no-op — the
 * `inFlight` ref (not the `submitting` state, which only updates on the next
 * render) is what actually blocks a double-click that lands before repaint.
 * Every auth form pairs `submitting` with `Button loading` (which keeps its
 * width and disables itself) and calls `run` from its `onSubmit`.
 */
export function useSingleFlightSubmit<T>(
  submit: () => Promise<T>,
): readonly [submitting: boolean, run: () => Promise<T | undefined>] {
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(async () => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setSubmitting(true);
    try {
      return await submit();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [submit]);
  return [submitting, run] as const;
}

/**
 * Focuses the first invalid field, in the caller's declared (DOM) order,
 * after a validation or provider failure has set field-level errors. A
 * screen with no per-field errors (a form-level failure, e.g.
 * `INVALID_CREDENTIALS`) simply passes an all-`false` list and this is a
 * no-op — the status region already carries the failure via `AuthEntry
 * status`/`AlertBanner`.
 */
export function focusFirstInvalidField(
  fields: readonly { readonly id: string; readonly invalid: boolean }[],
): void {
  const first = fields.find((field) => field.invalid);
  if (!first) return;
  document.getElementById(first.id)?.focus();
}

/**
 * Resolves a provider failure code to the i18n key the plan's mapping table
 * names for that screen. Each screen supplies only the subset of
 * `AuthProviderFailureCode` it can actually observe (per its row in the
 * plan); any other code — including ones the client, by design, never throws
 * for that call — falls back to the screen's own `unavailable` key.
 */
export function providerFailureMessageKey<Code extends string, Key>(
  code: Code,
  mapping: Readonly<Partial<Record<Code, Key>>>,
  fallback: Key,
): Key {
  return mapping[code] ?? fallback;
}
