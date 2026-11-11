import { createLink } from "@tanstack/react-router";
import * as UI from "@bakery/ui";

/**
 * `UI.Link` driven by the router: the same anchor every auth screen renders,
 * but a click navigates in place instead of reloading the document. Settings
 * screens link between account pages with this; the entry screens keep plain
 * `UI.Link href` because a full document load is what they want there.
 */
export const RouterLink = createLink(UI.Link);
