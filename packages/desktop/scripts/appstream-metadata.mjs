import { isIP } from "node:net";

function xml(value) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw new Error("Il metadato contiene caratteri XML non validi.");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function validateAppStreamIdentity({ id, homepage }) {
  if (typeof id !== "string" || id.length > 200 || !/^[a-z0-9]+(?:\.[a-z0-9_-]+){2,}$/u.test(id)) {
    throw new Error("HISTOS_APPSTREAM_ID deve essere un identificatore reverse-DNS minuscolo di almeno tre segmenti, per esempio it.organizzazione.histospublish.");
  }

  if (typeof homepage !== "string" || homepage.length > 2_048) throw new Error("HISTOS_APPSTREAM_HOMEPAGE non è valido.");
  let parsedHomepage;
  try {
    parsedHomepage = new URL(homepage);
  } catch {
    throw new Error("HISTOS_APPSTREAM_HOMEPAGE deve essere l’URL HTTPS ufficiale del prodotto.");
  }
  const hostname = parsedHomepage.hostname.toLowerCase();
  if (parsedHomepage.protocol !== "https:" || parsedHomepage.username || parsedHomepage.password ||
      !hostname.includes(".") || isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".invalid") || hostname.endsWith(".test") || hostname.endsWith(".example") ||
      ["example.com", "example.org", "example.net"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("HISTOS_APPSTREAM_HOMEPAGE deve essere un URL HTTPS pubblico, senza credenziali né dominio di esempio.");
  }
  return { id, homepage: parsedHomepage.toString() };
}

export function validateAppStreamSettings({ id, homepage, maintainer, developerName }) {
  const identity = validateAppStreamIdentity({ id, homepage });
  if (typeof maintainer !== "string" || maintainer.includes("\n") || maintainer.includes("\r") ||
      !/^.+ <[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/u.test(maintainer) ||
      /(?:example\.(?:com|net|org|invalid)|\.invalid)>$/iu.test(maintainer)) {
    throw new Error("HISTOS_DEB_MAINTAINER deve contenere nome ed email nel formato Nome <email@dominio.it>, senza dati di esempio.");
  }
  if (typeof developerName !== "string" || !developerName.trim() || developerName.length > 200 || /[\u0000-\u001F]/u.test(developerName)) {
    throw new Error("HISTOS_APPSTREAM_DEVELOPER_NAME deve indicare il nome dell’organizzazione o del maintainer.");
  }
  return { ...identity, maintainer, developerName };
}

export function createAppStreamMetainfo({ id, homepage, version, releaseDate, developerName }) {
  const identity = validateAppStreamIdentity({ id, homepage });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Versione AppStream non valida.");
  if (typeof developerName !== "string" || !developerName.trim() || developerName.length > 200 || /[\u0000-\u001F]/u.test(developerName)) {
    throw new Error("Nome sviluppatore AppStream non valido.");
  }
  const safeId = xml(identity.id);
  const safeHomepage = xml(identity.homepage);
  const safeVersion = xml(version);
  const parsedDate = new Date(`${releaseDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== releaseDate) {
    throw new Error("Data release AppStream non valida.");
  }
  const safeDate = xml(parsedDate.toISOString().slice(0, 10));
  const safeDeveloper = xml(developerName);
  const developerId = xml(identity.id.split(".").slice(0, -1).join("."));
  return `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${safeId}</id>
  <name>Histeon Publish</name>
  <summary>Creazione e pubblicazione controllata di siti web statici</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>GPL-3.0-or-later</project_license>
  <description>
    <p>Crea bundle statici, li esporta e prepara pubblicazioni controllate per servizi compatibili.</p>
  </description>
  <url type="homepage">${safeHomepage}</url>
  <icon type="stock">histos-publish</icon>
  <launchable type="desktop-id">${safeId}.desktop</launchable>
  <provides>
    <binary>histos-publish</binary>
  </provides>
  <categories>
    <category>Development</category>
    <category>WebDevelopment</category>
  </categories>
  <developer id="${developerId}">
    <name>${safeDeveloper}</name>
  </developer>
  <releases>
    <release version="${safeVersion}" date="${safeDate}" />
  </releases>
</component>
`;
}
