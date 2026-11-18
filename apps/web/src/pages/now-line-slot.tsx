import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type Publisher = (node: ReactNode) => void;

const NowLineContext = createContext<Publisher | null>(null);
const NowLineNodeContext = createContext<ReactNode>(null);

/**
 * Lets a page's content put the session's "now" line where the page keeps its
 * composer: in the sticky footer, directly above it, at every width and however
 * far the content has scrolled.
 *
 * The content publishes a node; the footer renders the outlet. A page with no
 * provider publishes nothing, and the content draws the line where it is.
 */
export function NowLineProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null);
  const publish = useMemo<Publisher>(() => (next) => setNode(next), []);
  return (
    <NowLineContext.Provider value={publish}>
      <NowLineNodeContext.Provider value={node}>
        {children}
      </NowLineNodeContext.Provider>
    </NowLineContext.Provider>
  );
}

/** The footer's place for the published line. */
export function NowLineOutlet() {
  return <>{useContext(NowLineNodeContext)}</>;
}

/**
 * Publishes `node` into the footer's outlet while it is set. Returns whether
 * there is an outlet to publish into, so the caller can draw the line itself
 * when there is not.
 */
export function usePublishNowLine(node: ReactNode): boolean {
  const publish = useContext(NowLineContext);
  useEffect(() => {
    if (!publish) return;
    publish(node);
    return () => publish(null);
  }, [publish, node]);
  return publish !== null;
}
