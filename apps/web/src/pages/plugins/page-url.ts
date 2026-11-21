/** What the host hands a plugin page: how Bakery looks and reads for this person. */
export type PluginPageRender = {
  readonly theme: "light" | "dark";
  /** The person's Bakery locale as a BCP 47 tag, such as "en" or "ar-EG". */
  readonly locale: string;
  readonly dir: "ltr" | "rtl";
};

/**
 * The address of one plugin page's document, for the sealed frame's `src`.
 * A frame cannot send the organization header, so the organization rides in
 * the query next to the three render inputs the page reads from its own
 * `location.search`. The path segments are encoded, so an id can never add a
 * segment of its own.
 */
export function pluginPageDocumentUrl(
  installId: string,
  pageId: string,
  organizationId: string,
  render: PluginPageRender,
): string {
  const query = new URLSearchParams({
    theme: render.theme,
    locale: render.locale,
    dir: render.dir,
    organizationId,
  });
  return `/v1/plugin-installs/${encodeURIComponent(installId)}/pages/${
    encodeURIComponent(pageId)
  }/document?${query.toString()}`;
}
