import { HistosPublishError } from "@histos-publish/core";
import type { CmsProjectCatalog } from "@histos-publish/cms";
import type { CmsRemoteCatalog, CmsRemoteConnection, CmsRemoteSecretStore } from "./cms-remote-catalog.js";
import { readStoredSecret } from "./cms-remote.js";
import { REMOTE_NAMESPACE, requestRemote, UUID, validateCapabilities } from "./cms-remote-transport.js";

/**
 * Doc 23 item 201: on a new WordPress the project's home does not become the site's home (`show_on_front` stays
 * `posts`): the home is at /home/ while in Publish it is /. After the first send with publishing, Publish proposes to
 * set the site's home and posts page as in the project, and sets them only when the user says yes. The site's route
 * is `/front-page` of the bridge (builder docs/spec/cms-bridge.md §18).
 *
 * The pages come from the project, never from the client: the app only answers yes or no. Asked once per
 * connection: the answer is remembered (CmsRemoteCatalog.frontPageAnswer).
 */

const ROUTE = `${REMOTE_NAMESPACE}/front-page`;

export interface CmsFrontPageOffer {
  /** The project's home page, which would become the site's home. */
  frontPage: { id: string; title: string };
  /** The project's «blog» page, which would list the posts; null when the project has none. */
  postsPage: { id: string; title: string } | null;
  /** The project has posts but no «blog» page: on WP the list of all posts then has no address of its own. */
  postsWithoutPage: boolean;
  /** What the site shows today: its posts, a page of the project, or a page of its own (never named). */
  current: { showOnFront: "posts" | "page"; frontPageIsOther: boolean; postsPageIsOther: boolean };
}

interface SiteFrontPage {
  showOnFront: "posts" | "page";
  frontPage: string | null;
  postsPage: string | null;
  frontPageOther: boolean;
  postsPageOther: boolean;
}

/** The site's answer, checked field by field: it is untrusted data. */
export function parseSiteFrontPage(value: unknown): SiteFrontPage {
  const item = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const id = (entry: unknown) => (entry === null ? null : typeof entry === "string" && UUID.test(entry) ? entry : undefined);
  const frontPage = id(item?.frontPage);
  const postsPage = id(item?.postsPage);
  if (
    !item ||
    (item.showOnFront !== "posts" && item.showOnFront !== "page") ||
    frontPage === undefined ||
    postsPage === undefined ||
    typeof item.frontPageOther !== "boolean" ||
    typeof item.postsPageOther !== "boolean"
  )
    throw new HistosPublishError("Il sito non dice in modo valido quale sia la sua pagina iniziale.", "cms-remote-front-page-invalid", 502);
  return { showOnFront: item.showOnFront, frontPage, postsPage, frontPageOther: item.frontPageOther, postsPageOther: item.postsPageOther };
}

/** The project's home («home») and posts page («blog»), published and in the site's own language. */
async function projectPages(projects: CmsProjectCatalog, projectId: string): Promise<{ home: { id: string; title: string } | null; blog: { id: string; title: string } | null; hasPosts: boolean }> {
  const opened = await projects.openProject(projectId);
  if (!opened) throw new HistosPublishError("Progetto CMS locale non trovato.", "cms-project-missing", 404);
  try {
    const locale = opened.store.getRenderSettings().locale.toLowerCase();
    const own = (document: { locale: string | null }) => document.locale === null || document.locale.toLowerCase() === locale;
    const pages = opened.store.listPages().filter((page) => page.status === "published" && own(page));
    const named = (slug: string) => {
      const page = pages.find((item) => item.slug === slug);
      return page ? { id: page.id, title: page.title.slice(0, 120) } : null;
    };
    return { home: named("home"), blog: named("blog"), hasPosts: opened.store.listPosts().some((post) => post.status === "published" && own(post)) };
  } finally {
    opened.store.close();
  }
}

function linkedConnection(catalog: CmsRemoteCatalog, connectionId: string, projectId: string): CmsRemoteConnection {
  const connection = catalog.get(connectionId);
  if (!connection) throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
  if (!UUID.test(projectId) || connection.projectId !== projectId)
    throw new HistosPublishError("Il sito WP è collegato a un altro progetto.", "cms-remote-project-changed", 409);
  return connection;
}

/**
 * The proposal for this site, or null: none once the user answered, without the publish permission, on a site whose
 * Histeon cannot set its home, when the project has no published home page, or when the site already shows the
 * project's home and posts page.
 */
export async function frontPageOffer(
  input: { connectionId: string; projectId: string },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<CmsFrontPageOffer | null> {
  const connection = linkedConnection(catalog, input.connectionId, input.projectId);
  if (catalog.frontPageAnswer(connection.id) !== null || !connection.publish || !connection.read) return null;
  const pages = await projectPages(projects, input.projectId);
  if (!pages.home) return null;
  const secret = await readStoredSecret(storeFor, connection.id);
  const capabilities = validateCapabilities(JSON.parse((await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`)).bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId || capabilities.projectId !== input.projectId || !capabilities.frontPage || !capabilities.publish) return null;
  const site = parseSiteFrontPage(JSON.parse((await requestRemote(connection, secret, "GET", ROUTE, new Uint8Array(), 16 * 1024)).bytes.toString("utf8")) as unknown);
  const homeDone = site.showOnFront === "page" && site.frontPage === pages.home.id;
  const postsDone = !pages.blog || site.postsPage === pages.blog.id;
  if (homeDone && postsDone) return null;
  return {
    frontPage: pages.home,
    postsPage: pages.blog,
    postsWithoutPage: !pages.blog && pages.hasPosts,
    current: { showOnFront: site.showOnFront, frontPageIsOther: site.frontPageOther, postsPageIsOther: site.postsPageOther },
  };
}

/**
 * The user's answer. Yes: the site's home and posts page become the project's, read again from the project now;
 * no: nothing changes on the site. Either way the proposal is not made again for this connection.
 */
export async function answerFrontPageOffer(
  input: { connectionId: string; projectId: string; accept: boolean },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<{ answer: "accepted" | "declined"; showOnFront?: "posts" | "page" }> {
  const connection = linkedConnection(catalog, input.connectionId, input.projectId);
  if (!input.accept) {
    catalog.setFrontPageAnswer(connection.id, "declined");
    return { answer: "declined" };
  }
  if (!connection.publish)
    throw new HistosPublishError("Per cambiare la pagina iniziale del sito il collegamento deve permettere di pubblicare.", "cms-remote-publish-scope-required", 403);
  const pages = await projectPages(projects, input.projectId);
  if (!pages.home) throw new HistosPublishError("Il progetto non ha una pagina «home» pubblicata.", "cms-front-page-missing", 409);
  const secret = await readStoredSecret(storeFor, connection.id);
  const body = Buffer.from(JSON.stringify({ frontPage: pages.home.id, postsPage: pages.blog?.id ?? null }), "utf8");
  const site = parseSiteFrontPage(JSON.parse((await requestRemote(connection, secret, "POST", ROUTE, body, 16 * 1024, "application/json")).bytes.toString("utf8")) as unknown);
  if (site.showOnFront !== "page" || site.frontPage !== pages.home.id || (pages.blog && site.postsPage !== pages.blog.id))
    throw new HistosPublishError("Il sito non ha confermato la nuova pagina iniziale.", "cms-remote-front-page-invalid", 502);
  catalog.setFrontPageAnswer(connection.id, "accepted");
  return { answer: "accepted", showOnFront: site.showOnFront };
}
