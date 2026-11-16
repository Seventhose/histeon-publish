import { HistosPublishError, SafeHttpClient } from "@histos-publish/core";

/**
 * Downloads one remote image of a Histeon prototype (docs/progettazione/histos-cms/14-prototipo-histos.md §4) with
 * the crawler's safe client: HTTPS only, public addresses only (no private networks, loopback or cloud metadata),
 * pinned DNS, no credentials, no redirects, a size cap and a time limit. The bytes are checked by the caller.
 */
export async function fetchPrototypeAsset(input: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  let url: URL;
  try { url = new URL(input); } catch { throw new HistosPublishError("Indirizzo del media non valido.", "prototype-asset-url-invalid", 2); }
  if (url.protocol !== "https:" || url.username || url.password) throw new HistosPublishError("Un media remoto deve essere un indirizzo https:// senza credenziali.", "prototype-asset-url-invalid", 2);
  const client = new SafeHttpClient({
    origin: url.origin,
    userAgent: "HistosPublish-Prototype/1.0",
    timeoutMs: 20_000,
    delayMs: 0,
    publicOnly: true,
    strictOrigin: true,
    ...(signal ? { signal } : {}),
  });
  const response = await client.get(url, { maxBytes, bypassCache: true, headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,font/woff2,font/woff" } });
  if (response.status >= 300 && response.status < 400) throw new HistosPublishError("Il server del media risponde con un reindirizzamento: usa l'indirizzo finale.", "prototype-asset-redirect", 2);
  if (response.status !== 200) throw new HistosPublishError(`Il server del media risponde ${response.status}.`, "prototype-asset-status", 2);
  return response.body;
}
