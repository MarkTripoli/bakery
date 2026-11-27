import type { SessionApi } from "../../../packages/cli/src/session-call.ts";

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
  operation: string;
  description: string;
  readOnly: boolean;
  properties: Record<string, unknown>;
  required: readonly string[];
  arguments?: (args: Record<string, unknown>) => Record<string, unknown>;
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

const FILES_TOOL_SPECS: readonly FilesToolSpec[] = Object.freeze([
  {
    name: "bakery_files_roots",
    operation: "storageRoots.list",
    description:
      "List the top-level folders of Bakery Files this step may open.",
    readOnly: true,
    properties: {},
    required: [],
  },
  {
    name: "bakery_files_list",
    operation: "storageFolderEntries.list",
    description:
      "List the files and folders in one Bakery Files folder, a page at a time.",
    readOnly: true,
    properties: { id: entryId, cursor, limit },
    required: ["id"],
  },
  {
    name: "bakery_files_stat",
    operation: "storageFileVersions.list",
    description:
      "Describe a file's current version: revision, size, media type and SHA-256.",
    readOnly: true,
    properties: { id: entryId },
    required: ["id"],
    arguments: (args) => ({ ...args, limit: 1 }),
  },
  {
    name: "bakery_files_read",
    operation: "storageFiles.content",
    description:
      "Read a file's bytes, as base64, whole or one byte range. The answer carries the version's SHA-256.",
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
  },
  {
    name: "bakery_files_search",
    operation: "files.search",
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
  },
  {
    name: "bakery_files_write",
    operation: "storageFiles.put",
    description:
      "Upload a file to a path, or save a new version of the file already there. Content is base64, at most 1 MiB.",
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
      content: { type: "string", description: "The file's bytes, base64." },
    },
    required: ["path", "mediaType", "content"],
  },
  {
    name: "bakery_files_mkdir",
    operation: "storageFolders.create",
    description: "Create a folder at an absolute path whose parent exists.",
    readOnly: false,
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the new folder.",
      },
    },
    required: ["path"],
  },
]);

export const FILES_CALL_FAILED_TEXT = "The file call was refused or failed.";

export async function bakeryFilesTools(
  session: SessionApi,
): Promise<readonly BuiltinGatewayTool[]> {
  const offered = new Set((await session.tools()).map((tool) => tool.name));
  return FILES_TOOL_SPECS.filter((spec) => offered.has(spec.operation)).map(
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
            const result = await session.call(
              spec.operation,
              spec.arguments?.(args) ?? args,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            };
          } catch {
            return {
              content: [{ type: "text", text: FILES_CALL_FAILED_TEXT }],
              isError: true,
            };
          }
        },
      }),
  );
}
