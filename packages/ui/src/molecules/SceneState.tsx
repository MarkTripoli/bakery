import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import { scene } from "../brand/scene-assets.ts";
import type { SceneId } from "../brand/scene-select.ts";
import "../feedback.css";

export type SceneStateProps =
  & SemanticNativeProps<HTMLAttributes<HTMLElement>>
  & {
    /** The page's own actions, unchanged: this template adds no button of its own. */
    action?: ReactNode;
    /** The sentence under the heading, in the page's own words. */
    description?: ReactNode;
    /** Which character scene stands above the heading. */
    scene: SceneId;
    /** The page's own heading. The scene never replaces it. */
    title: ReactNode;
    /** `page` insets the block by the 32px page inset, as `EmptyState` does. */
    inset?: "none" | "page";
  };

/**
 * A whole page that has one thing to say, with the character scene above it.
 *
 * The rule this component exists to make easy to follow: a scene appears only
 * when the whole page (or the whole content area) says one thing. Never inside
 * a list, table, card, panel, dialog, sheet or banner - those keep the plain
 * `EmptyState` - and at most one scene on screen. A mascot on every empty list
 * would make routine screens loud; on the rare whole-page moment it makes them
 * friendly.
 *
 * The scene is decoration, because the heading says the same thing in words:
 * it carries an empty `alt` and is hidden from assistive technology. The
 * heading, the sentence and the actions are the page's own and are not
 * restyled here, so a page that adopts this template keeps its copy and its
 * buttons exactly as they were.
 */
export function SceneState(
  {
    action,
    description,
    inset = "none",
    scene: id,
    title,
    ...props
  }: SceneStateProps,
) {
  // The 600px export is the one the design asks for at both sizes: 240px on a
  // desktop and 160px on a phone, which is a downscale of the same art rather
  // than a second asset to keep in step.
  const art = scene(id, { theme: "light", width: 600 });
  const dark = scene(id, { theme: "dark", width: 600 });
  return (
    <section
      className="ui-scene-state"
      {...props}
      data-inset={inset === "page" ? "page" : undefined}
      data-scene={id}
      data-state="default"
      data-ui-component="sceneState"
    >
      {
        /* One <picture> rather than two <img>s: the theme picks the art, and a
          hidden duplicate would be a second image for a screen reader to skip
          and a second request for the browser to make. */
      }
      <picture className="ui-scene-state__art">
        <source media="(prefers-color-scheme: dark)" srcSet={dark.src} />
        <img
          alt=""
          aria-hidden="true"
          height={art.height}
          src={art.src}
          width={art.width}
        />
      </picture>
      <h2 className="ui-feedback-title">{title}</h2>
      {description
        ? <div className="ui-feedback-description">{description}</div>
        : null}
      {action ? <div className="ui-feedback-action">{action}</div> : null}
    </section>
  );
}
