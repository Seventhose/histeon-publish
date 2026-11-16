import type { BuilderConfig } from "../../cms/vendor/histos/editor/src/lib/config.ts";

declare global {
  interface Window { xbBuilder?: BuilderConfig }
}

async function start(): Promise<void> {
  const root = document.getElementById("xb-builder");
  if (!root) throw new Error("Radice dell’editor Histeon non trovata.");
  const query = new URLSearchParams(window.location.search);
  const projectId = query.get("project") ?? "";
  const documentId = query.get("document") ?? "";
  if (!/^[0-9a-f-]{36}$/iu.test(projectId) || !/^[1-9][0-9]{0,15}$/u.test(documentId) || !Number.isSafeInteger(Number(documentId))) {
    root.textContent = "Apri una pagina dal catalogo CMS Histeon.";
    return;
  }
  const token = sessionStorage.getItem("histos-publish-session") ?? "";
  const back = query.get("back");
  const response = await fetch(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/builder-config?document=${encodeURIComponent(documentId)}${back ? `&back=${encodeURIComponent(back)}` : ""}`, {
    headers: { "X-Histos-Token": token, Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
  });
  const body = await response.json().catch(() => null) as (BuilderConfig & { error?: string }) | null;
  if (!response.ok || !body) {
    root.textContent = body?.error ?? "Non riesco a caricare la configurazione dell’editor.";
    return;
  }
  window.xbBuilder = body;
  const builderEntry: string = "/histos-builder/builder.js";
  await import(/* @vite-ignore */ builderEntry);
}

void start().catch((error: unknown) => {
  const root = document.getElementById("xb-builder");
  if (root) root.textContent = error instanceof Error ? error.message : "Errore di avvio dell’editor Histeon.";
});
