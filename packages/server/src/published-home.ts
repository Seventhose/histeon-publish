import { SafeHttpClient, type HttpResponseMetadata } from "@histos-publish/core";

export interface PublishedHomeCheck {
  status: "ok" | "warning" | "unavailable";
  url?: string;
  statusCode?: number;
  contentType?: string;
  contentDisposition?: string;
  message: string;
}

export type PublishedHomeProbe = (url: URL) => Promise<HttpResponseMetadata>;

async function probePublicHome(url: URL): Promise<HttpResponseMetadata> {
  const client = new SafeHttpClient({
    origin: url.origin,
    userAgent: "Histeon Publish health check",
    timeoutMs: 10_000,
    delayMs: 0,
    publicOnly: true,
    strictOrigin: true,
  });
  return client.probe(url, { headers: { Range: "bytes=0-0" } });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function visibleUrl(url: URL): string {
  const safe = new URL(url);
  safe.search = "";
  safe.hash = "";
  return safe.href;
}

function unavailable(message: string): PublishedHomeCheck {
  return { status: "unavailable", message };
}

function warning(url: URL, message: string, details: { statusCode?: number; contentType?: string; contentDisposition?: string } = {}): PublishedHomeCheck {
  return { status: "warning", url: visibleUrl(url), ...details, message };
}

/** Checks an uploaded site's public home without following cross-origin redirects or contacting private networks. */
export async function checkPublishedHome(url?: string, probe: PublishedHomeProbe = probePublicHome): Promise<PublishedHomeCheck> {
  if (!url) return unavailable("Non è stato configurato un indirizzo pubblico da controllare.");
  let target: URL;
  try { target = new URL(url); }
  catch { return unavailable("L’indirizzo pubblico configurato non è valido."); }
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    return unavailable("Il controllo automatico richiede un indirizzo HTTPS pubblico senza credenziali.");
  }

  const origin = target.origin;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    let response: HttpResponseMetadata;
    try { response = await probe(target); }
    catch { return warning(target, "La pubblicazione è avvenuta, ma non ho potuto verificare l’indirizzo in modo sicuro. Controlla DNS e disponibilità del sito."); }

    if (response.status >= 300 && response.status < 400) {
      const location = header(response.headers.location);
      if (!location) return warning(target, `L’indirizzo pubblico risponde con un reindirizzamento HTTP ${response.status} senza destinazione.` , { statusCode: response.status });
      let next: URL;
      try { next = new URL(location, target); }
      catch { return warning(target, "Il sito ha restituito un indirizzo di reindirizzamento non valido.", { statusCode: response.status }); }
      if (next.protocol !== "https:" || next.origin !== origin || next.username || next.password) {
        return warning(target, "Il sito reindirizza fuori dal proprio indirizzo HTTPS. Per sicurezza Histeon non segue questo collegamento automaticamente.", { statusCode: response.status });
      }
      if (redirectCount === 3) return warning(target, "Il sito supera il numero di reindirizzamenti consentito.", { statusCode: response.status });
      target = next;
      continue;
    }

    const contentType = (header(response.headers["content-type"]) ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const contentDisposition = header(response.headers["content-disposition"])?.slice(0, 200) ?? "";
    const details = {
      statusCode: response.status,
      ...(contentType ? { contentType } : {}),
      ...(contentDisposition ? { contentDisposition } : {}),
    };
    if (response.status !== 200 && response.status !== 206) {
      return warning(target, `L’indirizzo pubblico risponde HTTP ${response.status}. La pubblicazione è avvenuta, ma la home non ha restituito una pagina consultabile.`, details);
    }
    if (/attachment/iu.test(contentDisposition)) {
      return warning(target, "Il server invia la home come allegato. Il browser può scaricarla invece di mostrarla: controlla index.html e l’intestazione Content-Disposition.", details);
    }
    if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
      return warning(target, `La home non è stata restituita come HTML (Content-Type: ${contentType || "assente"}). Il browser potrebbe scaricare un file invece di mostrare il sito.`, details);
    }
    return { status: "ok", url: visibleUrl(target), ...details, message: "Controllo riuscito: la home risponde come pagina HTML." };
  }
  return warning(target, "Il sito non ha completato il controllo della home.");
}
