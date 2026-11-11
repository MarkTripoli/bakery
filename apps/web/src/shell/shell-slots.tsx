import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Shell regions a route may fill: the top-bar breadcrumbs and actions, the
 * inspector column and the status strip (Paper 5J-0 / HU-0). The shell owns
 * the regions; a page claims one with `<ShellSlot>` and its children portal
 * into it, so page state and queries stay in the page.
 */
export type ShellSlotName =
  | "breadcrumbs"
  | "actions"
  | "inspector"
  | "statusStrip";

type ShellSlotsValue = {
  claimed: ReadonlySet<ShellSlotName>;
  claim: (name: ShellSlotName) => () => void;
  targets: Partial<Record<ShellSlotName, HTMLElement>>;
  target: (name: ShellSlotName) => (element: HTMLElement | null) => void;
  inspectorSize: "standard" | "medium" | "wide";
  setInspectorSize: (size: "standard" | "medium" | "wide") => void;
  mainInset: "padded" | "flush" | "page" | "pageWide";
  setMainInset: (inset: "padded" | "flush" | "page" | "pageWide") => void;
  /** `page` when the mounted page draws its own phone header, not the shell. */
  phoneHeader: "shell" | "page";
  setPhoneHeader: (owner: "shell" | "page") => void;
  activeNavigation: string | null;
  setActiveNavigation: (id: string | null) => void;
};

const ShellSlotsContext = createContext<ShellSlotsValue | null>(null);

export function ShellSlotsProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Map<ShellSlotName, number>>(
    () => new Map(),
  );
  const [targets, setTargets] = useState<
    Partial<Record<ShellSlotName, HTMLElement>>
  >({});
  const [inspectorSize, setInspectorSize] = useState<
    "standard" | "medium" | "wide"
  >(
    "standard",
  );
  const [mainInset, setMainInset] = useState<
    "padded" | "flush" | "page" | "pageWide"
  >(
    "padded",
  );
  const [phoneHeader, setPhoneHeader] = useState<"shell" | "page">("shell");
  const [activeNavigation, setActiveNavigation] = useState<string | null>(
    null,
  );
  const claim = useCallback((name: ShellSlotName) => {
    setClaims((current) =>
      new Map(current).set(name, (current.get(name) ?? 0) + 1)
    );
    return () =>
      setClaims((current) => {
        const next = new Map(current);
        const count = (next.get(name) ?? 1) - 1;
        if (count > 0) next.set(name, count);
        else next.delete(name);
        return next;
      });
  }, []);
  // One stable ref callback per region: a fresh callback on every render
  // would detach and re-attach the ref, re-setting state in a loop.
  const refs = useRef(
    new Map<ShellSlotName, (element: HTMLElement | null) => void>(),
  );
  const target = useCallback((name: ShellSlotName) => {
    let ref = refs.current.get(name);
    if (!ref) {
      ref = (element: HTMLElement | null) =>
        setTargets((current) =>
          current[name] === (element ?? undefined)
            ? current
            : { ...current, [name]: element ?? undefined }
        );
      refs.current.set(name, ref);
    }
    return ref;
  }, []);
  const value = useMemo<ShellSlotsValue>(() => ({
    claimed: new Set(claims.keys()),
    claim,
    targets,
    target,
    inspectorSize,
    setInspectorSize,
    mainInset,
    setMainInset,
    phoneHeader,
    setPhoneHeader,
    activeNavigation,
    setActiveNavigation,
  }), [
    claims,
    claim,
    targets,
    target,
    inspectorSize,
    mainInset,
    phoneHeader,
    activeNavigation,
  ]);
  return (
    <ShellSlotsContext.Provider value={value}>
      {children}
    </ShellSlotsContext.Provider>
  );
}

/** Shell-side access: which regions are claimed and where they mount. */
export function useShellSlotTargets() {
  return useContext(ShellSlotsContext);
}

/**
 * Render `children` into a shell region. Outside an app shell (auth entry
 * routes, Storybook) it renders nothing, and `fallback` is shown in place.
 */
export function ShellSlot(
  { children, fallback = null, name, size }: {
    children: ReactNode;
    fallback?: ReactNode;
    name: ShellSlotName;
    /** Inspector only: `wide` is the HU-0 session pane. */
    size?: "standard" | "medium" | "wide";
  },
) {
  const slots = useContext(ShellSlotsContext);
  const claim = slots?.claim;
  const setInspectorSize = slots?.setInspectorSize;
  useLayoutEffect(() => claim?.(name), [claim, name]);
  useLayoutEffect(() => {
    if (name !== "inspector" || !size || !setInspectorSize) return;
    setInspectorSize(size);
    return () => setInspectorSize("standard");
  }, [name, setInspectorSize, size]);
  if (!slots) return <>{fallback}</>;
  const element = slots.targets[name];
  return element ? createPortal(children, element) : null;
}

/**
 * Let a page that carries its own Paper inset render flush in `<main>`. With
 * `phoneHeader="page"` the page draws its own phone header (a back control or
 * compact bar), so the shell drops its top bar on phones.
 */
export function ShellFlushMain(
  { inset = "flush", phoneHeader = "shell" }: {
    inset?: "flush" | "page" | "pageWide";
    phoneHeader?: "shell" | "page";
  },
) {
  const slots = useContext(ShellSlotsContext);
  const setMainInset = slots?.setMainInset;
  const setPhoneHeader = slots?.setPhoneHeader;
  useLayoutEffect(() => {
    if (!setMainInset) return;
    setMainInset(inset);
    return () => setMainInset("padded");
  }, [inset, setMainInset]);
  useLayoutEffect(() => {
    if (!setPhoneHeader) return;
    setPhoneHeader(phoneHeader);
    return () => setPhoneHeader("shell");
  }, [phoneHeader, setPhoneHeader]);
  return null;
}

/**
 * Mark a primary destination current when the route's own path does not
 * match it, e.g. a session view under `/tasks/:id` marks Sessions. The item
 * links to the presented route while the override is mounted.
 */
export function ShellActiveNavigation({ id }: { id: string }) {
  const setActiveNavigation = useContext(ShellSlotsContext)
    ?.setActiveNavigation;
  useLayoutEffect(() => {
    if (!setActiveNavigation) return;
    setActiveNavigation(id);
    return () => setActiveNavigation(null);
  }, [id, setActiveNavigation]);
  return null;
}
