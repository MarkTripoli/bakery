/**
 * Lines and encoding of a text-ish file, counted without trusting it
 * (chapter 25 §17.6).
 *
 * The count is of bytes read, which for a file this size is the whole file: a
 * preview that says "412 lines" about a file it only partly read would be
 * describing its own truncation. `utf8` is whether a strict decoder accepted
 * the bytes, which is the honest answer to "will this render as text"; it is
 * false for UTF-16 and for an unknown legacy encoding rather than a guess.
 */
export type TextShape = Readonly<{ lineCount: number; utf8: boolean }>;

export function describeText(bytes: Uint8Array): TextShape {
  let lineCount = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) lineCount += 1;
  }
  // Empty bytes have no lines rather than one empty line.
  if (bytes.byteLength === 0) lineCount = 0;
  let utf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    utf8 = false;
  }
  return { lineCount, utf8 };
}
