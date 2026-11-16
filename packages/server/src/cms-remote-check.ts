import { inspectStaticPageArchive, type CmsProjectCatalog } from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";
import type { CmsRemoteCatalog, CmsRemoteSecretStore } from "./cms-remote-catalog.js";
import { CmsRemoteRejectedError, MAX_ARCHIVE_BYTES, REMOTE_NAMESPACE, UUID, requestRemote, validateCapabilities } from "./cms-remote-transport.js";
import { assertRemotePhp, assertRemoteSupportsMarkup, assertRemoteSupportsProducts, assertRemoteSupportsProfile, assertRemoteSupportsScripts, bindRemoteProject, readStoredSecret } from "./cms-remote.js";

/**
 * Doc 23 item 197, «Controlla il sito»: the reading a send starts from, done on its own, before any send. The site reads
 * itself as for a check before a download (`PageProfileAdapter::export('read')`, which writes nothing on it), and the
 * answer lists by name every content that cannot travel, why, and what to do. Today one learns it from a refused send,
 * one content at a time.
 *
 * What the site can say depends on its Histeon: a content the project does not know yet stays out of the reading and is
 * named in it (`manifest.leftOut`), all of them; a content the project knows stops the whole reading with its name, so a
 * second one may wait behind it (`stoppedEarly`); a reading the site cannot prepare at all says no name. Publish then
 * reads every content of the archive on its own (inspectStaticPageArchive), and adds what the project needs that the
 * site cannot read (its Histeon, PHP, WooCommerce, JavaScript).
 *
 * All of it comes from the site: plain text, cut short, never markup, never a path or an id that chooses anything.
 */

export interface RemoteSiteProblem {
  /** On the site, or in the project (something of it the site cannot read). */
  where: "site" | "project";
  /** page, post, component, template-part, template, query, document, …; "site" for the site as a whole. */
  kind: string;
  title: string;
  reason: string;
  remedy: string;
  /** The words of the site or of the check, as they are. */
  message?: string;
  /** It stops a send. Otherwise the content stays out and does not change. */
  blocking: boolean;
}

export interface RemoteSiteCheck {
  checkedAt: string;
  host: string;
  /** Contents the site's reading holds. */
  read: number;
  problems: RemoteSiteProblem[];
  canSend: boolean;
  stoppedEarly: boolean;
}

const MAX_PROBLEMS = 300;

/** Plain text of the site: no control or direction characters, cut short. */
export function siteText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

const REASONS: Array<{ test: RegExp; reason: (match: RegExpMatchArray) => string; remedy: string }> = [
  {
    test: /expression scope is not portable[^:]*:\s*([A-Za-z_$][\w$]{0,30}(?:\.[A-Za-z_$][\w$]{0,30}){0,3})/u,
    reason: (match) => `Un'espressione usa «${match[1] ?? "url"}», che non viaggia fra WP e Publish (di url viaggia solo url.path).`,
    remedy: "Nel builder, in WP, cambia l'espressione: per la voce attiva di un menu usa url.path, che viaggia da Histeon 0.5.4.",
  },
  {
    test: /external, embedded or unresolved media|external or unresolved media|Invalid media URL|not a WordPress attachment/u,
    reason: () => "Un'immagine ha un indirizzo che non è un file della libreria dei media del sito (un altro sito, o un indirizzo scritto a mano).",
    remedy: "In WP scegli di nuovo l'immagine dalla libreria dei media. Se è del sito ma scritta in http su un sito https, viaggia da Histeon 0.5.4.",
  },
  {
    test: /default slot|slot predefinito|blocco «Contenuto del post»/u,
    reason: () => "Il template non ha il blocco «Contenuto del post»: senza, non c'è dove mettere la pagina.",
    remedy: "Nel template, in WP, rimetti il blocco «Contenuto del post» (in un archivio può restare vuoto) e salva.",
  },
  {
    test: /custom script outside/u,
    reason: () => "Ha uno script personalizzato, che template e parti di template non portano.",
    remedy: "In WP togli lo script da qui e mettilo in un componente o nella pagina.",
  },
  {
    test: /uses a WordPress template that is not part/u,
    reason: () => "Usa un template di WP che non è di Histeon.",
    remedy: "In WP assegna un template di Histeon, o il template predefinito.",
  },
  {
    test: /block outside the static page profile|non importa il blocco/u,
    reason: () => "Contiene un blocco che non viaggia fra WP e Publish.",
    remedy: "Nel builder, in WP, sostituisci quel blocco con elementi di Histeon, o togli il contenuto dal progetto.",
  },
  {
    test: /srcset/u,
    reason: () => "Un'immagine responsive elenca file che non viaggiano (misure intermedie, o un indirizzo con spazi o virgole).",
    remedy: "Nel builder elenca solo i file originali dei media.",
  },
  {
    test: /featured image .* is missing/u,
    reason: () => "L'immagine in evidenza non c'è più nella libreria dei media.",
    remedy: "In WP scegli di nuovo l'immagine in evidenza, o toglila.",
  },
  {
    test: /refers to a component missing|component .* does not declare prop/u,
    reason: () => "Usa un componente che non c'è più, o una sua proprietà che non esiste.",
    remedy: "In WP rimetti il componente, o togli il blocco che lo usa.",
  },
  {
    test: /expression modifier is unavailable|unsupported node|loop source kind is not portable|unsupported argument/u,
    reason: () => "Usa un'espressione o un loop che l'altro lato non sa ancora leggere.",
    remedy: "Porta Publish e Histeon in WP alla versione più recente, o cambia l'espressione in WP.",
  },
  {
    test: /markup from Histeon CMS|not transferable|is allowed only|must have a static value|character reference/u,
    reason: () => "Ha del markup che non viaggia fra WP e Publish.",
    remedy: "Correggi l'elemento nel builder in WP: il messaggio qui sotto dice quale.",
  },
  {
    test: /markup che WordPress rimuoverebbe/u,
    reason: () => "Il titolo o il riassunto contiene del markup, che WP toglierebbe.",
    remedy: "In WP togli il markup dal titolo o dal riassunto.",
  },
  {
    test: /che il profilo non può trasferire/u,
    reason: () => "Ha un indirizzo (slug) che non viaggia.",
    remedy: "In WP cambia lo slug: solo lettere latine minuscole, cifre e trattini.",
  },
];

/** What a reason of the site means and what to do; `known` is false for a reason this Publish does not recognize. */
export function explainSiteReason(message: string): { reason: string; remedy: string; known: boolean } {
  for (const entry of REASONS) {
    const match = message.match(entry.test);
    if (match) return { reason: entry.reason(match), remedy: entry.remedy, known: true };
  }
  return {
    reason: "Non può viaggiare fra WP e Publish.",
    remedy: "Correggi questo contenuto in WP, poi premi di nuovo «Controlla il sito». Il messaggio qui sotto dice cosa non va.",
    known: false,
  };
}

function siteProblem(input: { kind: string; title: string; message: string; blocking: boolean }): RemoteSiteProblem {
  const message = siteText(input.message, 400);
  const explained = explainSiteReason(message);
  return { where: "site", kind: siteText(input.kind, 40) || "content", title: siteText(input.title, 160) || "Un contenuto del sito", reason: explained.reason, remedy: explained.remedy, message, blocking: input.blocking };
}

/**
 * The refusal of a reading names the content that stopped it as «Title: reason». The title is taken only when the
 * reason is one this Publish recognizes; otherwise the whole message stays the message.
 */
function stoppedReading(message: string): RemoteSiteProblem {
  const text = siteText(message, 600);
  const separator = text.indexOf(": ");
  if (separator > 0 && separator <= 160 && explainSiteReason(text.slice(separator + 2)).known) {
    return siteProblem({ kind: "content", title: text.slice(0, separator), message: text.slice(separator + 2), blocking: true });
  }
  return siteProblem({ kind: "content", title: "", message: text, blocking: true });
}

export async function checkRemoteSite(
  input: { connectionId: string; projectId?: string },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<RemoteSiteCheck> {
  const connection = catalog.get(input.connectionId);
  if (!connection) throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
  if (input.projectId !== undefined && !UUID.test(input.projectId)) throw new HistosPublishError("Identificativo del progetto CMS non valido.", "cms-project-invalid", 400);
  if (!connection.read) {
    throw new HistosPublishError("Questo collegamento non permette di leggere il sito, e il controllo è una lettura: in WP crea un codice con la lettura e aggiorna il collegamento.", "cms-remote-read-scope-required", 403);
  }
  const secret = await readStoredSecret(storeFor, connection.id);
  const capabilities = validateCapabilities(JSON.parse((await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`)).bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId) {
    throw new HistosPublishError("L'identità del sito è cambiata: ricollega il sito prima di controllarlo.", "cms-remote-site-changed", 409);
  }
  const checkedAt = new Date().toISOString();
  bindRemoteProject(catalog, connection, capabilities, checkedAt);
  const problems: RemoteSiteProblem[] = [];

  // What of the project the site cannot read: every reason, not only the first a send would stop at.
  const projectId = input.projectId;
  if (projectId && (connection.projectId === null || connection.projectId === projectId)) {
    const opened = await projects.openProject(projectId);
    if (opened) {
      try {
        const { createStaticPageProfile } = await import("@histos-publish/cms");
        const local = await createStaticPageProfile(opened.project, opened.store, undefined, connection.siteId);
        const checks: Array<() => void> = [
          () => assertRemoteSupportsProfile(capabilities.profiles, local.profile.manifest.profile),
          () => assertRemoteSupportsMarkup(capabilities.markup, local.profile),
          () => assertRemoteSupportsProducts(capabilities.commerce, local.profile),
          () => assertRemoteSupportsScripts(capabilities.scripts ?? [], local.profile),
          () => assertRemotePhp(capabilities.php),
        ];
        for (const check of checks) {
          try { check(); } catch (error) {
            if (!(error instanceof HistosPublishError)) throw error;
            problems.push({ where: "project", kind: "project", title: siteText(opened.project.name, 160), reason: error.message.replace(/:\s*non ho inviato nulla\.\s*$/u, ".").replace(/\s*Non ho inviato nulla\.\s*$/u, ""), remedy: "Aggiorna Histeon in WP (o PHP dall'hosting, se lo dice il motivo), poi ricontrolla.", blocking: true });
          }
        }
      } finally {
        opened.store.close();
      }
    }
  }

  let read = 0;
  let stoppedEarly = false;
  try {
    const response = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/export`, Buffer.alloc(0), MAX_ARCHIVE_BYTES, undefined, { "X-Histos-Export": capabilities.readings.includes("check") ? "check" : "read" });
    if (!response.contentType.toLowerCase().startsWith("application/zip")) {
      throw new HistosPublishError("Il sito non ha restituito la sua rilettura.", "cms-remote-export-invalid", 422);
    }
    const inspection = await inspectStaticPageArchive(response.bytes);
    read = inspection.entities;
    // A site with the `check` reading names the project's own contents that cannot travel too, as blocking.
    for (const item of inspection.leftOut) problems.push(siteProblem({ kind: item.kind, title: item.title, message: item.reason, blocking: item.blocks }));
    for (const item of inspection.problems) problems.push(siteProblem({ kind: item.kind, title: item.title, message: item.reason, blocking: true }));
    if (inspection.whole) {
      problems.push({ ...siteProblem({ kind: "site", title: "La rilettura del sito", message: inspection.whole, blocking: true }), reason: "Publish non riesce a leggere la rilettura del sito, e non per un contenuto solo." });
    }
  } catch (error) {
    if (!(error instanceof CmsRemoteRejectedError)) throw error;
    if (error.exitCode === 422 && error.remoteCode === "xb_cms_unavailable") {
      problems.push(stoppedReading(error.message));
      stoppedEarly = true;
    } else if (error.exitCode >= 500) {
      problems.push({
        where: "site", kind: "site", title: "La rilettura del sito",
        reason: "Il sito non riesce a preparare la sua rilettura, e non dice per quale contenuto.",
        remedy: "Succede per esempio con un template di Histeon senza il blocco «Contenuto del post»: controlla i template in WP (in un archivio il blocco può restare vuoto), poi ricontrolla.",
        message: siteText(error.message, 400),
        blocking: true,
      });
      stoppedEarly = true;
    } else {
      throw error;
    }
  }
  const listed = problems
    .sort((left, right) => Number(right.blocking) - Number(left.blocking) || left.where.localeCompare(right.where) || left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title))
    .slice(0, MAX_PROBLEMS);
  return {
    checkedAt,
    host: new URL(connection.url).host,
    read,
    problems: listed,
    canSend: !problems.some((problem) => problem.blocking),
    stoppedEarly,
  };
}
