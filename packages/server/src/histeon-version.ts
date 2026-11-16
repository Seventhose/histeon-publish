/**
 * Doc 23 item 175: the Histeon this Publish knows, and what a linked site with an older one cannot do.
 *
 * The version is the plugin of the pinned builder (packages/cms/vendor/histos/UPSTREAM.md, «Pinned commit … Histeon
 * X.Y.Z»), the same one the desktop app packages and installs on a new WordPress; a test keeps the two equal. A site says
 * its version in the link's capabilities (`environment.histeon`) from Histeon 0.5.2 on: a site that says nothing has the
 * released 0.5.1 or an earlier one.
 */
export const HISTEON_VERSION = "0.5.15";

/** The newest Histeon a site that does not say its version can have. */
export const HISTEON_WITHOUT_ENVIRONMENT = "0.5.1";

export type HisteonFeatureId = "site-environment" | "post-image" | "types-without-pages" | "group-by" | "media-links" | "url-path" | "loop-group" | "terms-order" | "front-page" | "site-check" | "field-order" | "svg-text";

export interface HisteonFeature {
  id: HisteonFeatureId;
  /** The Histeon that brought it. */
  since: string;
  /** The capability that stops a send needing it, when there is one; without it the site refuses such a send itself. */
  capability?: string;
}

/**
 * What Publish uses of each Histeon, oldest first. A feature with a capability is checked before a send (the real block
 * stays there); one without is refused by the older site's own validation, so Publish can only say it beforehand.
 */
export const HISTEON_FEATURES: readonly HisteonFeature[] = [
  { id: "site-environment", since: "0.5.2" },
  { id: "post-image", since: "0.5.2" },
  { id: "types-without-pages", since: "0.5.2" },
  { id: "group-by", since: "0.5.2" },
  { id: "media-links", since: "0.5.2", capability: "histos-media-links-v1" },
  { id: "url-path", since: "0.5.4", capability: "histos-url-path-v1" },
  // Doc 23, item 187: in the builder after 0.5.4, released with 0.5.5; until HISTEON_VERSION says so, no notice lists it.
  { id: "loop-group", since: "0.5.5", capability: "histos-loop-group-v1" },
  // Doc 23, items 202, 201 and 197 (Histeon 0.5.7): a site refuses nothing for these, it just does not have them.
  { id: "terms-order", since: "0.5.7" },
  { id: "front-page", since: "0.5.7" },
  { id: "site-check", since: "0.5.7" },
  // Doc 23, item 232 (Histeon 0.5.13): an older site refuses a query ordered by a field, and the whole send with it.
  { id: "field-order", since: "0.5.13" },
  // Histeon 0.5.14: SVG drawings with text, gradients, inline style and states. The send of a project that uses them
  // is stopped by the capability (assertRemoteSupportsMarkup).
  { id: "svg-text", since: "0.5.14", capability: "histos-svg-text-v1" },
];

export interface HisteonSiteNotice {
  /** The site's Histeon, or null when it does not say it (0.5.1 or earlier). */
  site: string | null;
  /** The Histeon this Publish knows and installs. */
  known: string;
  /** What does not work until the site is updated. */
  missing: HisteonFeature[];
}

const parts = (version: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})/u.exec(version) ?? []).slice(1).map(Number);
  return [major, minor, patch];
};

/** Negative when `left` is older than `right`; only the three numbers count (a «-dev» suffix does not). */
export function compareHisteon(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The notice for a site, or null when its Histeon is the known one or a newer one. */
export function histeonSiteNotice(site: string | null, known: string = HISTEON_VERSION): HisteonSiteNotice | null {
  const effective = site ?? HISTEON_WITHOUT_ENVIRONMENT;
  if (compareHisteon(effective, known) >= 0) return null;
  return {
    site,
    known,
    missing: HISTEON_FEATURES.filter((feature) => compareHisteon(feature.since, effective) > 0 && compareHisteon(feature.since, known) <= 0).map((feature) => ({ ...feature })),
  };
}
