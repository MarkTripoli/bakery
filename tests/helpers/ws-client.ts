const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const closeHandshakeTimeoutMs = 1_000;

export type WebSocketHeaders = HeadersInit;

export type WebSocketHandshakeFailure = {
  readonly status: number;
  readonly body: unknown;
};

export type WebSocketClose = {
  readonly code: number;
  readonly reason: string;
};

export type WebSocketNext = string | WebSocketClose;

export type WsClient = {
  send(text: string): Promise<void>;
  /** Writes multiple complete client messages in one transport write. */
  sendMany(texts: readonly string[]): Promise<void>;
  sendRaw(opcode: number, bytes: Uint8Array): Promise<void>;
  next(timeoutMs?: number): Promise<WebSocketNext>;
  close(code?: number): Promise<void>;
};

type HandshakeResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly leftover: Uint8Array;
};

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let index = 3; index < bytes.length; index++) {
    if (
      bytes[index - 3] === 13 &&
      bytes[index - 2] === 10 &&
      bytes[index - 1] === 13 &&
      bytes[index] === 10
    ) return index + 1;
  }
  return -1;
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await conn.write(bytes.subarray(offset));
    if (written <= 0) throw new Error("WEBSOCKET_WRITE_FAILED");
    offset += written;
  }
}

function parseHandshake(bytes: Uint8Array): HandshakeResponse {
  const end = findHeaderEnd(bytes);
  if (end < 0) throw new Error("WEBSOCKET_HANDSHAKE_INCOMPLETE");
  const headerText = textDecoder.decode(bytes.subarray(0, end));
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(
    statusLine,
  );
  if (!statusMatch) throw new Error("WEBSOCKET_HANDSHAKE_INVALID_STATUS");
  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  return {
    status: Number(statusMatch[1]),
    headers,
    leftover: bytes.subarray(end),
  };
}

async function readHandshake(conn: Deno.Conn): Promise<HandshakeResponse> {
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const chunk = new Uint8Array(8192);
  while (findHeaderEnd(bytes) < 0) {
    const read = await conn.read(chunk);
    if (read === null) throw new Error("WEBSOCKET_HANDSHAKE_CLOSED");
    if (read === 0) continue;
    bytes = concatBytes(bytes, chunk.slice(0, read));
    if (bytes.length > 128 * 1024) {
      throw new Error("WEBSOCKET_HANDSHAKE_TOO_LARGE");
    }
  }
  return parseHandshake(bytes);
}

function decodeResponseBody(bytes: Uint8Array): unknown {
  const text = textDecoder.decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(
  conn: Deno.Conn,
  response: HandshakeResponse,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return decodeResponseBody(response.leftover);
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("WEBSOCKET_HANDSHAKE_INVALID_LENGTH");
  }
  let bytes: Uint8Array<ArrayBufferLike> = response.leftover;
  while (bytes.length < length) {
    const chunk = new Uint8Array(8192);
    const read = await conn.read(chunk);
    if (read === null) throw new Error("WEBSOCKET_HANDSHAKE_BODY_CLOSED");
    if (read === 0) continue;
    bytes = concatBytes(bytes, chunk.slice(0, read));
  }
  return decodeResponseBody(bytes.subarray(0, length));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function websocketAcceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    textEncoder.encode(key + websocketGuid),
  );
  return base64(new Uint8Array(digest));
}

export const computeWebSocketAccept = websocketAcceptKey;

function frameLength(length: number): number {
  if (length < 126) return 2;
  if (length <= 0xffff) return 4;
  return 10;
}

function makeClientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(opcode) || opcode < 0 || opcode > 0x0f) {
    throw new RangeError("WEBSOCKET_OPCODE_INVALID");
  }
  const extendedLength = frameLength(payload.length);
  const frame = new Uint8Array(extendedLength + 4 + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    new DataView(frame.buffer).setUint16(2, payload.length);
  } else {
    frame[1] = 0x80 | 127;
    new DataView(frame.buffer).setBigUint64(2, BigInt(payload.length));
  }
  const mask = randomBytes(4);
  frame.set(mask, extendedLength);
  for (let index = 0; index < payload.length; index++) {
    frame[extendedLength + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

class SocketClient implements WsClient {
  readonly #conn: Deno.Conn;
  #readBuffer: Uint8Array<ArrayBufferLike>;
  #pendingRead: Promise<void> | undefined;
  #pendingFrame: Promise<WebSocketNext> | undefined;
  #nextQueue: Promise<void> = Promise.resolve();
  #closed = false;
  #connClosed = false;
  #closeSent = false;
  constructor(conn: Deno.Conn, initialBytes: Uint8Array) {
    this.#conn = conn;
    this.#readBuffer = initialBytes;
  }

  #closeConnection(): void {
    if (this.#connClosed) return;
    this.#connClosed = true;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // The peer may have already closed the underlying resource.
    }
  }

  async send(text: string): Promise<void> {
    await this.sendRaw(0x1, textEncoder.encode(text));
  }

  async sendMany(texts: readonly string[]): Promise<void> {
    if (this.#closed) throw new Error("WEBSOCKET_CLOSED");
    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
    for (const text of texts) {
      bytes = concatBytes(
        bytes,
        makeClientFrame(0x1, textEncoder.encode(text)),
      );
    }
    await writeAll(this.#conn, bytes);
  }

  async sendRaw(opcode: number, bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("WEBSOCKET_CLOSED");
    await writeAll(this.#conn, makeClientFrame(opcode, bytes));
  }

  async #sendClose(payload: Uint8Array): Promise<void> {
    if (this.#closeSent) return;
    this.#closeSent = true;
    await writeAll(this.#conn, makeClientFrame(0x8, payload));
  }

  async #waitForCloseResponse(): Promise<void> {
    const deadline = Date.now() + closeHandshakeTimeoutMs;
    while (!this.#closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        const value = await this.next(remaining);
        if (typeof value !== "string") return;
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "WEBSOCKET_READ_TIMEOUT" ||
            error.message === "WEBSOCKET_CONNECTION_CLOSED")
        ) return;
        throw error;
      }
    }
  }

  async close(code = 1000): Promise<void> {
    if (this.#closed) return;
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
      throw new RangeError("WEBSOCKET_CLOSE_CODE_INVALID");
    }
    const payload = new Uint8Array(2);
    new DataView(payload.buffer).setUint16(0, code);
    try {
      await this.#sendClose(payload);
      await this.#waitForCloseResponse();
    } finally {
      this.#closeConnection();
    }
  }

  async next(timeoutMs = 10_000): Promise<WebSocketNext> {
    if (
      (!Number.isFinite(timeoutMs) && timeoutMs !== Infinity) ||
      timeoutMs < 0
    ) {
      throw new RangeError("WEBSOCKET_TIMEOUT_INVALID");
    }
    let release!: () => void;
    const previous = this.#nextQueue;
    this.#nextQueue = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      const read = this.#pendingFrame ??= this.#nextFrame();
      if (timeoutMs === Infinity) {
        try {
          return await read;
        } finally {
          if (this.#pendingFrame === read) this.#pendingFrame = undefined;
        }
      }
      let timer!: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("WEBSOCKET_READ_TIMEOUT")),
          timeoutMs,
        );
      });
      try {
        const value = await Promise.race([read, timeout]);
        if (this.#pendingFrame === read) this.#pendingFrame = undefined;
        return value;
      } catch (error) {
        if (
          !(error instanceof Error &&
            error.message === "WEBSOCKET_READ_TIMEOUT") &&
          this.#pendingFrame === read
        ) {
          this.#pendingFrame = undefined;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  }

  async #readMore(): Promise<void> {
    if (this.#pendingRead) return await this.#pendingRead;
    const pending = (async () => {
      const chunk = new Uint8Array(8192);
      const read = await this.#conn.read(chunk);
      if (read === null) {
        this.#closeConnection();
        throw new Error("WEBSOCKET_CONNECTION_CLOSED");
      }
      if (read > 0) {
        this.#readBuffer = concatBytes(
          this.#readBuffer,
          chunk.slice(0, read),
        );
      }
    })();
    this.#pendingRead = pending;
    try {
      await pending;
    } finally {
      if (this.#pendingRead === pending) this.#pendingRead = undefined;
    }
  }

  async #readBytes(length: number): Promise<Uint8Array> {
    while (this.#readBuffer.length < length) await this.#readMore();
    const bytes = this.#readBuffer.slice(0, length);
    this.#readBuffer = this.#readBuffer.slice(length);
    return bytes;
  }

  async #nextFrame(): Promise<WebSocketNext> {
    if (this.#closed) throw new Error("WEBSOCKET_CLOSED");
    let fragments: Uint8Array[] | undefined;
    while (true) {
      const header = await this.#readBytes(2);
      const first = header[0];
      const second = header[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      if (length === 126) {
        length = new DataView((await this.#readBytes(2)).buffer).getUint16(0);
      } else if (length === 127) {
        const value = new DataView((await this.#readBytes(8)).buffer)
          .getBigUint64(0);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WEBSOCKET_FRAME_TOO_LARGE");
        }
        length = Number(value);
      }
      const mask = masked ? await this.#readBytes(4) : undefined;
      const payload = await this.#readBytes(length);
      if (mask) {
        for (let index = 0; index < payload.length; index++) {
          payload[index] ^= mask[index % 4];
        }
      }
      // Control frames (0x8-0xA) may interleave a fragmented message.
      if (opcode === 0x8) {
        let code = 1000;
        let reason = "";
        if (payload.length >= 2) {
          code = new DataView(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength,
          ).getUint16(0);
          reason = textDecoder.decode(payload.subarray(2));
        } else if (payload.length === 1) {
          throw new Error("WEBSOCKET_CLOSE_PAYLOAD_INVALID");
        }
        try {
          await this.#sendClose(payload);
        } finally {
          this.#closeConnection();
        }
        return { code, reason };
      }
      if (opcode === 0x9) {
        if (!this.#closeSent) await this.sendRaw(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0) {
        if (!fragments) throw new Error("WEBSOCKET_UNEXPECTED_CONTINUATION");
        fragments.push(payload);
      } else {
        if (fragments) throw new Error("WEBSOCKET_FRAGMENT_INTERLEAVED");
        if (opcode !== 0x1) throw new Error("WEBSOCKET_TEXT_FRAME_REQUIRED");
        if (fin) return textDecoder.decode(payload);
        fragments = [payload];
        continue;
      }
      if (!fin) continue;
      let total = 0;
      for (const fragment of fragments) total += fragment.length;
      const message = new Uint8Array(total);
      let offset = 0;
      for (const fragment of fragments) {
        message.set(fragment, offset);
        offset += fragment.length;
      }
      return textDecoder.decode(message);
    }
  }
}

function requestTarget(url: URL): string {
  return `${url.pathname || "/"}${url.search}`;
}

function hostHeader(url: URL): string {
  const port = url.port;
  if (
    !port || (url.protocol === "ws:" && port === "80") ||
    (url.protocol === "wss:" && port === "443")
  ) return url.hostname;
  return `${url.hostname}:${port}`;
}

export async function connectWebSocket(
  target: string | URL,
  options: { readonly headers?: WebSocketHeaders } = {},
): Promise<WsClient | WebSocketHandshakeFailure> {
  const url = typeof target === "string" ? new URL(target) : new URL(target);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("WEBSOCKET_URL_REQUIRED");
  }
  const port = Number(url.port || (url.protocol === "wss:" ? 443 : 80));
  const conn = url.protocol === "wss:"
    ? await Deno.connectTls({ hostname: url.hostname, port })
    : await Deno.connect({ hostname: url.hostname, port });
  try {
    const key = base64(randomBytes(16));
    const headers = new Headers(options.headers);
    headers.set("Host", hostHeader(url));
    headers.set("Upgrade", "websocket");
    headers.set("Connection", "Upgrade");
    headers.set("Sec-WebSocket-Key", key);
    headers.set("Sec-WebSocket-Version", "13");
    let request = `GET ${requestTarget(url)} HTTP/1.1\r\n`;
    for (const [name, value] of headers) request += `${name}: ${value}\r\n`;
    request += "\r\n";
    await writeAll(conn, textEncoder.encode(request));
    const response = await readHandshake(conn);
    if (response.status !== 101) {
      const body = await readResponseBody(conn, response);
      conn.close();
      return { status: response.status, body };
    }
    const accepted = response.headers.get("sec-websocket-accept");
    if (!accepted || accepted !== await websocketAcceptKey(key)) {
      throw new Error("WEBSOCKET_ACCEPT_INVALID");
    }
    return new SocketClient(conn, response.leftover);
  } catch (error) {
    conn.close();
    throw error;
  }
}
