import type { StorageFolderItem } from "../../api/client.ts";

/** The files page's address for a folder path: `/files` at the top, else `/files/projects/web`. */
export function filesHref(path: string): string {
  return path === "" ? "/files" : `/files${path}`;
}

/** The folder path a `/files/$` address names: `""` at the top, else `/projects/web`. */
export function folderPathOf(splat: string | undefined): string {
  const trimmed = (splat ?? "").split("/").filter((part) => part !== "").join(
    "/",
  );
  return trimmed === "" ? "" : `/${trimmed}`;
}

/** The message that says what one top-level folder holds, by where it sits. */
export function rootNoteKey(item: StorageFolderItem) {
  if (item.policy === "personal") return "files.root.yours" as const;
  const top = item.path.split("/").filter((part) => part !== "")[0] ?? "";
  switch (top) {
    case "projects":
      return "files.root.projects" as const;
    case "shared":
      return "files.root.shared" as const;
    case "library":
      return "files.root.library" as const;
    case "connections":
      return "files.root.connections" as const;
    case "trash":
      return "files.root.trash" as const;
    case "system":
      return "files.root.system" as const;
    default:
      return null;
  }
}

/** The designed name of a top-level folder, by where it sits. */
export function rootNameKey(item: StorageFolderItem) {
  const top = item.path.split("/").filter((part) => part !== "")[0] ?? "";
  switch (top) {
    case "projects":
      return "files.root.name.projects" as const;
    case "shared":
      return "files.root.name.shared" as const;
    case "library":
      return "files.root.name.library" as const;
    case "connections":
      return "files.root.name.connections" as const;
    case "trash":
      return "files.root.name.trash" as const;
    case "system":
      return "files.root.name.system" as const;
    default:
      return null;
  }
}

/** A size as a number and the unit it reads in (1,024 to the step). */
export function sizeParts(bytes: number): {
  readonly value: number;
  readonly unit: "bytes" | "kilobytes" | "megabytes" | "gigabytes";
} {
  if (bytes < 1024) return { value: bytes, unit: "bytes" };
  if (bytes < 1024 ** 2) return { value: bytes / 1024, unit: "kilobytes" };
  if (bytes < 1024 ** 3) return { value: bytes / 1024 ** 2, unit: "megabytes" };
  return { value: bytes / 1024 ** 3, unit: "gigabytes" };
}
