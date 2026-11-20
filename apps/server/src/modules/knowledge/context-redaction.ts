/**
 * Credential redaction for text that is about to enter a model prompt
 * (#14 AC3, "never dumps ... credentials into prompts"). Pure and
 * deterministic: the same window always redacts to the same text, so a cached
 * or replayed extract matches a cold one. It runs on every projected window,
 * after the byte-range citation has been checked against the raw bytes and
 * before the text leaves the projection.
 *
 * The rules are deliberately broad: a missed credential reaches a model, a
 * redacted false positive costs one word. Quantifiers are bounded so a hostile
 * window cannot make a rule backtrack.
 *
 * Known limit: a credential cut in two by the window edge is only caught when
 * its recognisable prefix is whole at the end of the window; a window that
 * starts in the middle of a token cannot be recognised as one.
 */

/** Identity of the redaction rules; bumps whenever a rule is added or changed. */
export const CONTEXT_REDACTOR_VERSION = "bakery.redact@6";

/** What replaces a redacted credential. */
export const REDACTION_MARKER = "[redacted]";

export type RedactionResult = {
  /** The text with every recognised credential replaced by the marker. */
  text: string;
  /** How many credentials were replaced. */
  count: number;
};

/** A key name whose value is a credential, for `name: value` and `name=value` forms. */
const CREDENTIAL_KEY =
  "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|account[_-]?key|shared[_-]?access[_-]?key|sas[_-]?key|auth(?:orization)?|credential|bearer|signature|session[_-]?id|cookie)";

/** Whole-match rules: the matched text is a credential in itself. */
const WHOLE_RULES: readonly RegExp[] = [
  // PEM blocks: a complete block, or a block the window cut off (no END).
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // A window that starts inside a block: everything up to its END line.
  /^[\s\S]{0,70000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
  // Bakery access tokens and desktop credentials.
  /\bbk[yd]_[A-Za-z0-9_-]{8,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  // Slack.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g,
  // Anthropic, OpenAI and compatible secret keys.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitLab, npm, Hugging Face, SendGrid, Resend, Linear, Notion and Twilio keys.
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bre_[A-Za-z0-9_]{20,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/g,
  /\bntn_[A-Za-z0-9]{30,}/g,
  /\bSK[0-9a-f]{32}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35,}/g,
  // Stripe.
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * A recognisable token prefix whole at the very end of the window: the rest of
 * the token lies in the next window, so redact what is here at any length.
 */
const TRAILING_PREFIX =
  /(?:\bbk[yd]_|\bgh[pousr]_|\bgithub_pat_|\bglpat-|\bnpm_|\bhf_|\bSG\.|\blin_(?:api|oauth)_|\bntn_|\bxox[abposr]-|\bsk-|\bAIza|\b[rs]k_(?:live|test)_|\beyJ|-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----)[A-Za-z0-9_.\-/+= ]{0,60}$/g;

/** Rules that keep the surrounding text and replace only the secret part. */
const PARTIAL_RULES: readonly { pattern: RegExp; keep: number }[] = [
  // name: value, name = value, "name": "value" for credential-like names. It
  // runs first so `Authorization: Bearer x` is one credential, not two: the value
  // may start with its scheme word, which goes with it.
  {
    pattern: new RegExp(
      "(\\b[A-Za-z0-9_.-]{0,40}" + CREDENTIAL_KEY +
        "[A-Za-z0-9_.-]{0,40}[\"']?[ \\t]*[:=][ \\t]*)" +
        // A quoted value runs to its closing quote, spaces and all, honouring
        // backslash escapes and doubled quotes (YAML 'it''s', CSV "a ""b"""). The
        // closing quote is optional: a value the window cut off, or one longer
        // than the bound, is redacted to the end of the line rather than leaking
        // whole. A bare one runs to the next separator.
        "(?:\"(?:[^\"\\\\\\n]|\\\\.|\"\"){1,2000}\"?|'(?:[^'\\\\\\n]|\\\\.|''){1,2000}'?|(?:(?:Bearer|Basic|Token)[ \\t]+)?[^\\s\"',;}{]{4,300})",
      "gi",
    ),
    keep: 1,
  },
  // Bare bearer/basic credentials with no key name before them.
  {
    pattern: /\b((?:Bearer|Basic|Token)[ \t]+)[A-Za-z0-9._~+/=-]{12,}/gi,
    keep: 1,
  },
  // Credentials inside a URL: scheme://user:password@host.
  {
    pattern:
      /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}(?=@)/gi,
    keep: 1,
  },
];

/** Redacts every recognised credential in `text`. */
export function redactContextText(text: string): RedactionResult {
  let count = 0;
  let current = text;
  const replaceWhole = (pattern: RegExp) => {
    current = current.replace(pattern, () => {
      count += 1;
      return REDACTION_MARKER;
    });
  };
  for (const rule of WHOLE_RULES) replaceWhole(rule);
  replaceWhole(TRAILING_PREFIX);
  for (const { pattern, keep } of PARTIAL_RULES) {
    current = current.replace(pattern, (...match: unknown[]) => {
      // A value that is already the marker is not a second credential, with or
      // without the scheme word before it (`Bearer [redacted]`, left by a whole
      // rule that took the token itself).
      const prefix = match.slice(1, 1 + keep).join("");
      const whole = String(match[0]);
      const value = whole.slice(prefix.length).replace(
        /^(?:Bearer|Basic|Token)[ \t]+/i,
        "",
      );
      if (value === REDACTION_MARKER) return whole;
      count += 1;
      return prefix + REDACTION_MARKER;
    });
  }
  return { text: current, count };
}
