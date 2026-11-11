type SemanticOwnerAttribute =
  | "data-state"
  | "data-ui-component"
  | "data-variant";

export type SemanticNativeProps<Props> =
  & Omit<Props, "className" | "style" | SemanticOwnerAttribute>
  & Partial<Record<SemanticOwnerAttribute, never>>;

/** Removes caller-provided metadata reserved for canonical component owners. */
export function withoutSemanticOwnerProps<Props extends object>(
  props: Props,
): Omit<Props, SemanticOwnerAttribute> {
  const {
    "data-state": _state,
    "data-ui-component": _component,
    "data-variant": _variant,
    ...nativeProps
  } = props as Props & Partial<Record<SemanticOwnerAttribute, unknown>>;
  return nativeProps;
}
