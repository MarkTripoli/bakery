import {
  MEDIA_TYPE_MAX_LENGTH,
  MEDIA_TYPE_PATTERN,
} from "@bakery/contracts/contracts";

const MAX_MEDIA_SNIFF_BYTES = 4_096;

const ACTIVE_MEDIA_TYPES: Record<string, true> = {
  "application/ecmascript": true,
  "application/javascript": true,
  "application/vnd.microsoft.portable-executable": true,
  "application/wasm": true,
  "application/xhtml+xml": true,
  "image/svg+xml": true,
  "text/ecmascript": true,
  "text/html": true,
  "text/javascript": true,
};

const SAFE_MEDIA_TYPES: Record<string, true> = {
  "application/json": true,
  "image/avif": true,
  "image/bmp": true,
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "text/csv": true,
  "text/markdown": true,
  "text/plain": true,
  "text/xml": true,
  "application/xml": true,
};

const SIGNATURE_MEDIA_TYPES: Record<string, true> = {
  "application/pdf": true,
  "image/avif": true,
  "image/bmp": true,
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".cjs": "application/javascript",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mjs": "application/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".text": "text/plain",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

export type ArtifactMediaSafety = "safe" | "unsafe" | "unknown";

export type ArtifactMediaDecision = Readonly<{
  mediaType: string;
  safety: ArtifactMediaSafety;
  viewerEligible: boolean;
  attachmentOnly: boolean;
}>;

function mediaBaseType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function normalizedMediaType(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return isArtifactMediaType(normalized) ? normalized : null;
}

function isTextPrefix(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0 || byte === 0x7f || byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

function decodeTextPrefix(content: Uint8Array): string | null {
  const prefix = content.subarray(0, MAX_MEDIA_SNIFF_BYTES);
  if (!isTextPrefix(prefix)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(prefix, {
      stream: true,
    });
  } catch {
    return null;
  }
}

function hasBytes(content: Uint8Array, ...expected: number[]): boolean {
  if (content.byteLength < expected.length) return false;
  return expected.every((byte, index) => content[index] === byte);
}

function htmlSpace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" ||
    character === "\r" || character === "\f";
}

function skipHtmlComment(document: string, start: number): number {
  let index = start + 4;
  if (document[index] === ">") return index + 1;
  if (document[index] === "-" && document[index + 1] === ">") {
    return index + 2;
  }
  while (index < document.length) {
    if (document[index] === "-" && document[index + 1] === "-") {
      if (document[index + 2] === ">") return index + 3;
      if (document[index + 2] === "!" && document[index + 3] === ">") {
        return index + 4;
      }
    }
    index++;
  }
  return document.length;
}

function afterLeadingComments(document: string): string {
  let index = 0;
  while (index < document.length) {
    while (htmlSpace(document[index])) index++;
    if (!document.startsWith("<!--", index)) break;
    index = skipHtmlComment(document, index);
  }
  return index === 0 ? document : document.slice(index);
}

function eventAttributeName(
  document: string,
  start: number,
  end: number,
): boolean {
  if (
    end - start < 3 || document[start] !== "o" ||
    document[start + 1] !== "n"
  ) return false;
  const letter = document.charCodeAt(start + 2);
  if (letter < 97 || letter > 122) return false;
  for (let index = start + 3; index < end; index++) {
    const code = document.charCodeAt(index);
    if (
      !((code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 45 || code === 95)
    ) return false;
  }
  return true;
}

function containsActiveMarkup(document: string): boolean {
  const activeElement =
    /(?:body|embed|form|head|html|iframe|input|link|math|meta|object|noembed|noframes|noscript|plaintext|script|style|svg|template|textarea|title|xmp)/y;
  let index = 0;
  while (index < document.length) {
    if (document.startsWith("<!--", index)) {
      index = skipHtmlComment(document, index);
      continue;
    }
    if (
      document.startsWith("<!doctype", index) &&
      (htmlSpace(document[index + 9]) || document[index + 9] === ">" ||
        document[index + 9] === "[")
    ) return true;
    if (
      document[index] === "<" &&
      (document[index + 1] === "!" || document[index + 1] === "?")
    ) {
      const end = document.indexOf(">", index + 2);
      index = end < 0 ? document.length : end + 1;
      continue;
    }
    if (document[index] !== "<") {
      index++;
      continue;
    }
    const endTag = document[index + 1] === "/";
    const nameStart = index + (endTag ? 2 : 1);
    // A qualified XML name can bind even a non-ASCII/underscore prefix to
    // SVG or XHTML. Refuse it before HTML's ASCII-name/bogus-end-tag gates.
    let nameEnd = nameStart;
    while (
      nameEnd < document.length && !htmlSpace(document[nameEnd]) &&
      document[nameEnd] !== "/" && document[nameEnd] !== ">"
    ) {
      if (document[nameEnd] === ":") return true;
      nameEnd++;
    }
    if (endTag) {
      const next = document[index + 2];
      if (next !== undefined && next !== ">" && !(next >= "a" && next <= "z")) {
        const end = document.indexOf(">", index + 2);
        index = end < 0 ? document.length : end + 1;
        continue;
      }
    }
    if (
      document.charCodeAt(nameStart) < 97 ||
      document.charCodeAt(nameStart) > 122
    ) {
      index++;
      continue;
    }
    index = nameEnd;
    if (index === document.length) continue;
    if (!endTag) {
      activeElement.lastIndex = nameStart;
      if (activeElement.test(document) && activeElement.lastIndex === index) {
        return true;
      }
    }
    while (index < document.length) {
      while (htmlSpace(document[index]) || document[index] === "/") index++;
      if (document[index] === ">") {
        index++;
        break;
      }
      const attributeStart = index;
      while (
        index < document.length && !htmlSpace(document[index]) &&
        document[index] !== "=" && document[index] !== "/" &&
        document[index] !== ">"
      ) index++;
      if (attributeStart === index) {
        index++;
        continue;
      }
      const eventAttribute = eventAttributeName(
        document,
        attributeStart,
        index,
      );
      while (htmlSpace(document[index])) index++;
      if (document[index] !== "=") continue;
      if (eventAttribute && !endTag) return true;
      index++;
      while (htmlSpace(document[index])) index++;
      const quote = document[index];
      if (quote === '"' || quote === "'") {
        index++;
        while (index < document.length && document[index] !== quote) index++;
        if (index < document.length) index++;
      } else {
        while (
          index < document.length && !htmlSpace(document[index]) &&
          document[index] !== ">"
        ) index++;
      }
    }
  }
  return false;
}

function sniffMediaType(content: Uint8Array): string | null {
  if (hasBytes(content, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (hasBytes(content, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    content.byteLength >= 6 &&
    (new TextDecoder().decode(content.subarray(0, 6)) === "GIF87a" ||
      new TextDecoder().decode(content.subarray(0, 6)) === "GIF89a")
  ) return "image/gif";
  if (
    content.byteLength >= 12 &&
    new TextDecoder().decode(content.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(content.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  if (
    content.byteLength >= 12 &&
    new TextDecoder().decode(content.subarray(4, 8)) === "ftyp" &&
    (new TextDecoder().decode(content.subarray(8, 12)) === "avif" ||
      new TextDecoder().decode(content.subarray(8, 12)) === "avis")
  ) return "image/avif";
  if (hasBytes(content, 0x42, 0x4d)) return "image/bmp";
  if (hasBytes(content, 0x25, 0x50, 0x44, 0x46, 0x2d)) {
    return "application/pdf";
  }

  const text = decodeTextPrefix(content);
  if (text === null) return null;
  const trimmed = text.trimStart().toLowerCase();
  const document = afterLeadingComments(trimmed);
  if (
    /^<svg(?:[\s/>])/.test(document) ||
    /^<\?xml[\s\S]*<svg(?:[\s/>])/.test(document) ||
    /^(?:<\?xml[^>]*\?>\s*)?<!doctype\s+svg(?:\s|>|\[)/
      .test(document)
  ) return "image/svg+xml";
  if (
    /^<!doctype(?:\s|>)/.test(document) ||
    /^(?:<\?xml[^>]*\?>\s*)?<!doctype(?:\s|>)/.test(document) ||
    containsActiveMarkup(document)
  ) return "text/html";
  return "text/plain";
}

function compatibleWithSniff(
  declaredType: string,
  sniffedType: string | null,
  content: Uint8Array,
): boolean {
  const declaredBase = mediaBaseType(declaredType);
  if (content.byteLength === 0) return true;
  if (sniffedType === null) {
    return !Object.hasOwn(SAFE_MEDIA_TYPES, declaredBase) &&
      !Object.hasOwn(SIGNATURE_MEDIA_TYPES, declaredBase) &&
      !Object.hasOwn(ACTIVE_MEDIA_TYPES, declaredBase);
  }
  if (Object.hasOwn(SIGNATURE_MEDIA_TYPES, declaredBase)) {
    return declaredBase === sniffedType;
  }
  if (Object.hasOwn(ACTIVE_MEDIA_TYPES, declaredBase)) {
    if (declaredBase === "image/svg+xml") return sniffedType === declaredBase;
    return sniffedType === "text/plain" || sniffedType === "text/html";
  }
  if (Object.hasOwn(SAFE_MEDIA_TYPES, declaredBase)) {
    return sniffedType === "text/plain" || sniffedType === declaredBase;
  }
  return true;
}

export function isArtifactMediaType(value: string): boolean {
  return value.length <= MEDIA_TYPE_MAX_LENGTH &&
    MEDIA_TYPE_PATTERN.test(value);
}

export function inferArtifactMediaType(path: string): string | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MEDIA_TYPE_BY_EXTENSION[extension] ?? null;
}

export function classifyArtifactMedia(input: {
  declaredType?: string | null;
  content: Uint8Array;
}): ArtifactMediaDecision | null {
  const declaredType = input.declaredType == null
    ? null
    : normalizedMediaType(input.declaredType);
  if (input.declaredType != null && declaredType === null) return null;

  const sniffedType = sniffMediaType(input.content);
  if (
    declaredType !== null &&
    !compatibleWithSniff(declaredType, sniffedType, input.content)
  ) return null;

  const mediaType = declaredType ?? sniffedType ?? "application/octet-stream";
  const baseType = mediaBaseType(mediaType);
  const safety = Object.hasOwn(ACTIVE_MEDIA_TYPES, baseType)
    ? "unsafe"
    : Object.hasOwn(SAFE_MEDIA_TYPES, baseType)
    ? "safe"
    : "unknown";
  return Object.freeze({
    mediaType,
    safety,
    viewerEligible: safety === "safe",
    attachmentOnly: safety !== "safe",
  });
}

export function storedMediaSafety(value: string): ArtifactMediaSafety | null {
  const normalized = normalizedMediaType(value);
  if (normalized === null) return null;
  const baseType = mediaBaseType(normalized);
  return Object.hasOwn(ACTIVE_MEDIA_TYPES, baseType)
    ? "unsafe"
    : Object.hasOwn(SAFE_MEDIA_TYPES, baseType)
    ? "safe"
    : "unknown";
}
