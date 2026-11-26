import type { MessageKey } from "@bakery/i18n";
import { ACTION_TITLES } from "./workflow-state.ts";
import { type BlockKind, blockKindOf, planGateOf } from "./workflow-tree.ts";

export type LimitChange = {
  readonly name: string;
  readonly unit: "tries" | "items";
  readonly max: number;
  readonly was: number;
};

export type PublishChanges = {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly limits: readonly LimitChange[];
  readonly reordered: boolean;
  readonly grouped: boolean;
  readonly settings: boolean;
  readonly other: boolean;
  readonly differs: boolean;
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
  "when",
  "then",
];

const STOP = "workflow.stop";

function isObject(value: unknown): value is Held {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNode(value: unknown): value is Held & { id: string } {
  return isObject(value) && typeof value.id === "string" &&
    NODE_MARKS.some((mark) => value[mark] !== undefined);
}

function canonical(value: unknown): string {
  const ordered = (held: unknown): unknown =>
    Array.isArray(held)
      ? held.map(ordered)
      : isObject(held)
      ? Object.fromEntries(
        Object.keys(held).sort().map((key) => [key, ordered(held[key])]),
      )
      : held;
  return JSON.stringify(ordered(value)) ?? "";
}

function isWrapper(node: Held): boolean {
  return node.uses === undefined && planGateOf(node) === undefined &&
    blockKindOf(node) === "sequence";
}

type Card = {
  readonly path: string;
  readonly drawnPath: string;
  readonly parent: string;
  readonly node: Held;
  own: unknown;
  readonly end: boolean;
};

type Read = {
  readonly cards: Card[];
  readonly wrappers: string[];
  readonly rest: string;
  readonly whole: string;
};

function read(definition: unknown): Read {
  const spec = isObject(definition) ? definition : {};
  const { steps, ...rest } = spec;
  const top = Array.isArray(steps) ? steps : [];
  const cards: Card[] = [];
  const wrappers: string[] = [];
  const seen = new Map<string, number>();
  const unique = (path: string) => {
    const count = seen.get(path) ?? 0;
    seen.set(path, count + 1);
    return count === 0 ? path : `${path}#${count}`;
  };
  const walk = (value: unknown, path: string, drawn: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, path, drawn));
    }
    if (!isObject(value)) return value;
    if (!isNode(value)) {
      return Object.fromEntries(
        Object.entries(value).map((
          [key, held],
        ) => [key, walk(held, path, drawn)]),
      );
    }
    const full = unique(`${path}/${value.id}`);
    const inside = (parent: string) =>
      Object.fromEntries(
        Object.entries(value).map((
          [key, held],
        ) => [key, key === "id" ? held : walk(held, full, parent)]),
      );
    if (isWrapper(value)) {
      const { steps: held, ...own } = value;
      wrappers.push(canonical([full, own]));
      walk(held, full, drawn);
      return { ref: value.id };
    }
    const card: Card = {
      path: full,
      drawnPath: `${drawn}/${value.id}`,
      parent: drawn,
      node: value,
      own: undefined,
      end: value.uses === STOP && value === top.at(-1),
    };
    cards.push(card);
    card.own = planGateOf(value) === undefined ? inside(card.drawnPath) : value;
    return { ref: value.id };
  };
  walk(top, "", "");
  return {
    cards,
    wrappers,
    rest: canonical(rest),
    whole: canonical(spec),
  };
}

function pair(before: readonly Card[], after: readonly Card[]) {
  const matched = new Map<Card, Card>();
  const free = new Set(before);
  for (const key of ["path", "drawnPath"] as const) {
    for (const card of after) {
      if (matched.has(card)) continue;
      const earlier = [...free].find((one) => one[key] === card[key]);
      if (earlier === undefined) continue;
      matched.set(card, earlier);
      free.delete(earlier);
    }
  }
  return { matched, removed: [...free] };
}

function limitOf(card: Card): number | null {
  for (const block of ["repeat", "forEach"] as const) {
    const held = card.node[block];
    if (isObject(held) && typeof held.max === "number") return held.max;
  }
  return typeof card.node.max === "number" ? card.node.max : null;
}

function withoutLimit(card: Card): string {
  const strip = (held: unknown): unknown =>
    isObject(held)
      ? Object.fromEntries(
        Object.entries(held).filter(([key]) => key !== "max"),
      )
      : held;
  const own = card.own as Held;
  return canonical(strip({
    ...own,
    ...(own.repeat === undefined ? {} : { repeat: strip(own.repeat) }),
    ...(own.forEach === undefined ? {} : { forEach: strip(own.forEach) }),
  }));
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
  const name = (card: Card): string => {
    const node = planGateOf(card.node) ?? card.node;
    if (typeof node.name === "string" && node.name !== "") return node.name;
    if (card.end) return translate("library.editor.pathEnd");
    if (typeof node.uses === "string") return actionName(node.uses);
    const block = blockKindOf(card.node);
    return block === null || block === "sequence" || block === "approval"
      ? String(card.node.id)
      : translate(BLOCK_WORDS[block]);
  };
  const { matched, removed } = pair(held.cards, next.cards);
  const changed: string[] = [];
  const limits: LimitChange[] = [];
  for (const [card, earlier] of matched) {
    if (canonical(card.own) === canonical(earlier.own)) continue;
    const max = limitOf(card);
    const was = limitOf(earlier);
    if (max !== null && was !== null && max !== was) {
      limits.push({
        name: name(card),
        unit: blockKindOf(card.node) === "each" ? "items" : "tries",
        max,
        was,
      });
      if (withoutLimit(card) === withoutLimit(earlier)) continue;
    }
    changed.push(name(card));
  }
  const kept = next.cards.filter((card) => matched.has(card));
  const reordered = kept.some((card, index) =>
    kept.slice(index + 1).some((later) =>
      later.parent === card.parent &&
      held.cards.indexOf(matched.get(later)!) <
        held.cards.indexOf(matched.get(card)!)
    )
  );
  const added = next.cards.filter((card) => !matched.has(card)).map(name);
  const grouped = [...held.wrappers].sort().join() !==
    [...next.wrappers].sort().join();
  const first = before === null || before === undefined;
  const settings = !first && held.rest !== next.rest;
  const differs = first || held.whole !== next.whole;
  const listed = added.length + changed.length + removed.length +
          limits.length > 0 || reordered || grouped || settings;
  return {
    added,
    changed,
    removed: removed.map(name),
    limits,
    reordered,
    grouped: !first && grouped,
    settings,
    other: differs && !first && !listed,
    differs,
  };
}

export function anyChange(changes: PublishChanges): boolean {
  return changes.differs;
}
