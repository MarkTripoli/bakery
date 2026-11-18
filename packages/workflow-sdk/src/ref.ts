/**
 * A reference is the string the document carries (`$input.repositoryId`,
 * `$step.brief.artifact.versionId`). The type is an opaque brand over the value
 * it resolves to, so a reference to a number is not a string and is refused
 * where a string is expected. At runtime it is that plain string, so the
 * document the builder emits is plain JSON.
 */
declare const refValue: unique symbol;
export type Ref<T> = { readonly [refValue]: T };

const MAX_DEPTH = 5;
type Prev = [never, 0, 1, 2, 3, 4];

type Join<K extends string, P> = P extends string ? `${K}.${P}` : never;

/** Every dotted path through an object type, to a bounded depth. */
export type OutputPath<T, D extends number = typeof MAX_DEPTH> = [D] extends
  [never] ? never
  : T extends readonly unknown[] ? never
  : T extends object ? {
      [K in keyof T & string]:
        | K
        | Join<K, OutputPath<NonNullable<T[K]>, Prev[D]>>;
    }[keyof T & string]
  : never;

/** The type found at a dotted path. */
export type ValueAt<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T ? ValueAt<NonNullable<T[H]>, R> : never
  : P extends keyof T ? T[P]
  : never;
