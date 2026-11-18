/**
 * A minimal reader for the session feed's server-sent events: a block of
 * `field: value` lines ended by a blank line, with `: comment` lines (the
 * server's keep-alive) ignored. The fetch stream hands over arbitrary chunks, so
 * the parser keeps what it has not finished a block for until the next chunk.
 */
export type SseEvent = Readonly<
  { id: string | null; event: string; data: string }
>;

export function createSseParser(): (chunk: string) => SseEvent[] {
  let pending = "";
  return (chunk) => {
    pending += chunk.replaceAll("\r\n", "\n");
    const events: SseEvent[] = [];
    let end = pending.indexOf("\n\n");
    while (end >= 0) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) events.push({ id, event, data: data.join("\n") });
      end = pending.indexOf("\n\n");
    }
    return events;
  };
}
