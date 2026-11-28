export function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function hasControlOrLineSeparator(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 ||
      code === 0x2029
    ) return true;
  }
  return false;
}
