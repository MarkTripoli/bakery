import type { McpStdioLaunchSpec } from "@bakery/contracts/mcp-capabilities";
import { launchStdioMcpServer, StdioMcpError } from "./stdio-mcp.ts";

export const LOCAL_MCP_DISCOVERY_INTERVAL_MS = 10 * 60_000;

type DiscoveryClient = Readonly<{
  localMcpConnections(
    after: string | null,
    signal?: AbortSignal,
  ): Promise<{
    value: {
      items: readonly {
        connectionId: string;
        launchSpec: McpStdioLaunchSpec;
        currentDigest: string | null;
      }[];
      nextCursor: string | null;
    };
  }>;
  reportLocalMcpSnapshot(
    connectionId: string,
    report: { protocolVersion: string; tools: readonly unknown[] },
    signal?: AbortSignal,
  ): Promise<{ value: { digest: string } }>;
}>;

export type LocalDiscoveryOutcome = Readonly<{
  connectionId: string;
  digest: string | null;
  failure: string | null;
}>;

export async function discoverLocalMcpServers(
  client: DiscoveryClient,
  options: Readonly<{
    allowlist: readonly string[];
    launch?: typeof launchStdioMcpServer;
    signal?: AbortSignal;
  }>,
): Promise<LocalDiscoveryOutcome[]> {
  const launch = options.launch ?? launchStdioMcpServer;
  const outcomes: LocalDiscoveryOutcome[] = [];
  let after: string | null = null;
  do {
    const page: {
      items: readonly {
        connectionId: string;
        launchSpec: McpStdioLaunchSpec;
      }[];
      nextCursor: string | null;
    } = (await client.localMcpConnections(after, options.signal)).value;
    for (const item of page.items) {
      try {
        const server = await launch(item.launchSpec, {
          allowlist: options.allowlist,
          signal: options.signal,
        });
        let listed;
        try {
          listed = await server.listTools(options.signal);
        } finally {
          await server.close();
        }
        const pinned = await client.reportLocalMcpSnapshot(
          item.connectionId,
          listed,
          options.signal,
        );
        outcomes.push({
          connectionId: item.connectionId,
          digest: pinned.value.digest,
          failure: null,
        });
      } catch (error) {
        outcomes.push({
          connectionId: item.connectionId,
          digest: null,
          failure: error instanceof StdioMcpError
            ? error.code
            : "LOCAL_MCP_DISCOVERY_FAILED",
        });
      }
    }
    after = page.nextCursor;
  } while (after !== null);
  return outcomes;
}
