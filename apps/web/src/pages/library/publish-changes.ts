import type { MessageKey } from "@bakery/i18n";
import { ACTION_TITLES } from "./workflow-state.ts";
import { type BlockKind, blockKindOf } from "./workflow-tree.ts";

export type PublishChanges = {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly reordered: boolean;
  readonly settings: boolean;
};

type Held = Record<string, unknown>;

const BLOCK_WORDS: Readonly<
  Record<Exclude<BlockKind, "approval" | "sequence">, MessageKey>
> = {
  if: "library.editor.group.if",
  fix: "library.editor.group.fixUntilPasses",
  repeat: "library.editor.group.repeat",
  together: "library.editor.group.together",
  each: "library.editor.group.each",
  call: "library.editor.group.call",
  wait: "library.editor.group.wait",
};

const NODE_MARKS = [
  "uses",
  "steps",
  "kind",
  "repeat",
  "parallel",
  "forEach",
  "branch",
  "wait",
  "call",
];

function isObject(value: unknown): value is Held {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNode(value: Held): value is Held & { id: string } {
  return typeof value.id === "string" &&
    NODE_MARKS.some((mark) => value[mark] !== undefined);
}

type Walked = {
  readonly own: Map<string, string>;
  readonly node: Map<string, Held>;
  readonly lists: Map<string, readonly string[]>;
};

function walk(value: unknown, at: string, found: Walked): unknown {
  if (Array.isArray(value)) {
    const ids = value.flatMap((item) =>
      isObject(item) && isNode(item) ? [item.id] : []
    );
    if (ids.length > 0) found.lists.set(at, ids);
    return value.map((item, index) => walk(item, `${at}/${index}`, found));
  }
  if (!isObject(value)) return value;
  const key = isNode(value) ? value.id : at;
  if (isNode(value)) {
    found.own.set(value.id, "");
    found.node.set(value.id, value);
  }
  const own = Object.fromEntries(
    Object.keys(value).sort().map((name) => [
      name,
      walk(value[name], `${key}/${name}`, found),
    ]),
  );
  if (!isNode(value)) return own;
  found.own.set(value.id, JSON.stringify(own));
  return { ref: value.id };
}

function read(definition: unknown) {
  const found: Walked = {
    own: new Map(),
    node: new Map(),
    lists: new Map(),
  };
  const { steps, ...rest } = isObject(definition) ? definition : {};
  walk(steps ?? [], "steps", found);
  return { ...found, rest: JSON.stringify(walk(rest, "", found)) };
}

export function publishChanges(
  before: unknown,
  after: unknown,
  translate: (key: MessageKey) => string,
): PublishChanges {
  const held = read(before);
  const next = read(after);
  const actionName = (uses: string): string => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key);
  };
  const name = (node: Held | undefined): string => {
    if (node === undefined) return "";
    if (typeof node.name === "string" && node.name !== "") return node.name;
    if (typeof node.uses === "string") return actionName(node.uses);
    const block = blockKindOf(node);
    if (block === "approval") return actionName("human.approval");
    return block === null || block === "sequence"
      ? String(node.id)
      : translate(BLOCK_WORDS[block]);
  };
  const drawn = (node: Held | undefined) =>
    node !== undefined &&
    (node.uses !== undefined || blockKindOf(node) !== "sequence");
  const named = (ids: Iterable<string>, from: Map<string, Held>) =>
    [...ids].filter((id) => drawn(from.get(id))).map((id) =>
      name(from.get(id))
    );
  const ids = [...next.own.keys()];
  const reordered = [...next.lists].some(([at, list]) => {
    const kept = list.filter((id) => held.own.has(id));
    const earlier = (held.lists.get(at) ?? []).filter((id) => next.own.has(id));
    return kept.length > 1 && earlier.join() !== kept.join();
  });
  const edited = ids.filter((id) =>
    held.own.has(id) && held.own.get(id) !== next.own.get(id)
  );
  const wrapperEdited = edited.some((id) => !drawn(next.node.get(id)));
  return {
    added: named(ids.filter((id) => !held.own.has(id)), next.node),
    changed: named(edited, next.node),
    removed: named(
      [...held.own.keys()].filter((id) => !next.own.has(id)),
      held.node,
    ),
    reordered,
    settings: before !== null && before !== undefined &&
      (held.rest !== next.rest || wrapperEdited),
  };
}

export function anyChange(changes: PublishChanges): boolean {
  return changes.added.length > 0 || changes.changed.length > 0 ||
    changes.removed.length > 0 || changes.reordered || changes.settings;
}
