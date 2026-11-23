#!/bin/sh
# A minimal stdio MCP server for tests (#441). Tools: "echo" returns its text;
# "probe" reports whether a host path is visible and whether the network is
# reachable, so a test can tell the T1 sandbox from an allowlisted launch.
exec /usr/bin/node -e '
const fs = require("node:fs");
const net = require("node:net");
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const tools = [
  { name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "probe", description: "Reports what the process can see.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  if (m.method === "tools/list") return send({ id: m.id, result: { tools } });
  if (m.method === "tools/call" && m.params.name === "echo") return send({ id: m.id, result: { content: [{ type: "text", text: String(m.params.arguments.text) }] } });
  if (m.method === "tools/call" && m.params.name === "probe") {
    const network = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.argv[1] || 9) });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", (e) => resolve(e.code));
    });
    return send({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ pathVisible: fs.existsSync(m.params.arguments.path), network, home: process.env.HOME, secret: process.env.BAKERY_SECRET ?? null }) }] } });
  }
  send({ id: m.id, error: { code: -32601, message: "Method not found." } });
});
' "$@"
