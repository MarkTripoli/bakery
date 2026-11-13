// The one slice of runtime-cases.json the worker-dark renderer reads.
//
// The dark phone case is captured under the runtime context of the approved
// light phone case, with only the theme changed. Hashing the whole of
// runtime-cases.json made every runtime case added anywhere in the UI change
// the worker-dark source digest and turn `render:paper:worker-dark --check`
// red on main (#319, #323), although the renderer reads a single context from
// that file and nothing else. The derived file below carries exactly that
// context, `render-worker-dark-references.mjs` writes it and reads the case
// settings back from it, and the baseline hashes it in place of the whole
// file. A new case or an unrelated context leaves its bytes, and so the digest,
// unchanged; an edit to this context changes them and is reported by --check
// as a file that differs from a fresh derivation.
//
// Dependency free on purpose: the rail tests import it without a browser.

export const RUNTIME_CASES_PATH =
  "docs/technical-design/ui-baselines/runtime-cases.json";
export const WORKER_DARK_RUNTIME_CONTEXT = "paper-detail-light-phone";

const NOTE =
  "Derived from runtime-cases.json by render-worker-dark-references.mjs: the one runtime context the worker-dark renderer reads. Not edited by hand.";

/**
 * The committed bytes of `worker-dark-mocks/runtime-context.json`.
 *
 * @param {string} runtimeCasesText the text of runtime-cases.json
 * @returns {Buffer}
 */
export function deriveWorkerDarkRuntimeContext(runtimeCasesText) {
  const context = JSON.parse(runtimeCasesText)?.contexts
    ?.[WORKER_DARK_RUNTIME_CONTEXT];
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(`missing runtime context ${WORKER_DARK_RUNTIME_CONTEXT}`);
  }
  return Buffer.from(
    JSON.stringify(
      {
        note: NOTE,
        derivedFrom: RUNTIME_CASES_PATH,
        contexts: { [WORKER_DARK_RUNTIME_CONTEXT]: context },
      },
      null,
      2,
    ) + "\n",
  );
}
