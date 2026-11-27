import {
  type SessionApi,
  SessionRefusal,
} from "../../../packages/cli/src/session-call.ts";

export type GatewayCallResult = { content: unknown[]; isError: boolean };

export type BuiltinGatewayTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  call(args: Record<string, unknown>): Promise<GatewayCallResult>;
}>;

type FilesToolSpec = Readonly<{
  name: string;
  operations: readonly string[];
  description: string;
  readOnly: boolean;
  properties: Record<string, unknown>;
  required: readonly string[];
  run: (session: SessionApi, args: Record<string, unknown>) => Promise<unknown>;
}>;

const entryId = {
  type: "string",
  format: "uuid",
  description: "Id of the file or folder, as a listing or search returned it.",
};
const cursor = {
  type: "string",
  description: "The nextCursor of the previous page; omit for the first page.",
};
const limit = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Most items to return on one page.",
};

export const FILES_WRITE_MAX_BASE64_CHARACTERS = 65_536;

const direct =
  (operation: string) => (session: SessionApi, args: Record<string, unknown>) =>
    session.call(operation, args);

async function stat(
  session: SessionApi,
  args: Record<string, unknown>,
): Promise<unknown> {
  const versions = await session.call("storageFileVersions.list", {
    id: args.id,
    limit: 1,
  }) as { items?: { id?: unknown; revision?: unknown; sha256?: unknown }[] };
  const current = versions.items?.[0];
  if (typeof current?.id !== "string") return null;
  const atVersion = await session.call("storageFiles.byVersion", {
    id: current.id,
  }) as { file?: Record<string, unknown> };
  return {
    ...atVersion.file,
    revision: current.revision,
    sha256: current.sha256,
  };
}

async function write(
  session: SessionApi,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { version, ...put } = args;
  return await session.call(
    "storageFiles.put",
    put,
    typeof version === "number" ? version : undefined,
  );
}

const FILES_TOOL_SPECS: readonly FilesToolSpec[] = Object.freeze([
  {
    name: "bakery_files_roots",
    operations: ["storageRoots.list"],
    description:
      "List the top-level folders of Bakery Files this step may open.",
    readOnly: true,
    properties: {},
    required: [],
    run: direct("storageRoots.list"),
  },
  {
    name: "bakery_files_list",
    operations: ["storageFolderEntries.list"],
    description:
      "List the files and folders in one Bakery Files folder, a page at a time.",
    readOnly: true,
    properties: { id: entryId, cursor, limit },
    required: ["id"],
    run: direct("storageFolderEntries.list"),
  },
  {
    name: "bakery_files_stat",
    operations: ["storageFileVersions.list", "storageFiles.byVersion"],
    description:
      "Describe a file as it is now: path, revision, size, media type, SHA-256, and the version number bakery_files_write needs to replace it.",
    readOnly: true,
    properties: { id: entryId },
    required: ["id"],
    run: stat,
  },
  {
    name: "bakery_files_read",
    operations: ["storageFiles.content"],
    description:
      "Read a file's bytes, as base64, whole or one byte range. bakery_files_stat gives its SHA-256.",
    readOnly: true,
    properties: {
      id: entryId,
      revision: {
        type: "integer",
        minimum: 1,
        description: "Which version to read; omit for the current one.",
      },
      range: {
        type: "string",
        pattern: "^bytes=(?:\\d+-\\d*|-\\d+)$",
        description: "One HTTP byte range, such as bytes=0-1023.",
      },
    },
    required: ["id"],
    run: direct("storageFiles.content"),
  },
  {
    name: "bakery_files_search",
    operations: ["files.search"],
    description:
      "Find files by name. Only files this step may read are returned.",
    readOnly: true,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Text to find in a file's name.",
      },
      path: {
        type: "string",
        description: "Absolute path of a folder to search under.",
      },
      cursor,
      limit,
    },
    required: ["query"],
    run: direct("files.search"),
  },
  {
    name: "bakery_files_write",
    operations: ["storageFiles.put"],
    description:
      "Upload a new file to a path, or save a new version of a file there by passing the version bakery_files_stat or the last write gave. Content is base64, at most 65536 characters (48 KiB of bytes).",
    readOnly: false,
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path, such as /shared/briefs/plan.md. Its folder must exist.",
      },
      mediaType: {
        type: "string",
        description: "Media type, such as text/markdown.",
      },
      content: {
        type: "string",
        maxLength: FILES_WRITE_MAX_BASE64_CHARACTERS,
        description: "The file's bytes, base64.",
      },
      version: {
        type: "integer",
        description:
          "The file's current version, to replace a file that exists; omit for a new file.",
      },
    },
    required: ["path", "mediaType", "content"],
    run: write,
  },
  {
    name: "bakery_files_mkdir",
    operations: ["storageFolders.create"],
    description: "Create a folder at an absolute path whose parent exists.",
    readOnly: false,
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the new folder.",
      },
    },
    required: ["path"],
    run: direct("storageFolders.create"),
  },
]);

export function filesCallFailure(error: unknown): string {
  return error instanceof SessionRefusal
    ? `Bakery refused the file call: ${error.message}`
    : "The file call failed.";
}

export async function bakeryFilesTools(
  session: SessionApi,
): Promise<readonly BuiltinGatewayTool[]> {
  const offered = new Set((await session.tools()).map((tool) => tool.name));
  return FILES_TOOL_SPECS.filter((spec) =>
    spec.operations.every((operation) => offered.has(operation))
  ).map(
    (spec): BuiltinGatewayTool =>
      Object.freeze({
        name: spec.name,
        description: spec.description,
        readOnly: spec.readOnly,
        inputSchema: {
          type: "object",
          properties: spec.properties,
          required: [...spec.required],
          additionalProperties: false,
        },
        call: async (args) => {
          try {
            const result = await spec.run(session, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: filesCallFailure(error) }],
              isError: true,
            };
          }
        },
      }),
  );
}
