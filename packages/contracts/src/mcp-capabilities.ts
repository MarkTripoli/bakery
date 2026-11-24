import { z } from "zod";
import { canonicalJson, sha256Hex } from "./workflow-compiler/canonical.ts";

/**
 * External MCP capabilities with fixed grants (issue #20, B11.02).
 *
 * The design decision this module encodes is that **discovery is not
 * permission**. A server tells us what it can do; that answer is recorded as an
 * immutable snapshot and changes nothing about what may be invoked. What may be
 * invoked is decided by a binding an operator wrote, pinning one snapshot. The
 * three acceptance criteria follow from keeping those two apart:
 *
 * - A pinned tool whose remote schema changed, or whose connection or grant was
 *   revoked, is refused rather than dispatched (criterion 1).
 * - A capability that only exists on one host stays unavailable when that host
 *   is not eligible, rather than being rerouted to a host that happens to be
 *   reachable (criterion 2).
 * - A malformed or oversized discovery is rejected on import, and imported tool
 *   text can never widen its own authority (criterion 3).
 */

/** The two transports an external MCP server may use. */
export const MCP_TRANSPORTS = Object.freeze(
  ["stdio", "streamable_http"] as const,
);
export type McpTransport = typeof MCP_TRANSPORTS[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const McpStdioLaunchSpecSchema = z.strictObject({
  command: z.string().min(2).max(1024)
    .regex(/^\/[^\0]*$/, "an absolute path")
    .refine((path) => !path.split("/").includes(".."), "no .. segment")
    .describe(
      "Absolute path of the executable the worker runs; never resolved through PATH or a shell.",
    ),
  args: z.array(
    z.string().max(4096).refine((value) => !value.includes("\0"), "no NUL")
      .describe("One argument, passed as is; no shell interpolation."),
  ).max(64).default([]).describe("Arguments passed to the command, in order."),
  artifactDigest: z.string().regex(SHA256_HEX).describe(
    "Lowercase SHA-256 of the command file; a file with any other digest is refused, never run.",
  ),
}).describe(
  "Pinned launch of a local stdio MCP server: command, arguments and the command file's digest.",
);
export type McpStdioLaunchSpec = z.output<typeof McpStdioLaunchSpecSchema>;

/**
 * A connection's lifecycle. `degraded` is distinct from `disabled` on purpose:
 * degraded means the server is reachable but not answering usefully (a protocol
 * or auth problem), which is a different operator action from switching it off.
 */
export const MCP_CONNECTION_STATUSES = Object.freeze(
  ["enabled", "disabled", "degraded", "revoked"] as const,
);
export type McpConnectionStatus = typeof MCP_CONNECTION_STATUSES[number];

/**
 * Bounds every discovery is held to.
 *
 * These exist because the third acceptance criterion is about a hostile or
 * broken server, and a limit that is enforced in one place cannot be argued
 * with in another. They are deliberately small numbers rather than "large
 * enough": a server that wants more than this is a server whose operator should
 * ask for a bigger bound deliberately.
 */
export const MCP_DISCOVERY_LIMITS = Object.freeze({
  /** Most tools one snapshot may carry. */
  maxTools: 500,
  /** Most bytes of one tool description, after trimming. */
  maxDescriptionBytes: 2_048,
  /** Most bytes of one tool's input schema, serialized. */
  maxSchemaBytes: 65_536,
  /** Most bytes of the whole snapshot manifest, serialized. */
  maxManifestBytes: 1_048_576,
});

/** Thrown when a discovery exceeds a bound; the caller reports, never truncates. */
export type McpDiscoveryViolation =
  | "too_many_tools"
  | "description_too_long"
  | "schema_too_large"
  | "manifest_too_large"
  | "malformed_manifest";

/**
 * One discovered tool.
 *
 * `description` is untrusted remote text. It is stored to be shown to a person,
 * never parsed to decide what a tool may do - that is the whole of "no arbitrary
 * tool gains scope". The schema is kept as an opaque JSON value here because the
 * digest computed over it is what dispatch compares, not this module.
 */
export const McpDiscoveredToolSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Tool name as the server reported it, matched exactly on invoke.",
    ),
  description: z
    .string()
    .max(MCP_DISCOVERY_LIMITS.maxDescriptionBytes)
    .describe(
      "Untrusted human-readable description; shown, never parsed for authority.",
    ),
  inputSchema: z
    .unknown()
    .describe(
      "Opaque JSON input schema; its serialized digest is what dispatch pins.",
    ),
})
  .describe(
    "One discovered tool: its name, its untrusted description, and its opaque input schema.",
  );
export type McpDiscoveredTool = z.infer<typeof McpDiscoveredToolSchema>;

/**
 * What one discovery observed, and the digest over it.
 *
 * `protocolVersion` is what the server actually answered with. Bakery targets
 * 2026-07-28 and does not claim old upstream versions are compatible, so this
 * is recorded rather than assumed.
 */
export const McpCapabilitySnapshotSchema = z.object({
  protocolVersion: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Protocol version the server answered with, recorded as observed.",
    ),
  tools: z
    .array(McpDiscoveredToolSchema)
    .max(MCP_DISCOVERY_LIMITS.maxTools)
    .describe("Tools observed in this discovery, bounded by maxTools."),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe(
      "SHA-256 of the canonical manifest; compared at invoke to detect drift.",
    ),
})
  .describe(
    "One immutable observation of what a server can do, and the digest that pins it.",
  );
export type McpCapabilitySnapshot = z.infer<typeof McpCapabilitySnapshotSchema>;

/**
 * Why an invocation was refused.
 *
 * Every one of these is a refusal, never a fallback. A drift or a denial must
 * not be satisfied by retrying somewhere else: that would turn a fixed grant
 * into a search for a host permissive enough to run the work.
 */
export const MCP_INVOCATION_DENIALS = Object.freeze(
  [
    "schema_drift",
    "connection_revoked",
    "grant_revoked",
    "host_ineligible",
    "capability_not_bound",
    "snapshot_missing",
    "personal_use_not_granted",
    "personal_unattended",
  ] as const,
);
export type McpInvocationDenial = typeof MCP_INVOCATION_DENIALS[number];

/**
 * One invocation request against a pinned snapshot.
 *
 * `pinnedDigest` is what the binding recorded. The server re-reads the current
 * snapshot and compares; a mismatch is `schema_drift` before anything is
 * dispatched.
 */
export const McpInvocationInputSchema = z.object({
  connectionId: z
    .uuid()
    .describe("The MCP connection the binding names."),
  toolName: z
    .string()
    .min(1)
    .max(200)
    .describe("Tool to invoke, matched exactly against the pinned snapshot."),
  pinnedDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe(
      "Snapshot digest the binding pinned; a mismatch is refused as drift.",
    ),
  arguments: z
    .record(
      z.string().describe(
        "Argument name as the pinned tool schema defines it.",
      ),
      z.unknown().describe(
        "One argument value, validated by the pinned schema.",
      ),
    )
    .describe(
      "Arguments passed through to the server, already validated by the pinned schema.",
    ),
})
  .describe(
    "One request to invoke a pinned tool, naming the snapshot digest it was pinned at.",
  );
export type McpInvocationInput = z.infer<typeof McpInvocationInputSchema>;

/**
 * Why an invocation was refused, as data.
 *
 * The safe Problem is built from this, so the same refusal reads the same way
 * over REST and over Bakery's own MCP transport.
 */
export const McpInvocationRefusalSchema = z.object({
  denial: z
    .enum(MCP_INVOCATION_DENIALS)
    .describe("Which fixed-grant check refused the invocation."),
  detail: z
    .string()
    .max(500)
    .describe(
      "Operator-facing explanation; never includes credentials or schema contents.",
    ),
})
  .describe(
    "A refused invocation: which fixed-grant check failed, and why.",
  );
export type McpInvocationRefusal = z.infer<typeof McpInvocationRefusalSchema>;

/**
 * Whether a given host may run a connection's transport.
 *
 * A `stdio` server is a process on one machine. If that machine is not eligible
 * the capability is unavailable - not "available somewhere else", because the
 * somewhere else does not have the server.
 */
export function mcpHostEligible(
  input: { transport: McpTransport; boundHostId?: string | null },
  host: { hostId: string; eligible: boolean },
): boolean {
  if (input.transport !== "stdio") return host.eligible;
  if (!input.boundHostId) return false;
  return input.boundHostId === host.hostId && host.eligible;
}

/**
 * The digest a snapshot is pinned by.
 *
 * Canonical JSON with sorted keys, so two servers that report the same
 * capability set in a different member order produce the same digest and are
 * not spuriously reported as drift. Reused from the workflow compiler rather
 * than reimplemented: one canonical form, one digest.
 */
export async function mcpCapabilityDigest(manifest: {
  protocolVersion: string;
  tools: readonly McpDiscoveredTool[];
}): Promise<string> {
  // WebCrypto is async by nature, so the digest is too. A sync variant would
  // have to reach for a non-standard hash, and one canonical digest is worth
  // more than a tidier call signature.
  return await sha256Hex(canonicalJson({
    protocolVersion: manifest.protocolVersion,
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
}

/**
 * Check a discovery against every bound before it is stored.
 *
 * Returns the first violation rather than a list, because the caller's job is
 * to refuse the whole discovery and report why; a server that broke three
 * bounds at once does not need three messages. Nothing is truncated: a
 * truncated tool list would look like a successful import of a smaller server,
 * which is precisely the confusion the bounds exist to prevent.
 */
export function mcpDiscoveryViolation(manifest: {
  protocolVersion: string;
  tools: readonly McpDiscoveredTool[];
}): McpDiscoveryViolation | undefined {
  if (manifest.tools.length > MCP_DISCOVERY_LIMITS.maxTools) {
    return "too_many_tools";
  }
  for (const tool of manifest.tools) {
    if (
      byteLength(tool.description) > MCP_DISCOVERY_LIMITS.maxDescriptionBytes
    ) return "description_too_long";
    let serialized: string;
    try {
      serialized = canonicalJson(tool.inputSchema);
    } catch {
      // A schema that is not JSON-compatible (a cycle, a function) cannot be
      // digested, so it cannot be pinned, so it cannot be invoked.
      return "malformed_manifest";
    }
    if (byteLength(serialized) > MCP_DISCOVERY_LIMITS.maxSchemaBytes) {
      return "schema_too_large";
    }
  }
  try {
    const total = canonicalJson({
      protocolVersion: manifest.protocolVersion,
      tools: manifest.tools,
    });
    if (byteLength(total) > MCP_DISCOVERY_LIMITS.maxManifestBytes) {
      return "manifest_too_large";
    }
  } catch {
    return "malformed_manifest";
  }
  return undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
