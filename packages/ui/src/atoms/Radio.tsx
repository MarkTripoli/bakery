import {
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type SemanticNativeProps,
  withoutSemanticOwnerProps,
} from "../foundations/semantic-native-props.ts";
import "../controls.css";

export type RadioProps =
  & Omit<SemanticNativeProps<InputHTMLAttributes<HTMLInputElement>>, "type">
  & {
    children: ReactNode;
  };

export function Radio({ children, ...unsafeInputProps }: RadioProps) {
  const inputProps = withoutSemanticOwnerProps(unsafeInputProps);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [uncontrolledChecked, setUncontrolledChecked] = useState(
    Boolean(inputProps.defaultChecked),
  );
  const isChecked = inputProps.checked === undefined
    ? uncontrolledChecked
    : inputProps.checked;
  const invalid = inputProps["aria-invalid"] === true ||
    inputProps["aria-invalid"] === "true";
  const state = inputProps.disabled
    ? "disabled"
    : invalid
    ? "invalid"
    : focused
    ? "focus"
    : "default";

  useEffect(() => {
    const input = inputRef.current;
    if (!input || inputProps.checked !== undefined) return;
    const form = input.form;
    let disposed = false;
    const synchronizeGroup = (event: Event) => {
      const target = event.target;
      if (
        input.name && target instanceof HTMLInputElement &&
        target.type === "radio" && target.name === input.name
      ) {
        setUncontrolledChecked(input.checked);
      }
    };
    const synchronizeReset = () => {
      globalThis.setTimeout(() => {
        if (!disposed) setUncontrolledChecked(input.checked);
      });
    };
    document.addEventListener("change", synchronizeGroup);
    form?.addEventListener("reset", synchronizeReset);
    return () => {
      document.removeEventListener("change", synchronizeGroup);
      form?.removeEventListener("reset", synchronizeReset);
      disposed = true;
    };
  }, [inputProps.checked]);

  return (
    <label
      className="ui-radio"
      data-state={state}
      data-ui-component="radio"
      data-variant={isChecked ? "checked" : "unchecked"}
    >
      <input
        {...inputProps}
        onBlur={(event) => {
          inputProps.onBlur?.(event);
          setFocused(false);
        }}
        onChange={(event) => {
          inputProps.onChange?.(event);
          if (inputProps.checked === undefined) {
            setUncontrolledChecked(event.currentTarget.checked);
          }
        }}
        onFocus={(event) => {
          inputProps.onFocus?.(event);
          setFocused(true);
        }}
        ref={inputRef}
        type="radio"
      />
      {children}
    </label>
  );
}
