import { StandardError } from "@bakery/contracts/http";

const CURSOR_VERSION = 2;
const MAX_CURSOR_BYTES = 512;
const UNSCOPED = "unscoped";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DECIMAL_SEQUENCE = /^(0|[1-9]\d*)$/;

export type CursorBinding = {
  action: string;
  principalId: string;
  organizationId?: string;
  ordering: string;
  filters: string;
  schemaVersion: number;
};

export type CursorPosition = {
  createdAt?: string;
  position?: number;
  iteration?: number;
  id: string;
};

export type SequenceCursorPosition = {
  sequence: string;
};

export type SequenceIdCursorPosition = SequenceCursorPosition & {
  id: string;
};

type CursorPayload = {
  v: number;
  a: string;
  p: string;
  o: string;
  r: string;
  f: string;
  s: number;
  k: "row";
  c?: string;
  n?: number;
  t?: number;
  i: string;
};

type SequenceCursorPayload = Omit<CursorPayload, "c" | "i" | "k"> & {
  k: "sequence";
  q: string;
};

type SequenceIdCursorPayload = Omit<SequenceCursorPayload, "k"> & {
  k: "sequence-row";
  i: string;
};

function invalidCursor(): never {
  throw new StandardError({ code: "INVALID_CURSOR" });
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  const padding = "=".repeat((4 - value.length % 4) % 4);
  try {
    const decoded = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) {
      bytes[index] = decoded.charCodeAt(index);
    }
    if (encodeBase64Url(bytes) !== value) invalidCursor();
    return bytes;
  } catch {
    return invalidCursor();
  }
}

function assertBinding(binding: CursorBinding): void {
  if (
    !binding.action || !binding.ordering || !binding.filters ||
    !Number.isSafeInteger(binding.schemaVersion) || binding.schemaVersion < 1 ||
    !UUID.test(binding.principalId) ||
    (binding.organizationId !== undefined &&
      !UUID.test(binding.organizationId))
  ) {
    throw new Error("CURSOR_BINDING_INVALID");
  }
}

type RowCursorKind = "timestamp" | "ordinal";

function bindingRowCursorKind(binding: CursorBinding): RowCursorKind {
  if (
    binding.ordering === "createdAt:asc,id:asc" ||
    binding.ordering === "createdAt:desc,id:desc"
  ) return "timestamp";
  if (
    binding.ordering === "position:asc,iteration:asc,id:asc" ||
    binding.ordering === "revision:desc,id:desc"
  ) {
    return "ordinal";
  }
  throw new Error("CURSOR_BINDING_INVALID");
}

function positionKind(position: CursorPosition): RowCursorKind | null {
  const timestampValid = typeof position.createdAt === "string" &&
    position.position === undefined && position.iteration === undefined &&
    TIMESTAMP.test(position.createdAt) &&
    Number.isFinite(Date.parse(position.createdAt));
  if (timestampValid && UUID.test(position.id)) return "timestamp";
  const ordinalValid = position.createdAt === undefined &&
    Number.isSafeInteger(position.position) &&
    Number.isSafeInteger(position.iteration) &&
    (position.position as number) >= 0 &&
    (position.iteration as number) >= 0;
  return ordinalValid && UUID.test(position.id) ? "ordinal" : null;
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("CURSOR_SECRET_REQUIRED");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function encodePayload(secret: string, payload: object): Promise<string> {
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importKey(secret),
      new TextEncoder().encode(encoded),
    ),
  );
  const cursor = `${encoded}.${encodeBase64Url(signature)}`;
  if (new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES) {
    throw new Error("CURSOR_TOO_LARGE");
  }
  return cursor;
}

async function decodePayload(
  secret: string,
  cursor: string,
): Promise<Record<string, unknown>> {
  if (
    new TextEncoder().encode(cursor).byteLength > MAX_CURSOR_BYTES ||
    cursor.split(".").length !== 2
  ) invalidCursor();
  const [encoded, encodedSignature] = cursor.split(".");
  const signature = decodeBase64Url(encodedSignature);
  if (
    signature.byteLength !== 32 ||
    !await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      signature,
      new TextEncoder().encode(encoded),
    )
  ) invalidCursor();

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Url(encoded),
      ),
    );
  } catch {
    return invalidCursor();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return invalidCursor();
  }
  return payload as Record<string, unknown>;
}

function validPayloadBinding(
  record: Record<string, unknown>,
  binding: CursorBinding,
): boolean {
  return record.v === CURSOR_VERSION && record.a === binding.action &&
    record.p === binding.principalId &&
    record.o === (binding.organizationId ?? UNSCOPED) &&
    record.r === binding.ordering && record.f === binding.filters &&
    record.s === binding.schemaVersion;
}

export async function encodeCursor(
  secret: string,
  binding: CursorBinding,
  position: CursorPosition,
): Promise<string> {
  assertBinding(binding);
  const kind = positionKind(position);
  if (!kind || kind !== bindingRowCursorKind(binding)) {
    throw new Error("CURSOR_POSITION_INVALID");
  }
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    a: binding.action,
    p: binding.principalId,
    o: binding.organizationId ?? UNSCOPED,
    r: binding.ordering,
    f: binding.filters,
    s: binding.schemaVersion,
    k: "row",
    ...(kind === "timestamp"
      ? { c: position.createdAt }
      : { n: position.position, t: position.iteration }),
    i: position.id,
  };
  return await encodePayload(secret, payload);
}

export async function decodeCursor(
  secret: string,
  cursor: string | undefined,
  binding: CursorBinding,
): Promise<CursorPosition | null> {
  assertBinding(binding);
  if (cursor === undefined) return null;
  const expectedKind = bindingRowCursorKind(binding);
  const record = await decodePayload(secret, cursor);
  const keys = Object.keys(record).sort().join(",");
  const timestampPayload = keys === "a,c,f,i,k,o,p,r,s,v" &&
    typeof record.c === "string" &&
    typeof record.i === "string";
  const ordinalPayload = keys === "a,f,i,k,n,o,p,r,s,t,v" &&
    typeof record.n === "number" &&
    typeof record.t === "number" &&
    typeof record.i === "string";
  const position = expectedKind === "timestamp" && timestampPayload
    ? { createdAt: record.c as string, id: record.i as string }
    : expectedKind === "ordinal" && ordinalPayload
    ? {
      position: record.n as number,
      iteration: record.t as number,
      id: record.i as string,
    }
    : null;
  if (
    !validPayloadBinding(record, binding) || record.k !== "row" ||
    !position || positionKind(position) !== expectedKind
  ) return invalidCursor();
  return position;
}

export async function encodeSequenceCursor(
  secret: string,
  binding: CursorBinding,
  position: SequenceCursorPosition,
): Promise<string> {
  assertBinding(binding);
  if (!DECIMAL_SEQUENCE.test(position.sequence)) {
    throw new Error("CURSOR_POSITION_INVALID");
  }
  const payload: SequenceCursorPayload = {
    v: CURSOR_VERSION,
    a: binding.action,
    p: binding.principalId,
    o: binding.organizationId ?? UNSCOPED,
    r: binding.ordering,
    f: binding.filters,
    s: binding.schemaVersion,
    k: "sequence",
    q: position.sequence,
  };
  return await encodePayload(secret, payload);
}

export async function decodeSequenceCursor(
  secret: string,
  cursor: string | undefined,
  binding: CursorBinding,
): Promise<SequenceCursorPosition | null> {
  assertBinding(binding);
  if (cursor === undefined) return null;
  const record = await decodePayload(secret, cursor);
  if (
    Object.keys(record).sort().join(",") !== "a,f,k,o,p,q,r,s,v" ||
    !validPayloadBinding(record, binding) || record.k !== "sequence" ||
    typeof record.q !== "string" || !DECIMAL_SEQUENCE.test(record.q)
  ) return invalidCursor();
  return { sequence: record.q };
}

export async function encodeSequenceIdCursor(
  secret: string,
  binding: CursorBinding,
  position: SequenceIdCursorPosition,
): Promise<string> {
  assertBinding(binding);
  if (!DECIMAL_SEQUENCE.test(position.sequence) || !UUID.test(position.id)) {
    throw new Error("CURSOR_POSITION_INVALID");
  }
  const payload: SequenceIdCursorPayload = {
    v: CURSOR_VERSION,
    a: binding.action,
    p: binding.principalId,
    o: binding.organizationId ?? UNSCOPED,
    r: binding.ordering,
    f: binding.filters,
    s: binding.schemaVersion,
    k: "sequence-row",
    q: position.sequence,
    i: position.id,
  };
  return await encodePayload(secret, payload);
}

export async function decodeSequenceIdCursor(
  secret: string,
  cursor: string | undefined,
  binding: CursorBinding,
): Promise<SequenceIdCursorPosition | null> {
  assertBinding(binding);
  if (cursor === undefined) return null;
  const record = await decodePayload(secret, cursor);
  if (
    Object.keys(record).sort().join(",") !== "a,f,i,k,o,p,q,r,s,v" ||
    !validPayloadBinding(record, binding) || record.k !== "sequence-row" ||
    typeof record.q !== "string" || !DECIMAL_SEQUENCE.test(record.q) ||
    typeof record.i !== "string" || !UUID.test(record.i)
  ) return invalidCursor();
  return { sequence: record.q, id: record.i };
}

export async function decodeSequenceCursorFilters(
  secret: string,
  cursor: string,
  binding: Omit<CursorBinding, "filters">,
): Promise<{ sequence: string; filters: string }> {
  try {
    if (
      !binding.action || !binding.ordering ||
      !Number.isSafeInteger(binding.schemaVersion) ||
      binding.schemaVersion < 1 ||
      !UUID.test(binding.principalId) ||
      (binding.organizationId !== undefined &&
        !UUID.test(binding.organizationId))
    ) return invalidCursor();
    const record = await decodePayload(secret, cursor);
    if (
      Object.keys(record).sort().join(",") !== "a,f,k,o,p,q,r,s,v" ||
      record.v !== CURSOR_VERSION ||
      record.a !== binding.action ||
      record.p !== binding.principalId ||
      record.o !== (binding.organizationId ?? UNSCOPED) ||
      record.r !== binding.ordering ||
      record.s !== binding.schemaVersion ||
      record.k !== "sequence" ||
      typeof record.f !== "string" ||
      !record.f ||
      typeof record.q !== "string" ||
      !DECIMAL_SEQUENCE.test(record.q)
    ) return invalidCursor();
    return { sequence: record.q, filters: record.f };
  } catch {
    return invalidCursor();
  }
}
