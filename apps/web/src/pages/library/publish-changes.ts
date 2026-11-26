import type { MessageKey } from "@bakery/i18n";
import { ACTION_TITLES } from "./workflow-state.ts";

export type PublishChanges = {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly reordered: boolean;
  readonly settings: boolean;
};

type Held = Record<string, unknown>;

const BLOCK_WORDS: Readonly<Record<string, MessageKey>> = {
  repeat: "library.editor.group.repeat",
  parallel: "library.editor.group.together",
  forEach: "library.editor.group.each",
  branch: "library.editor.group.if",
  wait: "library.editor.group.wait",
  call: "library.editor.group.call",
};

const NODE_MARKS = ["uses", "steps", "kind", ...Object.keys(BLOCK_WORDS)];

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
  const own = Object.fromEntries(
    Object.keys(value).sort().map((name) => [
      name,
      walk(value[name], `${key}/${name}`, found),
    ]),
  );
  if (!isNode(value)) return own;
  found.own.set(value.id, JSON.stringify(own));
  found.node.set(value.id, value);
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
  const name = (node: Held | undefined): string => {
    if (node === undefined) return "";
    if (typeof node.name === "string" && node.name !== "") return node.name;
    if (typeof node.uses === "string") {
      const key = ACTION_TITLES[node.uses];
      return key === undefined ? node.uses : translate(key);
    }
    const block = Object.keys(BLOCK_WORDS).find((one) =>
      node[one] !== undefined || node.kind === one
    );
    return block === undefined
      ? String(node.id)
      : translate(BLOCK_WORDS[block]);
  };
  const named = (ids: Iterable<string>, from: Map<string, Held>) =>
    [...ids].map((id) => name(from.get(id)));
  const ids = [...next.own.keys()];
  const reordered = [...next.lists].some(([at, list]) => {
    const kept = list.filter((id) => held.own.has(id));
    const earlier = (held.lists.get(at) ?? []).filter((id) => next.own.has(id));
    return kept.length > 1 && earlier.join() !== kept.join();
  });
  return {
    added: named(ids.filter((id) => !held.own.has(id)), next.node),
    changed: named(
      ids.filter((id) =>
        held.own.has(id) && held.own.get(id) !== next.own.get(id)
      ),
      next.node,
    ),
    removed: named(
      [...held.own.keys()].filter((id) => !next.own.has(id)),
      held.node,
    ),
    reordered,
    settings: before !== null && before !== undefined &&
      held.rest !== next.rest,
  };
}

export function anyChange(changes: PublishChanges): boolean {
  return changes.added.length > 0 || changes.changed.length > 0 ||
    changes.removed.length > 0 || changes.reordered || changes.settings;
}
