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
  // Counted the way a person counts the lines of a file, not the way a byte scan
  // does: a newline ends the line it is on, so "alpha\nbeta\ngamma\n" is three
  // lines, not four. Most text files end with a newline, and a fact that is one
  // too many on most files is worse than no fact at all.
  let lineCount = 0;
  let last = -1;
  for (const byte of bytes) {
    if (byte === 0x0a) lineCount += 1;
    last = byte;
  }
  // A final line that is not newline-terminated is still a line.
  if (bytes.byteLength > 0 && last !== 0x0a) lineCount += 1;
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
