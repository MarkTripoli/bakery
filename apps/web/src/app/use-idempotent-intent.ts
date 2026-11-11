import { useCallback, useRef } from "react";

/**
 * Idempotency-Key holder for one user intent. `keyFor(signature)` reuses the
 * key while the signature (request body, plus anything else that changes the
 * request) is unchanged and mints a new key when it changes. `reset()` after
 * success.
 */
export function useIdempotentIntent(): {
  readonly keyFor: (signature: string) => string;
  readonly reset: () => void;
} {
  const intent = useRef<{ key: string; signature: string } | null>(null);
  const keyFor = useCallback((signature: string) => {
    if (!intent.current || intent.current.signature !== signature) {
      intent.current = { key: crypto.randomUUID(), signature };
    }
    return intent.current.key;
  }, []);
  const reset = useCallback(() => {
    intent.current = null;
  }, []);
  return { keyFor, reset };
}
